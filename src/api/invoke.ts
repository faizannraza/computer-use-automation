/**
 * Invoking a capability by name — the single path every caller (HTTP, chatbot,
 * dashboard) goes through.
 *
 * There is deliberately no "fast path" here. An invocation resolves the same
 * artifact, applies the same profile and overlay, and calls the same
 * `replayCapability` the CLI does, so the ActionGate, the policy, redaction,
 * and the escalation path apply identically. The wrapper must not become a way
 * around the guardrails, so it is not allowed to do anything the engine cannot.
 */
import path from 'node:path';
import { loadCatalog } from '../catalog/catalog.js';
import type { CatalogEntry } from '../catalog/catalog.js';
import { loadPolicy } from '../policy/policy.js';
import type { Policy } from '../policy/policy.js';
import { Redactor } from '../policy/redact.js';
import { applyProfile, envOverridesForRole, loadProfile, policyPathFor } from '../profile/appProfile.js';
import type { AppProfile } from '../profile/appProfile.js';
import { replayCapability } from '../replay/engine.js';
import type { ReplayOptions } from '../replay/engine.js';
import { loadCapability } from '../schema/capability.js';
import type { CapabilityArtifact } from '../schema/capability.js';
import type { ReplayResult } from '../schema/result.js';
import { newRunId } from '../evidence/runLog.js';
import { HttpOperator } from './httpOperator.js';
import type { RunStore } from './runStore.js';

export interface InvokeOptions {
  role?: string;
  headed?: boolean;
  slowMoMs?: number;
  inject?: { kind: string; atStepId?: string };
}

export interface InvokeRequest {
  name: string;
  params: Record<string, string>;
  options?: InvokeOptions;
}

export interface ApiContext {
  profileFile: string;
  profile: AppProfile;
  policy: Policy;
  capabilitiesDir: string;
  evidenceBaseDir: string;
  store: RunStore;
  interventionTimeoutMs: number;
  /** Concurrency cap: each run drives its own browser, so this is a real
   * resource bound rather than a throughput knob. */
  maxConcurrentRuns: number;
  /**
   * Presentation pacing for runs this server drives, when the caller did not
   * ask for its own. It exists because a run started from the CHATBOT has no
   * way to ask: the planner deliberately chooses capabilities and parameters
   * and nothing else, so "show me this one slowly" cannot be its decision.
   * This is the operator's decision, taken once when the server starts.
   *
   * Unset in production, where a replay should run headless at full speed.
   */
  demoPacing?: { headed?: boolean; slowMoMs?: number };
}

export function loadContext(opts: {
  profileFile: string;
  capabilitiesDir: string;
  evidenceBaseDir: string;
  store: RunStore;
  policyFile?: string;
  interventionTimeoutMs?: number;
  maxConcurrentRuns?: number;
  demoPacing?: { headed?: boolean; slowMoMs?: number };
}): ApiContext {
  const profile = loadProfile(opts.profileFile);
  const policy = loadPolicy(opts.policyFile ?? policyPathFor(opts.profileFile, profile));
  return {
    profileFile: opts.profileFile,
    profile,
    policy,
    capabilitiesDir: opts.capabilitiesDir,
    evidenceBaseDir: opts.evidenceBaseDir,
    store: opts.store,
    interventionTimeoutMs: opts.interventionTimeoutMs ?? 180_000,
    maxConcurrentRuns: opts.maxConcurrentRuns ?? 2,
    ...(opts.demoPacing !== undefined ? { demoPacing: opts.demoPacing } : {}),
  };
}

export class InvocationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolve a catalog name to the entry an invocation will run.
 *
 * Three outcomes, all of them 4xx, because none of them is a server fault:
 * the capability is callable, the name is unknown (404), or the file exists
 * and does not load (422). The third used to be indistinguishable from the
 * second — the catalog threw on the first bad artifact, so a broken file took
 * every name down with it — and "not found" is the wrong thing to tell a
 * caller about a recording that is sitting right there with a schema error.
 */
