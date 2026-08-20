/**
 * The replay result contract. The four-way top-level split is the load-
 * bearing design decision: an expected business outcome ("no such member")
 * is a different type from a failure, so a caller can't confuse the two —
 * the types don't allow it.
 */

export type FailureClass =
  | 'INVALID_PARAMS' // caller-side: params missing or malformed (no browser launched)
  | 'TARGET_NOT_FOUND' // no locator strategy produced a confident match
  | 'TARGET_AMBIGUOUS' // near-equal candidates — the engine refuses to guess
  | 'PRECONDITION_FAILED' // step guard not met and no recovery applied
  | 'POSTCONDITION_TIMEOUT' // acted, but the checkpoint never became true
  | 'UNEXPECTED_STATE' // anomaly detected (unknown dialog, error page, unmet success criteria)
  | 'RECOVERY_EXHAUSTED' // a known condition recurred beyond its attempt budget
  | 'POLICY_BLOCKED' // the ActionGate (or a pre-flight policy check) refused
  | 'SURFACE_ERROR'; // the driver itself failed (crash, stale ref, browser gone)

export interface ReplayFailure {
  class: FailureClass;
  stepId?: string;
  /** What the artifact expected — rendered conditions / target description. */
  expected: string;
  /** What was actually observed — location, headings, dialogs, candidates. */
  observed: string;
  /** Evidence-relative path to the failure screenshot, when one could be taken. */
  screenshotRef?: string;
}

export interface StepTrace {
  stepId: string;
  intent: string;
  status: 'ok' | 'failed' | 'skipped';
  /** Which locator strategy fired (0 = most robust) — the drift signal. */
  strategyIndex?: number;
  strategy?: string;
  score?: number;
  ms: number;
}

export interface RecoveryUse {
  code: string;
  attempts: number;
}

// ---------- human-in-the-loop contract ----------

export type InterventionKind =
  /** An irreversible action awaits a human decision before it is performed. */
  | 'approve_risky'
  /** The run hit a state only a human can clear (e.g. supervisor authorization). */
  | 'human_action_required'
  /** Discovery/replay is stuck with no declared handling. */
  | 'agent_stuck';

export type OperatorAction = 'approve' | 'resume' | 'abort';

/** Everything a human operator needs to act: what, where, why, and the live state. */
export interface InterventionRequest {
  id: string;
  at: string;
  kind: InterventionKind;
  /**
   * Which path raised it. Replay interventions describe a hash-verified,
   * human-approved artifact; discovery interventions describe an unreviewed
   * recording in progress — an operator console must be able to tell.
   */
  origin?: 'discovery' | 'replay';
  capabilityId: string;
  version: string;
  runId: string;
  stepId?: string;
  stepIntent?: string;
  /** Why the automation stopped. */
  reason: string;
  /** What the operator is expected to do. */
  suggestedResolution: string;
  /** Which resolutions are meaningful for this intervention. */
  options: OperatorAction[];
  observationSummary: string;
  screenshotRef?: string;
}

export interface OperatorResolution {
  action: OperatorAction;
  note?: string;
  at: string;
}

/** What ends up in the replay result + evidence about each intervention. */
export interface InterventionRecord {
  id: string;
  kind: InterventionKind;
  stepId?: string;
  reason: string;
  resolution: OperatorAction;
  note?: string;
  /** Number of human actions captured on the live session during the handoff. */
  humanActions: number;
  heldForMs: number;
}

interface ResultBase {
  capabilityId: string;
  version: string;
  runId: string;
  evidenceDir: string;
  /**
   * The operator role the run signed on as, when the invocation resolved one.
   * Credentials reach an artifact through fixed env var names whichever role
   * supplied them, so without this the result of a supervisor-authority run is
   * indistinguishable from a teller's — there would be no field to query.
   */
  role?: string;
  stepsRun: StepTrace[];
  recoveriesUsed: RecoveryUse[];
  /** Human handoffs that occurred during the run (empty when fully unattended). */
  interventions: InterventionRecord[];
  /**
   * True if any irreversible action was DISPATCHED during the run — counted
   * the moment it passes the gate, not when its checkpoint confirms, because
   * the side effect may have taken place regardless of what the UI showed
   * afterwards. The retry-decision signal for calling agents: a 'failed'
   * result with irreversibleCompleted=true must NOT be blindly re-invoked.
   */
  irreversibleCompleted: boolean;
  startedAt: string;
  finishedAt: string;
}

export type ReplayResult =
  | (ResultBase & { status: 'success'; outputs: Record<string, string> })
  | (ResultBase & { status: 'business_outcome'; code: string; message: string; outputs: Record<string, string> })
  /** The run ENDED at an escalation (aborted, or no operator was available).
   * A run that escalated and then resumed to completion reports success /
   * business_outcome with the handoff in `interventions`. */
  | (ResultBase & { status: 'escalated'; interventionId: string; reason: string; resolution: 'aborted_by_operator' | 'no_operator_available' })
  | (ResultBase & { status: 'failed'; failure: ReplayFailure });
