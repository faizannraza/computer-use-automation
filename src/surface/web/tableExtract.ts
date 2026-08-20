/**
 * Table extraction over an Observation — the mechanism behind the `readTable`
 * semantic action.
 *
 * A member-servicing console answers "what are this member's shares?" with a
 * TABLE, not a cell. Our element model already carries what that needs: each
 * observed cell knows its column header (mined from the header row) and which
 * row it belongs to. Grouping cells by row identity under the requested
 * headers reconstructs the rows without any new perception.
 *
 * Kept pure and driver-free so it is unit-testable without a browser, and so a
 * desktop surface could satisfy the same action from a native grid control.
 */
import type { Observation, ObservedElement } from '../../core/types.js';
import type { FrameHint } from '../../schema/locators.js';
import { frameMatches } from './locatorResolver.js';

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Separator inside a composed row key: cannot occur in any component. */
const SEP = '\u0000';

/**
 * The key that decides which observed cells are "the same row".
 *
 * `rowId` is real identity (table ordinal + row ordinal, assigned by the
 * walker) and wins whenever it is present. `nearText` is a fallback for
 * observations recorded before rowId existed, and a WEAK one: it is the row's
 * cells joined and truncated to 160 chars, so a ledger's duplicate posting
 * (byte-identical rows) and two wide rows sharing a 160-char prefix both
 * collapse into one row — losing a transaction, or reporting the LAST-walked
 * cell as that row's balance. It is kept so old traces still extract
 * something, not because it can be trusted.
 *
 * The frame is always part of the key: rowIds restart per document, so two
 * frames' tables would otherwise merge row-for-row.
 */
function rowKey(el: ObservedElement): string {
  const frame = el.framePath.map((f) => `${f.name ?? ''}@${f.url}`).join('>');
  if (el.rowId !== undefined) return `${frame}${SEP}id${SEP}${el.rowId}`;
  if (el.nearText !== undefined) return `${frame}${SEP}tx${SEP}${el.nearText}`;
  // No identity at all: give the cell a row of its own rather than merge it
  // into an unrelated one.
  return `${frame}${SEP}ref${SEP}${el.ref}`;
}

/**
 * Rows of `columns` → cell text, in the order the rows appear on screen.
 *
 * Deliberate behaviour at the edges, chosen so a caller never receives a value
 * belonging to a different column or a different row:
 *  - A requested column that exists nowhere on the page is absent from every
 *    row — never `''`, which would read as "the page said this is blank".
 *  - A column absent from ONE row (ragged rows; a cell the walker skipped
 *    because it wraps a control) is absent from that row's object only.
 *  - A header that appears TWICE ("Amount" over two columns) resolves to the
 *    leftmost such cell in each row; later duplicates are dropped. Last-write
 *    would make the answer depend on walk order, and nothing recommends the
 *    right-hand column over the left — screen order is at least stable and
 *    matches what a person reading the row sees first.
 */
export function extractTable(
  obs: Observation,
  columns: string[],
  frame?: FrameHint,
): Record<string, string>[] {
  const wanted = columns.map(norm);
  const isCell = (el: ObservedElement): boolean => el.role === 'cell' || el.role === 'rowheader';
  const rows = new Map<string, Record<string, string>>();
  const order: string[] = [];

  for (const el of obs.elements) {
    if (!isCell(el) || el.colHeader === undefined) continue;
    const idx = wanted.indexOf(norm(el.colHeader));
    if (idx === -1) continue;
    if (frame !== undefined && !frameMatches([frame], el.framePath)) continue;
    const key = rowKey(el);
    let row = rows.get(key);
    if (row === undefined) {
      row = {};
      rows.set(key, row);
      order.push(key);
    }
    // Report under the caller's spelling of the column, not the page's.
    // First writer wins — see the duplicate-header note above.
    const named = columns[idx]!;
    if (!Object.prototype.hasOwnProperty.call(row, named)) row[named] = el.name;
  }

  return order.map((k) => rows.get(k)!);
}
