/** Saved artifacts exposed as callable tools an agent can discover and
 * invoke by name. Params become the input schema (env-sourced params are
 * infrastructure, not caller inputs); outputs and outcome codes go into the
 * description so a caller knows what comes back and what to handle. */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { CapabilityArtifact, ParamSpec } from '../schema/capability.js';
import { loadCapability } from '../schema/capability.js';

/**
 * An artifact file that is present but did not load — a schema refusal, bad
 * JSON, a hash mismatch, an unreadable file.
 *
 * It is NOT a callable capability and never becomes one: everything here is
 * derived from the file, because the artifact's own declarations (its id, its
 * params, its outcomes) are exactly what could not be read.
 */
export interface BrokenCapability {
  /**
   * The name a caller would most plausibly invoke this file by, taken from the
   * `<name>@<version>.json` convention. A GUESS, and labelled as one wherever
   * it is shown: the artifact's declared `capability.id` is unknowable here.
   */
  name: string;
  file: string;
  error: string;
}

export interface Catalog {
  entries: CatalogEntry[];
  broken: BrokenCapability[];
}

export interface CatalogEntry {
  name: string;
  version: string;
  title: string;
  description: string;
  approval: 'draft' | 'approved';
  maxRisk: string;
  /** Which target application this capability drives — capabilities for
   * several apps can share one catalog. */
  app: string;
  /** Operator role the app requires for this function, when it restricts it. */
  requiresRole?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  outputs: Record<string, { type: string; description: string }>;
  outcomes: { code: string; description: string }[];
  artifactFile: string;
}

/**
 * Read a directory of artifacts into the valid entries plus the files that
 * refused to load.
 *
 * PARTIAL-FAIL BY DESIGN. This used to rethrow on the first bad file, which
 * made the whole catalog — and therefore every route that touches it, health
 * included — hostage to any one artifact. That is the wrong shape for a
 * surface whose entire point is holding MANY independently recorded artifacts:
 * they are recorded at different times, against different screens, and the
 * schema keeps gaining refusals (a `readTable` step's output must be declared
 * `type: 'table'`; a detector may not match on redacted text), so "one of them
 * does not load" is a normal operating state, not an emergency. Nine working
 * capabilities must not be unreachable because a tenth is malformed.
 *
 * Loudness is preserved by REPORTING rather than by throwing: every failure
 * comes back naming its file and its error, and the consumers surface it —
 * `/api/profile` and `/api/health` publish the list, the dashboard renders a
 * row per broken file, and invoking one by name is a 4xx that quotes the
 * error. What is NOT covered: a file that parses but was recorded against the
 * wrong screen still counts as valid here — this only knows load-time truth.
 */
export function loadCatalog(dir = 'capabilities'): Catalog {
  const entries: CatalogEntry[] = [];
  const broken: BrokenCapability[] = [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    // A missing or unreadable directory is a deployment mistake, and it is
    // reported as one broken pseudo-entry rather than thrown: the same rule as
    // above (the API keeps serving, the operator is told exactly what is
    // wrong) applied to the one failure that would otherwise empty the catalog
    // silently.
    return { entries, broken: [{ name: `(${path.basename(dir)})`, file: dir, error: messageOf(err) }] };
  }

  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const { artifact } = loadCapability(full);
      entries.push(toEntry(artifact, full));
    } catch (err) {
      broken.push({ name: presumedName(file), file: full, error: messageOf(err) });
    }
  }
  return { entries, broken };
}

/** The callable subset. Callers that also need to SHOW the failures use
 *  `loadCatalog` — this one silently omits them, which is right for an agent's
 *  tool list (an unloadable artifact is not callable) and wrong for an
 *  operator view. */
export function buildCatalog(dir = 'capabilities'): CatalogEntry[] {
  return loadCatalog(dir).entries;
}

/** `member.transferFunds@1.0.0.json` → `member.transferFunds`. */
function presumedName(file: string): string {
  const stem = file.replace(/\.json$/, '');
  const at = stem.indexOf('@');
  return at > 0 ? stem.slice(0, at) : stem;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function toEntry(artifact: CapabilityArtifact, file: string): CatalogEntry {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(artifact.params)) {
    if (spec.source === 'env') continue; // resolved by the runtime, not the caller
    properties[name] = paramToJsonSchema(spec);
    if (spec.required) required.push(name);
  }
  const outcomes = artifact.outcomes.map((o) => ({ code: o.code, description: o.description }));
  const outputs = Object.fromEntries(
    Object.entries(artifact.outputs).map(([k, v]) => [k, { type: v.type, description: v.description }]),
  );
  return {
    name: artifact.capability.id,
    version: artifact.capability.version,
    title: artifact.capability.title,
    description: describeForAgent(artifact),
    approval: artifact.provenance.approval.state,
    maxRisk: artifact.policy.maxRisk,
    app: artifact.capability.app.appId,
    ...(artifact.policy.requiresRole !== undefined ? { requiresRole: artifact.policy.requiresRole } : {}),
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputs,
    outcomes,
    artifactFile: file,
  };
}

/** One description string a calling agent can act on: what it does, what
 * comes back, and which business outcomes must be handled. */
function describeForAgent(artifact: CapabilityArtifact): string {
  const parts = [artifact.capability.description];
  const outs = Object.entries(artifact.outputs).map(([k, v]) => `${k} (${v.type})`);
  if (outs.length > 0) parts.push(`Returns: ${outs.join(', ')}.`);
  if (artifact.outcomes.length > 0) {
    parts.push(`Possible business outcomes (handle these): ${artifact.outcomes.map((o) => o.code).join(', ')}.`);
  }
  if (artifact.policy.maxRisk === 'irreversible') {
    parts.push('Contains an IRREVERSIBLE step: unattended invocation escalates to a human under the default policy.');
  }
  return parts.join(' ');
}

function paramToJsonSchema(spec: ParamSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = { description: spec.description };
  switch (spec.type) {
    case 'integer':
      schema['type'] = 'integer';
      break;
    case 'enum':
      schema['type'] = 'string';
      if (spec.values) schema['enum'] = spec.values;
      break;
    default:
      schema['type'] = 'string';
  }
  if (spec.pattern !== undefined) schema['pattern'] = spec.pattern;
  if (spec.example !== undefined) schema['examples'] = [spec.example];
  return schema;
}

/**
 * Resolve a catalog name to its artifact file (how `--invoke` finds it).
 *
 * A name that matches a BROKEN file is reported as broken rather than as
 * missing: "no such capability" would send the caller looking for a recording
 * that exists and is one schema error away from working, which is the most
 * expensive possible wrong answer.
 */
export function findByName(name: string, dir = 'capabilities'): CatalogEntry {
  const { entries, broken } = loadCatalog(dir);
  const entry = entries.find((e) => e.name === name);
  if (entry) return entry;
  const bad = broken.find((b) => b.name === name);
  if (bad) throw new Error(`capability '${name}' failed to load from '${bad.file}': ${bad.error}`);
  throw new Error(`no capability named '${name}' in ${dir}/`);
}
