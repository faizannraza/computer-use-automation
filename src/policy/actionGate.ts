/**
 * The ActionGate: the single choke point through which EVERY action reaches
 * the surface — LLM discovery, deterministic replay, no exceptions. It
 * enforces, in one auditable place:
 *   1. who is in control (the agent physically cannot act during a human
 *      takeover — the HITL control token is checked here, not by convention),
 *   2. the origin/path allowlist,
 *   3. the action-kind allowlist,
 *   4. risk-class handling for irreversible actions.
 *
 * Nothing else in the codebase calls surface.act().
 */
import type { ActResultValue, ControlHolder, RiskClass, SemanticAction } from '../core/types.js';
import type { Surface } from '../surface/surface.js';
import type { Policy } from './policy.js';

export type DenyCode =
  | 'NOT_IN_CONTROL'
  | 'ACTION_KIND_DISALLOWED'
  | 'OFF_ORIGIN'
  | 'PATH_DENIED'
  | 'RISK_BLOCKED'
  | 'RISK_NEEDS_ESCALATION';

export interface GateContext {
  risk: RiskClass;
  /**
   * Set when a human (via intervention) or the invoking caller (policy mode
   * 'confirm') has explicitly approved this specific irreversible action.
   */
  approved?: boolean;
  /**
   * The document URL of the FRAME the target element lives in. Element
   * actions dispatch into frames, and a page on an allowed origin can embed
   * an off-origin frame — so the frame's own origin is checked too.
   */
  frameUrl?: string | undefined;
}

export interface GateDecision {
  allowed: boolean;
  code?: DenyCode;
  reason?: string;
}

export interface GateEvent {
  action: SemanticAction;
  context: GateContext;
  decision: GateDecision;
  location: string;
}

export class PolicyViolation extends Error {
  constructor(
    readonly code: DenyCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'PolicyViolation';
  }
}

export interface ActionGateOptions {
  /** Who currently holds the live session. Defaults to agent-always (pre-HITL). */
  getHolder?: () => ControlHolder;
  /** Audit sink — every decision, allowed or denied, is reported. */
  onEvent?: (event: GateEvent) => void;
}

export class ActionGate {
  constructor(
    private readonly policy: Policy,
    private readonly surface: Surface,
    private readonly opts: ActionGateOptions = {},
  ) {}

  /** Pure decision — exposed separately so it is unit-testable and reusable. */
  authorize(action: SemanticAction, ctx: GateContext): GateDecision {
    const holder = this.opts.getHolder?.() ?? 'agent';
    if (holder !== 'agent') {
      return deny('NOT_IN_CONTROL', `session is held by '${holder}' — automation may not act`);
    }
    if (!this.policy.allowedActions.includes(action.kind)) {
      return deny('ACTION_KIND_DISALLOWED', `action kind '${action.kind}' is not in the policy allowlist`);
    }

    // Where does this action land? Navigations are checked against their
    // destination; element actions against the current top-level location
    // AND the target element's own frame (frames can be off-origin even
    // when the page is allowed).
    const locations = action.kind === 'navigate' ? [action.url] : [this.surface.currentLocation()];
    if (ctx.frameUrl !== undefined && ctx.frameUrl !== '') locations.push(ctx.frameUrl);
    for (const rawUrl of locations) {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return deny('OFF_ORIGIN', `unparseable location '${rawUrl}'`);
      }
      if (!this.policy.allowedOrigins.includes(url.origin)) {
        return deny('OFF_ORIGIN', `origin '${url.origin}' is not in the allowlist`);
      }
      if (this.policy.deniedPathPrefixes.some((p) => url.pathname.startsWith(p))) {
        return deny('PATH_DENIED', `path '${url.pathname}' is explicitly denied`);
      }
      if (
        this.policy.allowedPathPrefixes.length > 0 &&
        !this.policy.allowedPathPrefixes.some((p) => url.pathname.startsWith(p))
      ) {
        return deny('PATH_DENIED', `path '${url.pathname}' is outside the allowed prefixes`);
      }
    }

    if (ctx.risk === 'irreversible' && !ctx.approved) {
      switch (this.policy.irreversibleActionMode) {
        case 'block':
          return deny('RISK_BLOCKED', 'irreversible action and policy mode is block');
        case 'confirm':
          return deny('RISK_BLOCKED', 'irreversible action requires up-front confirmation (policy mode: confirm)');
        case 'escalate':
          return deny('RISK_NEEDS_ESCALATION', 'irreversible action requires human approval (policy mode: escalate)');
      }
    }
    return { allowed: true };
  }

  /** Authorize, audit, then act. The ONLY path to surface.act(). */
  async execute(action: SemanticAction, ctx: GateContext): Promise<ActResultValue> {
    const decision = this.authorize(action, ctx);
    this.opts.onEvent?.({ action, context: ctx, decision, location: this.surface.currentLocation() });
    if (!decision.allowed) {
      throw new PolicyViolation(decision.code!, decision.reason!);
    }
    return this.surface.act(action);
  }
}

function deny(code: DenyCode, reason: string): GateDecision {
  return { allowed: false, code, reason };
}
