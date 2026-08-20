/** Saved artifacts exposed as callable tools an agent can discover and
 * invoke by name. Params become the input schema (env-sourced params are
 * infrastructure, not caller inputs); outputs and outcome codes go into the
 * description so a caller knows what comes back and what to handle. */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { CapabilityArtifact, ParamSpec } from '../schema/capability.js';
import { loadCapability } from '../schema/capability.js';

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

export function buildCatalog(dir = 'capabilities'): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const full = path.join(dir, file);
    try {
      const { artifact } = loadCapability(full);
      entries.push(toEntry(artifact, full));
    } catch (err) {
      // The catalog is an agent-facing surface: a broken artifact must fail
      // loudly AND name itself, not brick the listing with a bare stack.
      throw new Error(`invalid capability artifact '${full}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return entries;
}

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

/** Resolve a catalog name to its artifact file (how `--invoke` finds it). */
export function findByName(name: string, dir = 'capabilities'): CatalogEntry {
  const entry = buildCatalog(dir).find((e) => e.name === name);
  if (!entry) throw new Error(`no capability named '${name}' in ${dir}/`);
  return entry;
}
