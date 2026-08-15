/**
 * The deterministic replay engine — the production execution path. It
 * interprets a capability artifact with NO model in the loop: locator
 * ladders resolve targets, conditions are polled, and every observed state
 * is classified in a strict priority order:
 *
 *   postcondition satisfied            → step ok, continue
 *   > expected business outcome        → return business_outcome (a result!)
 *   > known recoverable condition      → run its handler, bounded, re-enter
 *   > declared anomaly / unknown dialog→ hard failure, fast
 *   > timeout                          → POSTCONDITION_TIMEOUT with expected/observed
 *
 * The ordering is itself a design claim: outcomes outrank recoveries outrank
 * anomalies, so a "record not found" page that is also slow is reported as
 * the business outcome — never retried into confusion.
 */
import type { Observation, RiskClass, SemanticAction } from '../core/types.js';
import { applyTemplate, substituteDeep } from '../core/template.js';
import { RunLog } from '../evidence/runLog.js';
import { ActionGate, PolicyViolation } from '../policy/actionGate.js';
import type { Policy } from '../policy/policy.js';
import { Redactor, maskValue } from '../policy/redact.js';
import type { Binding, CapabilityArtifact, Step } from '../schema/capability.js';
import type { ResolvedCapability } from '../schema/overlay.js';
import type { RecoveryUse, ReplayFailure, ReplayResult, StepTrace } from '../schema/result.js';
import type { Surface } from '../surface/surface.js';
import { PlaywrightWebSurface } from '../surface/web/playwrightSurface.js';
import { evaluateAll, evaluateCondition, renderConditions, summarizeObservation } from './detectors.js';

export interface ReplayOptions {
  policy: Policy;
  paramValues: Record<string, string>;
  /** From loadCapability(): content-hash verification result. */
  verified?: boolean;
  allowUnverified?: boolean;
  allowDraft?: boolean;
  headed?: boolean;
  evidenceBaseDir?: string;
}

/** Internal control-flow: abort the run with a typed failure. */
class Halt extends Error {
  constructor(readonly failure: Omit<ReplayFailure, 'screenshotRef'>) {
    super(`${failure.class}: ${failure.expected}`);
  }
}

const MAX_RESTARTS = 2;