export function entryFor(ctx: ApiContext, name: string): CatalogEntry {
  const { entries, broken } = loadCatalog(ctx.capabilitiesDir);
  const entry = entries.find((e) => e.name === name);
  if (entry) return entry;
  const bad = broken.find((b) => b.name === name);
  if (bad) {
    throw new InvocationError(
      422,
      `capability '${name}' is recorded in '${bad.file}' but that artifact does not load: ${bad.error}`,
    );
  }
  throw new InvocationError(404, `no capability named '${name}' in ${ctx.capabilitiesDir}/`);
}

/**
 * The artifact AS IT WILL EXECUTE: the recorded flow with this deployment's app
 * profile merged in. Anything deciding how an invocation behaves has to ask
 * this rather than the raw file, because the profile contributes outcomes,
 * recoveries and anomalies that the recording never declared.
 */
export function mergedArtifactFor(ctx: ApiContext, name: string): CapabilityArtifact {
  return applyProfile(artifactFor(ctx, name), ctx.profile).artifact;
}

/**
 * Can this invocation stop and wait for a person?
 *
 * Two independent ways it can, and the caller must be told about both:
 *  - an irreversible step, which the policy escalates before it posts; and
 *  - ANY recovery whose handler is `escalate` — which after a profile merge is
 *    typically every capability in the deployment, since an app-level recovery
 *    like MERIDIAN's SUPERVISOR_OVERRIDE_REQUIRED is merged into all of them.
 *
 * Keying the forced-async rule on `maxRisk === 'irreversible'` alone therefore
 * missed the common case: a read-only lookup that trips a 403 escalates, and a
 * synchronous dispatch then holds the HTTP request open for the full
 * intervention timeout (180s) — precisely the failure the rule exists to
 * prevent. Pass the MERGED artifact; the raw one has not seen the profile.
 */
export function pausesForHuman(artifact: CapabilityArtifact): boolean {
  return artifact.policy.maxRisk === 'irreversible' || escalatingRecoveries(artifact).length > 0;
}

/** Codes whose recovery hands the run to a person — named so the 202 can say
 *  WHY it refused to answer synchronously. */
export function escalatingRecoveries(artifact: CapabilityArtifact): string[] {
  return artifact.recoveries.filter((r) => r.handler.kind === 'escalate').map((r) => r.code);
}

let active = 0;

/**
 * Which operator role each run was invoked as.
 *
 * `RunSummary` is reconstructed from evidence on disk, and the role is not in
 * the artifact — it is a property of the INVOCATION. Recording it here is what
 * lets `/api/runs` answer "who ran this", which is the field an auditor asks
 * for first and which nothing recorded before. Bounded so a long-lived server
 * does not accumulate one entry per run forever; the authoritative copy is the
 * run's own evidence (see the engine dependency noted at the call site).
 */
const invocationRoles = new Map<string, string>();
const MAX_TRACKED_ROLES = 1000;

/** The operator role a run was invoked as, if this process started it. */
export function roleForRun(runId: string): string | undefined {
  return invocationRoles.get(runId);
}

function recordRole(runId: string, role: string): void {
  invocationRoles.set(runId, role);
  while (invocationRoles.size > MAX_TRACKED_ROLES) {
    const oldest = invocationRoles.keys().next();
    if (oldest.done === true) break;
    invocationRoles.delete(oldest.value);
  }
}

export interface StartedInvocation {
  runId: string;
  /** Resolves when the run reaches a terminal state. */
  done: Promise<ReplayResult>;
}

/**
 * Start a run and return immediately with its id, so a caller can subscribe to
 * the live stream before the first event fires — and so a run that pauses for
 * a human approval is not riding on a held-open HTTP request.
 */
