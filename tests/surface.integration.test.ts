/** Drives the full member-lookup flow through Surface + ActionGate alone:
 * semantic locators only, across frames, no Playwright calls above the seam.
 * Ends by reading the savings balance out of a legacy table and checking the
 * operator password never reached the evidence log. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../apps/mock-cu/server.js';
import { ActionGate } from '../src/policy/actionGate.js';
import { PolicySchema } from '../src/policy/policy.js';
import { Redactor } from '../src/policy/redact.js';
import { RunLog } from '../src/evidence/runLog.js';
import { evaluateCondition } from '../src/replay/detectors.js';
import { TargetRefSchema } from '../src/schema/locators.js';
import { PlaywrightWebSurface } from '../src/surface/web/playwrightSurface.js';

let server: Server;
let base: string;
let surface: PlaywrightWebSurface;
let gate: ActionGate;
let log: RunLog;

const target = (raw: unknown) => TargetRefSchema.parse(raw);

async function resolveOk(raw: unknown): Promise<number> {
  const res = await surface.resolve(target(raw));
  if (!res.ok) throw new Error(`resolution failed: ${res.reason} — ${res.detail}`);
  return res.ref;
}

beforeAll(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;

  const redactor = new Redactor();
  redactor.register('password', 'Passw0rd!', 'secret');
  log = new RunLog('replay', { baseDir: 'evidence/_scratch', redactor });

  surface = await PlaywrightWebSurface.launch();
  gate = new ActionGate(
    PolicySchema.parse({
      allowedOrigins: [base],
      allowedActions: ['navigate', 'activate', 'setValue', 'choose', 'read', 'answerDialog'],
    }),
    surface,
    { onEvent: (e) => log.event('gate', { decision: e.decision, kind: e.action.kind }) },
  );
}, 60_000);

afterAll(async () => {
  await surface.close();
  server.close();
});

describe('member lookup flow through Surface + ActionGate only', () => {
  it('completes sign-in → search → detail → balance read across frames', async () => {
    // Sign in.
    await gate.execute({ kind: 'navigate', url: `${base}/login` }, { risk: 'read' });
    await surface.observe();
    const userRef = await resolveOk({ framePath: [], strategies: [{ s: 'labelText', label: 'Operator ID' }] });
    await gate.execute({ kind: 'setValue', ref: userRef, value: 'teller1' }, { risk: 'reversible' });
    const passRef = await resolveOk({ framePath: [], strategies: [{ s: 'labelText', label: 'Password' }] });
    await gate.execute({ kind: 'setValue', ref: passRef, value: 'Passw0rd!' }, { risk: 'reversible' });
    const signIn = await resolveOk({ framePath: [], strategies: [{ s: 'roleName', role: 'button', name: 'Sign In' }] });
    await gate.execute({ kind: 'activate', ref: signIn }, { risk: 'reversible' });
    await surface.settle();

    // Frameset shell: navigate to Member Search via the menu frame.
    let obs = await surface.observe();
    expect(obs.elements.some((e) => e.framePath.some((f) => f.name === 'menu'))).toBe(true);
    // Per-frame text is captured alongside the flat text — the substrate for
    // frame-scoped conditions.
    expect(obs.frameTexts!.some((f) => f.framePath.some((p) => p.name === 'menu') && /member search/i.test(f.text))).toBe(true);
    expect(obs.frameTexts!.some((f) => f.framePath.some((p) => p.name === 'work'))).toBe(true);
    const navLink = await resolveOk({
      framePath: [{ name: 'menu' }],
      strategies: [{ s: 'roleName', role: 'link', name: 'Member Search' }],
    });
    await gate.execute({ kind: 'activate', ref: navLink }, { risk: 'read' });
    await surface.settle();
    await surface.observe();

    // Search for the member — controls live in the work frame.
    const queryRef = await resolveOk({
      framePath: [{ name: 'work' }],
      strategies: [{ s: 'labelText', label: 'Member No. or Name' }],
    });
    await gate.execute({ kind: 'setValue', ref: queryRef, value: '12345' }, { risk: 'reversible' });
    const searchBtn = await resolveOk({
      framePath: [{ name: 'work' }],
      strategies: [{ s: 'roleName', role: 'button', name: 'Search' }],
    });
    await gate.execute({ kind: 'activate', ref: searchBtn }, { risk: 'reversible' });
    await surface.settle();
    await surface.observe();

    // Open the member from the results row — anchored by row text, not position.
    const memberLink = await resolveOk({
      framePath: [{ name: 'work' }],
      strategies: [{ s: 'textAnchor', text: 'Alexis Testmember', relation: 'rowOf', targetRole: 'link' }],
    });
    await gate.execute({ kind: 'activate', ref: memberLink }, { risk: 'read' });
    await surface.settle();
    obs = await surface.observe();
    expect(obs.visibleText).toContain('Member Information');

    // Frame-scoped conditions against a REAL browser observation: the member
    // detail lives in the work frame, so the scoped check passes there and —
    // the whole point — the same text cannot be satisfied by the menu frame.
    expect(await evaluateCondition({ c: 'textPresent', pattern: 'Member Information', frame: { name: 'work' } }, obs)).toBe(true);
    expect(await evaluateCondition({ c: 'textPresent', pattern: 'Member Information', frame: { name: 'menu' } }, obs)).toBe(false);
    expect(await evaluateCondition({ c: 'textPresent', pattern: 'Member Search', frame: { name: 'menu' } }, obs)).toBe(true);

    // Read the savings balance out of the legacy accounts table.
    const balanceCell = await resolveOk({
      framePath: [{ name: 'work' }],
      strategies: [{ s: 'tableCell', rowAnchor: { text: 'REGULAR SAVINGS' }, columnHeader: 'Balance' }],
    });
    const read = await gate.execute({ kind: 'read', ref: balanceCell }, { risk: 'read' });
    expect(read.readValue).toBe('$4,821.97');

    log.event('flow_complete', { balance: read.readValue });
    log.screenshot('member-detail', obs.screenshot);
  }, 60_000);

  it('never wrote the secret password to the evidence log', () => {
    const jsonl = readFileSync(path.join(log.dir, 'run.jsonl'), 'utf8');
    expect(jsonl).not.toContain('Passw0rd!');
    expect(jsonl.length).toBeGreaterThan(0);
  });

  it('holds a native dialog and surfaces it as observed state', async () => {
    await fetch(`${base}/__faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fault: 'native_dialog', mode: 'once' }),
    });
    await gate.execute({ kind: 'navigate', url: `${base}/home` }, { risk: 'read' });
    await surface.page.waitForTimeout(300); // let the confirm() fire
    const obs = await surface.observe();
    expect(obs.dialog).toBeDefined();
    expect(obs.dialog!.text).toContain('compliance attestation');
    // Answer it deliberately (dismiss) and confirm normal observation resumes.
    await gate.execute({ kind: 'answerDialog', accept: false }, { risk: 'reversible' });
    const after = await surface.observe();
    expect(after.dialog).toBeUndefined();
    expect(after.elements.length).toBeGreaterThan(0);
  }, 30_000);
});
