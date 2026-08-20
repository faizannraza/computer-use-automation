/** Condition evaluation — the one vocabulary every classification uses. */
import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/core/types.js';
import { applyTemplate, substituteDeep } from '../src/core/template.js';
import type { Condition } from '../src/schema/conditions.js';
import { ConditionSchema } from '../src/schema/conditions.js';
import { evaluateCondition, renderCondition, summarizeObservation } from '../src/replay/detectors.js';

const obs: Observation = {
  seq: 1,
  location: 'http://localhost:4173/members/12345',
  title: 'MockCore Teller — Member 12345',
  elements: [
    {
      ref: 0,
      role: 'heading',
      name: 'Member Details',
      framePath: [{ name: 'work', url: 'http://localhost:4173/members/12345' }],
      interactive: false,
    },
  ],
  visibleText: 'Member Information Standing GOOD $4,821.97',
  frameTexts: [
    { framePath: [{ name: 'menu', url: 'http://localhost:4173/nav' }], text: 'Main Menu Home Member Search Session' },
    { framePath: [{ name: 'work', url: 'http://localhost:4173/members/12345' }], text: 'Member Information Standing GOOD $4,821.97' },
  ],
  at: new Date().toISOString(),
};

const cond = (raw: unknown): Condition => ConditionSchema.parse(raw);

describe('evaluateCondition', () => {
  it('textPresent / textAbsent (case-insensitive substring)', async () => {
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: 'member information' }), obs)).toBe(true);
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: 'No members matched' }), obs)).toBe(false);
    expect(await evaluateCondition(cond({ c: 'textAbsent', pattern: 'No members matched' }), obs)).toBe(true);
  });

  it('textPresent with regex flag', async () => {
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: '\\$[\\d,]+\\.\\d{2}', regex: true }), obs)).toBe(true);
  });

  it('urlMatches with glob patterns', async () => {
    expect(await evaluateCondition(cond({ c: 'urlMatches', pattern: '*/members/*' }), obs)).toBe(true);
    expect(await evaluateCondition(cond({ c: 'urlMatches', pattern: '*/login' }), obs)).toBe(false);
  });

  it('dialogOpen with and without a text pattern', async () => {
    const withDialog: Observation = { ...obs, dialog: { kind: 'confirm', text: 'Continue to the screen?' } };
    expect(await evaluateCondition(cond({ c: 'dialogOpen' }), obs)).toBe(false);
    expect(await evaluateCondition(cond({ c: 'dialogOpen' }), withDialog)).toBe(true);
    expect(await evaluateCondition(cond({ c: 'dialogOpen', textPattern: 'continue' }), withDialog)).toBe(true);
    expect(await evaluateCondition(cond({ c: 'dialogOpen', textPattern: 'delete' }), withDialog)).toBe(false);
  });

  it('frame-scoped textPresent sees only the named frame — chrome text cannot satisfy it', async () => {
    // "Session" lives in the nav chrome. Unscoped, it matches anywhere;
    // scoped to the work frame, it correctly does not.
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: 'Session' }), { ...obs, visibleText: obs.visibleText + ' Session' })).toBe(true);
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: 'Session', frame: { name: 'work' } }), obs)).toBe(false);
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: 'Session', frame: { name: 'menu' } }), obs)).toBe(true);
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: 'Standing', frame: { name: 'work' } }), obs)).toBe(true);
  });

  it('frame-scoped textAbsent is scoped the same way', async () => {
    expect(await evaluateCondition(cond({ c: 'textAbsent', pattern: 'Session', frame: { name: 'work' } }), obs)).toBe(true);
    expect(await evaluateCondition(cond({ c: 'textAbsent', pattern: 'Standing', frame: { name: 'work' } }), obs)).toBe(false);
  });

  it('a scoped condition never silently widens when per-frame text is unavailable', async () => {
    const noFrames: Observation = { ...obs };
    delete noFrames.frameTexts;
    // The text IS on the page, but the scope cannot be evaluated — both
    // present and absent refuse to claim anything they cannot see.
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: 'Standing', frame: { name: 'work' } }), noFrames)).toBe(false);
    expect(await evaluateCondition(cond({ c: 'textAbsent', pattern: 'nope', frame: { name: 'work' } }), noFrames)).toBe(false);
    // Unscoped conditions are unaffected.
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: 'Standing' }), noFrames)).toBe(true);
  });

  it('elementPresent resolves through the locator ladder', async () => {
    const present = cond({
      c: 'elementPresent',
      target: { framePath: [], strategies: [{ s: 'roleName', role: 'heading', name: 'Member Details' }] },
    });
    const absent = cond({
      c: 'elementPresent',
      target: { framePath: [], strategies: [{ s: 'roleName', role: 'button', name: 'Delete' }] },
    });
    expect(await evaluateCondition(present, obs)).toBe(true);
    expect(await evaluateCondition(absent, obs)).toBe(false);
  });

  it('all / any combinators nest', async () => {
    const c = cond({
      c: 'all',
      of: [
        { c: 'textPresent', pattern: 'Standing' },
        { c: 'any', of: [{ c: 'textPresent', pattern: 'nope' }, { c: 'urlMatches', pattern: '*/members/*' }] },
      ],
    });
    expect(await evaluateCondition(c, obs)).toBe(true);
  });
});

describe('templates', () => {
  it('substitutes placeholders and fails loudly on unresolved ones', () => {
    expect(applyTemplate('{baseUrl}/members/{memberId}', { baseUrl: 'http://x', memberId: '12345' })).toBe(
      'http://x/members/12345',
    );
    expect(() => applyTemplate('{missing}', {})).toThrow(/unresolved placeholder/);
  });

  it('substituteDeep reaches strings nested in conditions and targets', () => {
    const c = substituteDeep(cond({ c: 'textPresent', pattern: 'Member {memberId}' }), { memberId: '777' });
    expect(c).toEqual({ c: 'textPresent', pattern: 'Member 777' });
  });
});

describe('rendering', () => {
  it('renders conditions and observations for failure reports', () => {
    expect(renderCondition(cond({ c: 'textPresent', pattern: 'Standing' }))).toBe('textPresent "Standing"');
    expect(renderCondition(cond({ c: 'textPresent', pattern: 'Standing', frame: { name: 'work' } }))).toBe(
      'textPresent "Standing" [frame work]',
    );
    const summary = summarizeObservation(obs);
    expect(summary).toContain('at http://localhost:4173/members/12345');
    expect(summary).toContain('Member Details');
  });
});
