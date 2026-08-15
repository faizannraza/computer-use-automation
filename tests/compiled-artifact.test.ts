/**
 * Acceptance for the DISCOVERED artifact (the one compiled from the real
 * LLM run and committed at capabilities/): it must generalize — replaying
 * with a member the discovery run never saw, and reporting the not-found
 * business outcome the probe grounded. Runs with allowDraft so CI does not
 * depend on the human approval ceremony (`cu approve`).
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../apps/mock-cu/server.js';
import { loadPolicy, PolicySchema } from '../src/policy/policy.js';
import type { Policy } from '../src/policy/policy.js';
import { replayCapability } from '../src/replay/engine.js';
import { loadCapability } from '../src/schema/capability.js';

let server: Server;
let base: string;
let policy: Policy;

const { artifact, verified } = loadCapability('capabilities/member.readSavingsBalance@1.0.0.json');

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

describe('the LLM-discovered artifact (compiled, committed)', () => {
  it('was produced by discovery, is schema-valid, and hash-verifies', () => {
    expect(artifact.provenance.recordedBy.kind).toBe('llm-discovery');
    expect(artifact.provenance.recordedBy.discoveryRunId).toBeDefined();
    expect(verified).toBe(true);
  });

  it('contains no credential material and no raw recorded PII', () => {
    const json = JSON.stringify(artifact);
    expect(json).not.toContain('Passw0rd');
    expect(json).not.toContain('teller1');
    expect(json).not.toContain('Alexis Testmember');
  });

  it('generalizes: replays green for a member the discovery run never saw', async () => {
    const result = await replayCapability(
      { artifact, bindings: { baseUrl: base } },
      { policy, verified, allowDraft: true, paramValues: { memberId: '10001' }, evidenceBaseDir: 'evidence/_scratch' },
    );
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs['savingsBalance']).toBe('$12,500.50');
    for (const t of result.stepsRun) {
      if (t.strategyIndex !== undefined) expect(t.strategyIndex).toBe(0); // no drift
    }
  }, 60_000);

  it('reports the probe-grounded MEMBER_NOT_FOUND outcome for an unknown member', async () => {
    const result = await replayCapability(
      { artifact, bindings: { baseUrl: base } },
      { policy, verified, allowDraft: true, paramValues: { memberId: '99999' }, evidenceBaseDir: 'evidence/_scratch' },
    );
    expect(result.status).toBe('business_outcome');
    if (result.status !== 'business_outcome') return;
    expect(result.code).toBe('MEMBER_NOT_FOUND');
  }, 60_000);
});
