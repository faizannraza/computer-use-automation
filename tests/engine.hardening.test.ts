/**
 * Hardening suite from the adversarial review: the engine's remaining
 * classification branches (timeout, exhausted recovery, precondition,
 * anomaly), the refuse-restart-after-irreversible safety guard, and the
 * guarantee that FAILED results keep their forensics (step traces,
 * recoveries, the irreversible-completed signal).
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../apps/mock-cu/server.js';
import type { Operator } from '../src/hitl/sessionController.js';
import { loadPolicy, PolicySchema } from '../src/policy/policy.js';
import type { Policy } from '../src/policy/policy.js';
import { replayCapability } from '../src/replay/engine.js';
import { CapabilityArtifactSchema, computeContentHash, loadCapability } from '../src/schema/capability.js';
import type { CapabilityArtifact } from '../src/schema/capability.js';

let server: Server;
let base: string;
let policy: Policy;

const { artifact: gold } = loadCapability('tests/fixtures/member.readSavingsBalance.gold.json');

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

function variant(mutate: (a: CapabilityArtifact) => void): CapabilityArtifact {
  const a = structuredClone(gold);
  mutate(a);
  a.integrity.contentHash = computeContentHash(a);
  return CapabilityArtifactSchema.parse(a);
}

const opts = () => ({
  policy,
  verified: true,
  paramValues: { memberId: '12345' },
  evidenceBaseDir: 'evidence/_scratch',
});

describe('engine classification branches', () => {
  it('POSTCONDITION_TIMEOUT — and failed results KEEP their step traces', async () => {
    const a = variant((x) => {
      const s3 = x.steps.find((s) => s.id === 's3')!;
      s3.post = [{ c: 'textPresent', pattern: 'THIS_MARKER_NEVER_APPEARS' }];
      s3.wait = { timeoutMs: 1500, pollMs: 200 };
    });
    const result = await replayCapability({ artifact: a, bindings: { baseUrl: base } }, opts());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('POSTCONDITION_TIMEOUT');
    expect(result.failure.stepId).toBe('s3');
    // Forensics survive the failure: s1 and s2 completed before s3 timed out.
    expect(result.stepsRun.map((t) => t.stepId)).toEqual(['s1', 's2']);
    expect(result.stepsRun.every((t) => t.status === 'ok')).toBe(true);
    expect(result.irreversibleCompleted).toBe(false);
  }, 60_000);

  it('RECOVERY_EXHAUSTED when a known condition recurs beyond its attempt budget', async () => {
    await armFault('session_timeout', 'on'); // fires on EVERY authed request
    const result = await replayCapability({ artifact: gold, bindings: { baseUrl: base } }, opts());
    await armFault('session_timeout', 'off');
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('RECOVERY_EXHAUSTED');
    expect(result.failure.observed).toContain('SESSION_TIMEOUT');
    expect(result.recoveriesUsed).toContainEqual({ code: 'SESSION_TIMEOUT', attempts: 2 });
  }, 60_000);

  it('PRECONDITION_FAILED when the entry state is not what the artifact requires', async () => {
    await armFault('app_error', 'once'); // the entrypoint load 500s
    const result = await replayCapability({ artifact: gold, bindings: { baseUrl: base } }, opts());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('PRECONDITION_FAILED');
    expect(result.failure.stepId).toBe('s1');
    expect(result.failure.expected).toContain('Operator Sign In');
  }, 60_000);

  it('declared anomalies fail fast as UNEXPECTED_STATE instead of waiting out the clock', async () => {
    const a = variant((x) => {
      const s3 = x.steps.find((s) => s.id === 's3')!;
      s3.post = [{ c: 'textPresent', pattern: 'THIS_MARKER_NEVER_APPEARS' }];
      s3.wait = { timeoutMs: 8000, pollMs: 200 };
      x.anomalies.push({
        code: 'TEST_ANOMALY',
        description: 'Synthetic anomaly for the fail-fast path.',
        when: { c: 'textPresent', pattern: 'Announcements' }, // present right after sign-in
      });
    });
    const t0 = Date.now();
    const result = await replayCapability({ artifact: a, bindings: { baseUrl: base } }, opts());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('UNEXPECTED_STATE');
    expect(result.failure.observed).toContain('TEST_ANOMALY');
    expect(Date.now() - t0).toBeLessThan(8000); // failed fast, did not wait out s3's timeout
  }, 60_000);
});

describe('irreversible dispatch semantics', () => {
  it('a dispatched irreversible action counts even when its checkpoint then fails', async () => {
    const a = variant((x) => {
      x.steps = x.steps.filter((s) => ['s1', 's2', 's3'].includes(s.id));
      const s3 = x.steps.find((s) => s.id === 's3')!;
      s3.risk = 'irreversible';
      s3.post = [{ c: 'textPresent', pattern: 'THIS_MARKER_NEVER_APPEARS' }];
      s3.wait = { timeoutMs: 1500, pollMs: 200 };
      x.policy.maxRisk = 'irreversible';
      x.successCriteria = [];
      x.outputs = {};
    });
    const autoApprove = {
      async handle() {
        return { action: 'approve' as const };
      },
    };
    const result = await replayCapability(
      { artifact: a, bindings: { baseUrl: base } },
      { ...opts(), operator: autoApprove },
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('POSTCONDITION_TIMEOUT');
    // The click left the gate: the side effect may exist even though the
    // checkpoint failed — a retry decision must know that.
    expect(result.irreversibleCompleted).toBe(true);
  }, 60_000);
});

describe('refuse-restart-after-irreversible (the double-execution guard)', () => {
  it('a restartRun recovery after a completed irreversible step is refused, never re-run', async () => {
    // Synthetic flow: sign-in is marked irreversible (stand-in for a posting
    // step), then a checkpoint that never passes while a restartRun recovery
    // matches the visible screen — the exact trap that would double-execute.
    const a = variant((x) => {
      x.steps = x.steps.filter((s) => ['s1', 's2', 's3'].includes(s.id));
      const s3 = x.steps.find((s) => s.id === 's3')!;
      s3.risk = 'irreversible';
      x.steps.push({
        id: 's4',
        intent: 'Checkpoint that never passes (forces the recovery path)',
        action: { kind: 'assert' },
        pre: [],
        post: [{ c: 'textPresent', pattern: 'THIS_MARKER_NEVER_APPEARS' }],
        wait: { timeoutMs: 1500, pollMs: 200 },
        risk: 'read',
        onDetect: [],
      });
      x.recoveries = [
        {
          code: 'TEMPTING_RESTART',
          description: 'A recovery that would re-run the flow from the top.',
          when: { c: 'textPresent', pattern: 'Announcements' },
          handler: { kind: 'restartRun' },
          maxAttempts: 3,
        },
      ];
      x.policy.maxRisk = 'irreversible';
      x.successCriteria = [];
      x.outputs = {};
    });
    const autoApprove: Operator = {
      async handle(req) {
        expect(req.kind).toBe('approve_risky');
        return { action: 'approve', note: 'test auto-approval' };
      },
    };
    const result = await replayCapability(
      { artifact: a, bindings: { baseUrl: base } },
      { ...opts(), operator: autoApprove },
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('UNEXPECTED_STATE');
    expect(result.failure.observed).toContain('irreversible step already completed — refusing');
    expect(result.irreversibleCompleted).toBe(true);
    expect(result.stepsRun.map((t) => t.stepId)).toContain('s3'); // the irreversible step is on record
  }, 60_000);
});
