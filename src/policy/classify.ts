/**
 * Field classification: registering regulated on-screen data with the redactor
 * even when no capability declared it.
 *
 * Sensitivity annotations on params and outputs only cover values the FLOW
 * knows about. A member-servicing console puts far more on screen than any one
 * capability names — a last-name search lists other members' numbers and
 * names, a record screen shows an address and phone the flow never reads. None
 * of that is a param or an output, so none of it was ever redacted.
 *
 * The app profile classifies those fields by label and by column header (the
 * only handles a legacy screen offers), and every observation is swept through
 * here so the values land in the redactor before anything is written.
 */
import type { Observation } from '../core/types.js';
import type { AppProfile } from '../profile/appProfile.js';
import type { Redactor, Sensitivity } from './redact.js';
import { maxSensitivity } from './redact.js';

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

interface ClassifiedFields {
  labels?: string[] | undefined;
  labelPatterns?: string[] | undefined;
  columns?: string[] | undefined;
}

/**
 * Does this text name a classified field? Literal labels match normalised
 * (case/spacing-insensitive); patterns match the label AS RENDERED, because a
 * per-record label — a share id like "101555-S0001:" — is distinguished from
 * ordinary prose precisely by its case and punctuation.
 */
function labelMatcher(fields: ClassifiedFields): { any: boolean; matches: (text: string) => boolean } {
  const labels = new Set((fields.labels ?? []).map(norm));
  const patterns = (fields.labelPatterns ?? []).map((p) => new RegExp(p));
  return {
    any: labels.size > 0 || patterns.length > 0,
    matches: (text: string) => {
      const rendered = text.replace(/\s+/g, ' ').trim();
      return labels.has(norm(rendered)) || patterns.some((re) => re.test(rendered));
    },
  };
}

/**
 * The row's cells as WHOLE strings.
 *
 * `cellTexts` is authoritative; splitting `nearText` on '|' is a fallback for
 * observations recorded before the walker emitted it, and an unsound one: a
 * cell whose own text contains a pipe (an address, a memo) splits into two and
 * shifts every later index, so the label→value pairing goes off by one — the
 * neighbouring value gets redacted and the regulated one stays in the clear.
 */
function rowCells(el: { cellTexts?: string[] | undefined; nearText?: string | undefined }): string[] {
  if (el.cellTexts !== undefined) return el.cellTexts.map((c) => c.trim());
  return (el.nearText ?? '').split('|').map((c) => c.trim());
}

/**
 * Register every classified value visible in this observation.
 * Returns how many distinct values were newly registered (evidence-worthy: it
 * shows the sweep is actually finding things).
 *
 * `onGap` reports a classified label with no value cell after it — a row that
 * was truncated, or a label sitting last in its row. The sweep cannot redact
 * what it cannot see, so the honest thing is to say so on the event stream
 * rather than to return a count that quietly under-reports.
 */
export function classifyObservation(
  obs: Observation,
  classification: AppProfile['dataClassification'],
  redactor: Redactor,
  onGap?: (detail: { label: string; rowId?: string }) => void,
): number {
  if (!classification) return 0;
  let registered = 0;

  const sweep = (fields: ClassifiedFields | undefined, sensitivity: Sensitivity): void => {
    if (!fields) return;
    const label = labelMatcher(fields);
    const columns = new Set((fields.columns ?? []).map(norm));

    // Column-addressed: table cells under a classified header.
    if (columns.size > 0) {
      for (const el of obs.elements) {
        if (el.colHeader === undefined || !columns.has(norm(el.colHeader))) continue;
        const value = el.value ?? el.name;
        if (value && redactor.register('classified', value, sensitivity)) registered += 1;
      }
    }

    // Label-addressed: legacy record screens are label/value cell PAIRS in one
    // row, so the value is the cell following the label in that row.
    if (label.any) {
      const seenRows = new Set<string>();
      for (const el of obs.elements) {
        // A form control carries its own label directly.
        if (el.label !== undefined && label.matches(el.label)) {
          const value = el.value ?? '';
          if (value && redactor.register('classified', value, sensitivity)) registered += 1;
        }
        const rowKey = el.rowId ?? el.nearText;
        if (rowKey === undefined || seenRows.has(rowKey)) continue;
        seenRows.add(rowKey);
        const cells = rowCells(el);
        cells.forEach((cell, i) => {
          if (!label.matches(cell)) return;
          const value = cells[i + 1];
          if (value === undefined || value === '') {
            // The label is the last cell we can see: either it genuinely ends
            // the row, or the row was truncated between label and value. Either
            // way there is nothing to register, and silence would look
            // identical to "nothing regulated was on screen".
            onGap?.({ label: cell, ...(el.rowId !== undefined ? { rowId: el.rowId } : {}) });
            return;
          }
          if (redactor.register('classified', value, sensitivity)) registered += 1;
        });
      }
    }
  };

  sweep(classification.pii, 'pii');
  // Balances and amounts are masked with the same stub as PII — the point is
  // that they do not persist, not that they are distinguishable once masked.
  sweep(classification.financial, 'pii');
  return registered;
}

