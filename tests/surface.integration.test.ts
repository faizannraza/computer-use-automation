/** Drives the full member-lookup flow through Surface + ActionGate alone:
 * semantic locators only, across frames, no Playwright calls above the seam.
 * Ends by reading the savings balance out of a legacy table and checking the
 * operator password never reached the evidence log. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { Frame } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../apps/mock-cu/server.js';
import type { Observation, ObservedElement } from '../src/core/types.js';
import type { RawElement } from '../src/surface/web/elementMap.js';
import { collectFrame } from '../src/surface/web/elementMap.js';
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

/**
 * Frame identity, computed exactly the way PlaywrightWebSurface computes an
 * element's framePath — so an observation's elements can be bucketed back onto
 * the frames they were walked in.
 */
function frameKeyOf(frame: Frame): string {
  const parts: string[] = [];
  let cur: Frame | null = frame;
  while (cur && cur.parentFrame()) {
    parts.unshift(`${cur.name()}|${cur.url()}`);
    cur = cur.parentFrame();
  }
  return parts.join('>>');
}

function elementFrameKey(el: ObservedElement): string {
  return el.framePath.map((p) => `${p.name ?? ''}|${p.url}`).join('>>');
}

/**
 * PER-FRAME store[]/out[] alignment. Frame TOTALS are the wrong assertion:
 * refMap maps ref → {frame, index}, so a +1 in one frame and a −1 in another
 * net out in a sum while every ref in both frames points at the wrong node.
 * Returns the per-frame observed/stashed counts so callers can also prove the
 * page under test was not vacuously empty.
 */
async function frameAlignment(obs: Observation): Promise<{ observed: number; stashed: number }[]> {
  const observed = new Map<string, number>();
  for (const el of obs.elements) {
    const k = elementFrameKey(el);
    observed.set(k, (observed.get(k) ?? 0) + 1);
  }
  const rows: { observed: number; stashed: number }[] = [];
  for (const frame of surface.page.frames()) {
    if (frame.isDetached()) continue;
    const stashed = await frame
      .evaluate(() => (window as unknown as { __cuEls?: Element[] }).__cuEls?.length ?? 0)
      .catch(() => 0);
    const key = frameKeyOf(frame);
    rows.push({ observed: observed.get(key) ?? 0, stashed });
    observed.delete(key);
  }
  // Anything left over was observed against a frame that no longer exists —
  // itself a misalignment, so surface it rather than dropping it.
  for (const [, count] of observed) rows.push({ observed: count, stashed: -1 });
  return rows;
}

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

  it('the element map stays index-aligned with the stashed DOM nodes', async () => {
    // LOAD-BEARING INVARIANT: observation refs index into window.__cuEls, and
    // act() dispatches to __cuEls[index]. If the walker ever pushes to one
    // array without the other, every later ref on that page acts on the WRONG
    // element — silently, with no error. Any change to the walker's push path
    // (e.g. emitting new element kinds) must keep this green.
    await gate.execute({ kind: 'navigate', url: `${base}/members/12345` }, { risk: 'read' });
    await surface.settle();
    const obs = await surface.observe();
    const rows = await frameAlignment(obs);
    for (const row of rows) expect(row.observed).toBe(row.stashed);
    expect(rows.reduce((n, r) => n + r.stashed, 0)).toBeGreaterThan(0);
  }, 30_000);

  it('stays index-aligned on a page with HIDDEN inputs, per frame', async () => {
    // The member detail screen has no hidden inputs, so it never exercises the
    // one branch the emit()/push() split exists for: a hidden field is emitted
    // WITHOUT the visibility filter (it is 0x0 by definition) and without a
    // bbox. Get an off-by-one wrong there and every ref after it on the page
    // acts on the wrong node. The review screen carries three hidden fields
    // (cmbType, txtNickname, txtDeposit) and is reachable only by POST, so the
    // flow has to be driven to it.
    await gate.execute({ kind: 'navigate', url: `${base}/members/12345/subaccounts/new` }, { risk: 'read' });
    await surface.settle();
    await surface.observe();
    const typeRef = await resolveOk({ framePath: [], strategies: [{ s: 'labelText', label: 'Account Type' }] });
    await gate.execute({ kind: 'choose', ref: typeRef, option: 'HOLIDAY CLUB' }, { risk: 'reversible' });
    const nickRef = await resolveOk({ framePath: [], strategies: [{ s: 'labelText', label: 'Nickname' }] });
    await gate.execute({ kind: 'setValue', ref: nickRef, value: 'Vacation' }, { risk: 'reversible' });
    const depRef = await resolveOk({ framePath: [], strategies: [{ s: 'labelText', label: 'Initial Deposit' }] });
    await gate.execute({ kind: 'setValue', ref: depRef, value: '50.00' }, { risk: 'reversible' });
    const cont = await resolveOk({ framePath: [], strategies: [{ s: 'roleName', role: 'button', name: 'Continue' }] });
    await gate.execute({ kind: 'activate', ref: cont }, { risk: 'reversible' });
    await surface.settle();

    const obs = await surface.observe();
    expect(obs.visibleText).toContain('Review');
    const hidden = obs.elements.filter((e) => e.role === 'hidden');
    // Vacuity guard: if the screen ever stops rendering hidden fields this test
    // silently stops testing anything, so assert they are actually there.
    expect(hidden.length).toBeGreaterThanOrEqual(3);
    // ...and that they are still value-free, per the walker's contract.
    for (const h of hidden) expect(h.value).toMatch(/^\(present:\d+\)$/);

    const rows = await frameAlignment(obs);
    for (const row of rows) expect(row.observed).toBe(row.stashed);
    expect(rows.reduce((n, r) => n + r.stashed, 0)).toBeGreaterThan(hidden.length);
  }, 30_000);

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

