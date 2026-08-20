/**
 * The Surface seam: everything above this interface (discovery agent, replay
 * engine, policy gate, HITL controller) perceives and acts through it;
 * everything below it (Playwright today, a UIA/AX desktop driver in the
 * design) is an implementation detail. No Playwright type crosses this line.
 */
import type { ActResultValue, Observation, SemanticAction } from '../core/types.js';
import type { TargetRef } from '../schema/locators.js';

export interface Resolution {
  ok: true;
  /** Element ref within the observation the target resolved against. */
  ref: number;
  /** Which strategy in the ordered stack fired (0 = most robust). Drift telemetry. */
  strategyIndex: number;
  strategy: string;
  score: number;
}

export interface CandidateInfo {
  ref: number;
  role: string;
  name: string;
  score: number;
}

export interface ResolutionFailure {
  ok: false;
  reason: 'not_found' | 'ambiguous';
  /** The competing candidates (ambiguous) or best near-misses (not_found). */
  candidates: CandidateInfo[];
  detail: string;
}

export interface Surface {
  /** Capture a fresh point-in-time Observation (element map, text, screenshot, held dialog). */
  observe(): Promise<Observation>;
  /** The most recent observation, if any. Refs are only valid against this. */
  lastObservation(): Observation | undefined;
  /** Resolve a recorded target against the latest observation via the strategy ladder. */
  resolve(target: TargetRef): Promise<Resolution | ResolutionFailure>;
  /** Perform a semantic action. Callers must go through the ActionGate, never call this directly. */
  act(action: SemanticAction): Promise<ActResultValue>;
  /** Best-effort quiescence wait (load states settle). Condition-based waiting lives above. */
  settle(timeoutMs?: number): Promise<void>;
  /** Current top-level location (URL / window identity) for policy checks. */
  currentLocation(): string;
  /**
   * Optional: install the classifier that decides which observed elements are
   * blacked out in evidence captures, so regulated data classified by the app
   * profile does not persist in images.
   *
   * It takes a CALLBACK rather than a ref list because refs are meaningful only
   * within one observation generation. A caller who classified the previous
   * observation and handed back integers would be masking by numbers that the
   * next observation has already reassigned — and the capture that most needs
   * masking (the one where regulated data first appears) would go out clean,
   * with the stale refs blacking out unrelated nodes on the capture after it.
   * The surface invokes this against the observation it is about to capture.
   *
   * Optional because it is a property of a capturing surface, not of the seam.
   */
  setScreenshotMask?(classify: (observation: Observation) => number[]): void;
  /**
   * Optional harness affordance: force the target app's documented runtime
   * fault on the next request. Optional because it is a property of a driver
   * that can intercept requests — nothing in a recorded artifact can reach it.
   */
  armFaultInjection?(param: string, kind: string): Promise<void>;
  /**
   * Drop whatever the surface holds that makes the target treat this as an
   * established session (cookies, storage). Restarting a run means starting
   * over; without this, a session-based app skips its own sign-on and the
   * flow re-enters halfway through.
   */
  resetSession?(): Promise<void>;
  close(): Promise<void>;
}
