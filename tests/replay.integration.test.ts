/** Gold artifact replayed against the live mock app, no model anywhere.
 * Covers the full result contract: success with typed outputs, a named
 * business outcome, a recovered runtime error, a refused ambiguity, and the
 * pre-flight guards. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../apps/mock-cu/server.js';
import { loadPolicy } from '../src/policy/policy.js';
import { PolicySchema } from '../src/policy/policy.js';
import type { Policy } from '../src/policy/policy.js';
import { replayCapability } from '../src/replay/engine.js';
import { loadCapability } from '../src/schema/capability.js';
import type { ResolvedCapability } from '../src/schema/overlay.js';

let server: Server;
let base: string;
let policy: Policy;

const { artifact, verified } = loadCapability('tests/fixtures/member.readSavingsBalance.gold.json');

function resolved(): ResolvedCapability {
  return { artifact, bindings: { baseUrl: base } };
}

async function armFault(fault: string, mode: string, param?: number): Promise<void> {
  await fetch(`${base}/__faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fault, mode, param }),
  });
}

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

const opts = () => ({
  policy,
  verified,
  paramValues: { memberId: '12345' },
  evidenceBaseDir: 'evidence/_scratch',
});

describe('deterministic replay of member.readSavingsBalance', () => {
  it('succeeds and returns the typed output', async () => {
    const result = await replayCapability(resolved(), opts());
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs['savingsBalance']).toBe('$4,821.97');
    expect(result.stepsRun.map((t) => t.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    // Drift telemetry: the primary strategy resolved every target.
    for (const t of result.stepsRun) {
      if (t.strategyIndex !== undefined) expect(t.strategyIndex).toBe(0);
    }
    // Evidence exists and the secret never reached disk; the pii output is masked there.
    const jsonl = readFileSync(path.join(result.evidenceDir, 'run.jsonl'), 'utf8');
    expect(jsonl).not.toContain('Passw0rd!');
    const resultJson = readFileSync(path.join(result.evidenceDir, 'result.json'), 'utf8');
    expect(resultJson).not.toContain('Passw0rd!');
    expect(resultJson).toContain('***97'); // pii-masked balance in evidence; caller gets the real value
  }, 60_000);

  it('reports MEMBER_NOT_FOUND as a business outcome', async () => {
    const result = await replayCapability(resolved(), { ...opts(), paramValues: { memberId: '99999' } });
    expect(result.status).toBe('business_outcome');
    if (result.status !== 'business_outcome') return;
    expect(result.code).toBe('MEMBER_NOT_FOUND');
    expect(result.message).toContain('legitimate business result');
  }, 60_000);

  it('recovers from a mid-flow session timeout by re-authenticating', async () => {
    await armFault('session_timeout', 'once');
    const result = await replayCapability(resolved(), opts());
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs['savingsBalance']).toBe('$4,821.97');
    expect(result.recoveriesUsed).toContainEqual({ code: 'SESSION_TIMEOUT', attempts: 1 });
  }, 60_000);

  it('fails TARGET_AMBIGUOUS on duplicate Search buttons instead of guessing', async () => {
    await armFault('duplicate_button', 'on');
    const result = await replayCapability(resolved(), opts());
    await armFault('duplicate_button', 'off');
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('TARGET_AMBIGUOUS');
    expect(result.failure.stepId).toBe('s6');
    expect(result.failure.expected).toContain('unique confident match');
    expect(result.failure.observed).toContain('refusing to guess');
    expect(result.failure.screenshotRef).toBeDefined();
  }, 60_000);

  it('dismisses the known interstitial and completes', async () => {
    await armFault('interstitial', 'once');
    const result = await replayCapability(resolved(), opts());
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.recoveriesUsed).toContainEqual({ code: 'KNOWN_INTERSTITIAL', attempts: 1 });
  }, 60_000);
});

describe('pre-flight guards (no browser launched)', () => {
  it('rejects missing params as INVALID_PARAMS', async () => {
    const result = await replayCapability(resolved(), { ...opts(), paramValues: {} });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('INVALID_PARAMS');
    expect(result.failure.observed).toContain("'memberId'");
  });

  it('refuses unattended replay of a draft artifact', async () => {
    const draft = structuredClone(artifact);
    draft.provenance.approval.state = 'draft';
    const result = await replayCapability({ artifact: draft, bindings: { baseUrl: base } }, opts());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('POLICY_BLOCKED');
    expect(result.failure.observed).toContain('draft');
  });

  it('refuses an artifact whose content hash does not verify', async () => {
    const result = await replayCapability(resolved(), { ...opts(), verified: false });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.observed).toContain('hash mismatch');
  });
});
