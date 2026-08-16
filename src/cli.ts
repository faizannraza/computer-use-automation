#!/usr/bin/env tsx
/**
 * cu — the command-line entrypoint.
 *
 *   cu discover --goal "..." --param k=v ...        LLM-driven discovery → compiled draft artifact
 *   cu replay --capability <file> --param k=v ...   deterministic replay (no LLM)
 *   cu approve <file> --by "name"                   mark a reviewed artifact approved (re-hashes)
 *   cu validate <file>                              schema + integrity check
 *   cu hash <file>                                  (re)compute integrity.contentHash
 *
 * Exit codes for `replay`: 0 = success OR a named business outcome (both are
 * legitimate results a caller handles), 2 = failed, 3 = escalated.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildCatalog, findByName } from './catalog/catalog.js';
import { runDiscovery } from './discovery/agent.js';
import type { OutputHint } from './discovery/compile.js';
import { TerminalOperator } from './hitl/terminalOperator.js';
import { loadPolicy } from './policy/policy.js';
import { replayCapability } from './replay/engine.js';
import { CapabilityArtifactSchema, ParamSpecSchema, computeContentHash, loadCapability } from './schema/capability.js';
import type { ParamSpec, Sensitivity } from './schema/capability.js';
import { applyOverlay, loadOverlay } from './schema/overlay.js';
import type { ResolvedCapability } from './schema/overlay.js';

const [command, ...rest] = process.argv.slice(2);

try {
  await dispatch();
} catch (err) {
  // One boundary for operator-facing errors: message, not stack trace.
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(70);
}

async function dispatch(): Promise<void> {
switch (command) {
  case 'discover':
    await discoverCmd(rest);
    break;
  case 'replay':
    await replayCmd(rest);
    break;
  case 'catalog':
    await catalogCmd(rest);
    break;
  case 'approve':
    approveCmd(rest);
    break;
  case 'validate':
    validateCmd(rest);
    break;
  case 'hash':
    hashCmd(rest);
    break;
  default:
    console.error('usage: cu <discover|replay|catalog|approve|validate|hash> ...');
    process.exit(64);
}
}

/**
 * The agent-facing surface: `cu catalog` prints the callable-capability
 * catalog (function-calling tool definitions); `cu catalog --invoke <name>`
 * invokes one by name with typed args — the path an AI agent would take.
 */