export async function replayCapability(resolved: ResolvedCapability, opts: ReplayOptions): Promise<ReplayResult> {
  const { artifact, bindings } = resolved;
  const startedAt = new Date().toISOString();
  const redactor = new Redactor();

  // ---- Resolve & validate params (before any browser exists). ----
  const params: Record<string, string> = {};
  const maskedParams: Record<string, string> = {};
  let paramError: string | undefined;
  for (const [name, spec] of Object.entries(artifact.params)) {
    const raw = spec.source === 'env' ? process.env[spec.env!] : opts.paramValues[name];
    if (raw === undefined || raw === '') {
      if (spec.required) {
        paramError = spec.source === 'env'
          ? `required param '${name}' resolves from env var ${spec.env}, which is not set`
          : `required param '${name}' was not supplied`;
        break;
      }
      continue;
    }
    if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(raw)) {
      paramError = `param '${name}' does not match ${spec.pattern}`;
      break;
    }
    if (spec.type === 'enum' && spec.values !== undefined && !spec.values.includes(raw)) {
      paramError = `param '${name}' must be one of: ${spec.values.join(', ')}`;
      break;
    }
    params[name] = raw;
    maskedParams[name] = maskValue(name, raw, spec.sensitivity);
    redactor.register(name, raw, spec.sensitivity);
  }

  const log = new RunLog('replay', { baseDir: opts.evidenceBaseDir ?? 'evidence', redactor });
  const base = {
    capabilityId: artifact.capability.id,
    version: artifact.capability.version,
    runId: log.runId,
    evidenceDir: log.dir,
    startedAt,
  };
  const finish = (result: ReplayResult): ReplayResult => {
    log.event('run_result', { status: result.status, ...(result.status === 'failed' ? { failure: result.failure } : {}) });
    log.writeJson('result', result);
    return result;
  };
  const earlyFail = (failure: ReplayFailure): ReplayResult =>
    finish({ ...base, status: 'failed', failure, stepsRun: [], recoveriesUsed: [], finishedAt: new Date().toISOString() });

  log.event('run_start', {
    capability: `${artifact.capability.id}@${artifact.capability.version}`,
    tenant: resolved.tenantId ?? null,
    params: maskedParams,
  });

  if (paramError) {
    return earlyFail({ class: 'INVALID_PARAMS', expected: 'params matching the capability contract', observed: paramError });
  }

  // ---- Pre-flight guards: integrity, approval, policy fit. ----
  if (opts.verified === false && !opts.allowUnverified) {
    return earlyFail({
      class: 'POLICY_BLOCKED',
      expected: 'artifact content hash to match integrity.contentHash',
      observed: 'hash mismatch — the artifact was modified after it was hashed (re-hash after deliberate edits)',
    });
  }
  if (artifact.provenance.approval.state === 'draft' && !opts.allowDraft) {
    return earlyFail({
      class: 'POLICY_BLOCKED',
      expected: 'an approved artifact (or an explicit --allow-draft)',
      observed: 'artifact is in draft state — unattended replay of unreviewed automation is refused',
    });
  }
  const missingActions = artifact.policy.actionsUsed.filter((a) => !opts.policy.allowedActions.includes(a));
  if (missingActions.length > 0) {
    return earlyFail({
      class: 'POLICY_BLOCKED',
      expected: `policy to allow action kinds: ${artifact.policy.actionsUsed.join(', ')}`,
      observed: `policy forbids: ${missingActions.join(', ')}`,
    });
  }
  if (artifact.policy.maxRisk === 'irreversible' && opts.policy.irreversibleActionMode === 'block') {
    return earlyFail({
      class: 'POLICY_BLOCKED',
      expected: 'a policy permitting irreversible steps (confirm/escalate)',
      observed: "capability contains irreversible steps but policy mode is 'block'",
    });
  }

  const subst = { ...bindings, ...params };
  const surface = await PlaywrightWebSurface.launch({ headed: opts.headed ?? false });
  const gate = new ActionGate(opts.policy, surface, {
    onEvent: (e) =>
      log.event('gate', { kind: e.action.kind, decision: e.decision, location: e.location, risk: e.context.risk }),
  });

  try {
    return finish(await run(artifact, subst, surface, gate, log, redactor, opts, base));
  } catch (err) {
    const obs = surface.lastObservation();
    const failure: ReplayFailure =
      err instanceof Halt
        ? { ...err.failure, ...shotRef(log, 'failure', obs) }
        : err instanceof PolicyViolation
          ? {
              class: 'POLICY_BLOCKED',
              expected: 'action permitted by policy',
              observed: err.message,
              ...shotRef(log, 'failure', obs),
            }
          : {
              class: 'SURFACE_ERROR',
              expected: 'the surface driver to keep functioning',
              observed: err instanceof Error ? err.message : String(err),
              ...shotRef(log, 'failure', obs),
            };
    return finish({ ...base, status: 'failed', failure, stepsRun: [], recoveriesUsed: [], finishedAt: new Date().toISOString() });
  } finally {
    await surface.close();
  }
}

function shotRef(log: RunLog, name: string, obs: Observation | undefined): { screenshotRef?: string } {
  const ref = log.screenshot(name, obs?.screenshot);
  return ref !== undefined ? { screenshotRef: ref } : {};
}

// ---------------------------------------------------------------------------

