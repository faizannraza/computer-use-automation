/**
 * A non-interactive operator for RECORDING sessions.
 *
 * Discovering a risky flow means the model eventually clicks the button that
 * posts. The gate refuses it and demands a human — correctly — which makes an
 * unattended recording of such a flow impossible. This operator is the
 * pre-authorisation an engineer gives before starting the recording: "I am
 * deliberately recording the transfer flow against a demo institution; approve
 * the posting steps."
 *
 * It is deliberately NOT a general auto-approver:
 *  - it only answers `approve_risky` (a decision). Anything needing a human to
 *    act on the live session is aborted, because no one is watching.
 *  - every approval is stamped with a note naming it as harness
 *    pre-authorisation. That note travels on the resolution, so it lands on the
 *    run log's `intervention_resolved` event; the compile report separately
 *    flags the step as human-approved during discovery, without the name.
 * Replay is unaffected: a replayed artifact still escalates to a real operator.
 */
import type { Operator, OperatorSessionAccess } from './sessionController.js';
import type { InterventionRequest, OperatorResolution } from '../schema/result.js';

export class RecordingOperator implements Operator {
  constructor(private readonly authorisedBy: string) {}

  async handle(req: InterventionRequest, _session: OperatorSessionAccess): Promise<Omit<OperatorResolution, 'at'>> {
    if (req.kind !== 'approve_risky' || !req.options.includes('approve')) {
      return {
        action: 'abort',
        note: 'recording operator answers approval decisions only; this intervention needs a human on the live session',
      };
    }
    return {
      action: 'approve',
      note: `pre-authorised for recording by ${this.authorisedBy} — non-interactive discovery against a demo institution`,
    };
  }
}
