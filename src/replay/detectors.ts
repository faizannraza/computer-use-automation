/** Evaluates a Condition against an Observation. One evaluator serves step
 * postconditions, outcome detectors, recovery triggers, anomaly screens,
 * and success criteria. */
import type { Observation } from '../core/types.js';
import type { Condition } from '../schema/conditions.js';
import type { FrameHint } from '../schema/locators.js';
import { frameMatches, resolveTarget } from '../surface/web/locatorResolver.js';
import { globToRegExp } from '../core/template.js';

function textMatches(haystack: string, pattern: string, regex: boolean | undefined): boolean {
  if (regex) return new RegExp(pattern, 'i').test(haystack);
  return haystack.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * The text a frame-scoped condition evaluates against. Unscoped conditions
 * see the whole surface's text. A scoped condition returns undefined — the
 * check has no evidence — when the observation carries no per-frame text at
 * all (a held dialog, a synthetic observation) AND when no observed frame
 * matches the hint (mid-transition, blank frame, wrong page). Undefined must
 * never satisfy either polarity: textPresent-by-blindness and
 * textAbsent-by-blindness are both exactly the false positives the scope
 * exists to prevent.
 */
function scopedText(obs: Observation, frame: FrameHint | undefined): string | undefined {
  if (frame === undefined) return obs.visibleText;
  if (obs.frameTexts === undefined) return undefined;
  const matched = obs.frameTexts.filter((f) => frameMatches([frame], f.framePath));
  if (matched.length === 0) return undefined; // the frame was not observed — that is not evidence of absence
  return matched.map((f) => f.text).join('\n');
}

export async function evaluateCondition(cond: Condition, obs: Observation): Promise<boolean> {
  switch (cond.c) {
    case 'textPresent': {
      const hay = scopedText(obs, cond.frame);
      return hay !== undefined && textMatches(hay, cond.pattern, cond.regex);
    }
    case 'textAbsent': {
      // Scoped-but-unevaluable is false here too: "the text is absent" must
      // never be satisfied by an inability to look.
      const hay = scopedText(obs, cond.frame);
      return hay !== undefined && !textMatches(hay, cond.pattern, cond.regex);
    }
    case 'urlMatches':
      return globToRegExp(cond.pattern).test(obs.location);
    case 'dialogOpen':
      if (!obs.dialog) return false;
      return cond.textPattern === undefined || textMatches(obs.dialog.text, cond.textPattern, undefined);
    case 'elementPresent': {
      const res = await resolveTarget(cond.target, obs); // structural strategies skipped: pure check
      return res.ok;
    }
    case 'all': {
      for (const c of cond.of) if (!(await evaluateCondition(c, obs))) return false;
      return true;
    }
    case 'any': {
      for (const c of cond.of) if (await evaluateCondition(c, obs)) return true;
      return false;
    }
  }
}

export async function evaluateAll(conds: Condition[], obs: Observation): Promise<boolean> {
  for (const c of conds) if (!(await evaluateCondition(c, obs))) return false;
  return true;
}

/** Human-readable rendering for `expected` fields in failure reports. */
export function renderCondition(cond: Condition): string {
  switch (cond.c) {
    case 'textPresent':
      return `textPresent ${JSON.stringify(cond.pattern)}${renderFrame(cond.frame)}`;
    case 'textAbsent':
      return `textAbsent ${JSON.stringify(cond.pattern)}${renderFrame(cond.frame)}`;
    case 'urlMatches':
      return `urlMatches ${JSON.stringify(cond.pattern)}`;
    case 'dialogOpen':
      return cond.textPattern ? `dialogOpen ~ ${JSON.stringify(cond.textPattern)}` : 'dialogOpen';
    case 'elementPresent': {
      const first = cond.target.strategies[0];
      return `elementPresent [${first ? describeLocator(first) : '?'}]`;
    }
    case 'all':
      return `all(${cond.of.map(renderCondition).join(', ')})`;
    case 'any':
      return `any(${cond.of.map(renderCondition).join(', ')})`;
  }
}

export function renderConditions(conds: Condition[]): string {
  return conds.map(renderCondition).join(' AND ');
}

function renderFrame(frame: FrameHint | undefined): string {
  if (frame === undefined) return '';
  return ` [frame ${frame.name ?? frame.urlPattern ?? '?'}]`;
}

function describeLocator(loc: { s: string } & Record<string, unknown>): string {
  switch (loc.s) {
    case 'roleName':
      return `${String(loc['role'])} ${JSON.stringify(loc['name'])}`;
    case 'labelText':
      return `label ${JSON.stringify(loc['label'])}`;
    case 'textAnchor':
      return `${String(loc['relation'])} ${JSON.stringify(loc['text'])}`;
    case 'tableCell': {
      const anchor = loc['rowAnchor'] as { text: string };
      return `cell[row~${JSON.stringify(anchor.text)} × col ${JSON.stringify(loc['columnHeader'])}]`;
    }
    default:
      return loc.s;
  }
}

/** Compact description of what was actually observed, for failure reports. */
