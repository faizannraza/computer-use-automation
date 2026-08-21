/**
 * Rendering an observation for the model is a WRITE BOUNDARY: whatever it
 * produces lands in `transcript.json` and in the model's context. Redaction is
 * exact-string substitution over registered needles, so anything this renderer
 * shortens must be shortened on a boundary that keeps values whole — a value
 * cut in half matches no needle and ships in the clear.
 *
 * This is not hypothetical. An earlier `nearText.slice(0, 80)` here put
 * `E-mail:ada.lovelacn@example.c` into committed discovery evidence: one
 * character short of matching its needle, and enough to identify the member.
 */
import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/policy/redact.js';
import { renderObservationText } from '../src/discovery/render.js';
import type { Observation, ObservedElement } from '../src/core/types.js';

const cell = (ref: number, over: Partial<ObservedElement> = {}): ObservedElement => ({
  ref,
  role: 'cell',
  name: '',
  framePath: [],
  interactive: false,
  ...over,
});

const obsOf = (elements: ObservedElement[]): Observation => ({
  seq: 1,
  at: '2026-08-20T12:00:00.000Z',
  location: 'https://example.test/members/100234',
  title: 'MEMBER RECORD',
  elements,
  visibleText: '',
});

describe('rendering an observation for the model', () => {
  const EMAIL = 'ada.lovelace@example.com';
  // Sized so the e-mail STRADDLES the 80-character budget rather than falling
  // wholly inside or outside it: the leading cells run to 64 characters, so a
  // naive `slice(0, 80)` keeps 16 characters of the address — comfortably
  // enough to identify the member, and exactly the shape of the real leak.
  const cells = ['MEMBER RECORD', 'Member No.:', 'Name:', 'Lovelace, Ada', 'E-mail:', EMAIL];

  it('never emits a partial cell, so a classified value stays matchable', () => {
    const text = renderObservationText(
      obsOf([cell(0, { name: EMAIL, cellTexts: cells, nearText: cells.join(' | ') })]),
    );
    const row = /row="((?:[^"\\]|\\.)*)"/.exec(text);
    expect(row, 'the row anchor should be rendered').not.toBeNull();

    // Whatever survived must be a sequence of WHOLE cells — the property that
    // makes every value in it either fully present or fully absent.
    const rendered = JSON.parse(`"${row![1]!}"`) as string;
    for (const part of rendered.split(' | ')) {
      if (part === '') continue;
      expect(cells, `"${part}" is not a whole cell`).toContain(part);
    }
  });

  it('a truncated row leaves no unredactable prefix of the value behind', () => {
    const redactor = new Redactor();
    redactor.register('email', EMAIL, 'pii');
    const rendered = redactor.apply(
      renderObservationText(obsOf([cell(0, { name: 'x', cellTexts: cells, nearText: cells.join(' | ') })])),
    );
    // Every prefix long enough to identify the member must be gone, not just
    // the full string: a needle only matches what it matches.
    for (let n = 12; n <= EMAIL.length; n += 1) {
      expect(rendered, `leaked a ${n}-char prefix of the e-mail`).not.toContain(EMAIL.slice(0, n));
    }
  });

  it('keeps a row whole when it fits inside the budget', () => {
    const small = ['S01', 'Regular Shares', 'OPEN'];
    const text = renderObservationText(
      obsOf([cell(0, { name: 'Select', cellTexts: small, nearText: small.join(' | ') })]),
    );
    expect(text).toContain(small.join(' | '));
  });

  it('falls back to cell-aligned splitting for observations recorded without cellTexts', () => {
    const text = renderObservationText(obsOf([cell(0, { name: 'x', nearText: cells.join(' | ') })]));
    const row = /row="((?:[^"\\]|\\.)*)"/.exec(text);
    // Without this, the test cannot fail: when the regex misses, `rendered` is
    // '', `''.split(' | ')` yields [''], the `continue` fires, and the loop
    // makes zero assertions. Verified by suppressing the `row=` attribute in
    // render.ts — two sibling tests failed and this one still passed.
    expect(row, 'no row= attribute was rendered at all').not.toBeNull();
    const rendered = JSON.parse(`"${row![1]!}"`) as string;
    expect(rendered, 'the row rendered empty').not.toBe('');
    for (const part of rendered.split(' | ')) {
      if (part === '') continue;
      expect(cells).toContain(part);
    }
  });
});

/**
 * `summarizeObservation` is the third place a length limit met exact-string
 * redaction and lost. It is routed to the human deciding an approval and
 * written into `intervention-*.json` and failure reports, and it truncates —
 * so it must redact BEFORE it cuts. A real approval record carried
 * `Member: 100234 - Lovelace,` because it cut first.
 */
describe('summarizing an observation for an operator', () => {
  const NAME = 'Lovelace, Ada';
  // The snippet is cut at 200 characters. Place the name so it STRADDLES that
  // boundary — inside it, or wholly past it, and the test would pass whether
  // or not redaction runs first.
  const lead = 'MERIDIAN CORE CONFIRM ACCOUNT HOLD IRREVERSIBLE ACTION Member: 100234 - ';
  const filler = 'SHARES BALANCES '.repeat(40).slice(0, 200 - 6 - lead.length);

  const held = (): Observation => ({
    ...obsOf([cell(0, { role: 'heading', name: `Member: 100234 - ${NAME}` })]),
    visibleText: `${filler}${lead}${NAME} Reason: FRAUD`,
  });

  it('leaves no partial name behind when the snippet is cut', async () => {
    const { summarizeObservation } = await import('../src/core/observation.js');
    const redactor = new Redactor();
    redactor.register('memberName', NAME, 'pii');
    const summary = summarizeObservation(held(), (t) => redactor.apply(t));
    for (let n = 6; n <= NAME.length; n += 1) {
      expect(summary, `leaked a ${n}-char prefix of the member name`).not.toContain(NAME.slice(0, n));
    }
  });

  it('still says what screen the operator is looking at', async () => {
    const { summarizeObservation } = await import('../src/core/observation.js');
    const redactor = new Redactor();
    redactor.register('memberName', NAME, 'pii');
    const summary = summarizeObservation(held(), (t) => redactor.apply(t));
    expect(summary).toContain('CONFIRM ACCOUNT HOLD');
    expect(summary).toContain('100234');
  });
});
