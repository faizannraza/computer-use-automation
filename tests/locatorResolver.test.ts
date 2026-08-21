/** Ladder behavior: ordered fallback, unique-confident match wins,
 * near-ties fail hard, frame filtering, score thresholds. */
import { describe, expect, it } from 'vitest';
import type { Observation, ObservedElement } from '../src/core/types.js';
import { TargetRefSchema } from '../src/schema/locators.js';
import { resolveTarget } from '../src/surface/web/locatorResolver.js';

function el(partial: Partial<ObservedElement> & { ref: number; role: string; name: string }): ObservedElement {
  return { framePath: [{ name: 'work', url: 'http://x/page' }], interactive: true, ...partial };
}

function obs(elements: ObservedElement[]): Observation {
  return { seq: 1, location: 'http://x/page', title: 't', elements, visibleText: '', at: new Date().toISOString() };
}

const target = (raw: unknown) => TargetRefSchema.parse(raw);

describe('resolveTarget', () => {
  it('resolves a unique role+name match at full confidence on strategy 0', async () => {
    const o = obs([el({ ref: 0, role: 'button', name: 'Sign In' }), el({ ref: 1, role: 'link', name: 'Sign In' })]);
    const res = await resolveTarget(
      target({ framePath: [], strategies: [{ s: 'roleName', role: 'button', name: 'Sign In' }] }),
      o,
    );
    expect(res).toMatchObject({ ok: true, ref: 0, strategyIndex: 0, score: 1 });
  });

  it('refuses to guess between near-equal duplicates (TARGET_AMBIGUOUS)', async () => {
    const o = obs([el({ ref: 0, role: 'button', name: 'Search' }), el({ ref: 1, role: 'button', name: 'Search' })]);
    const res = await resolveTarget(
      target({ framePath: [], strategies: [{ s: 'roleName', role: 'button', name: 'Search' }] }),
      o,
    );
    expect(res).toMatchObject({ ok: false, reason: 'ambiguous' });
    if (!res.ok) expect(res.candidates).toHaveLength(2);
  });

  it('falls through the ladder in order and reports which strategy fired', async () => {
    const o = obs([el({ ref: 3, role: 'textbox', name: 'Member No. or Name', label: 'Member No. or Name' })]);
    const res = await resolveTarget(
      target({
        framePath: [],
        strategies: [
          { s: 'roleName', role: 'button', name: 'Find' }, // misses
          { s: 'labelText', label: 'Member No. or Name' }, // hits
        ],
      }),
      o,
    );
    expect(res).toMatchObject({ ok: true, ref: 3, strategyIndex: 1, strategy: 'labelText' });
  });

  it('addresses table cells by row anchor × column header', async () => {
    const o = obs([
      el({ ref: 0, role: 'cell', name: '$312.40', interactive: false, colHeader: 'Balance', nearText: 'S01 | CHECKING | Everyday Checking | $312.40' }),
      el({ ref: 1, role: 'cell', name: '$4,821.97', interactive: false, colHeader: 'Balance', nearText: 'S00 | REGULAR SAVINGS | Primary Savings | $4,821.97' }),
    ]);
    const res = await resolveTarget(
      target({
        framePath: [],
        strategies: [{ s: 'tableCell', rowAnchor: { text: 'REGULAR SAVINGS' }, columnHeader: 'Balance' }],
      }),
      o,
    );
    expect(res).toMatchObject({ ok: true, ref: 1 });
  });

  it('filters by frame path (same control in two frames)', async () => {
    const o = obs([
      el({ ref: 0, role: 'link', name: 'Home', framePath: [{ name: 'menu', url: 'http://x/nav' }] }),
      el({ ref: 1, role: 'link', name: 'Home', framePath: [{ name: 'work', url: 'http://x/home' }] }),
    ]);
    const res = await resolveTarget(
      target({ framePath: [{ name: 'work' }], strategies: [{ s: 'roleName', role: 'link', name: 'Home' }] }),
      o,
    );
    expect(res).toMatchObject({ ok: true, ref: 1 });
  });

  it('reports not_found with near-misses when no strategy is confident enough', async () => {
    const o = obs([el({ ref: 0, role: 'button', name: 'Search Members Now' })]);
    const res = await resolveTarget(
      target({
        framePath: [],
        strategies: [{ s: 'roleName', role: 'button', name: 'Search', nameMatch: 'contains' }],
        disambiguation: { requireUnique: true, minScore: 0.9 }, // contains scores 0.8 < 0.9
      }),
      o,
    );
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
    if (!res.ok) expect(res.candidates[0]).toMatchObject({ ref: 0 });
  });

  it('skips the web-tagged structural strategy when no lookup is available', async () => {
    const o = obs([el({ ref: 0, role: 'button', name: 'Go' })]);
    const res = await resolveTarget(
      target({
        framePath: [],
        strategies: [
          { s: 'structural', surface: 'web', css: 'input.btn' },
          { s: 'roleName', role: 'button', name: 'Go' },
        ],
      }),
      o,
    );
    expect(res).toMatchObject({ ok: true, ref: 0, strategyIndex: 1 });
  });
});

