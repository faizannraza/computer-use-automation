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
