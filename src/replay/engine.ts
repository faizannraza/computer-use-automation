/**
 * The deterministic replay engine — the production execution path. It
 * interprets a capability artifact with no model in the loop: locator
 * ladders resolve targets, conditions are polled, and every observed state
 * is classified in a strict priority order:
 *
 *   postcondition satisfied            → step ok, continue
 *   > expected business outcome        → return business_outcome (a result)
 *   > known recoverable condition      → run its handler, bounded, re-enter
 *   > declared anomaly / unknown dialog→ hard failure, fast
 *   > timeout                          → POSTCONDITION_TIMEOUT with expected/observed
 *
 * The ordering is itself a design claim: outcomes outrank recoveries outrank
 * anomalies, so a "record not found" page that is also slow is reported as
 * the business outcome — never retried into confusion.
 */
import type { FramePathEntry, Observation, ObservedElement, RiskClass, SemanticAction } from '../core/types.js';
import { applyTemplate, substituteDeep } from '../core/template.js';
import { RunLog } from '../evidence/runLog.js';
import { ActionGate, PolicyViolation } from '../policy/actionGate.js';
import type { Policy } from '../policy/policy.js';
import { Redactor, maskValue } from '../policy/redact.js';
import { classifiedElementRefs, classifyObservation, effectiveParamSensitivity } from '../policy/classify.js';
import type { AppProfile } from '../profile/appProfile.js';
import { SessionController } from '../hitl/sessionController.js';
import type { Operator } from '../hitl/sessionController.js';
import type { Binding, CapabilityArtifact, Step } from '../schema/capability.js';
import { extractingAction } from '../schema/capability.js';
import type { ResolvedCapability } from '../schema/overlay.js';
import type { InterventionRequest, RecoveryUse, ReplayFailure, ReplayResult, StepTrace } from '../schema/result.js';
import type { Surface } from '../surface/surface.js';
import { PlaywrightWebSurface } from '../surface/web/playwrightSurface.js';
import { evaluateAll, evaluateCondition, renderConditions, summarizeObservation } from './detectors.js';

export interface ReplayOptions {
  policy: Policy;
  paramValues: Record<string, string>;
  /** From loadCapability(): content-hash verification result. */
  verified?: boolean;
  allowDraft?: boolean;
  headed?: boolean;
  /** Demo aid: throttle driver actions (Playwright slowMo) so a headed
   * replay is watchable by an audience. Never set on production replays. */
  slowMoMs?: number;
  evidenceBaseDir?: string;
  /** Caller-assigned run id, so an HTTP invocation can hand back a
   * subscribable id BEFORE the first event is emitted. */
  runId?: string;
  /** Live event sink — receives redacted JSONL lines (see RunLogOptions). */
  onEvent?: (redactedLine: string) => void;
  /**
   * The redactor the run registers its needles in. Supply one when the caller
   * must scrub a channel the engine does not own — an approval console
   * rendering live screen text to a human, say. Such a channel cannot be served
   * by a redactor seeded from the declared params alone: the values that matter
   * there (other members' names, balances, addresses) are the ones
   * classifyObservation registers as the run observes them, and a caller
   * holding a separate instance would re-expose exactly what the single write
   * boundary exists to catch. This is an injection point for the SAME redactor,
   * not a second redaction path.
   */
  redactor?: Redactor;
  /**
   * Per-invocation values for `source: 'env'` params, keyed by ENV VAR NAME.
   * This is how one capability runs as different operator roles without
   * mutating process.env — which would race across concurrent API invocations.
   */
  envOverrides?: Record<string, string>;
  /**
   * The operator role those credentials belong to (profile-defined, already
   * RESOLVED — i.e. the profile's default filled in, not the caller's blank).
   * Recorded on run_start and on the result so an audit can answer "which runs
   * used supervisor authority", which the env-var indirection otherwise hides:
   * every role signs on through the same two variable names.
   */
  role?: string;
  /**
   * Human-in-the-loop operator. When present, escalations pause the run and
   * hand the LIVE session to the operator; when absent, a run that needs a
   * human ends as status 'escalated' / 'no_operator_available' — it never
   * guesses its way past a decision a person should make.
   */
  operator?: Operator;
  /**
   * The target application's profile. Supplies app-level runtime handling
   * (already merged into the artifact by the caller) and, at run time, the
   * field classification that redacts regulated data the flow never declared.
   */
  profile?: AppProfile;
  /**
   * Harness affordance: force one of the app's documented runtime faults on a
   * chosen step (or on the entrypoint). Not reachable from an artifact.
   */
  inject?: { kind: string; atStepId?: string };
}

/** Internal control-flow: abort the run with a typed failure. */
class Halt extends Error {
  constructor(readonly failure: Omit<ReplayFailure, 'screenshotRef'>) {
    super(`${failure.class}: ${failure.expected}`);
  }
}

/** Internal control-flow: the run ends at an escalation. */
class EscalationHalt extends Error {
  constructor(
    readonly interventionId: string,
    readonly reason: string,
    readonly resolution: 'aborted_by_operator' | 'no_operator_available',
  ) {
    super(`escalated: ${reason}`);
  }
}

/**
 * Per-run bookkeeping shared between run() and the failure path, so failed
 * and escalated results carry the same forensics (step traces, recoveries,
 * whether an irreversible step already completed) as successful ones —
 * a failure is exactly when the caller needs them most.
 */
