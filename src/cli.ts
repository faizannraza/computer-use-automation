#!/usr/bin/env tsx
/**
 * cu — the command-line entrypoint.
 *
 *   cu replay --capability <file> --param k=v ...   deterministic replay (no LLM)
 *   cu validate <file>                              schema + integrity check
 *   cu hash <file>                                  (re)compute integrity.contentHash
 *
 * Exit codes for `replay`: 0 = success OR a named business outcome (both are
 * legitimate results a caller handles), 2 = failed, 3 = escalated.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadPolicy } from './policy/policy.js';
import { replayCapability } from './replay/engine.js';
import { CapabilityArtifactSchema, computeContentHash, loadCapability } from './schema/capability.js';
import { applyOverlay, loadOverlay } from './schema/overlay.js';
import type { ResolvedCapability } from './schema/overlay.js';

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case 'replay':
    await replayCmd(rest);
    break;
  case 'validate':
    validateCmd(rest);
    break;
  case 'hash':
    hashCmd(rest);
    break;
  default:
    console.error('usage: cu <replay|validate|hash> ...');
    process.exit(64);
}

async function replayCmd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      capability: { type: 'string' },
      param: { type: 'string', multiple: true },
      'base-url': { type: 'string', default: 'http://localhost:4173' },
      policy: { type: 'string', default: 'policies/default.policy.json' },
      tenant: { type: 'string' },
      headed: { type: 'boolean', default: false },
      'allow-draft': { type: 'boolean', default: false },
      'evidence-dir': { type: 'string', default: 'evidence' },
      // Test-harness convenience: arms a fault on the MOCK APP before the run
      // (name:mode[:param]). This talks to the mock's /__faults endpoint —
      // which the automation policy itself denies the agent from touching.
      'inject-fault': { type: 'string', multiple: true },
    },
  });
  if (!values.capability) {
    console.error('replay requires --capability <artifact.json>');
    process.exit(64);
  }

  const { artifact, verified } = loadCapability(values.capability);
  let resolved: ResolvedCapability;
  if (values.tenant) {
    resolved = applyOverlay(artifact, loadOverlay(values.tenant));
    resolved.bindings['baseUrl'] ??= values['base-url']!;
  } else {
    resolved = { artifact, bindings: { baseUrl: values['base-url']! } };
  }

  const paramValues: Record<string, string> = {};
  for (const kv of values.param ?? []) {
    const eq = kv.indexOf('=');
    if (eq < 1) {
      console.error(`--param expects k=v, got '${kv}'`);
      process.exit(64);
    }
    paramValues[kv.slice(0, eq)] = kv.slice(eq + 1);
  }

  for (const spec of values['inject-fault'] ?? []) {
    const [fault, mode = 'once', param] = spec.split(':');
    const res = await fetch(`${resolved.bindings['baseUrl']}/__faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fault, mode, ...(param !== undefined ? { param: Number(param) } : {}) }),
    });
    if (!res.ok) {
      console.error(`fault injection failed: ${res.status} ${await res.text()}`);
      process.exit(70);
    }
    console.error(`[harness] armed fault ${fault} (${mode})`);
  }

  const result = await replayCapability(resolved, {
    policy: loadPolicy(values.policy!),
    paramValues,
    verified,
    allowDraft: values['allow-draft']!,
    headed: values.headed!,
    evidenceBaseDir: values['evidence-dir']!,
  });

  // Human summary → stderr; machine-readable result → stdout (the caller
  // channel: outputs here are intentionally NOT redacted — the invoking
  // agent is entitled to them; evidence on disk is redacted).
  console.error(`\n[${result.status.toUpperCase()}] ${result.capabilityId}@${result.version} run ${result.runId}`);
  console.error(`  evidence: ${result.evidenceDir}`);
  if (result.status === 'failed') {
    console.error(`  ${result.failure.class} at ${result.failure.stepId ?? '(run)'}`);
    console.error(`  expected: ${result.failure.expected}`);
    console.error(`  observed: ${result.failure.observed}`);
  }
  if (result.status === 'business_outcome') console.error(`  outcome: ${result.code} — ${result.message}`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'success' || result.status === 'business_outcome' ? 0 : result.status === 'failed' ? 2 : 3);
}

function validateCmd(argv: string[]): void {
  const file = argv[0];
  if (!file) {
    console.error('usage: cu validate <artifact.json>');
    process.exit(64);
  }
  const { artifact, verified } = loadCapability(file);
  console.log(`schema: OK (${artifact.capability.id}@${artifact.capability.version})`);
  console.log(`integrity: ${verified ? 'OK' : 'MISMATCH — run `cu hash` after deliberate edits'}`);
  process.exit(verified ? 0 : 1);
}

function hashCmd(argv: string[]): void {
  const file = argv[0];
  if (!file) {
    console.error('usage: cu hash <artifact.json>');
    process.exit(64);
  }
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const artifact = CapabilityArtifactSchema.parse(raw); // must be schema-valid to hash
  artifact.integrity.contentHash = computeContentHash(artifact);
  writeFileSync(file, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`integrity.contentHash = ${artifact.integrity.contentHash}`);
}
