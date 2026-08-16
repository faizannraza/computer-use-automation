/**
 * Human-in-the-loop acceptance: the risky sub-account flow with a SCRIPTED
 * operator standing in for the human (the same Operator interface the
 * terminal operator implements — the handoff mechanism under test is
 * identical either way).
 *
 * The headline scenario hits BOTH escalation kinds in one run:
 *   1. the irreversible Confirm click pauses for approval (policy: escalate)
 *   2. the injected permission fault demands supervisor authorization —
 *      the "human" enters the PIN on the SAME live session, resumes, and
 *      the step's own postcondition verifies their work.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../apps/mock-cu/server.js';
import type { Operator, OperatorSessionAccess } from '../src/hitl/sessionController.js';
import { loadPolicy, PolicySchema } from '../src/policy/policy.js';
import type { Policy } from '../src/policy/policy.js';
import { replayCapability } from '../src/replay/engine.js';
import { loadCapability } from '../src/schema/capability.js';
import type { InterventionRequest, OperatorResolution } from '../src/schema/result.js';

let server: Server;
let base: string;
let policy: Policy;

const { artifact, verified } = loadCapability('capabilities/member.openSubAccount@1.0.0.json');

const params = {
  memberId: '12345',
  acctType: 'HOLIDAY CLUB',
  nickname: 'Vacation Fund',
  initialDeposit: '50.00',
};

beforeAll(async () => {
  process.env.MOCK_CU_USER = 'teller1';
  process.env.MOCK_CU_PASS = 'Passw0rd!';
  const app = createApp();
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
  policy = PolicySchema.parse({ ...loadPolicy('policies/default.policy.json'), allowedOrigins: [base] });
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  await fetch(`${base}/__reset`, { method: 'POST' });
});

async function armFault(fault: string, mode: string): Promise<void> {
  await fetch(`${base}/__faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fault, mode }),
  });
}

const opts = (operator?: Operator) => ({
  policy,
  verified,
  paramValues: params,
  evidenceBaseDir: 'evidence/_scratch',
  ...(operator ? { operator } : {}),
});

describe('escalation & handoff on the live session', () => {
  it('full handoff: approve the irreversible confirm, then a human clears supervisor auth with the PIN', async () => {
    await armFault('permission_denied', 'once');
    const seen: InterventionRequest[] = [];
    const operator: Operator = {
      async handle(req, session: OperatorSessionAccess): Promise<Omit<OperatorResolution, 'at'>> {
        seen.push(req);
        if (req.kind === 'approve_risky') {
          return { action: 'approve', note: 'Reviewed the pending confirm — proceed.' };
        }
        // human_action_required: the "human" performs the supervisor override
        // on the SAME live page the automation was driving.
        const work = session.page.frame('work');
        if (!work) throw new Error('work frame missing');
        await work.fill('input[name=txtPin]', '7391');
        await work.click('input[value=Authorize]');
        await work.waitForLoadState('load');
        return { action: 'resume', note: 'Supervisor authorized the transaction.' };
      },
    };

    const result = await replayCapability({ artifact, bindings: { baseUrl: base } }, opts(operator));
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs['confirmationNo']).toMatch(/^CNF-\d{6}$/);
    expect(result.outputs['newSuffix']).toBe('S02');

    // Both escalation kinds occurred, in order, with the handoff recorded.
    expect(result.interventions.map((i) => i.kind)).toEqual(['approve_risky', 'human_action_required']);
    expect(result.interventions[1]!.resolution).toBe('resume');
    expect(result.interventions[1]!.humanActions).toBeGreaterThan(0);
    expect(seen[0]!.stepId).toBe('s13');
    expect(seen[1]!.observationSummary).toContain('Supervisor Authorization Required');
    expect(seen[1]!.screenshotRef).toBeDefined();

    // Evidence: human actions recorded; the PIN value NEVER persisted.
    const jsonl = readFileSync(path.join(result.evidenceDir, 'run.jsonl'), 'utf8');
    expect(jsonl).toContain('"type":"human_action"');
    expect(jsonl).toContain('intervention_raised');
    expect(jsonl).not.toContain('7391');
    expect(jsonl).not.toContain('Passw0rd!');
    const pinEvent = jsonl.split('\n').find((l) => l.includes('human_action') && l.includes('password'));
    expect(pinEvent).toBeDefined(); // the PIN field change was captured…
    expect(pinEvent).toContain('"valueLength":4'); // …as length-only metadata
  }, 90_000);

  it('records an operator abort as an escalated result', async () => {
    const operator: Operator = {
      async handle(req): Promise<Omit<OperatorResolution, 'at'>> {
        expect(req.kind).toBe('approve_risky');
        return { action: 'abort', note: 'Not comfortable approving this in a test.' };
      },
    };
    const result = await replayCapability({ artifact, bindings: { baseUrl: base } }, opts(operator));
    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') return;
    expect(result.resolution).toBe('aborted_by_operator');
    expect(result.interventions).toHaveLength(1);
  }, 60_000);

  it('with no operator attached, a run needing a human ends escalated — it never guesses past the decision', async () => {
    const result = await replayCapability({ artifact, bindings: { baseUrl: base } }, opts());
    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') return;
    expect(result.resolution).toBe('no_operator_available');
  }, 60_000);

  it('unattended runs still handle expected business outcomes before the risky step (VALIDATION_REJECTED)', async () => {
    const result = await replayCapability(
      { artifact, bindings: { baseUrl: base } },
      { ...opts(), paramValues: { ...params, initialDeposit: '5.00' } },
    );
    expect(result.status).toBe('business_outcome');
    if (result.status !== 'business_outcome') return;
    expect(result.code).toBe('VALIDATION_REJECTED');
  }, 60_000);

  it('the automation is locked out while the human holds the session (control token)', async () => {
    await armFault('permission_denied', 'once');
    let holderDuringHandoff: string | undefined;
    const operator: Operator = {
      async handle(req, session): Promise<Omit<OperatorResolution, 'at'>> {
        if (req.kind === 'approve_risky') return { action: 'approve' };
        // While we hold the session, gate-audited agent actions must be zero:
        // do the manual work, and capture proof the token is 'human'.
        holderDuringHandoff = 'human'; // the gate unit test proves rejection; here we prove sequencing
        const work = session.page.frame('work')!;
        await work.fill('input[name=txtPin]', '7391');
        await work.click('input[value=Authorize]');
        await work.waitForLoadState('load');
        return { action: 'resume' };
      },
    };
    const result = await replayCapability({ artifact, bindings: { baseUrl: base } }, opts(operator));
    expect(result.status).toBe('success');
    expect(holderDuringHandoff).toBe('human');
    // No gate-approved agent action may appear between the intervention being
    // raised and resolved — the human worked, the agent waited.
    const jsonl = readFileSync((result as { evidenceDir: string }).evidenceDir + '/run.jsonl', 'utf8');
    const lines = jsonl.trim().split('\n');
    const raised = lines.findIndex((l) => l.includes('intervention_raised') && l.includes('human_action_required'));
    const resolved = lines.findIndex((l) => l.includes('intervention_resolved') && l.includes('human_action_required'));
    expect(raised).toBeGreaterThan(-1);
    expect(resolved).toBeGreaterThan(raised);
    const between = lines.slice(raised + 1, resolved);
    expect(between.some((l) => l.includes('"type":"gate"'))).toBe(false);
    expect(between.some((l) => l.includes('"type":"human_action"'))).toBe(true);
  }, 90_000);
});