/**
 * The walker's column arithmetic, exercised in a real browser against markup
 * the mock core does not contain. No MockCore screen uses rowspan or a
 * two-tier header, and adding one would move fixtures that other tests assert
 * on — but a spanned cell is ordinary in a legacy core's ledger and sub-ledger
 * screens, and getting it wrong files a Status string under "Balance".
 */
describe('in-page table walker', () => {
  async function walk(html: string): Promise<RawElement[]> {
    await surface.page.setContent(`<html><body>${html}</body></html>`);
    return (await collectFrame(surface.page.mainFrame())).els;
  }
  const cellNamed = (els: RawElement[], name: string): RawElement | undefined =>
    els.find((e) => (e.role === 'cell' || e.role === 'rowheader') && e.name === name);

  it('files cells under the right column header when an earlier row carries rowSpan', async () => {
    // Row 3 has three markup cells for four visual columns — column 0 is still
    // occupied by the rowspan=2 "S00". Counting markup cells shifts every
    // header one to the left, so "FROZEN" gets reported as the Balance.
    const els = await walk(`
      <table>
        <tr><th>Share ID</th><th>Type</th><th>Balance</th><th>Status</th></tr>
        <tr><td rowspan="2">S00</td><td>REGULAR</td><td>$4,821.97</td><td>OPEN</td></tr>
        <tr><td>SUB-LEDGER</td><td>$0.00</td><td>FROZEN</td></tr>
      </table>`);
    expect(cellNamed(els, 'SUB-LEDGER')?.colHeader).toBe('Type');
    expect(cellNamed(els, '$0.00')?.colHeader).toBe('Balance');
    expect(cellNamed(els, 'FROZEN')?.colHeader).toBe('Status');
    // The spanning row itself was never broken and must stay unbroken.
    expect(cellNamed(els, 'S00')?.colHeader).toBe('Share ID');
    expect(cellNamed(els, '$4,821.97')?.colHeader).toBe('Balance');
  }, 30_000);

  it('resolves a two-tier header, reading tier-1 cells through their rowSpan', async () => {
    const els = await walk(`
      <table>
        <tr><th rowspan="2">Share ID</th><th colspan="2">Amounts</th><th rowspan="2">Status</th></tr>
        <tr><th>Available</th><th>Ledger</th></tr>
        <tr><td>S01</td><td>$10.00</td><td>$20.00</td><td>OPEN</td></tr>
      </table>`);
    expect(cellNamed(els, 'S01')?.colHeader).toBe('Share ID');
    expect(cellNamed(els, '$10.00')?.colHeader).toBe('Available');
    expect(cellNamed(els, '$20.00')?.colHeader).toBe('Ledger');
    expect(cellNamed(els, 'OPEN')?.colHeader).toBe('Status');
  }, 30_000);

  it('gives each row an identity, and its cells as discrete strings', async () => {
    // A duplicate posting: two rows that are byte-identical, plus a
    // description containing the very character nearText joins cells with.
    const els = await walk(`
      <table>
        <tr><th>Date</th><th>Description</th><th>Amount</th></tr>
        <tr><td>2026-08-14</td><td>ACH DEBIT | CITY UTILITIES</td><td>$118.42</td></tr>
        <tr><td>2026-08-14</td><td>ACH DEBIT | CITY UTILITIES</td><td>$118.42</td></tr>
      </table>`);
    const cells = els.filter((e) => e.role === 'cell');
    expect(cells).toHaveLength(6);
    // Row text cannot tell these rows apart; row identity can.
    expect(new Set(cells.map((c) => c.nearText)).size).toBe(1);
    expect(new Set(cells.map((c) => c.rowId)).size).toBe(2);

    const desc = cells.find((c) => c.name.startsWith('ACH'))!;
    expect(desc.cellTexts).toEqual(['2026-08-14', 'ACH DEBIT | CITY UTILITIES', '$118.42']);
    // The reason cellTexts exists: splitting the joined row text finds four
    // "cells" in a three-cell row, shifting every value one place.
    expect(desc.nearText!.split('|')).toHaveLength(4);
  }, 30_000);

  it('truncates row text on a cell boundary, so a classified value stays redactable', async () => {
    // Redaction is exact-string substitution over registered needles, applied
    // when evidence is written. Cutting the row text mid-value leaves a prefix
    // that matches no needle, so it ships in cleartext — together with the rest
    // of the row, which names the member it belongs to. The budget must
    // therefore drop a whole cell rather than keep half of one.
    const email = 'dorothy.vaughan@example.com';
    const filler = 'X'.repeat(150); // pushes the e-mail across the 160-char budget
    const els = await walk(`
      <table>
        <tr><th>Notes</th><th>E-mail</th></tr>
        <tr><td>${filler}</td><td>${email}</td></tr>
      </table>`);
    const rowText = cellNamed(els, filler)!.nearText!;

    // Whole-or-absent: no proper prefix of the needle may appear on its own.
    for (let i = 4; i < email.length; i++) {
      if (rowText.includes(email.slice(0, i))) expect(rowText).toContain(email);
    }
    expect(rowText).not.toContain('dorothy');

    // The value is not lost, just kept where it stays matchable: cellTexts
    // holds it whole, so the redactor can mask it.
    const cells = cellNamed(els, filler)!.cellTexts!;
    expect(cells).toEqual([filler, email]);
    const redactor = new Redactor();
    redactor.register('email', email, 'pii');
    expect(redactor.apply(cells.join(' | '))).not.toContain('dorothy');
    expect(redactor.apply(cells.join(' | '))).toContain('***om');
  }, 30_000);

  it('keeps a value that fits inside the budget, whole', async () => {
    // The other half of whole-or-absent: within budget nothing is dropped, so
    // row anchors keep working and the needle still matches.
    const email = 'dorothy.vaughan@example.com';
    const els = await walk(`
      <table>
        <tr><th>Member</th><th>E-mail</th></tr>
        <tr><td>103001</td><td>${email}</td></tr>
      </table>`);
    const rowText = cellNamed(els, '103001')!.nearText!;
    expect(rowText).toBe(`103001 | ${email}`);
    const redactor = new Redactor();
    redactor.register('email', email, 'pii');
    expect(redactor.apply(rowText)).toBe('103001 | ***om');
  }, 30_000);
});
