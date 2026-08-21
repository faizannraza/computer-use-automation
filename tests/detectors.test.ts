/** Condition evaluation — the one vocabulary every classification uses. */
import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/core/types.js';
import { applyTemplate, substituteDeep } from '../src/core/template.js';
import type { Condition } from '../src/schema/conditions.js';
import { ConditionSchema } from '../src/schema/conditions.js';
import { evaluateCondition, renderCondition } from '../src/replay/detectors.js';
import { summarizeObservation } from '../src/core/observation.js';

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

  it('an unobserved frame is not evidence of absence: no matching frame → false for BOTH polarities', async () => {
    // A held dialog reports frameTexts: [] (the page is unobservable), and a
    // mid-transition frame may simply be missing — a scoped textAbsent must
    // not be satisfied by an inability to look.
    const dialogHeld: Observation = { ...obs, frameTexts: [], dialog: { kind: 'confirm', text: 'Post this transaction?' } };
    expect(await evaluateCondition(cond({ c: 'textAbsent', pattern: 'Error', frame: { name: 'work' } }), dialogHeld)).toBe(false);
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: 'Standing', frame: { name: 'work' } }), dialogHeld)).toBe(false);
    // Frame name that matches nothing in a normal observation: same rule.
    expect(await evaluateCondition(cond({ c: 'textAbsent', pattern: 'anything', frame: { name: 'ghost' } }), obs)).toBe(false);
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: 'Standing', frame: { name: 'ghost' } }), obs)).toBe(false);
  });

  it('a BLANK observed frame is evidence of absence — unlike an unobserved one', async () => {
    const blankWork: Observation = {
      ...obs,
      frameTexts: [
        { framePath: [{ name: 'menu', url: 'http://localhost:4173/nav' }], text: 'Main Menu' },
        { framePath: [{ name: 'work', url: 'http://localhost:4173/blank' }], text: '' },
      ],
    };
    // The work frame was walked and is genuinely empty: absence holds,
    // presence does not.
    expect(await evaluateCondition(cond({ c: 'textAbsent', pattern: 'Processing', frame: { name: 'work' } }), blankWork)).toBe(true);
    expect(await evaluateCondition(cond({ c: 'textPresent', pattern: 'anything', frame: { name: 'work' } }), blankWork)).toBe(false);
  });

  it('rejects an empty frame hint — it would match every frame and look scoped while being unscoped', () => {
    expect(() => cond({ c: 'textPresent', pattern: 'x', frame: {} })).toThrow(/name and\/or urlPattern/);
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

/**
 * `urlMatches` is anchored, and that had never been tested.
 *
 * The one existing negative case (a glob ending in "login", against a members
 * URL) fails for the wrong reason: the URL contains no "login" substring
 * anywhere, so it returns false whether the regex is anchored or not. Unanchor
 * globToRegExp and the suite stays green while a glob ending in "members"
 * starts matching every member DETAIL page — a postcondition meant to assert
 * "we are back on the list screen" would pass on the record you just opened.
 */
describe('urlMatches anchoring', () => {
  it('does not treat a prefix as a match', async () => {
    // obs.location is http://localhost:4173/members/12345
    expect(await evaluateCondition(ConditionSchema.parse({ c: 'urlMatches', pattern: '*/members' }), obs)).toBe(false);
  });

  it('still matches when the pattern covers the whole path', async () => {
    expect(await evaluateCondition(ConditionSchema.parse({ c: 'urlMatches', pattern: '*/members/*' }), obs)).toBe(true);
  });
});
