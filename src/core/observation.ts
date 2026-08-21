/**
 * Rendering an observation for a human.
 *
 * Lives in `core/` rather than beside the replay detectors because BOTH engines
 * need it: replay puts it in failure reports and on approval cards, and
 * discovery puts it on the approval card of an irreversible click it is
 * recording. It was previously imported by discovery FROM replay, which was the
 * one edge contradicting "discovery and replay never import each other" — the
 * artifact is supposed to be their only interface, and a shared formatter
 * belongs in the layer underneath both rather than in one of them.
 */
import type { Observation } from './types.js';

/**
 * A short, human-readable description of what was on screen — routed to an
 * operator deciding an approval, and written into failure reports.
 *
 * `redact` is optional but should almost always be supplied, because this
 * function TRUNCATES. Redaction is exact-string substitution over registered
 * needles, so cutting the text first leaves a partial value that no needle
 * matches: an approval record once carried `Member: 100234 - Lovelace,` — the
 * member's surname, in cleartext, in the file a reviewer opens. Redacting
 * BEFORE the cut fixes it for good, because a mask is a fixed short stub and
 * truncating a mask is harmless.
 */
export function summarizeObservation(obs: Observation, redact?: (text: string) => string): string {
  const parts: string[] = [`at ${obs.location}`];
  if (obs.title) parts.push(`title ${JSON.stringify(obs.title)}`);
  const scrub = redact ?? ((t: string) => t);
  if (obs.dialog) parts.push(`OPEN DIALOG (${obs.dialog.kind}): ${JSON.stringify(scrub(obs.dialog.text).slice(0, 120))}`);
  const headings = obs.elements
    .filter((e) => e.role === 'heading' || e.role === 'rowheader')
    .slice(0, 6)
    .map((e) => scrub(e.name));
  if (headings.length > 0) parts.push(`headings: ${headings.join(' | ')}`);
  // Which frames were observed — the fact a frame-scoped condition turns on.
  if (obs.frameTexts !== undefined && obs.frameTexts.length > 0) {
    const names = obs.frameTexts.map((f) => f.framePath[f.framePath.length - 1]?.name ?? '(main)');
    parts.push(`frames observed: ${names.join(', ')}`);
  }
  const snippet = scrub(obs.visibleText.replace(/\s+/g, ' ')).slice(0, 200);
  if (snippet) parts.push(`text: "${snippet}…"`);
  return parts.join('; ');
}