interface RunState {
  traces: StepTrace[];
  recoveryUse: Map<string, number>;
  irreversibleCompleted: boolean;
}

function recoveryList(use: Map<string, number>): RecoveryUse[] {
  return [...use.entries()].map(([code, attempts]) => ({ code, attempts }));
}

/**
 * Where an action is being dispatched from — for the gate, and for the human
 * who may have to approve it. Not simply a Step, because RECOVERY HANDLERS
 * dispatch too and must carry a risk and a description of their own rather
 * than borrowing a hardcoded one.
 */
interface DispatchSite {
  risk: RiskClass;
  stepId?: string;
  /** Shown to the approving human: what this click is meant to accomplish. */
  intent: string;
}

const RISK_ORDER: RiskClass[] = ['read', 'reversible', 'irreversible'];

/** The higher of two risk classes — risk claims may be raised, never lowered. */
function higherRisk(a: RiskClass, b: RiskClass): RiskClass {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

const MAX_RESTARTS = 2;

export async function replayCapability(resolved: ResolvedCapability, opts: ReplayOptions): Promise<ReplayResult> {
  const { artifact, bindings } = resolved;
  const startedAt = new Date().toISOString();
  const redactor = opts.redactor ?? new Redactor();

  // ---- Resolve & validate params (before any browser exists). ----
  const params: Record<string, string> = {};
  const maskedParams: Record<string, string> = {};
  let paramError: string | undefined;
  for (const [name, spec] of Object.entries(artifact.params)) {
    const raw =
      spec.source === 'env'
        ? (opts.envOverrides?.[spec.env!] ?? process.env[spec.env!])
        : opts.paramValues[name];
    if (raw === undefined || raw === '') {
      if (spec.required) {
        paramError = spec.source === 'env'
          ? `required param '${name}' resolves from env var ${spec.env} (or an invocation override), and neither supplied a value`
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
    // The artifact's declared sensitivity is a floor, not the last word: the
    // app profile classifies which FIELDS of this application are regulated,
    // and a param named after one of them is that data whatever the artifact
    // says. Raising here (never lowering) is what keeps a member's e-mail out
    // of run_start — which is written before any observation exists, so the
    // classification sweep cannot have registered the value yet, and a value
    // never registered as a needle survives every later write too.
    const sensitivity = effectiveParamSensitivity(name, spec.sensitivity, opts.profile?.dataClassification);
    maskedParams[name] = maskValue(name, raw, sensitivity);
    redactor.register(name, raw, sensitivity);
  }

  const log = new RunLog('replay', {
    baseDir: opts.evidenceBaseDir ?? 'evidence',
    redactor,
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
  });
  const base = {
    capabilityId: artifact.capability.id,
    version: artifact.capability.version,
    runId: log.runId,
    evidenceDir: log.dir,
    startedAt,
    ...(opts.role !== undefined ? { role: opts.role } : {}),
  };
  const finish = (result: ReplayResult): ReplayResult => {
    log.event('run_result', { status: result.status, ...(result.status === 'failed' ? { failure: result.failure } : {}) });
    log.writeJson('result', result);
    return result;
  };
  const earlyFail = (failure: ReplayFailure): ReplayResult =>
    finish({
      ...base,
      status: 'failed',
      failure,
      stepsRun: [],
      recoveriesUsed: [],
      interventions: [],
      irreversibleCompleted: false,
      finishedAt: new Date().toISOString(),
    });

  log.event('run_start', {
    capability: `${artifact.capability.id}@${artifact.capability.version}`,
    tenant: resolved.tenantId ?? null,
    // Explicitly null rather than absent when unknown: an auditor filtering for
    // privileged runs must be able to tell "ran as no declared role" from "the
    // field did not exist yet", and an absent key reads as neither.
    role: opts.role ?? null,
    params: maskedParams,
  });

  if (paramError) {
    return earlyFail({ class: 'INVALID_PARAMS', expected: 'params matching the capability contract', observed: paramError });
  }

  // ---- Pre-flight guards: integrity, approval, policy fit. ----
  if (opts.verified === false) {
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
  // Every capability navigates to its entrypoint, whether or not a step says
  // 'navigate' — and recovery handlers act too ('dismiss' activates a
  // control, 'answerDialog' answers one). All of it is checked here, not
  // first discovered by the gate after a browser has already launched.
  const recoveryKinds = artifact.recoveries.flatMap((r): ('activate' | 'answerDialog')[] => {
    switch (r.handler.kind) {
      case 'dismiss':
        return ['activate'];
      case 'answerDialog':
        return ['answerDialog'];
      case 'restartRun': // re-enters via the entrypoint navigate, already counted
      case 'escalate': // the human acts, not the gate
        return [];
      default: {
        // A new handler kind must decide its gate needs here or fail to compile.
        const exhaustive: never = r.handler;
        throw new Error(`unhandled recovery handler kind: ${JSON.stringify(exhaustive)}`);
      }
    }
  });
  const actionsNeeded = [
    ...new Set<(typeof artifact.policy.actionsUsed)[number]>([...artifact.policy.actionsUsed, 'navigate', ...recoveryKinds]),
  ];
  const missingActions = actionsNeeded.filter((a) => !opts.policy.allowedActions.includes(a));
  if (missingActions.length > 0) {
    return earlyFail({
      class: 'POLICY_BLOCKED',
      expected: `policy to allow action kinds: ${actionsNeeded.join(', ')} (navigate is implicit — the entrypoint; recovery handlers count too)`,
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
  const surface = await PlaywrightWebSurface.launch({
    headed: opts.headed ?? false,
    ...(opts.slowMoMs !== undefined ? { slowMoMs: opts.slowMoMs } : {}),
  });
  // The controller owns the control token; the gate checks it on every
  // action, so the automation cannot act at all during a human handoff.
  const controller = opts.operator ? new SessionController(surface, log, opts.operator) : undefined;
  const gate = new ActionGate(opts.policy, surface, {
    getHolder: () => controller?.holder() ?? 'agent',
    onEvent: (e) =>
      log.event('gate', { kind: e.action.kind, decision: e.decision, location: e.location, risk: e.context.risk }),
  });

  const state: RunState = { traces: [], recoveryUse: new Map(), irreversibleCompleted: false };
  try {
    return finish(await run(artifact, subst, surface, gate, controller, log, redactor, opts, base, state));
  } catch (err) {
    const obs = surface.lastObservation();
    const interventions = controller?.records ?? [];
    const forensics = {
      stepsRun: state.traces,
      recoveriesUsed: recoveryList(state.recoveryUse),
      interventions,
      irreversibleCompleted: state.irreversibleCompleted,
    };
    if (err instanceof EscalationHalt) {
      return finish({
        ...base,
        status: 'escalated',
        interventionId: err.interventionId,
        reason: err.reason,
        resolution: err.resolution,
        ...forensics,
        finishedAt: new Date().toISOString(),
      });
    }
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
    return finish({
      ...base,
      status: 'failed',
      failure,
      ...forensics,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    await surface.close();
  }
}

function shotRef(log: RunLog, name: string, obs: Observation | undefined): { screenshotRef?: string } {
  const ref = capture(log, name, obs);
  return ref !== undefined ? { screenshotRef: ref } : {};
}

/**
 * One evidence moment, recorded two ways: the screenshot shows what a person
 * would have seen, the element map shows what the locator ladder saw — and only
 * the second explains why a target resolved, or why it was refused. They share
 * the log's counter, so a reviewer can pair them by filename.
 */
function capture(log: RunLog, name: string, obs: Observation | undefined): string | undefined {
  const ref = log.screenshot(name, obs?.screenshot);
  if (obs !== undefined) log.elements(name, obs.elements, obs.location);
  return ref;
}

// ---------------------------------------------------------------------------

async function run(
  artifact: CapabilityArtifact,
  subst: Record<string, string>,
  surface: Surface,
  gate: ActionGate,
  controller: SessionController | undefined,
  log: RunLog,
  redactor: Redactor,
  opts: ReplayOptions,
  base: { capabilityId: string; version: string; runId: string; evidenceDir: string; startedAt: string; role?: string },
  state: RunState,
): Promise<ReplayResult> {
  const classification = opts.profile?.dataClassification;
  // Observation summaries are TRUNCATED before they are written, so redaction
  // has to happen first: a cut applied to raw text leaves a partial value the
  // write-boundary redactor can no longer match on.
  const scrubText = (text: string): string => redactor.apply(text);
  // Screenshot masking is installed ONCE, on the surface, rather than applied
  // after each observation: the surface runs it inside the capture it belongs
  // to. Driving it from out here — classify observation N, mask capture N+1 —
  // means the capture where regulated data first appears is written clean, and
  // the next one blacks out whatever those now-reassigned refs point at.
  if (classification) surface.setScreenshotMask?.((obs) => classifiedElementRefs(obs, classification));

  /**
   * Every observation in the run goes through here so that regulated data the
   * app profile classifies is registered with the redactor BEFORE anything is
   * written. The flow's own params and outputs are already covered by their
   * declared sensitivity; this covers what the flow never declared — other
   * members listed by a name search, an address on a record screen — which is
   * most of what a servicing console actually puts on screen.
   */
  const observeClassified = async (): Promise<Observation> => {
    const observation = await surface.observe();
    if (classification) {
      const registered = classifyObservation(observation, classification, redactor, (gap) =>
        log.event('classified_field_unpaired', gap),
      );
      if (registered > 0) log.event('classified_fields', { registered });
    }
    return observation;
  };

  // A harness-injected fault fires once per RUN. Re-arming it on each restart
  // would mean a recovery that restarts walks back into the same fault until
  // the budget is exhausted — measuring the harness, not the capability.
  let injectionFired = false;
  let recoveryBudget = opts.policy.maxRecoveryAttemptsPerRun;
  let restarts = 0;
  const recoveryUse = state.recoveryUse;
  const recoveriesUsed = (): RecoveryUse[] => recoveryList(recoveryUse);
  const interventions = () => controller?.records ?? [];

  /** Route an intervention to the operator (or end the run if there is none). */
  const escalate = async (
    req: Pick<InterventionRequest, 'kind' | 'reason' | 'suggestedResolution' | 'options'> & {
      stepId?: string;
      stepIntent?: string;
    },
  ) => {
    const obs = surface.lastObservation();
    if (!controller) {
      log.event('escalation_unattended', { kind: req.kind, reason: req.reason });
      throw new EscalationHalt('none', req.reason, 'no_operator_available');
    }
    const shot = capture(log, 'intervention', obs);
    const resolution = await controller.escalate({
      ...req,
      origin: 'replay',
      capabilityId: base.capabilityId,
      version: base.version,
      runId: base.runId,
      observationSummary: obs ? summarizeObservation(obs, scrubText) : '(no observation)',
      ...(shot !== undefined ? { screenshotRef: shot } : {}),
    });
    if (resolution.action === 'abort') {
      const last = controller.records[controller.records.length - 1]!;
      throw new EscalationHalt(last.id, req.reason, 'aborted_by_operator');
    }
    return resolution;
  };

  /**
   * Gate execution with the risky-action escalation path: an irreversible
   * action under policy mode 'escalate' pauses for a human decision; on
   * 'approve' the same action executes exactly once with approval attached.
   *
   * The approved action is RE-LOCATED before it runs. A ref is only valid
   * against the observation it came from, and a human's decision can take
   * minutes (especially through a remote approval surface) during which the
   * page may re-render or the human may click around. Re-observing and
   * re-matching the element by identity means the approved action lands on the
   * control the human actually reviewed — or refuses, rather than acting on
   * whatever now occupies that ref.
   *
   * Identity alone is not enough, though: a *Post Transfer* button has the same
   * role, name and frame whatever the amount beside it now says. So the
   * TRANSACTION is digested at escalation time and re-checked afterwards —
   * see transactionDigest() for what that covers and what it does not.
   */
  const gatedExecute = async (action: SemanticAction, site: DispatchSite, frameUrl?: string) => {
    const at = site.stepId !== undefined ? { stepId: site.stepId } : {};
    const ctx = { risk: site.risk, ...(frameUrl !== undefined ? { frameUrl } : {}) };
    try {
      return await gate.execute(action, ctx);
    } catch (err) {
      if (err instanceof PolicyViolation && err.code === 'RISK_NEEDS_ESCALATION') {
        const before = surface.lastObservation();
        const reviewed = 'ref' in action ? before?.elements.find((e) => e.ref === action.ref) : undefined;
        // Captured BEFORE the handoff: this is the state the human is about to
        // be shown, and the only definition of "what they approved".
        const reviewedDigest = reviewed !== undefined && before !== undefined ? transactionDigest(before, reviewed) : undefined;
        await escalate({
          ...at,
          stepIntent: site.intent,
          kind: 'approve_risky',
          reason: err.message,
          suggestedResolution:
            'Review the pending irreversible action in the live window. approve = the automation performs it; abort = stop the run.',
          options: ['approve', 'abort'],
        });
        let approvedAction = action;
        if (reviewed !== undefined && 'ref' in action) {
          const fresh = await observeClassified();
          // Identity is role|name|label|frames — deliberately record-independent,
          // so a *Place Hold* button is IDENTICAL on every member's record in
          // the same app. A human who navigated the live session during the
          // handoff would leave a unique, matching control on the wrong
          // account. The location is what distinguishes those screens — except
          // in a frameset app, where a frame navigation leaves the top-level
          // URL untouched; there the transaction digest below is what catches
          // it, because the frame's own contents change.
          if (before?.location !== undefined && fresh.location !== before.location) {
            throw new Halt({
              ...at,
              class: 'UNEXPECTED_STATE',
              expected: `the approved action to run on the reviewed screen (${before.location})`,
              observed: `the session moved to ${fresh.location} during the approval window — refusing to perform an approved irreversible action against a different record; ${summarizeObservation(fresh, scrubText)}`,
            });
          }
          const matches = fresh.elements.filter((e) => elementIdentity(e) === elementIdentity(reviewed));
          if (matches.length !== 1) {
            throw new Halt({
              ...at,
              class: 'UNEXPECTED_STATE',
              expected: `the approved control (${reviewed.role} ${JSON.stringify(reviewed.name)}) to still be uniquely present after the handoff`,
              observed: `${matches.length} matching controls after the human's decision — refusing to perform an approved irreversible action against a changed screen; ${summarizeObservation(fresh, scrubText)}`,
            });
          }
          if (reviewedDigest !== undefined && transactionDigest(fresh, matches[0]!) !== reviewedDigest) {
            throw new Halt({
              ...at,
              class: 'UNEXPECTED_STATE',
              expected: `the reviewed transaction to be unchanged after the handoff (the contents of the frame holding ${reviewed.role} ${JSON.stringify(reviewed.name)})`,
              observed: `the transaction changed during the approval window — refusing to post something other than what the human reviewed; ${summarizeObservation(fresh, scrubText)}`,
            });
          }
          approvedAction = { ...action, ref: matches[0]!.ref };
          log.event('approved_action_relocated', { ...at, fromRef: action.ref, toRef: matches[0]!.ref });
        }
        return await gate.execute(approvedAction, { ...ctx, approved: true });
      }
      throw err;
    }
  };

  /**
   * Scan the artifact's known recoverable conditions against the current
   * observation. Returns 'applied' (handler ran — re-classify), 'restart'
   * (run must restart from the entrypoint), or 'none'.
   *
   * A handler that ACTS ('dismiss' clicks a control, 'answerDialog' answers
   * one) dispatches at the risk of the run it is inside, never at a risk of
   * its own choosing. Recoveries are not covered by the artifact's content
   * hash — applyProfile() merges app-level ones in after verification — so a
   * hardcoded 'reversible' here is a gate-passing click that any profile edit
   * could aim at a posting control: nothing re-derives the risk of the button
   * a locator ladder happens to resolve. Charging the enclosing step's risk is
   * not enough either, since the step whose checkpoint is still pending when a
   * recovery fires is typically the *review* step before the posting one. So
   * the artifact's own declared ceiling applies, and a recovery click inside a
   * flow authorised to post escalates exactly like the posting step would.
   *
   * The cost is deliberate: in a flow whose maxRisk is 'irreversible', even a
   * benign interstitial dismissal now needs a human (or, unattended, ends the
   * run as 'escalated' rather than clicking unsupervised).
   */
  const tryRecoveries = async (
    obs: Observation,
    completedRisk: RiskClass[],
    step?: Step,
  ): Promise<'applied' | 'restart' | 'none'> => {
    const recoveryRisk = higherRisk(step?.risk ?? 'read', artifact.policy.maxRisk);
    for (const rec of artifact.recoveries) {
      const when = substituteDeep(rec.when, subst);
      if (!(await evaluateCondition(when, obs))) continue;
      const used = recoveryUse.get(rec.code) ?? 0;
      if (used >= rec.maxAttempts || recoveryBudget <= 0) {
        throw new Halt({
          class: 'RECOVERY_EXHAUSTED',
          expected: `recovery ${rec.code} to succeed within ${rec.maxAttempts} attempts (global budget ${opts.policy.maxRecoveryAttemptsPerRun})`,
          observed: `${rec.code} matched again after ${used} attempts; ${summarizeObservation(obs, scrubText)}`,
        });
      }
      recoveryUse.set(rec.code, used + 1);
      recoveryBudget -= 1;
      log.event('recovery_applied', { code: rec.code, attempt: used + 1, handler: rec.handler.kind, risk: recoveryRisk });
      const site: DispatchSite = {
        risk: recoveryRisk,
        intent: `recovery ${rec.code} (${rec.handler.kind}): ${rec.description}`,
        ...(step !== undefined ? { stepId: step.id } : {}),
      };
      switch (rec.handler.kind) {
        case 'dismiss': {
          const target = substituteDeep(rec.handler.target, subst);
          const res = await surface.resolve(target);
          if (!res.ok) {
            log.event('recovery_dismiss_unresolved', { code: rec.code, detail: res.detail });
            return 'none';
          }
          const dismissEl = surface.lastObservation()?.elements.find((e) => e.ref === res.ref);
          await gatedExecute(
            { kind: 'activate', ref: res.ref },
            site,
            dismissEl?.framePath[dismissEl.framePath.length - 1]?.url,
          );
          // Same dispatch-time accounting as a step: if that click could have
          // posted, the run must behave as though it did (no restart after it).
          if (recoveryRisk === 'irreversible') {
            state.irreversibleCompleted = true;
            completedRisk.push('irreversible');
          }
          await surface.settle();
          return 'applied';
        }
        case 'answerDialog':
          await gatedExecute({ kind: 'answerDialog', accept: rec.handler.accept }, site);
          if (recoveryRisk === 'irreversible') {
            state.irreversibleCompleted = true;
            completedRisk.push('irreversible');
          }
          return 'applied';
        case 'escalate': {
          // This state can only be cleared by a person on the live session.
          // After they resume, we re-enter classification — the step's own
          // postcondition verifies the human's work.
          await escalate({
            kind: 'human_action_required',
            reason: `${rec.code}: ${rec.description}`,
            suggestedResolution: rec.handler.suggestion,
            options: ['resume', 'abort'],
            ...(step !== undefined ? { stepId: step.id, stepIntent: step.intent } : {}),
          });
          await surface.settle();
          return 'applied';
        }
        case 'restartRun': {
          if (completedRisk.includes('irreversible')) {
            throw new Halt({
              class: 'UNEXPECTED_STATE',
              expected: 'a restartable run (no irreversible step completed yet)',
              observed: `recovery ${rec.code} wants to restart, but an irreversible step already completed — refusing`,
            });
          }
          // Restarting the RUN restarts its SESSION: the entrypoint assumes an
          // unauthenticated start, and a surviving session cookie makes the
          // app skip sign-on so the flow re-enters mid-way and the first
          // step's precondition fails. Observed live on MERIDIAN.
          await surface.resetSession?.();
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
        default: {
          // Exhaustiveness: without this, a handler kind added to the schema
          // but forgotten here would silently consume a recovery attempt and
          // log a misleading `recovery_applied` while doing nothing.
          const exhaustive: never = rec.handler;
          throw new Error(`unhandled recovery handler kind: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
    return 'none';
  };

  // ---- Main loop. `restart` recoveries re-enter from the entrypoint. ----
  outer: while (true) {
    const outputs: Record<string, string> = {};
    state.traces.splice(0); // restart begins a fresh attempt; state keeps the array identity
    const traces = state.traces;
    const completedRisk: RiskClass[] = [];

    // Harness: arm an entrypoint-scoped fault before the first request.
    if (opts.inject !== undefined && opts.inject.atStepId === undefined && !injectionFired) {
      injectionFired = true;
      await armInjection(surface, opts, log, '(entrypoint)');
    }
    const entryUrl = applyTemplate(artifact.capability.entrypoint.value, subst);
    await gate.execute({ kind: 'navigate', url: entryUrl }, { risk: 'read' });
    await surface.settle();
    let obs = await observeClassified();
    capture(log, 'entrypoint', obs);

    for (const rawStep of artifact.steps) {
      const step = substituteDeep(rawStep, subst) as Step;
      const t0 = Date.now();
      const trace: StepTrace = { stepId: step.id, intent: step.intent, status: 'failed', ms: 0 };
      log.event('step_start', { stepId: step.id, intent: step.intent, kind: step.action.kind, risk: step.risk });
      // Harness: arm a step-scoped fault so a condition can be forced on the
      // request THIS step triggers — including a form post, which is where the
      // interesting failures (a 500 or an expiry between review and post) live.
      if (opts.inject?.atStepId === step.id && !injectionFired) {
        injectionFired = true;
        await armInjection(surface, opts, log, step.id);
      }

      // 1. Precondition guard (with one recovery pass — e.g. a timeout page
      //    that landed between steps).
      obs = await observeClassified();
      if (!(await evaluateAll(step.pre, obs))) {
        const r = await tryRecoveries(obs, completedRisk, step);
        if (r === 'restart') continue outer;
        if (r === 'applied') obs = await observeClassified();
        if (!(await evaluateAll(step.pre, obs))) {
          throw new Halt({
            class: 'PRECONDITION_FAILED',
            stepId: step.id,
            expected: renderConditions(step.pre),
            observed: summarizeObservation(obs, scrubText),
          });
        }
      }

      // 2. Resolve the target (with one recovery pass on not_found;
      //    ambiguity is a refusal, never retried into a guess).
      let readValue: string | undefined;
      if (step.action.kind === 'navigate') {
        await gatedExecute({ kind: 'navigate', url: step.action.url }, stepSite(step));
      } else if (step.action.kind === 'readTable') {
        // A region read: no single control to resolve, so it is dispatched
        // straight through the gate (which still checks control token, action
        // kind, and page origin — and the frame's own origin when the step
        // scopes itself to one).
        const scoped = step.action.frame;
        const frameUrl =
          scoped === undefined
            ? undefined
            : obs.elements.find((e) => e.framePath[e.framePath.length - 1]?.name === scoped.name)?.framePath.slice(-1)[0]
                ?.url;
        const res = await gatedExecute(
          { kind: 'readTable', columns: step.action.columns, ...(scoped !== undefined ? { frame: scoped } : {}) },
          stepSite(step),
          frameUrl,
        );
        readValue = res.readValue;
        // A readTable has no target to resolve, so nothing above can report
        // "the table isn't there" — and an empty result is indistinguishable
        // from a genuinely empty table at the checkpoint, where `post: []`
        // passes on the first poll. Distinguish the two HERE, at the dispatch
        // site: zero rows under headers that genuinely exist is a legitimate
        // empty answer (a member with no shares); zero rows because not one of
        // the requested columns is on screen means the region was never found
        // — a renamed header, a failed header heuristic, the wrong frame — and
        // must fail like any other unresolved target rather than handing the
        // caller `[]` as fact.
        // A column requested but present NOWHERE is simply absent from every
        // row (the extractor never invents ''), which reads to a caller as a
        // table that has no such field rather than as a rename. That stays a
        // successful read — the rows it did find are real — but it is the
        // signature of drift, so it is announced.
        const missing = step.action.columns.filter((c) => !columnsPresent(obs, [c], scoped));
        if (missing.length > 0) log.event('readtable_columns_missing', { stepId: step.id, missing });
        if (parsedRowCount(readValue) === 0 && !columnsPresent(obs, step.action.columns, scoped)) {
          throw new Halt({
            class: 'TARGET_NOT_FOUND',
            stepId: step.id,
            expected: `a table exposing columns: ${step.action.columns.join(', ')}${scoped !== undefined ? ` in frame ${JSON.stringify(scoped.name ?? scoped.urlPattern)}` : ''}`,
            observed: `no observed cell sits under any of those column headers, so the read returned no rows; ${summarizeObservation(obs, scrubText)}`,
          });
        }
      } else if (step.action.kind !== 'assert') {
        let res = await surface.resolve(step.action.target);
        if (!res.ok && res.reason === 'not_found') {
          const r = await tryRecoveries(obs, completedRisk, step);
          if (r === 'restart') continue outer;
          if (r === 'applied') {
            await observeClassified();
            res = await surface.resolve(step.action.target);
          }
        }
        if (!res.ok) {
          throw new Halt({
            class: res.reason === 'ambiguous' ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
            stepId: step.id,
            expected: `a unique confident match for the step's target (strategies: ${step.action.target.strategies.map((s) => s.s).join(' → ')})`,
            observed: `${res.detail}; candidates: ${JSON.stringify(res.candidates)}; ${summarizeObservation(obs, scrubText)}`,
          });
        }
        trace.strategyIndex = res.strategyIndex;
        trace.strategy = res.strategy;
        trace.score = res.score;
        log.event('resolved', { stepId: step.id, strategyIndex: res.strategyIndex, strategy: res.strategy, score: res.score });

        // 3. Act through the gate — the only path to the surface. Irreversible
        //    actions pause here for human approval under policy mode 'escalate';
        //    the target's own frame origin is checked alongside the page's.
        const action = buildAction(step, res.ref, subst);
        const targetEl = surface.lastObservation()?.elements.find((e) => e.ref === res.ref);
        const frameUrl = targetEl?.framePath[targetEl.framePath.length - 1]?.url;
        const actResult = await gatedExecute(action, stepSite(step), frameUrl);
        readValue = actResult.readValue;
      }

      // Irreversible side effects are counted at DISPATCH, not at checkpoint
      // confirmation: once the action left the gate it may have taken effect
      // regardless of what the postcondition later says. This is what makes
      // the restart guard and the caller's retry signal conservative.
      //
      // Counted for EVERY dispatching kind, not just target-resolved clicks: a
      // 'navigate' step is schema-legal at any risk, and GET-triggered mutation
      // ("…/post?confirm=1") is routine in legacy cores — an uncounted one
      // would let a later restartRun recovery re-issue the very request that
      // already posted, and would tell the caller a retry is safe. 'assert'
      // dispatches nothing, so it can have no side effect to count. A step that
      // threw before dispatch (unresolved target) never reaches here.
      if (step.action.kind !== 'assert' && step.risk === 'irreversible') {
        state.irreversibleCompleted = true;
        completedRisk.push('irreversible');
      }

      const extracting = extractingAction(step.action);
      if (extracting && readValue !== undefined) {
        const spec = artifact.outputs[extracting.into];
        const value = spec?.source.transform === 'trim' ? readValue.trim() : readValue;
        outputs[extracting.into] = value;
        // Extracted values inherit their declared sensitivity immediately:
        // the caller receives the real value; evidence on disk sees the mask.
        if (spec) {
          redactor.register(extracting.into, value, spec.sensitivity);
          // A table's serialized form is one needle, which would leave the
          // individual cell values exposed wherever they appear on their own
          // (observation summaries, element maps). Register each cell too.
          if (spec.type === 'table') {
            try {
              for (const row of JSON.parse(value) as Record<string, string>[]) {
                for (const cell of Object.values(row)) redactor.register(extracting.into, cell, spec.sensitivity);
              }
            } catch {
              /* not parseable — the whole-value needle above still applies */
            }
          }
        }
        log.event('extracted', { stepId: step.id, into: extracting.into });
      }

      // 4. Wait & classify: post > outcomes > recoveries > anomalies > timeout.
      let deadline = Date.now() + step.wait.timeoutMs;
      // The first observation after a dispatch is usually the PREVIOUS screen:
      // a click returns as soon as it is dispatched, and nothing waits for the
      // response in between. A step's own onDetect codes are still trusted
      // immediately — the author declared that code plausible AT THIS STEP,
      // which is a warrant that survives a stale frame. App-wide codes carry no
      // such warrant (applyProfile attaches them to every step of every
      // capability), so leftover "TRANSACTION REJECTED" text from the screen
      // before a posting click must not be reported as this transaction's
      // outcome — a caller reading 'rejected' retries, and posts twice. They
      // therefore have to survive one poll interval. Not covered: an app-wide
      // condition that appears and disappears inside a single poll.
      let firstPoll = true;
      classify: while (true) {
        obs = await observeClassified();

        if (await evaluateAll(step.post, obs)) break classify;

        // The step's declared outcomes, plus any the app declares app-wide.
        const candidateCodes = [
          ...step.onDetect,
          ...(firstPoll
            ? []
            : artifact.outcomes.filter((o) => o.appWide === true && !step.onDetect.includes(o.code)).map((o) => o.code)),
        ];
        firstPoll = false;
        for (const code of candidateCodes) {
          const outcome = artifact.outcomes.find((o) => o.code === code)!;
          if (await evaluateCondition(substituteDeep(outcome.when, subst), obs)) {
            log.event('business_outcome', { stepId: step.id, code });
            capture(log, `outcome-${code}`, obs);
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
              interventions: interventions(),
              irreversibleCompleted: state.irreversibleCompleted,
              finishedAt: new Date().toISOString(),
            };
          }
        }

        const r = await tryRecoveries(obs, completedRisk, step);
        if (r === 'restart') continue outer;
        if (r === 'applied') {
          // A recovery (possibly a minutes-long human handoff) consumed real
          // time; the step deserves its full wait budget again afterwards.
          deadline = Date.now() + step.wait.timeoutMs;
          continue classify;
        }

        for (const anomaly of artifact.anomalies) {
          if (await evaluateCondition(substituteDeep(anomaly.when, subst), obs)) {
            throw new Halt({
              class: 'UNEXPECTED_STATE',
              stepId: step.id,
              expected: step.post.length > 0 ? renderConditions(step.post) : 'no anomalous state',
              observed: `anomaly ${anomaly.code} (${anomaly.description}); ${summarizeObservation(obs, scrubText)}`,
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
            observed: summarizeObservation(obs, scrubText),
          });
        }
        await new Promise((r2) => setTimeout(r2, step.wait.pollMs));
      }

      trace.status = 'ok';
      trace.ms = Date.now() - t0;
      traces.push(trace);
      if (step.risk !== 'irreversible') completedRisk.push(step.risk); // irreversible counted at dispatch
      log.event('step_ok', { stepId: step.id, ms: trace.ms });
      capture(log, `after-${step.id}`, obs);
    }

    // 5. Final checkpoint.
    obs = await observeClassified();
    const criteria = artifact.successCriteria.map((c) => substituteDeep(c, subst));
    if (!(await evaluateAll(criteria, obs))) {
      throw new Halt({
        class: 'UNEXPECTED_STATE',
        expected: renderConditions(criteria),
        observed: summarizeObservation(obs, scrubText),
      });
    }
    capture(log, 'final', obs);
    return {
      ...base,
      status: 'success',
      outputs,
      stepsRun: traces,
      recoveriesUsed: recoveriesUsed(),
      interventions: interventions(),
      irreversibleCompleted: state.irreversibleCompleted,
      finishedAt: new Date().toISOString(),
    };
  }
}

/**
 * Arm the app's documented fault mechanism for the next request. Query-param
 * injection is armed on the surface (a one-shot request rewrite); endpoint-
 * style injection is the caller's job before the run, since it is out-of-band.
 */
async function armInjection(
  surface: Surface,
  opts: ReplayOptions,
  log: RunLog,
  where: string,
): Promise<void> {
  const adapter = opts.profile?.faultInjection;
  const inject = opts.inject;
  if (!inject || !adapter) return;
  if (adapter.kind !== 'queryParam') return;
  if (!adapter.kinds.includes(inject.kind)) {
    throw new Error(`'${inject.kind}' is not a fault this app declares (${adapter.kinds.join(', ')})`);
  }
  if (!surface.armFaultInjection) return;
  await surface.armFaultInjection(adapter.param, inject.kind);
  log.event('fault_armed', { kind: inject.kind, at: where, mechanism: `${adapter.param}=${inject.kind}` });
}

/** Ref-independent element identity, used to re-find a control across
 * observations of the same screen (refs are observation-scoped). */
function elementIdentity(el: { role: string; name: string; label?: string; framePath: { name?: string }[] }): string {
  return `${el.role}|${el.name}|${el.label ?? ''}|${el.framePath.map((f) => f.name ?? '?').join('/')}`;
}

/** Rows in a serialized readTable result; -1 when it is not a row array. */
function parsedRowCount(serialized: string | undefined): number {
  if (serialized === undefined) return -1;
  try {
    const rows: unknown = JSON.parse(serialized);
    return Array.isArray(rows) ? rows.length : -1;
  } catch {
    return -1;
  }
}

/**
 * Is any requested column header actually on screen (within the step's frame,
 * when it scopes itself to one)? Header text is compared the same way the
 * extractor compares it — normalised — so "the column exists" means the same
 * thing at both ends and this guard cannot pass a read the extractor failed.
 */
function columnsPresent(
  obs: Observation,
  columns: string[],
  frame?: { name?: string | undefined; urlPattern?: string | undefined },
): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = new Set(columns.map(norm));
  return obs.elements.some((el) => {
    if (el.colHeader === undefined || !wanted.has(norm(el.colHeader))) return false;
    if (frame?.name === undefined) return true;
    return el.framePath.some((f) => f.name === frame.name);
  });
}

/** A step dispatches under its own declared risk, id and intent. */
function stepSite(step: Step): DispatchSite {
  return { risk: step.risk, stepId: step.id, intent: step.intent };
}

function frameKey(path: FramePathEntry[]): string {
  return path.map((f) => f.name ?? f.url).join('/');
}

/**
 * A digest of the TRANSACTION a human reviewed — the contents of the screen the
 * approved control sits on — so an approval cannot be replayed against
 * different values. Identity re-location proves the *button* is the one that
 * was reviewed; a posting button is identical whatever the amount beside it now
 * says, and during an approval window (up to minutes, with the live session
 * physically handed to the operator on the terminal path) a re-render, a back
 * navigation or a stray keystroke can change the values while leaving every
 * control intact.
 *
 * Scope, chosen to refuse tampering without aborting on noise:
 *  - the visible text of the control's OWN frame, plus every value-bearing
 *    field in it, keyed by label rather than by ref;
 *  - not other frames, so persistent chrome (banner, menu, a clock in a
 *    sibling frame) cannot invalidate an approval;
 *  - not hidden inputs, whose observed form is a per-request token length that
 *    legitimately changes on any re-render;
 *  - not password fields (never observed) and not server-side state: this
 *    catches a changed transaction, not a compromised backend.
 * A frame that renders live data in the work area (a countdown, a running
 * balance) would trip it — the correct direction for a posting screen, but the
 * reason this is scoped to one frame rather than the whole observation.
 */
function transactionDigest(obs: Observation, control: ObservedElement): string {
  const key = frameKey(control.framePath);
  const fields = obs.elements
    .filter((e) => e.value !== undefined && e.role !== 'hidden' && frameKey(e.framePath) === key)
    .map((e) => `${e.role}|${e.label ?? e.name}=${e.value}`)
    .sort();
  const text = (obs.frameTexts?.find((f) => frameKey(f.framePath) === key)?.text ?? obs.visibleText)
    .replace(/\s+/g, ' ')
    .trim();
  return JSON.stringify({ fields, text });
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
      return {
        kind: 'choose',
        ref,
        option: bindingValue(step.action.option, subst),
        ...(step.action.by !== undefined ? { by: step.action.by } : {}),
      };
    case 'navigate':
    case 'readTable':
    case 'assert':
      // Dispatched without a resolved target; never reaches this builder.
      throw new Error(`buildAction: '${step.action.kind}' steps are not target-resolved actions`);
    default: {
      // Exhaustiveness: a new step action kind must decide how it dispatches
      // HERE, at compile time — not by falling through at runtime mid-run.
      const exhaustive: never = step.action;
      throw new Error(`buildAction: unhandled step action ${JSON.stringify(exhaustive)}`);
    }
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
