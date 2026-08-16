/**
 * The SessionController: owner of "who is in control" of the live session.
 *
 * The control-transfer model:
 *   AGENT_ACTIVE --escalate()--> HUMAN_ACTIVE --resolution--> AGENT_ACTIVE
 *                                              --abort------> (run ends via
 *                                                              the engine's
 *                                                              escalated result)
 *
 * The token is not advisory: the ActionGate calls holder() on every single
 * action, so while a handoff is open the automation is locked out —
 * the same choke point that enforces the allowlist enforces possession.
 * There is exactly one live session (one browser context); nothing is
 * transferred to the human except control, which is why cookies, server
 * session, and page state are inherently preserved across the handoff.
 *
 * Resume verification lives in the engine, not here: the engine re-enters
 * its classification loop after a handoff, so the step's own postcondition
 * (or the next escalation) judges the human's work — one verification
 * vocabulary for machine and human actions alike.
 */
import type { ControlHolder } from '../core/types.js';
import type { RunLog } from '../evidence/runLog.js';
import type {
  InterventionRecord,
  InterventionRequest,
  OperatorResolution,
} from '../schema/result.js';
import type { PlaywrightWebSurface } from '../surface/web/playwrightSurface.js';
import { HumanCapture } from './humanCapture.js';

/** The operator seam: a terminal prompt today; a remote console would
 * implement the same interface over CDP screencast without touching the
 * controller. Tests implement it with a scripted "human". */
export interface Operator {
  handle(request: InterventionRequest, session: OperatorSessionAccess): Promise<Omit<OperatorResolution, 'at'>>;
}

/** What the operator's surface may use while it holds the session. */
export interface OperatorSessionAccess {
  /** The live Playwright page — the SAME session the automation was driving. */
  page: PlaywrightWebSurface['page'];
}

export type SessionState = 'AGENT_ACTIVE' | 'HUMAN_ACTIVE';

export class SessionController {
  private state: SessionState = 'AGENT_ACTIVE';
  private readonly capture: HumanCapture;
  private humanActionCount = 0;
  private interventionCount = 0;
  readonly records: InterventionRecord[] = [];

  constructor(
    private readonly surface: PlaywrightWebSurface,
    private readonly log: RunLog,
    private readonly operator: Operator,
  ) {
    this.capture = new HumanCapture(surface.page, (e) => {
      this.humanActionCount += 1;
      this.log.event('human_action', { ...e });
    });
  }

  holder(): ControlHolder {
    return this.state === 'HUMAN_ACTIVE' ? 'human' : 'agent';
  }

  /**
   * Route an intervention to the operator and cede control of the live
   * session until they resolve it. Returns the resolution; recording the
   * outcome and re-verifying state is the caller's (engine's) job.
   */
  async escalate(request: Omit<InterventionRequest, 'id' | 'at'>): Promise<OperatorResolution> {
    if (this.state !== 'AGENT_ACTIVE') throw new Error(`cannot escalate from state ${this.state}`);
    this.interventionCount += 1;
    const full: InterventionRequest = {
      ...request,
      id: `int-${String(this.interventionCount).padStart(2, '0')}`,
      at: new Date().toISOString(),
    };
    this.log.event('intervention_raised', { id: full.id, kind: full.kind, stepId: full.stepId, reason: full.reason });
    this.log.writeJson(`intervention-${full.id}`, full);

    this.state = 'HUMAN_ACTIVE';
    const actionsBefore = this.humanActionCount;
    const t0 = Date.now();
    await this.capture.start();
    let resolution: Omit<OperatorResolution, 'at'>;
    try {
      resolution = await this.operator.handle(full, { page: this.surface.page });
      if (!full.options.includes(resolution.action)) {
        throw new Error(`operator returned '${resolution.action}' but options were [${full.options.join(', ')}]`);
      }
    } finally {
      this.capture.stop();
      this.state = 'AGENT_ACTIVE';
    }
    const record: InterventionRecord = {
      id: full.id,
      kind: full.kind,
      reason: full.reason,
      resolution: resolution.action,
      humanActions: this.humanActionCount - actionsBefore,
      heldForMs: Date.now() - t0,
      ...(full.stepId !== undefined ? { stepId: full.stepId } : {}),
      ...(resolution.note !== undefined ? { note: resolution.note } : {}),
    };
    this.records.push(record);
    this.log.event('intervention_resolved', { ...record });
    return { ...resolution, at: new Date().toISOString() };
  }
}
