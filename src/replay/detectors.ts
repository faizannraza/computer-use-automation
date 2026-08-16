/** Evaluates a Condition against an Observation. One evaluator serves step
 * postconditions, outcome detectors, recovery triggers, anomaly screens,
 * and success criteria. */
import type { Observation } from '../core/types.js';
import type { Condition } from '../schema/conditions.js';
import { resolveTarget } from '../surface/web/locatorResolver.js';
import { globToRegExp } from '../core/template.js';

function textMatches(haystack: string, pattern: string, regex: boolean | undefined): boolean {
  if (regex) return new RegExp(pattern, 'i').test(haystack);
  return haystack.toLowerCase().includes(pattern.toLowerCase());
}

export async function evaluateCondition(cond: Condition, obs: Observation): Promise<boolean> {
  switch (cond.c) {
    case 'textPresent':
      return textMatches(obs.visibleText, cond.pattern, cond.regex);
    case 'textAbsent':
      return !textMatches(obs.visibleText, cond.pattern, cond.regex);
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
      return `textPresent ${JSON.stringify(cond.pattern)}`;
    case 'textAbsent':
      return `textAbsent ${JSON.stringify(cond.pattern)}`;
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
export function summarizeObservation(obs: Observation): string {
  const parts: string[] = [`at ${obs.location}`];
  if (obs.title) parts.push(`title ${JSON.stringify(obs.title)}`);
  if (obs.dialog) parts.push(`OPEN DIALOG (${obs.dialog.kind}): ${JSON.stringify(obs.dialog.text.slice(0, 120))}`);
  const headings = obs.elements
    .filter((e) => e.role === 'heading' || e.role === 'rowheader')
    .slice(0, 6)
    .map((e) => e.name);
  if (headings.length > 0) parts.push(`headings: ${headings.join(' | ')}`);
  const snippet = obs.visibleText.replace(/\s+/g, ' ').slice(0, 200);
  if (snippet) parts.push(`text: "${snippet}…"`);
  return parts.join('; ');
}