export function startInvocation(ctx: ApiContext, req: InvokeRequest): StartedInvocation {
  const entry = entryFor(ctx, req.name);
  const { artifact, verified } = loadCapability(entry.artifactFile);
  const merged = applyProfile(artifact, ctx.profile);
  const runId = newRunId();

  if (active >= ctx.maxConcurrentRuns) {
    throw new InvocationError(429, `already driving ${active} browser session(s); retry shortly`);
  }

  // Unknown params are refused rather than ignored: silently dropping one
  // would run a different invocation than the caller asked for.
  const declared = new Set(Object.keys(merged.artifact.params));
  const unknown = Object.keys(req.params).filter((p) => !declared.has(p));
  if (unknown.length > 0) {
    throw new InvocationError(400, `unknown param(s): ${unknown.join(', ')}. Declared: ${[...declared].join(', ')}`);
  }

  // The authority a capability may run with is the authority it was RECORDED
  // with — `requiresRole` when it declares one, the profile's default when it
  // does not. Both directions matter and only one of them is obvious:
  //
  //   under-privileged  a teller invoking a supervisor-only hold. Loud: the app
  //                     refuses it anyway, and that refusal is the real
  //                     authorization boundary.
  //   over-privileged   a routine teller capability invoked with `role:
  //                     supervisor`. SILENT: it works, it posts, and the only
  //                     trace is whichever operator id happens to be logged.
  //
  // Checking `requiresRole !== undefined` only catches the loud one — and the
  // capabilities that move money (transfer, open share, update info) are
  // exactly the ones that declare no role, because the compiler only records
  // one when it differs from the default. So the guard has to compare against
  // the recorded authority, not against the presence of a declaration.
  //
  // This is the API boundary only, deliberately. The CLI still lets you run a
  // supervisor-gated capability as a teller, because watching the TARGET refuse
  // it — and the run escalate with context — is the more honest demonstration
  // of what actually protects the account.
  // An UNKNOWN role is a different answer from a FORBIDDEN one, so it is
  // checked first: "that role does not exist here" is a 400 the caller fixes by
  // spelling it correctly, not a 403 they might read as an authorization
  // decision about a role they legitimately hold.
  const askedRole = req.options?.role;
  if (askedRole !== undefined && ctx.profile.credentials?.roles[askedRole] === undefined) {
    const known = Object.keys(ctx.profile.credentials?.roles ?? {});
    throw new InvocationError(
      400,
      `profile '${ctx.profile.appId}' has no operator role '${askedRole}'${known.length > 0 ? ` (roles: ${known.join(', ')})` : ''}`,
    );
  }
  const recordedRole = merged.artifact.policy.requiresRole ?? ctx.profile.credentials?.defaultRole;
  const resolvedRole = req.options?.role ?? ctx.profile.credentials?.defaultRole;
  if (recordedRole !== undefined && resolvedRole !== recordedRole) {
    const declared = merged.artifact.policy.requiresRole !== undefined;
    throw new InvocationError(
      403,
      `capability '${req.name}' ${declared ? `declares requiresRole '${recordedRole}'` : `was recorded as role '${recordedRole}'`}; ` +
        `this invocation resolves to role '${resolvedRole ?? '(none)'}' — ` +
        (declared
          ? `invoke it with options.role '${recordedRole}'`
          : `omit options.role, or re-record the capability as '${resolvedRole ?? '(none)'}' if it genuinely needs that authority`),
    );
  }

  let envOverrides: Record<string, string>;
  try {
    envOverrides = envOverridesForRole(ctx.profile, req.options?.role);
  } catch (err) {
    throw new InvocationError(400, err instanceof Error ? err.message : String(err));
  }

  ctx.store.start(runId, 'replay', merged.artifact.capability.id, merged.artifact.capability.version);
  if (resolvedRole !== undefined) recordRole(runId, resolvedRole);
  active += 1;

  // The redaction boundary for anything this invocation exposes OUTSIDE the
  // evidence log — today that is the open-intervention listing, which carries
  // a summary of the target screen. Seeded here with the declared params by
  // sensitivity, exactly as the engine seeds its own.
  //
  // This instance is passed to the engine (`opts.redactor`) and the engine
  // adopts it (`const redactor = opts.redactor ?? new Redactor()`), so ONE
  // redactor covers the whole run: the values `classifyObservation` registers
  // off the screen at run time — member names, balances the flow never
  // declared — are masked on the operator's intervention listing too, not just
  // in the evidence files. What it still does NOT cover: a value that appears
  // on screen and matches no classified label, column or declared param is
  // unknown to the redactor by construction, here as everywhere else.
  const redactor = new Redactor();
  for (const [name, spec] of Object.entries(merged.artifact.params)) {
    const raw = spec.source === 'env' ? (envOverrides[spec.env ?? ''] ?? process.env[spec.env ?? '']) : req.params[name];
    if (raw !== undefined && raw !== '') redactor.register(name, raw, spec.sensitivity);
  }

  const operator = new HttpOperator(runId, { timeoutMs: ctx.interventionTimeoutMs, redactor });
  const headed = req.options?.headed ?? ctx.demoPacing?.headed;
  const slowMoMs = req.options?.slowMoMs ?? ctx.demoPacing?.slowMoMs;
  const replayOptions: ReplayOptions & { redactor?: Redactor } = {
    policy: ctx.policy,
    paramValues: req.params,
    verified,
    runId,
    evidenceBaseDir: ctx.evidenceBaseDir,
    profile: ctx.profile,
    envOverrides,
    operator,
    redactor,
    onEvent: (line) => ctx.store.publish(runId, line),
    // Request wins, server pacing is the fallback. `??` and not `||`, so an
    // explicit `headed: false` or `slowMoMs: 0` still means what it says
    // instead of falling through to the demo default.
    ...(headed !== undefined ? { headed } : {}),
    ...(slowMoMs !== undefined ? { slowMoMs } : {}),
    ...(req.options?.inject !== undefined ? { inject: req.options.inject } : {}),
    // The DURABLE copy of "which authority did this run use". The in-process
    // map above only answers for runs this process started and only while it
    // lives; the engine writes this into run.jsonl and result.json, which is
    // where an auditor would actually look.
    ...(resolvedRole !== undefined ? { role: resolvedRole } : {}),
  };
  const done = replayCapability({ artifact: merged.artifact, bindings: { baseUrl: ctx.profile.baseUrl } }, replayOptions)
    .then((result) => {
      ctx.store.finish(runId, result);
      return result;
    })
    .catch((err: unknown) => {
      ctx.store.fail(runId, err instanceof Error ? err.message : String(err));
      throw err;
    })
    .finally(() => {
      active -= 1;
    });

  return { runId, done };
}