async function catalogCmd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      invoke: { type: 'string' },
      param: { type: 'string', multiple: true },
      'base-url': { type: 'string', default: 'http://localhost:4173' },
      policy: { type: 'string', default: 'policies/default.policy.json' },
      dir: { type: 'string', default: 'capabilities' },
      'allow-draft': { type: 'boolean', default: false },
      'evidence-dir': { type: 'string', default: 'evidence' },
    },
  });
  if (!values.invoke) {
    console.log(JSON.stringify(buildCatalog(values.dir!), null, 2));
    return;
  }
  const entry = findByName(values.invoke, values.dir!);
  const paramValues: Record<string, string> = {};
  for (const kv of values.param ?? []) {
    const eq = kv.indexOf('=');
    if (eq < 1) {
      console.error(`--param expects k=v, got '${kv}'`);
      process.exit(64);
    }
    paramValues[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  const { artifact, verified } = loadCapability(entry.artifactFile);
  const result = await replayCapability(
    { artifact, bindings: { baseUrl: values['base-url']! } },
    {
      policy: loadPolicy(values.policy!),
      paramValues,
      verified,
      allowDraft: values['allow-draft']!,
      evidenceBaseDir: values['evidence-dir']!,
    },
  );
  console.error(`\n[${result.status.toUpperCase()}] invoked ${entry.name}@${entry.version} via catalog`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'success' || result.status === 'business_outcome' ? 0 : result.status === 'failed' ? 2 : 3);
}

async function discoverCmd(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      goal: { type: 'string' },
      // --param memberId=12345:internal    (caller-supplied, value inline)
      param: { type: 'string', multiple: true },
      // --env-param operatorPassword=MOCK_CU_PASS:secret  (resolved from env)
      'env-param': { type: 'string', multiple: true },
      // --output savingsBalance:money:pii  (type/sensitivity hints for declared outputs)
      output: { type: 'string', multiple: true },
      'base-url': { type: 'string', default: 'http://localhost:4173' },
      policy: { type: 'string', default: 'policies/default.policy.json' },
      headed: { type: 'boolean', default: false },
      'max-turns': { type: 'string', default: '30' },
      'evidence-dir': { type: 'string', default: 'evidence' },
      'save-dir': { type: 'string', default: 'capabilities' },
      'artifact-version': { type: 'string', default: '1.0.0' },
      model: { type: 'string' },
    },
  });
  if (!values.goal) {
    console.error('discover requires --goal "..."');
    process.exit(64);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('discover requires ANTHROPIC_API_KEY (put it in .env — see .env.example)');
    process.exit(64);
  }

  const paramSpecs: Record<string, ParamSpec> = {};
  const paramValues: Record<string, string> = {};
  for (const spec of values.param ?? []) {
    const m = /^([a-zA-Z][a-zA-Z0-9]*)=([^:]*)(?::(none|internal|pii|secret))?$/.exec(spec);
    if (!m) {
      console.error(`--param expects name=value[:sensitivity], got '${spec}'`);
      process.exit(64);
    }
    const [, name, value, sensitivity] = m;
    paramValues[name!] = value!;
    paramSpecs[name!] = ParamSpecSchema.parse({
      type: 'string',
      description: `Caller-supplied parameter '${name}'.`,
      sensitivity: (sensitivity as Sensitivity | undefined) ?? 'none',
      source: 'caller',
      ...(/^\d+$/.test(value!) ? { pattern: '^[0-9]+$' } : {}),
      ...((sensitivity ?? 'none') === 'none' || sensitivity === 'internal' ? { example: value } : {}),
    });
  }
  for (const spec of values['env-param'] ?? []) {
    const m = /^([a-zA-Z][a-zA-Z0-9]*)=([A-Z0-9_]+)(?::(none|internal|pii|secret))?$/.exec(spec);
    if (!m) {
      console.error(`--env-param expects name=ENV_VAR[:sensitivity], got '${spec}'`);
      process.exit(64);
    }
    const [, name, env, sensitivity] = m;
    paramSpecs[name!] = ParamSpecSchema.parse({
      type: 'string',
      description: `Resolved from the environment (${env}) at invocation time; never stored in the artifact.`,
      sensitivity: (sensitivity as Sensitivity | undefined) ?? 'internal',
      source: 'env',
      env,
    });
  }
  const outputHints: Record<string, OutputHint> = {};
  const OUTPUT_TYPES = ['string', 'integer', 'money'];
  const SENSITIVITIES = ['none', 'internal', 'pii', 'secret'];
  for (const spec of values.output ?? []) {
    const [name, type, sensitivity] = spec.split(':');
    // Validated strictly: a typo'd sensitivity here would silently disable
    // redaction of an extracted value — and only surface after a paid run.
    if (!name || (type && !OUTPUT_TYPES.includes(type)) || (sensitivity && !SENSITIVITIES.includes(sensitivity))) {
      console.error(`--output expects name[:${OUTPUT_TYPES.join('|')}[:${SENSITIVITIES.join('|')}]], got '${spec}'`);
      process.exit(64);
    }
    const hint: OutputHint = {};
    if (type) hint.type = type as Exclude<OutputHint['type'], undefined>;
    if (sensitivity) hint.sensitivity = sensitivity as Sensitivity;
    outputHints[name] = hint;
  }

  console.error(`[discover] goal: ${values.goal}`);
  console.error(`[discover] model turns cap: ${values['max-turns']} — this performs a REAL LLM run`);
  const result = await runDiscovery({
    goal: values.goal,
    paramSpecs,
    paramValues,
    outputHints,
    policy: loadPolicy(values.policy!),
    baseUrl: values['base-url']!,
    headed: values.headed!,
    maxTurns: Number(values['max-turns']),
    evidenceBaseDir: values['evidence-dir']!,
    saveDir: values['save-dir']!,
    artifactVersion: values['artifact-version']!,
    ...(values.model ? { model: values.model } : {}),
  });
  console.error(`\n[${result.status.toUpperCase()}] discovery run ${result.runId}`);
  console.error(`  evidence: ${result.evidenceDir}`);
  console.error(`  usage: ${result.usage.turns} turns, ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`);
  if (result.artifactPath) console.error(`  artifact: ${result.artifactPath} (draft — review, then \`cu approve\`)`);
  if (result.reason) console.error(`  reason: ${result.reason}`);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'compiled' ? 0 : 2);
}

function approveCmd(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { by: { type: 'string' } },
  });
  const file = positionals[0];
  if (!file || !values.by) {
    console.error('usage: cu approve <artifact.json> --by "reviewer name"');
    process.exit(64);
  }
  const artifact = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  artifact.provenance.approval = { state: 'approved', by: values.by, at: new Date().toISOString() };
  artifact.integrity.contentHash = computeContentHash(artifact);
  writeFileSync(file, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`approved by ${values.by}; integrity.contentHash = ${artifact.integrity.contentHash}`);
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
      // Human-in-the-loop: escalations pause the run, print the intervention
      // to this terminal, and hand you the live browser window. Forces --headed.
      hitl: { type: 'boolean', default: false },
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

  if (values.hitl && !values.headed) {
    console.error('[hitl] forcing --headed: the human operator needs to see the live session');
  }
  const result = await replayCapability(resolved, {
    policy: loadPolicy(values.policy!),
    paramValues,
    verified,
    allowDraft: values['allow-draft']!,
    headed: values.headed! || values.hitl!,
    evidenceBaseDir: values['evidence-dir']!,
    ...(values.hitl ? { operator: new TerminalOperator() } : {}),
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
