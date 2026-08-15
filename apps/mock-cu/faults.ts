/**
 * Deterministic fault injection for the mock credit-union app.
 *
 * The whole point of building a local target app is that runtime errors —
 * the interesting failures in this domain — can be triggered on demand and
 * reproduced exactly. Faults are set via the test-harness endpoints
 * (POST /__faults) and are consumed either once ('once') or on every
 * request ('on') until turned off.
 *
 * These endpoints are part of the TEST HARNESS, not the simulated bank app:
 * the automation policy allowlist never permits the agent to touch them.
 */

export type FaultName =
  | 'slow_load' // delays the next page load (transient slowness)
  | 'session_timeout' // expires the operator session (re-auth required)
  | 'permission_denied' // confirm step requires supervisor authorization
  | 'interstitial' // known dismissible notice page before the requested page
  | 'native_dialog' // page fires a native confirm() dialog on load
  | 'duplicate_button' // renders a second identical Search button (ambiguity)
  | 'app_error'; // outright HTTP 500 application error

export type FaultMode = 'off' | 'once' | 'on';

export interface FaultState {
  mode: FaultMode;
  /** Fault-specific parameter (e.g. delay in ms for slow_load). */
  param?: number;
}

const ALL_FAULTS: FaultName[] = [
  'slow_load',
  'session_timeout',
  'permission_denied',
  'interstitial',
  'native_dialog',
  'duplicate_button',
  'app_error',
];

const state = new Map<FaultName, FaultState>();

export function isFaultName(name: string): name is FaultName {
  return (ALL_FAULTS as string[]).includes(name);
}

export function setFault(name: FaultName, mode: FaultMode, param?: number): void {
  if (mode === 'off') {
    state.delete(name);
  } else {
    state.set(name, param === undefined ? { mode } : { mode, param });
  }
}

export function resetFaults(): void {
  state.clear();
}

/** Non-consuming check — use when the same activation must affect a whole render. */
export function peekFault(name: FaultName): FaultState | undefined {
  return state.get(name);
}

/** Consuming check — a 'once' fault deactivates the first time it fires. */
export function triggerFault(name: FaultName): FaultState | undefined {
  const s = state.get(name);
  if (!s) return undefined;
  if (s.mode === 'once') state.delete(name);
  return s;
}

/** Native-dialog fault: pages accept an optional confirm() text to fire on load. */
export function consumeNativeDialog(): string | null {
  const hit = triggerFault('native_dialog');
  return hit
    ? 'Reminder: quarterly compliance attestation is due Friday. Continue to the requested screen?'
    : null;
}

export function faultsSnapshot(): Record<string, FaultState> {
  const out: Record<string, FaultState> = {};
  for (const [k, v] of state) out[k] = v;
  return out;
}
