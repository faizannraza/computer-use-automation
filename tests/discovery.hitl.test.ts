/**
 * Discovery-time human-in-the-loop, with NO model and NO API key: the tool
 * executor (the harness half of the discovery loop) is driven directly, the
 * way the model would drive it. An irreversible click under the default
 * policy (mode 'escalate') must pause the RECORDING for a human decision —
 * the same control-token handoff replay uses — which is what makes risky
 * flows discoverable rather than hand-authored.
 */
import type { Server } from 'node:http';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../apps/mock-cu/server.js';
import { DiscoveryToolExecutor } from '../src/discovery/toolExecutor.js';
import { Recorder } from '../src/discovery/recorder.js';
import { RunLog } from '../src/evidence/runLog.js';
import type { Operator } from '../src/hitl/sessionController.js';
import { SessionController } from '../src/hitl/sessionController.js';
import { ActionGate } from '../src/policy/actionGate.js';
import { PolicySchema, loadPolicy } from '../src/policy/policy.js';
import type { Policy } from '../src/policy/policy.js';
import { Redactor } from '../src/policy/redact.js';
import { PlaywrightWebSurface } from '../src/surface/web/playwrightSurface.js';

let server: Server;
let base: string;
let policy: Policy;
let surface: PlaywrightWebSurface;

beforeAll(async () => {
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

afterEach(async () => {
  await surface?.close();
});

interface Setup {
  executor: DiscoveryToolExecutor;
  recorder: Recorder;
  controller?: SessionController;
  gate: ActionGate;
}

async function setup(operator?: Operator): Promise<Setup> {
  surface = await PlaywrightWebSurface.launch();
  const log = new RunLog('discovery', { baseDir: 'evidence/_scratch', redactor: new Redactor() });
  const recorder = new Recorder('test goal');
  const controller = operator ? new SessionController(surface, log, operator) : undefined;
  const gate = new ActionGate(policy, surface, { getHolder: () => controller?.holder() ?? 'agent' });
  const executor = new DiscoveryToolExecutor({
    surface,
    gate,
    recorder,
    log,
    redactor: new Redactor(),
    paramValues: {},
    outputHints: {},
    runId: log.runId,
    ...(controller ? { controller } : {}),
  });
  return { executor, recorder, gate, ...(controller ? { controller } : {}) };
}

/** Navigate to the sign-in screen and return the Sign In button's ref. */
async function reachSignIn(executor: DiscoveryToolExecutor): Promise<number> {
  const nav = await executor.handle('navigate', { url: `${base}/login`, intent: 'Open the sign-in screen' });
  expect(nav.isError).toBeUndefined();
  const el = surface.lastObservation()!.elements.find((e) => e.role === 'button' && e.name === 'Sign In');
  expect(el).toBeDefined();
  return el!.ref;
}

describe('discovery-time escalation of irreversible clicks', () => {
  it('approve: the recording pauses, the gate locks the agent out, the click runs once and carries provenance', async () => {
    const denialsDuringHandoff: string[] = [];
    const operator: Operator = {
      async handle(req, session) {
        expect(req.kind).toBe('approve_risky');
        expect(req.origin).toBe('discovery'); // an operator console can tell recording from replay
        expect(req.capabilityId).toBe('(discovery)');
        expect(req.reason).toContain('RISK_NEEDS_ESCALATION');
        // The human approves against harness-derived identity, not model prose.
        expect(req.reason).toContain('target (harness-verified): button "Sign In"');
        expect(req.stepIntent).toContain('[model-authored]');
        expect(req.options).toEqual(['approve', 'abort']);
        expect(session.page).toBeDefined(); // the SAME live session
        // While the human holds the token, the recording cannot act at all.
        const probe = setups.gate.authorize({ kind: 'read', ref: 0 }, { risk: 'read' });
        expect(probe.allowed).toBe(false);
        if (probe.code) denialsDuringHandoff.push(probe.code);
        return { action: 'approve', note: 'scripted test approval' };
      },
    };
    const setups = await setup(operator);
    const ref = await reachSignIn(setups.executor);
    const outcome = await setups.executor.handle('click', { ref, intent: 'Commit the risky action', irreversible: true });
    expect(outcome.isError).toBeUndefined();

    expect(denialsDuringHandoff).toEqual(['NOT_IN_CONTROL']);
    // The handoff was recorded, and the action carries its approval provenance.
    expect(setups.controller!.records).toHaveLength(1);
    expect(setups.controller!.records[0]).toMatchObject({ id: 'int-01', kind: 'approve_risky', resolution: 'approve' });
    const actions = setups.recorder.get().actions;
    const click = actions[actions.length - 1]!;
    expect(click).toMatchObject({ kind: 'activate', risk: 'irreversible', approvedIntervention: 'int-01' });
  }, 60_000);

  it('abort: never executed, never recorded, flagged for the compiler — and the refusal is STICKY', async () => {
    const operator: Operator = {
      async handle() {
        return { action: 'abort' as const, note: 'scripted refusal' };
      },
    };
    const setups = await setup(operator);
    const ref = await reachSignIn(setups.executor);
    const before = setups.recorder.get().actions.length;
    const outcome = await setups.executor.handle('click', { ref, intent: 'Commit the risky action', irreversible: true });
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome.blocks)).toContain('DECLINED');
    // Nothing was recorded: a refused action must not enter the trace — but
    // the refusal itself IS on record for the artifact reviewer.
    expect(setups.recorder.get().actions).toHaveLength(before);
    expect(setups.recorder.get().declinedInterventions).toEqual([{ id: 'int-01', intent: 'Commit the risky action' }]);
    expect(setups.controller!.records[0]).toMatchObject({ kind: 'approve_risky', resolution: 'abort' });

    // The refusal sticks to the CONTROL, not to the risk label: re-issuing
    // the same click as "reversible" must not slip past the human's decision.
    const freshRef = surface.lastObservation()!.elements.find((e) => e.role === 'button' && e.name === 'Sign In')!.ref;
    const retry = await setups.executor.handle('click', { ref: freshRef, intent: 'Just a normal click, honest' });
    expect(retry.isError).toBe(true);
    expect(JSON.stringify(retry.blocks)).toContain('must not be activated');
    expect(setups.recorder.get().actions).toHaveLength(before); // still nothing recorded
    expect(setups.controller!.records).toHaveLength(1); // and no second handoff was needed
  }, 60_000);

  it('no operator attached: the refusal reaches the model as a policy error (pre-HITL behavior)', async () => {
    const setups = await setup();
    const ref = await reachSignIn(setups.executor);
    const outcome = await setups.executor.handle('click', { ref, intent: 'Commit the risky action', irreversible: true });
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome.blocks)).toContain('POLICY: RISK_NEEDS_ESCALATION');
    expect(setups.recorder.get().actions.filter((a) => a.kind === 'activate')).toHaveLength(0);
  }, 60_000);

  it('reversible clicks never escalate', async () => {
    const operator: Operator = {
      async handle() {
        throw new Error('must not be called for a reversible click');
      },
    };
    const setups = await setup(operator);
    const ref = await reachSignIn(setups.executor);
    const outcome = await setups.executor.handle('click', { ref, intent: 'Ordinary click' });
    expect(outcome.isError).toBeUndefined();
    expect(setups.controller!.records).toHaveLength(0);
  }, 60_000);
});
