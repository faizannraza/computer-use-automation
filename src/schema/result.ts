/**
 * The replay result contract. The four-way top-level split is the load-
 * bearing design decision: an expected business outcome ("no such member")
 * is a DIFFERENT TYPE from a failure, so conflating them — the most common
 * design mistake in this domain — is structurally impossible.
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

interface ResultBase {
  capabilityId: string;
  version: string;
  runId: string;
  evidenceDir: string;
  stepsRun: StepTrace[];
  recoveriesUsed: RecoveryUse[];
  startedAt: string;
  finishedAt: string;
}

export type ReplayResult =
  | (ResultBase & { status: 'success'; outputs: Record<string, string> })
  | (ResultBase & { status: 'business_outcome'; code: string; message: string; outputs: Record<string, string> })
  | (ResultBase & { status: 'escalated'; interventionId: string; reason: string; resolution: string })
  | (ResultBase & { status: 'failed'; failure: ReplayFailure });
