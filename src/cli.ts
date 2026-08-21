#!/usr/bin/env tsx
/**
 * cu — the command-line entrypoint.
 *
 *   cu discover --goal "..." --param k=v ...        LLM-driven discovery → compiled draft artifact
 *   cu replay --capability <file> --param k=v ...   deterministic replay (no LLM)
 *   cu approve <file> --by "name"                   mark a reviewed artifact approved (re-hashes)
 *   cu recompile <file> --trace <dir>               re-derive an artifact from its recorded trace
 *   cu validate <file...>                           schema + integrity check (all files)
 *   cu hash <file>                                  (re)compute integrity.contentHash
 *
 * Exit codes for `replay`: 0 = success OR a named business outcome (both are
 * legitimate results a caller handles), 2 = failed, 3 = escalated.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findByName, loadCatalog } from './catalog/catalog.js';
import { runDiscovery } from './discovery/agent.js';
import { compileTrace, genericCallerParamDescription } from './discovery/compile.js';
import type { OutputHint } from './discovery/compile.js';
import type { DiscoveryTrace } from './discovery/recorder.js';
import { newRunId } from './evidence/runLog.js';
import { RecordingOperator } from './hitl/recordingOperator.js';
import { TerminalOperator } from './hitl/terminalOperator.js';
import { loadPolicy } from './policy/policy.js';
import { applyProfile, envOverridesForRole, loadProfile, policyPathFor, resolvedRoleName } from './profile/appProfile.js';
import { replayCapability } from './replay/engine.js';
import { buildStabilityReport } from './replay/stability.js';
import type { ReplayResult } from './schema/result.js';
import { CapabilityArtifactSchema, ParamSpecSchema, computeContentHash, loadCapability } from './schema/capability.js';
import type { ParamSpec, Sensitivity } from './schema/capability.js';
import { applyOverlay, loadOverlay } from './schema/overlay.js';
import type { ResolvedCapability } from './schema/overlay.js';

/** What the redactor leaves behind: `***`, `***<2 chars>`, or `«secret:name»`. */
const MASKED = /\*\*\*|«secret:/;

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
  case 'recompile':
    recompileCmd(rest);
    break;
  case 'validate':
    validateCmd(rest);
    break;
  case 'hash':
    hashCmd(rest);
    break;
  default:
    console.error('usage: cu <discover|replay|catalog|approve|recompile|validate|hash> ...');
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
    // stdout stays the machine-readable tool list (an unloadable artifact is
    // not callable, so it is not in it); the files that refused to load go to
    // stderr, so a broken recording is impossible to miss without corrupting
    // the JSON a caller is piping.
    const { entries, broken } = loadCatalog(values.dir!);
    console.log(JSON.stringify(entries, null, 2));
    for (const b of broken) console.error(`WARNING: '${b.file}' did not load and is not callable: ${b.error}`);
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
      'base-url': { type: 'string' },
      policy: { type: 'string' },
      // Target application profile: supplies base URL, policy and the
      // operator roles a discovery run signs on with.
      app: { type: 'string' },
      role: { type: 'string' },
      headed: { type: 'boolean', default: false },
      // Human-in-the-loop for DISCOVERY: irreversible clicks pause the
      // recording and hand you the live browser for approval — this is what
      // lets a risky flow be discovered instead of hand-authored. Forces --headed.
      hitl: { type: 'boolean', default: false },
      // Pre-authorise the posting steps of a RECORDING session (see
      // RecordingOperator). Requires a name, which is stamped onto every
      // approval in the evidence and the compile report.
      'authorise-recording-as': { type: 'string' },
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
    // Shape inferred from the recorded value, and only where the shape is
    // unambiguous. This is the only input validation a compiled capability
    // gets, so leaving an AMOUNT untyped means "typed args in" buys nothing on
    // the one field of a money transfer where it matters most. Inference is
    // deliberately narrow — a value that is not clearly one of these stays a
    // free string rather than acquiring a pattern that later rejects a
    // legitimate input.
    const shape = /^\d+$/.test(value!)
      ? { type: 'integer' as const, pattern: '^[0-9]+$' }
      : /^\$?\d[\d,]*\.\d{2}$/.test(value!)
        ? { type: 'money' as const, pattern: '^\\$?[0-9][0-9,]*\\.[0-9]{2}$' }
        : { type: 'string' as const };
    paramSpecs[name!] = ParamSpecSchema.parse({
      ...shape,
      // A placeholder on purpose. The compiler recognises this exact string and
      // replaces it with the on-screen label of the field the param was
      // actually typed into (plus a choose's offered options) — which is
      // knowledge only the recording has, so it cannot be written here.
      description: genericCallerParamDescription(name!),
      sensitivity: (sensitivity as Sensitivity | undefined) ?? 'none',
      source: 'caller',
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

  const discoveryProfile = values.app ? loadProfile(values.app) : undefined;
  const discoveryBaseUrl = values['base-url'] ?? discoveryProfile?.baseUrl ?? 'http://localhost:4173';
  const discoveryPolicy =
    values.policy ??
    (values.app && discoveryProfile ? policyPathFor(values.app, discoveryProfile) : 'policies/default.policy.json');

  console.error(`[discover] goal: ${values.goal}`);
  console.error(`[discover] model turns cap: ${values['max-turns']} — this performs a REAL LLM run`);
  if (values.hitl && !process.stdin.isTTY) {
    // A non-interactive --hitl discovery would auto-abort every escalation
    // on EOF while burning real model turns — fail before spending anything.
    console.error('discover --hitl requires an interactive terminal (stdin is not a TTY)');
    process.exit(64);
  }
  if (values.hitl && !values.headed) {
    console.error('[hitl] forcing --headed: the human operator needs to see the live session');
  }
  const result = await runDiscovery({
    goal: values.goal,
    paramSpecs,
    paramValues,
    outputHints,
    policy: loadPolicy(discoveryPolicy),
    baseUrl: discoveryBaseUrl,
    headed: values.headed! || values.hitl!,
    ...(discoveryProfile !== undefined
      ? {
          app: { appId: discoveryProfile.appId, vendor: discoveryProfile.vendor },
          envOverrides: envOverridesForRole(discoveryProfile, values.role),
          profile: discoveryProfile,
          // Only a non-default role is worth recording as a REQUIREMENT: the
          // default is what any caller gets anyway.
          ...(values.role !== undefined && values.role !== discoveryProfile.credentials?.defaultRole
            ? { requiresRole: values.role }
            : {}),
        }
      : {}),
    maxTurns: Number(values['max-turns']),
    evidenceBaseDir: values['evidence-dir']!,
    saveDir: values['save-dir']!,
    artifactVersion: values['artifact-version']!,
    ...(values.model ? { model: values.model } : {}),
    ...(values.hitl
      ? { operator: new TerminalOperator() }
      : values['authorise-recording-as']
        ? { operator: new RecordingOperator(values['authorise-recording-as']) }
        : {}),
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
      // Defaults are resolved below, because an --app profile supplies both.
      'base-url': { type: 'string' },
      policy: { type: 'string' },
      // The target application's profile: base URL, policy, operator roles,
      // app-level runtime handling, and data classification.
      app: { type: 'string' },
      // Which operator role to sign on as (profile-defined, e.g. supervisor).
      role: { type: 'string' },
      // Harness: force one of the app's documented faults, optionally on a
      // specific step — `--inject maintenance@s7`.
      inject: { type: 'string' },
      tenant: { type: 'string' },
      headed: { type: 'boolean', default: false },
      // Demo aid: throttle driver actions by N ms (Playwright slowMo) so a
      // --headed replay is watchable by an audience. Not a production flag.
      'slow-mo': { type: 'string' },
      // Human-in-the-loop: escalations pause the run, print the intervention
      // to this terminal, and hand you the live browser window. Forces --headed.
      hitl: { type: 'boolean', default: false },
      'allow-draft': { type: 'boolean', default: false },
      'evidence-dir': { type: 'string', default: 'evidence' },
      // Multi-run stability (stretch): replay N times and aggregate a
      // flakiness report — status flapping, output consistency, and the
      // per-step strategy-rank distribution (the drift signal, summed).
      times: { type: 'string', default: '1' },
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
  const times = Number(values.times);
  if (!Number.isInteger(times) || times < 1) {
    console.error(`--times expects a positive integer, got '${values.times}'`);
    process.exit(64);
  }
  const slowMoMs = values['slow-mo'] !== undefined ? Number(values['slow-mo']) : undefined;
  if (slowMoMs !== undefined && (!Number.isInteger(slowMoMs) || slowMoMs < 0)) {
    console.error(`--slow-mo expects a non-negative integer (milliseconds), got '${values['slow-mo']}'`);
    process.exit(64);
  }
  if (times > 1 && values.hitl) {
    console.error('--times cannot combine with --hitl: an interactive handoff is not a repeatable measurement');
    process.exit(64);
  }

  const profile = values.app ? loadProfile(values.app) : undefined;
  const baseUrl = values['base-url'] ?? profile?.baseUrl ?? 'http://localhost:4173';
  const policyFile =
    values.policy ?? (values.app && profile ? policyPathFor(values.app, profile) : 'policies/default.policy.json');

  const loaded = loadCapability(values.capability);
  const verified = loaded.verified;
  // The profile merges app-level runtime handling BEFORE the tenant overlay:
  // "what this product does" first, then "what this institution's instance
  // does". Both are additive and both announce what they contributed.
  let artifact = loaded.artifact;
  if (profile) {
    const merged = applyProfile(artifact, profile);
    artifact = merged.artifact;
    if (merged.addedRecoveries.length > 0 || merged.addedAnomalies.length > 0) {
      console.error(
        `[profile] ${profile.appId}: +recoveries ${merged.addedRecoveries.join(',') || '—'} +anomalies ${merged.addedAnomalies.join(',') || '—'}`,
      );
    }
  }
  let resolved: ResolvedCapability;
  if (values.tenant) {
    resolved = applyOverlay(artifact, loadOverlay(values.tenant));
    resolved.bindings['baseUrl'] ??= baseUrl;
  } else {
    resolved = { artifact, bindings: { baseUrl } };
  }

  let injectPlan: { kind: string; atStepId?: string } | undefined;
  if (values.inject) {
    const [kind, atStepId] = values.inject.split('@');
    if (!kind) {
      console.error(`--inject expects <kind>[@stepId], got '${values.inject}'`);
      process.exit(64);
    }
    injectPlan = { kind, ...(atStepId ? { atStepId } : {}) };
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
    if (times > 1 && mode === 'once') {
      console.error(
        `[harness] note: '${fault}:once' is consumed by the first of ${times} runs — later runs see a clean app, so a status flap here measures the harness, not the capability`,
      );
    }
  }

  if (values.hitl && !values.headed) {
    console.error('[hitl] forcing --headed: the human operator needs to see the live session');
  }
  const runOpts = {
    policy: loadPolicy(policyFile),
    paramValues,
    verified,
    allowDraft: values['allow-draft']!,
    headed: values.headed! || values.hitl!,
    evidenceBaseDir: values['evidence-dir']!,
    ...(slowMoMs !== undefined && slowMoMs > 0 ? { slowMoMs } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(injectPlan !== undefined ? { inject: injectPlan } : {}),
    ...(profile !== undefined ? { envOverrides: envOverridesForRole(profile, values.role) } : {}),
    // The RESOLVED role, not the flag: a run that took the profile's default
    // must not log as null, or "which runs used supervisor authority" has no
    // answer for exactly the runs an auditor cares about.
    ...(() => {
      const role = profile !== undefined ? resolvedRoleName(profile, values.role) : undefined;
      return role !== undefined ? { role } : {};
    })(),
    ...(values.hitl ? { operator: new TerminalOperator() } : {}),
  };

  if (times > 1) {
    // Stability mode: N independent replays, one aggregated report. The
    // report itself carries no output values (statuses, timings, strategy
    // ranks only), so it needs no redaction pass.
    const results: ReplayResult[] = [];
    for (let i = 1; i <= times; i++) {
      const r = await replayCapability(resolved, runOpts);
      console.error(`[${i}/${times}] ${r.status}${r.status === 'failed' ? ` (${r.failure.class})` : ''} — run ${r.runId}`);
      results.push(r);
    }
    const report = buildStabilityReport(results);
    const reportFile = path.join(values['evidence-dir']!, 'replay', `stability-${newRunId()}.json`);
    writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.error(`\n[${report.verdict.toUpperCase()}] ${report.capabilityId}@${report.version} over ${report.runs} runs`);
    for (const reason of report.reasons) console.error(`  - ${reason}`);
    console.error(`  report: ${reportFile}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(results.some((r) => r.status === 'failed') ? 2 : results.some((r) => r.status === 'escalated') ? 3 : 0);
  }

  const result = await replayCapability(resolved, runOpts);

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

/**
 * Re-derive a shipped artifact from the discovery trace that produced it.
 *
 * A compiler improvement is worthless if the artifacts already in the repo
 * still carry the old compiler's mistakes, and hand-patching them would throw
 * away the one property that makes an artifact trustworthy — that deterministic
 * code, not a person, wrote it from a recorded run.
 *
 * Every input `compileTrace` needs is recoverable from the artifact itself:
 * the param specs are its own contract, each caller param's recorded value is
 * its `example`, and the output hints are its declared sensitivities. So this
 * is a genuine re-derivation, and running it against an UNCHANGED compiler
 * reproduces the artifact byte-for-byte — which is what makes the diff it
 * prints meaningful.
 *
 * The recompiled artifact comes back as a DRAFT. A machine may re-derive a
 * capability; only a person may approve one.
 */
function recompileCmd(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      trace: { type: 'string' },
      'base-url': { type: 'string' },
      app: { type: 'string' },
      param: { type: 'string', multiple: true },
      write: { type: 'boolean' },
    },
  });
  const file = positionals[0];
  if (!file || !values.trace) {
    console.error(
      'usage: cu recompile <artifact.json> --trace <discovery-run-dir> [--app <profile>|--base-url <url>] [--param k=v] [--write]',
    );
    process.exit(64);
  }
  const supplied: Record<string, string> = {};
  for (const spec of values.param ?? []) {
    const eq = spec.indexOf('=');
    if (eq < 1) {
      console.error(`--param expects name=value, got '${spec}'`);
      process.exit(64);
    }
    supplied[spec.slice(0, eq)] = spec.slice(eq + 1);
  }
  const before = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  // The profile is a compiler INPUT, not just a source of the base URL: it
  // names the app's transaction-token field, and a re-derivation run without it
  // would drop the token assertions and report them as a compiler difference
  // that is really a missing flag.
  const recompileProfile = values.app ? loadProfile(values.app) : undefined;
  const baseUrl = values['base-url'] ?? recompileProfile?.baseUrl;
  if (!baseUrl) {
    console.error('recompile needs the base URL the run was recorded against: pass --app <profile> or --base-url <url>');
    process.exit(64);
  }
  const trace = JSON.parse(readFileSync(path.join(values.trace, 'trace.json'), 'utf8')) as DiscoveryTrace;

  const callerParamValues: Record<string, string> = {};
  for (const [name, spec] of Object.entries(before.params)) {
    if (spec.source !== 'caller') continue;
    // An explicitly supplied value wins: it is the escape hatch for a param
    // the artifact cannot recover on its own (see the masked-example guard).
    if (supplied[name] !== undefined) {
      callerParamValues[name] = supplied[name];
      continue;
    }
    if (spec.example === undefined) {
      console.error(`param '${name}' is caller-sourced but records no example, so its recorded value cannot be recovered`);
      process.exit(65);
    }
    // A masked example is not a recoverable value, and feeding one back in is
    // actively wrong rather than merely lossy: `***om` is a two-character
    // suffix that a DIFFERENT on-screen value masks to just as readily, so the
    // compiler would bind the param to text that is not the param. Recompiling
    // a capability whose recorded values were classified regulated data needs
    // a fresh recording, not a reconstruction.
    if (MASKED.test(spec.example)) {
      console.error(
        `param '${name}' records only a redacted example ('${spec.example}') — pass the recorded value explicitly with --param ${name}=<value>, or re-record the capability`,
      );
      process.exit(65);
    }
    callerParamValues[name] = spec.example;
  }
  const outputHints: Record<string, OutputHint> = {};
  for (const [name, spec] of Object.entries(before.outputs)) {
    // 'table' is structural, never a hint — see the output block in compile.ts.
    outputHints[name] = {
      ...(spec.type === 'table' ? {} : { type: spec.type }),
      sensitivity: spec.sensitivity,
    };
  }

  const { artifact, report } = compileTrace({
    trace,
    // The role the flow was recorded as is a fact about the RECORDING, and the
    // trace does not carry it — so recompiling must preserve what the artifact
    // already knows, or a supervisor-only capability silently loses the one
    // declaration that says so.
    ...(before.policy.requiresRole !== undefined ? { requiresRole: before.policy.requiresRole } : {}),
    paramSpecs: before.params,
    callerParamValues,
    outputHints,
    baseUrl,
    model: before.provenance.recordedBy.model ?? 'unknown',
    discoveryRunId: before.provenance.recordedBy.discoveryRunId ?? path.basename(values.trace),
    app: before.capability.app,
    version: before.capability.version,
    // The trace directory is `<evidenceBaseDir>/discovery/<runId>`, so the
    // base the artifact should point back at is two levels up from it.
    evidenceBaseDir: path.dirname(path.dirname(path.resolve(values.trace))).replace(`${process.cwd()}${path.sep}`, ''),
    ...(recompileProfile !== undefined ? { profile: recompileProfile } : {}),
  });
  // The recording happened once. Recompiling re-reads it; it does not re-do it.
  // `evidenceRef` is deliberately NOT carried over — recompiling is exactly
  // when a stale provenance pointer gets corrected.
  artifact.provenance.recordedAt = before.provenance.recordedAt;
  artifact.integrity.contentHash = computeContentHash(artifact);

  // The approval block is inside the hash — that is what makes approving a
  // re-hash — so a draft recompiled from an approved artifact always differs
  // by both, and neither is a compiler difference.
  const diffs = diffJson(before, artifact, '').filter(
    (d) => !d.startsWith('provenance.approval') && !d.startsWith('integrity.contentHash'),
  );
  if (diffs.length === 0) {
    console.log(
      `${before.capability.id}: recompiles identically (modulo the approval block and its hash) — the shipped artifact is exactly what this compiler produces from this trace.`,
    );
  } else {
    console.log(`${before.capability.id}: ${diffs.length} difference(s) from the shipped artifact`);
    for (const d of diffs) console.log(`  ${d}`);
  }
  for (const note of report.notes) console.log(`  note: ${note}`);

  if (!values.write) {
    console.log('(dry run — pass --write to replace the artifact, which resets it to draft for re-approval)');
    return;
  }
  writeFileSync(file, JSON.stringify(artifact, null, 2) + '\n');
  console.log(`wrote ${file} as a DRAFT — review the diff above, then \`cu approve\` it.`);
}

/** Leaf-wise structural diff, so a recompile reports exactly what moved. */
function diffJson(a: unknown, b: unknown, at: string): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, i) => diffJson(a[i], b[i], `${at}[${i}]`)).flat();
  }
  if (isObj(a) && isObj(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) =>
      diffJson(a[k], b[k], at ? `${at}.${k}` : k),
    );
  }
  // Window the two values around the point where they actually diverge. A
  // fixed head-truncation prints two identical-looking strings whenever the
  // difference falls past the cut — which is exactly what happens on a long
  // prose field, the most common thing to differ in a recompile. A diff that
  // shows no difference reads as a bug in the tool.
  const sa = JSON.stringify(a) ?? 'undefined';
  const sb = JSON.stringify(b) ?? 'undefined';
  let i = 0;
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  const from = Math.max(0, i - 24);
  const show = (s: string): string => {
    const head = from > 0 ? '…' : '';
    const body = s.slice(from, from + 96);
    return `${head}${body}${from + 96 < s.length ? '…' : ''}`;
  };
  return [`${at}: ${show(sa)} → ${show(sb)}`];
}

function validateCmd(argv: string[]): void {
  // Every argument is checked, not just the first: `cu validate capabilities-meridian/*.json`
  // is the documented way to check a whole directory, and a validator that silently examines
  // one file out of seven and exits 0 is worse than no validator at all.
  const files = argv.filter((a) => !a.startsWith('-'));
  if (files.length === 0) {
    console.error('usage: cu validate <artifact.json> [artifact.json ...]');
    process.exit(64);
  }
  let failed = 0;
  for (const file of files) {
    // One bad artifact must not hide the ones after it, so a load failure is reported
    // against its own file and the sweep continues.
    try {
      const { artifact, verified } = loadCapability(file);
      const id = `${artifact.capability.id}@${artifact.capability.version}`;
      console.log(`${verified ? 'OK      ' : 'MISMATCH'}  ${id}  (${file})`);
      if (!verified) failed++;
    } catch (err) {
      console.log(`INVALID   ${file}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      failed++;
    }
  }
  console.log(
    failed === 0
      ? `\n${files.length} artifact${files.length === 1 ? '' : 's'}: schema and integrity OK`
      : `\n${failed} of ${files.length} failed — run \`cu hash\` after deliberate edits`,
  );
  process.exit(failed === 0 ? 0 : 1);
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
