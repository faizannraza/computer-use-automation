/**
 * Cross-tenant reuse, proven against a control rename the artifact never saw:
 * the SHIPPED LLM-discovered artifact replays against a re-skinned second
 * tenant ("Summit FCU": Sign In → "Log On", Search → "Find Member").
 *
 * Without the tenant overlay the run fails honestly (TARGET_NOT_FOUND at the
 * renamed control); with two prependStrategy patches it succeeds — same
 * artifact, no re-recording. Overlays are additive by construction, so the
 * tenant patch cannot change what the capability does.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../apps/mock-cu/server.js';
import { loadPolicy, PolicySchema } from '../src/policy/policy.js';
import type { Policy } from '../src/policy/policy.js';
import { replayCapability } from '../src/replay/engine.js';
import { loadCapability } from '../src/schema/capability.js';
import { applyOverlay, loadOverlay } from '../src/schema/overlay.js';

let server: Server;
let base: string;
let policy: Policy;

// The shipped, LLM-discovered artifact — not a fixture built for this test.
const { artifact, verified } = loadCapability('capabilities/member.readSavingsBalance@1.0.0.json');
const overlay = loadOverlay('tenants/summit-fcu.overlay.json');

beforeAll(async () => {
  process.env.MOCK_CU_USER = 'teller1';
  process.env.MOCK_CU_PASS = 'Passw0rd!';
  const app = createApp({ skin: 'summit' });
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

describe('the discovered artifact against a re-skinned second tenant', () => {
  it('without the overlay: fails honestly at the renamed control (TARGET_NOT_FOUND, not a wrong click)', async () => {
    const result = await replayCapability({ artifact, bindings: { baseUrl: base } }, opts());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('TARGET_NOT_FOUND');
    expect(result.failure.stepId).toBe('s3'); // the renamed Sign In button
    expect(result.failure.expected).toContain('roleName'); // which ladder ran is in the report
    expect(result.failure.observed).toContain('no strategy'); // an honest miss, not a guessed click
  }, 60_000);

  it('with the overlay: two prependStrategy patches make the same artifact succeed, at strategy 0', async () => {
    const resolved = applyOverlay(artifact, overlay);
    resolved.bindings['baseUrl'] = base; // test port, not the overlay's static one
    const result = await replayCapability(resolved, opts());
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs['savingsBalance']).toBe('$4,821.97');
    // The tenant's locators fired first; nothing fell down the ladder.
    for (const t of result.stepsRun) {
      if (t.strategyIndex !== undefined) expect(t.strategyIndex).toBe(0);
    }
  }, 60_000);

  it('the overlay cannot sneak in behavior: it binds, re-ranks locators, and nothing else', () => {
    const resolved = applyOverlay(artifact, overlay);
    // Same steps, same actions, same params/outputs/outcomes/risk as the base.
    expect(resolved.artifact.steps.map((s) => s.action.kind)).toEqual(artifact.steps.map((s) => s.action.kind));
    expect(resolved.artifact.params).toEqual(artifact.params);
    expect(resolved.artifact.outputs).toEqual(artifact.outputs);
    expect(resolved.artifact.outcomes).toEqual(artifact.outcomes);
    expect(resolved.artifact.policy).toEqual(artifact.policy);
  });
});
