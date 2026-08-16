/**
 * The minimal-but-real operator surface: the intervention context renders in
 * the terminal, the human works directly in the live headed browser window
 * (the same session the automation was driving), then types their
 * resolution. A production operator console (remote view via CDP screencast,
 * queueing, assignment) would implement the same Operator interface — the
 * handoff mechanism and control-transfer model do not change.
 */
import * as readline from 'node:readline/promises';
import type { InterventionRequest, OperatorAction, OperatorResolution } from '../schema/result.js';
import type { Operator, OperatorSessionAccess } from './sessionController.js';

export class TerminalOperator implements Operator {
  async handle(req: InterventionRequest, _session: OperatorSessionAccess): Promise<Omit<OperatorResolution, 'at'>> {
    const line = '─'.repeat(72);
    process.stderr.write(
      [
        '',
        line,
        `** HUMAN INTERVENTION REQUIRED ** [${req.id}] (${req.kind})`,
        line,
        `capability : ${req.capabilityId}@${req.version}  (run ${req.runId})`,
        `step       : ${req.stepId ?? '—'} — ${req.stepIntent ?? ''}`,
        `reason     : ${req.reason}`,
        `state      : ${req.observationSummary}`,
        `what to do : ${req.suggestedResolution}`,
        '',
        'You now control the LIVE browser window — the automation cannot act',
        'until you resolve this. Perform any manual work there first.',
        '',
        `resolutions: ${req.options.map(describe).join('  |  ')}`,
        line,
        '',
      ].join('\n'),
    );
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    // stdin EOF (Ctrl+D, or a non-interactive pipe) must resolve the
    // intervention as an abort — a handoff that can never be answered must
    // not hang the run forever with no result written.
    const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
    try {
      for (;;) {
        const raw = await Promise.race([rl.question(`resolution (${req.options.join('/')}) [+ optional note]: `), closed]);
        if (raw === null) return { action: 'abort', note: 'operator input stream closed (EOF) — aborting' };
        const answer = raw.trim();
        const [word, ...noteParts] = answer.split(/\s+/);
        const action = word?.toLowerCase() as OperatorAction;
        if (req.options.includes(action)) {
          const note = noteParts.join(' ');
          return { action, ...(note ? { note } : {}) };
        }
        process.stderr.write(`  please answer one of: ${req.options.join(', ')}\n`);
      }
    } finally {
      rl.close();
    }
  }
}

function describe(action: OperatorAction): string {
  switch (action) {
    case 'approve':
      return 'approve (perform the pending risky action)';
    case 'resume':
      return 'resume (I have done the manual work — continue)';
    case 'abort':
      return 'abort (stop this run)';
  }
}