/**
 * The keys a classified field can be addressed by, for matching a PARAM NAME
 * against a screen label. Normalisation drops everything a label carries for
 * the human eye and a param name cannot: punctuation, spacing, case, and the
 * trailing colon ("E-mail:" → "email"). A multi-word label additionally yields
 * its last word ("Mailing Address:" → "address"), because that is the head noun
 * a param is conventionally named after.
 */
function fieldKeys(field: string): string[] {
  const squashed = norm(field).replace(/[^a-z0-9]/g, '');
  const words = norm(field)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const last = words[words.length - 1];
  return last !== undefined && last !== squashed ? [squashed, last] : [squashed];
}

/**
 * The sensitivity a param must actually be handled at: the stronger of what the
 * artifact declares and what the app profile implies for a field of that name.
 *
 * Why this exists: an artifact's `sensitivity` is a hand-typed annotation
 * chosen once at compile time and cross-checked against nothing, so a member's
 * e-mail can be declared `none` while the very same profile that the run loads
 * classifies the screen's "E-mail:" field as PII. When the two disagree the
 * profile — a reviewed, app-wide statement about the data — wins, and it can
 * only RAISE: a profile can never talk a flow out of protecting something.
 *
 * The matching rule is deliberately narrow and name-based (see fieldKeys): a
 * param is regulated when its name is the name of a classified label or column.
 * What it does NOT do is infer from the VALUE — nothing here looks at whether a
 * string is shaped like an e-mail — so a param called `contact` carrying an
 * e-mail address is still only as protected as it declares itself to be. Value
 * sniffing would over-redact evidence that must stay readable; the observation
 * sweep in classifyObservation() is what catches such values once they appear
 * on screen. The gap this closes is exactly the window before that: run_start
 * writes the params before any observation exists.
 */
export function effectiveParamSensitivity(
  paramName: string,
  declared: Sensitivity,
  classification: AppProfile['dataClassification'],
): Sensitivity {
  if (!classification) return declared;
  const key = norm(paramName).replace(/[^a-z0-9]/g, '');
  if (key === '') return declared;
  for (const fields of [classification.pii, classification.financial]) {
    if (!fields) continue;
    // Financial values are masked with the same stub as PII (see the sweep
    // below), so both groups raise to the same level. labelPatterns are
    // deliberately NOT consulted: they describe labels that vary per record
    // (a share id), which is a shape no param NAME ever takes — matching them
    // here could only produce false positives.
    const all = [...(fields.labels ?? []), ...(fields.columns ?? [])];
    if (all.some((f) => fieldKeys(f).includes(key))) return maxSensitivity(declared, 'pii');
  }
  return declared;
}

/**
 * Element indices (per frame) whose on-screen rendering shows classified data,
 * so a screenshot can black them out before it is written to evidence.
 */
export function classifiedElementRefs(obs: Observation, classification: AppProfile['dataClassification']): number[] {
  if (!classification) return [];
  const refs: number[] = [];
  const collect = (fields: ClassifiedFields | undefined): void => {
    if (!fields) return;
    const label = labelMatcher(fields);
    const columns = new Set((fields.columns ?? []).map(norm));
    for (const el of obs.elements) {
      const byColumn = el.colHeader !== undefined && columns.has(norm(el.colHeader));
      const byLabel = el.label !== undefined && label.matches(el.label);
      // A value cell sitting immediately after a classified label cell. Read
      // from cellTexts for the same reason the sweep does: a pipe inside one
      // cell would otherwise shift the neighbour and mask the wrong element.
      let byNeighbour = false;
      if (!byColumn && !byLabel && label.any && (el.cellTexts !== undefined || el.nearText !== undefined)) {
        const cells = rowCells(el);
        const idx = cells.findIndex((c) => norm(c) === norm(el.name));
        byNeighbour = idx > 0 && label.matches(cells[idx - 1] ?? '');
      }
      if (byColumn || byLabel || byNeighbour) refs.push(el.ref);
    }
  };
  collect(classification.pii);
  collect(classification.financial);
  return [...new Set(refs)];
}