async function run(
  artifact: CapabilityArtifact,
  subst: Record<string, string>,
  surface: Surface,
  gate: ActionGate,
  log: RunLog,
  redactor: Redactor,
  opts: ReplayOptions,
  base: { capabilityId: string; version: string; runId: string; evidenceDir: string; startedAt: string },
): Promise<ReplayResult> {
  let recoveryBudget = opts.policy.maxRecoveryAttemptsPerRun;
  let restarts = 0;
  const recoveryUse = new Map<string, number>();
  const recoveriesUsed = (): RecoveryUse[] =>
    [...recoveryUse.entries()].map(([code, attempts]) => ({ code, attempts }));

  /**
   * Scan the artifact's known recoverable conditions against the current
   * observation. Returns 'applied' (handler ran — re-classify), 'restart'
   * (run must restart from the entrypoint), or 'none'.
   */
  const tryRecoveries = async (
    obs: Observation,
    completedRisk: RiskClass[],
  ): Promise<'applied' | 'restart' | 'none'> => {
    for (const rec of artifact.recoveries) {
      const when = substituteDeep(rec.when, subst);
      if (!(await evaluateCondition(when, obs))) continue;
      const used = recoveryUse.get(rec.code) ?? 0;
      if (used >= rec.maxAttempts || recoveryBudget <= 0) {
        throw new Halt({
          class: 'RECOVERY_EXHAUSTED',
          expected: `recovery ${rec.code} to succeed within ${rec.maxAttempts} attempts (global budget ${opts.policy.maxRecoveryAttemptsPerRun})`,
          observed: `${rec.code} matched again after ${used} attempts; ${summarizeObservation(obs)}`,
        });
      }
      recoveryUse.set(rec.code, used + 1);
      recoveryBudget -= 1;
      log.event('recovery_applied', { code: rec.code, attempt: used + 1, handler: rec.handler.kind });
      switch (rec.handler.kind) {
        case 'dismiss': {
          const target = substituteDeep(rec.handler.target, subst);
          const res = await surface.resolve(target);
          if (!res.ok) {
            log.event('recovery_dismiss_unresolved', { code: rec.code, detail: res.detail });
            return 'none';
          }
          await gate.execute({ kind: 'activate', ref: res.ref }, { risk: 'reversible' });
          await surface.settle();
          return 'applied';
        }
        case 'answerDialog':
          await gate.execute({ kind: 'answerDialog', accept: rec.handler.accept }, { risk: 'reversible' });
          return 'applied';
        case 'restartRun': {
          if (completedRisk.includes('irreversible')) {
            throw new Halt({
              class: 'UNEXPECTED_STATE',
              expected: 'a restartable run (no irreversible step completed yet)',
              observed: `recovery ${rec.code} wants to restart, but an irreversible step already completed — refusing`,
            });
          }
          restarts += 1;
          if (restarts > MAX_RESTARTS) {
            throw new Halt({
              class: 'RECOVERY_EXHAUSTED',
              expected: `at most ${MAX_RESTARTS} run restarts`,
              observed: `recovery ${rec.code} asked for restart #${restarts}`,
            });
          }
          return 'restart';
        }
      }
    }
    return 'none';
  };

  // ---- Main loop. `restart` recoveries re-enter from the entrypoint. ----
  outer: while (true) {
    const outputs: Record<string, string> = {};
    const traces: StepTrace[] = [];
    const completedRisk: RiskClass[] = [];

    const entryUrl = applyTemplate(artifact.capability.entrypoint.value, subst);
    await gate.execute({ kind: 'navigate', url: entryUrl }, { risk: 'read' });
    await surface.settle();
    let obs = await surface.observe();
    log.screenshot('entrypoint', obs.screenshot);

    for (const rawStep of artifact.steps) {
      const step = substituteDeep(rawStep, subst) as Step;
      const t0 = Date.now();
      const trace: StepTrace = { stepId: step.id, intent: step.intent, status: 'failed', ms: 0 };
      log.event('step_start', { stepId: step.id, intent: step.intent, kind: step.action.kind, risk: step.risk });

      // 1. Precondition guard (with one recovery pass — e.g. a timeout page
      //    that landed between steps).
      obs = await surface.observe();
      if (!(await evaluateAll(step.pre, obs))) {
        const r = await tryRecoveries(obs, completedRisk);
        if (r === 'restart') continue outer;
        if (r === 'applied') obs = await surface.observe();
        if (!(await evaluateAll(step.pre, obs))) {
          throw new Halt({
            class: 'PRECONDITION_FAILED',
            stepId: step.id,
            expected: renderConditions(step.pre),
            observed: summarizeObservation(obs),
          });
        }
      }

      // 2. Resolve the target (with one recovery pass on not_found;
      //    ambiguity is a refusal, never retried into a guess).
      let readValue: string | undefined;
      if (step.action.kind === 'navigate') {
        await gate.execute({ kind: 'navigate', url: step.action.url }, { risk: step.risk });
      } else if (step.action.kind !== 'assert') {
        let res = await surface.resolve(step.action.target);
        if (!res.ok && res.reason === 'not_found') {
          const r = await tryRecoveries(obs, completedRisk);
          if (r === 'restart') continue outer;
          if (r === 'applied') {
            await surface.observe();
            res = await surface.resolve(step.action.target);
          }
        }
        if (!res.ok) {
          throw new Halt({
            class: res.reason === 'ambiguous' ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
            stepId: step.id,
            expected: `a unique confident match for the step's target (strategies: ${step.action.target.strategies.map((s) => s.s).join(' → ')})`,
            observed: `${res.detail}; candidates: ${JSON.stringify(res.candidates)}; ${summarizeObservation(obs)}`,
          });
        }
        trace.strategyIndex = res.strategyIndex;
        trace.strategy = res.strategy;
        trace.score = res.score;
        log.event('resolved', { stepId: step.id, strategyIndex: res.strategyIndex, strategy: res.strategy, score: res.score });

        // 3. Act through the gate — the only path to the surface.
        const action = buildAction(step, res.ref, subst);
        const actResult = await gate.execute(action, { risk: step.risk });
        readValue = actResult.readValue;
      }

      if (step.action.kind === 'read' && readValue !== undefined) {
        const spec = artifact.outputs[step.action.into];
        const value = spec?.source.transform === 'trim' ? readValue.trim() : readValue;
        outputs[step.action.into] = value;
        // Extracted values inherit their declared sensitivity immediately:
        // the caller receives the real value; evidence on disk sees the mask.
        if (spec) redactor.register(step.action.into, value, spec.sensitivity);
        log.event('extracted', { stepId: step.id, into: step.action.into });
      }

      // 4. Wait & classify: post > outcomes > recoveries > anomalies > timeout.
      const deadline = Date.now() + step.wait.timeoutMs;
      classify: while (true) {
        obs = await surface.observe();

        if (await evaluateAll(step.post, obs)) break classify;

        for (const code of step.onDetect) {
          const outcome = artifact.outcomes.find((o) => o.code === code)!;
          if (await evaluateCondition(substituteDeep(outcome.when, subst), obs)) {
            log.event('business_outcome', { stepId: step.id, code });
            log.screenshot(`outcome-${code}`, obs.screenshot);
            trace.status = 'ok';
            trace.ms = Date.now() - t0;
            traces.push(trace);
            return {
              ...base,
              status: 'business_outcome',
              code,
              message: outcome.description,
              outputs: outcome.outputs,
              stepsRun: traces,
              recoveriesUsed: recoveriesUsed(),
              finishedAt: new Date().toISOString(),
            };
          }
        }

        const r = await tryRecoveries(obs, completedRisk);
        if (r === 'restart') continue outer;
        if (r === 'applied') continue classify;

        for (const anomaly of artifact.anomalies) {
          if (await evaluateCondition(substituteDeep(anomaly.when, subst), obs)) {
            throw new Halt({
              class: 'UNEXPECTED_STATE',
              stepId: step.id,
              expected: step.post.length > 0 ? renderConditions(step.post) : 'no anomalous state',
              observed: `anomaly ${anomaly.code} (${anomaly.description}); ${summarizeObservation(obs)}`,
            });
          }
        }
        if (obs.dialog) {
          throw new Halt({
            class: 'UNEXPECTED_STATE',
            stepId: step.id,
            expected: 'no unexpected dialog',
            observed: `unhandled ${obs.dialog.kind} dialog: ${JSON.stringify(obs.dialog.text)}`,
          });
        }
        if (Date.now() > deadline) {
          throw new Halt({
            class: 'POSTCONDITION_TIMEOUT',
            stepId: step.id,
            expected: renderConditions(step.post),
            observed: summarizeObservation(obs),
          });
        }
        await new Promise((r2) => setTimeout(r2, step.wait.pollMs));
      }

      trace.status = 'ok';
      trace.ms = Date.now() - t0;
      traces.push(trace);
      completedRisk.push(step.risk);
      log.event('step_ok', { stepId: step.id, ms: trace.ms });
      log.screenshot(`after-${step.id}`, obs.screenshot);
    }

    // 5. Final checkpoint.
    obs = await surface.observe();
    const criteria = artifact.successCriteria.map((c) => substituteDeep(c, subst));
    if (!(await evaluateAll(criteria, obs))) {
      throw new Halt({
        class: 'UNEXPECTED_STATE',
        expected: renderConditions(criteria),
        observed: summarizeObservation(obs),
      });
    }
    log.screenshot('final', obs.screenshot);
    return {
      ...base,
      status: 'success',
      outputs,
      stepsRun: traces,
      recoveriesUsed: recoveriesUsed(),
      finishedAt: new Date().toISOString(),
    };
  }
}

function buildAction(step: Step, ref: number, subst: Record<string, string>): SemanticAction {
  switch (step.action.kind) {
    case 'activate':
      return { kind: 'activate', ref };
    case 'read':
      return { kind: 'read', ref };
    case 'setValue':
      return { kind: 'setValue', ref, value: bindingValue(step.action.value, subst) };
    case 'choose':
      return { kind: 'choose', ref, option: bindingValue(step.action.option, subst) };
    default:
      throw new Error(`buildAction: unexpected kind ${step.action.kind}`);
  }
}

/**
 * `{literal}` bindings pass through (template placeholders inside them were
 * already substituted); `{param}` bindings resolve from the invocation's
 * params/bindings map — which is how secret values reach input fields
 * without ever being serialized into the artifact.
 */
function bindingValue(binding: Binding, subst: Record<string, string>): string {
  if ('literal' in binding) return binding.literal;
  const value = subst[binding.param];
  if (value === undefined) throw new Error(`binding references unknown param '${binding.param}'`);
  return value;
}