/**
 * The three decisions the ladder exists to make, none of which had a test.
 *
 * The existing suite covers the happy path (one confident candidate), the
 * trivial refusal (an exact tie), and the trivial threshold. A mutation audit
 * showed that "pick the best-scoring candidate", "how close is too close", and
 * "an exact anchor is exact" could all be broken with the suite still green —
 * and those are precisely the decisions that separate acting on the right
 * control from acting on the wrong one.
 */
describe('the decisions the ladder actually makes', () => {
  it('picks the best-scoring candidate, not the first one observed', async () => {
    // Both match the same rung; the weaker `contains` match is observed FIRST.
    // Take away the sort and replay clicks whichever control the DOM listed
    // first — on a screen with "Post Transfer" and "Post Transfer to Savings",
    // that is a different button.
    const o = obs([
      el({ ref: 0, role: 'button', name: 'Post Transfer to Savings' }), // contains → 0.8
      el({ ref: 1, role: 'button', name: 'Post Transfer' }), // exact → 1.0
    ]);
    const res = await resolveTarget(
      target({
        framePath: [],
        strategies: [{ s: 'roleName', role: 'button', name: 'Post Transfer', nameMatch: 'contains' }],
      }),
      o,
    );
    expect(res).toMatchObject({ ok: true, ref: 1, score: 1 });
  });

  it('acts when one candidate is decisively better, rather than refusing everything', async () => {
    // The counterweight to the ambiguity refusal, and the reason the epsilon is
    // a threshold rather than "any tie refuses". Two DIFFERENT scores with a
    // clear gap (1.0 vs 0.8) must resolve, or the ladder would refuse any
    // screen holding a control whose name contains another control's name —
    // which on a legacy console is most of them.
    const o = obs([
      el({ ref: 0, role: 'button', name: 'Apply Hold' }), // exact → 1.0
      el({ ref: 1, role: 'button', name: 'Apply Hold Now' }), // contains → 0.8
    ]);
    const res = await resolveTarget(
      target({
        framePath: [],
        strategies: [{ s: 'roleName', role: 'button', name: 'Apply Hold', nameMatch: 'contains' }],
      }),
      o,
    );
    // 1.0 − 0.8 = 0.2 > AMBIGUITY_EPSILON, so it acts, on the exact match.
    // Note what this does NOT pin: a gap SMALLER than the epsilon. Within one
    // rung the compiler only ever emits scores 0.2 apart, so the sub-epsilon
    // case is reachable only through the geometry modifier, which no fixture
    // constructs. That gap is real and is called out in the review notes.
    expect(res).toMatchObject({ ok: true, ref: 0 });
  });

  it("an exact rowAnchor must BE a cell, not merely appear inside one", async () => {
    // `match: 'exact'` carries the longest justifying comment in the resolver
    // and is used by no shipped artifact, so the branch had zero coverage.
    // Relaxed to a substring, anchor `S01` also matches row `S010` — the wrong
    // account's balance, returned confidently.
    const o = obs([
      el({
        ref: 0,
        role: 'cell',
        name: '$9.99',
        colHeader: 'Balance',
        cellTexts: ['S010', 'Holiday Club', '$9.99'],
        nearText: 'S010 | Holiday Club | $9.99',
      }),
    ]);
    const res = await resolveTarget(
      target({
        framePath: [],
        strategies: [{ s: 'tableCell', rowAnchor: { text: 'S01', match: 'exact' }, columnHeader: 'Balance' }],
      }),
      o,
    );
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('the same exact rowAnchor still resolves the row it really names', async () => {
    // The positive control: without it the test above passes if `tableCell`
    // stops matching anything at all.
    const o = obs([
      el({
        ref: 0,
        role: 'cell',
        name: '$1.00',
        colHeader: 'Balance',
        cellTexts: ['S01', 'Everyday', '$1.00'],
        nearText: 'S01 | Everyday | $1.00',
      }),
    ]);
    const res = await resolveTarget(
      target({
        framePath: [],
        strategies: [{ s: 'tableCell', rowAnchor: { text: 'S01', match: 'exact' }, columnHeader: 'Balance' }],
      }),
      o,
    );
    expect(res).toMatchObject({ ok: true, ref: 0 });
  });
});