/**
 * Outputs as a caller wants them: declared `table` outputs are carried as JSON
 * strings internally (one redaction boundary covers them) and parsed back into
 * structure here, at the contract edge.
 */
export function shapeOutputs(artifact: CapabilityArtifact, outputs: Record<string, string>): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(outputs)) {
    if (artifact.outputs[name]?.type === 'table') {
      try {
        shaped[name] = JSON.parse(value);
        continue;
      } catch {
        /* fall through to the raw string rather than dropping the value */
      }
    }
    shaped[name] = value;
  }
  return shaped;
}

export function artifactFor(ctx: ApiContext, name: string): CapabilityArtifact {
  const entry = entryFor(ctx, name);
  return loadCapability(entry.artifactFile).artifact;
}

/** Evidence file path for a run, guarded against traversal outside the run. */
export function evidencePath(ctx: ApiContext, kind: string, runId: string, rel: string): string {
  // `kind` and `runId` are URL path segments, and they build the ROOT that the
  // containment check below is measured against — a `..` in either MOVES the
  // root, so checking only `rel` confines the read to a directory the caller
  // chose (`/api/runs/../././evidence/.env` served the process's own secrets).
  // Both are therefore pinned to what a run can actually be called.
  if (kind !== 'discovery' && kind !== 'replay') throw new InvocationError(400, `unknown run kind '${kind}'`);
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(runId) || runId.includes('..')) {
    throw new InvocationError(400, `invalid run id '${runId}'`);
  }
  const root = path.resolve(ctx.evidenceBaseDir, kind, runId);
  const target = path.resolve(root, rel);
  // The run directory itself is inside the run: `rel === '.'` is how the
  // evidence LISTING asks for it, and rejecting it 400'd every listing.
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new InvocationError(400, 'path outside the run directory');
  }
  return target;
}
