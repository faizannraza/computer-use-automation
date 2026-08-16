/**
 * The agent-facing capability catalog (stretch goal): saved artifacts
 * exposed as a catalog of callable capabilities an AI agent can discover
 * and invoke by name with typed arguments.
 *
 * Each entry is derived from the artifact's own contract — params become the
 * input schema (env-sourced params are infrastructure, not caller inputs,
 * so they are excluded), outputs and outcome codes are surfaced in the
 * description so a calling agent knows what comes back and which business
 * outcomes it must handle. The tool-definition shape is the standard
 * function-calling format (name / description / JSON-schema input).
 */
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
    const { artifact } = loadCapability(path.join(dir, file));
    entries.push(toEntry(artifact, path.join(dir, file)));
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
