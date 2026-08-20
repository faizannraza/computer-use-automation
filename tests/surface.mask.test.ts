/**
 * Screenshot masking has to happen inside the capture it belongs to.
 *
 * The bug this pins down: the mask used to be computed from the PREVIOUS
 * observation and handed to the surface as ref integers. observe() clears and
 * rebuilds its ref map with fresh 0..n numbering before capturing, so the very
 * screenshot where regulated data first appeared was written unmasked, and the
 * next one blacked out whatever those recycled numbers now pointed at — which
 * is most wrong exactly when the page changed, i.e. when new PII arrived.
 *
 * The test is a pixel test on purpose: what must be true is a property of the
 * IMAGE on disk, not of the bookkeeping around it.
 */
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../apps/mock-cu/server.js';
import type { Observation } from '../src/core/types.js';
import { classifiedElementRefs } from '../src/policy/classify.js';
import { ActionGate } from '../src/policy/actionGate.js';
import { PolicySchema } from '../src/policy/policy.js';
import { loadProfile } from '../src/profile/appProfile.js';
import { TargetRefSchema } from '../src/schema/locators.js';
import { PlaywrightWebSurface } from '../src/surface/web/playwrightSurface.js';

let server: Server;
let base: string;
let surface: PlaywrightWebSurface;
let gate: ActionGate;

const classification = loadProfile('profiles/mockcore-teller.profile.json').dataClassification;

async function resolveOk(raw: unknown): Promise<number> {
  const res = await surface.resolve(TargetRefSchema.parse(raw));
  if (!res.ok) throw new Error(`resolution failed: ${res.reason} — ${res.detail}`);
  return res.ref;
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

  surface = await PlaywrightWebSurface.launch();
  gate = new ActionGate(
    PolicySchema.parse({
      allowedOrigins: [base],
      allowedActions: ['navigate', 'activate', 'setValue', 'choose', 'read', 'answerDialog'],
    }),
    surface,
  );

  await gate.execute({ kind: 'navigate', url: `${base}/login` }, { risk: 'read' });
  await surface.observe();
  await gate.execute(
    { kind: 'setValue', ref: await resolveOk({ framePath: [], strategies: [{ s: 'labelText', label: 'Operator ID' }] }), value: 'teller1' },
    { risk: 'reversible' },
  );
  await gate.execute(
    { kind: 'setValue', ref: await resolveOk({ framePath: [], strategies: [{ s: 'labelText', label: 'Password' }] }), value: 'Passw0rd!' },
    { risk: 'reversible' },
  );
  await gate.execute(
    { kind: 'activate', ref: await resolveOk({ framePath: [], strategies: [{ s: 'roleName', role: 'button', name: 'Sign In' }] }) },
    { risk: 'reversible' },
  );
  await surface.settle();
}, 60_000);

afterAll(async () => {
  await surface.close();
  server.close();
});

describe('evidence screenshots mask the observation they capture', () => {
  it('the FIRST capture of a screen with regulated data is already masked', async () => {
    const classified: { seq: number; refs: number[] }[] = [];
    surface.setScreenshotMask((obs: Observation) => {
      const refs = classifiedElementRefs(obs, classification);
      classified.push({ seq: obs.seq, refs });
      return refs;
    });

    // A screen with no classified field: nothing to mask, and nothing stale to
    // carry into the next capture.
    await gate.execute({ kind: 'navigate', url: `${base}/home` }, { risk: 'read' });
    await surface.settle();
    const home = await surface.observe();
    expect(classified.at(-1)!.refs).toEqual([]);

    // …then the member record, where balances appear for the first time.
    await gate.execute({ kind: 'navigate', url: `${base}/members/12345` }, { risk: 'read' });
    await surface.settle();
    const first = await surface.observe();
    const firstShot = first.screenshot!;

    // The classifier ran against the observation being captured, not the one
    // before it — same generation, so the refs are meaningful.
    expect(classified.at(-1)!.seq).toBe(first.seq);
    expect(classified.at(-1)!.refs.length).toBeGreaterThan(0);
    expect(first.seq).toBe(home.seq + 1);

    // A second look at the identical screen. Before the fix this capture was
    // the first masked one, so it differed from `firstShot`; now they match,
    // which is the whole claim: no unmasked frame was ever written.
    const second = await surface.observe();
    expect(firstShot.equals(second.screenshot!)).toBe(true);

    // Control: masking is not a no-op — with the classifier withdrawn the same
    // screen renders differently, so the equality above has content.
    surface.setScreenshotMask(() => []);
    const unmasked = await surface.observe();
    expect(firstShot.equals(unmasked.screenshot!)).toBe(false);
  }, 60_000);
});
