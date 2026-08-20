/**
 * The table extractor is pure and driver-free, so its guarantees are testable
 * without a browser: rows in screen order under the CALLER's column spelling,
 * nothing pulled in from unrequested columns or other frames, and a column a
 * row simply doesn't have left absent rather than filled with a neighbor's
 * value — a wrong balance next to the right member is the failure mode that
 * matters here.
 */
import { describe, expect, it } from 'vitest';
import type { Observation, ObservedElement } from '../src/core/types.js';
import { extractTable } from '../src/surface/web/tableExtract.js';

const WORK = [{ name: 'work', url: 'http://x/members/detail' }];

function cell(
  ref: number,
  name: string,
  colHeader: string,
  nearText: string,
  framePath: ObservedElement['framePath'] = WORK,
): ObservedElement {
  return { ref, role: 'cell', name, colHeader, nearText, framePath, interactive: false };
}

/** A cell as the CURRENT walker emits it: carrying its row's identity. */
function idCell(
  ref: number,
  name: string,
  colHeader: string,
  rowId: string,
  nearText: string,
  framePath: ObservedElement['framePath'] = WORK,
): ObservedElement {
  return { ...cell(ref, name, colHeader, nearText, framePath), rowId };
}

function obs(elements: ObservedElement[]): Observation {
  return {
    seq: 1,
    location: 'http://x/members/detail',
    title: 'Member Information',
    elements,
    visibleText: '',
    at: new Date().toISOString(),
  };
}

const S00 = 'S00 | REGULAR SAVINGS | $4,821.97 | OPEN';
const S01 = 'S01 | CHECKING | $312.40 | OPEN';

describe('extractTable', () => {
  it('returns rows in screen order, keyed by the caller\'s spelling of each column', () => {
    const rows = extractTable(
      obs([
        cell(0, 'S00', 'Share', S00),
        cell(1, '$4,821.97', 'Balance', S00),
        cell(2, 'S01', 'Share', S01),
        cell(3, '$312.40', 'Balance', S01),
      ]),
      // Deliberately not the page's casing: the caller declared these column
      // names in the artifact, so the output must come back under them.
      ['share', 'balance'],
    );
    expect(rows).toEqual([
      { share: 'S00', balance: '$4,821.97' },
      { share: 'S01', balance: '$312.40' },
    ]);
  });

  it('ignores cells under columns that were not requested', () => {
    const rows = extractTable(
      obs([
        cell(0, 'S00', 'Share', S00),
        cell(1, 'REGULAR SAVINGS', 'Type', S00),
        cell(2, 'OPEN', 'Status', S00),
      ]),
      ['Share', 'Status'],
    );
    expect(rows).toEqual([{ Share: 'S00', Status: 'OPEN' }]);
  });

  it('honors a frame hint: same-looking table in another frame is not merged in', () => {
    const otherFrame = [{ name: 'menu', url: 'http://x/nav' }];
    const o = obs([
      cell(0, 'S00', 'Share', S00),
      cell(1, 'S99', 'Share', 'S99 | STALE PANE', otherFrame),
    ]);
    expect(extractTable(o, ['Share'], { name: 'work' })).toEqual([{ Share: 'S00' }]);
    expect(extractTable(o, ['Share'], { name: 'menu' })).toEqual([{ Share: 'S99' }]);
    // No hint at all means every frame — the caller opted out of scoping.
    expect(extractTable(o, ['Share'])).toHaveLength(2);
  });

  it('keeps rows with different row text separate even when their cells are identical', () => {
    const rows = extractTable(
      obs([
        cell(0, '$0.00', 'Balance', 'S02 | HOLIDAY CLUB | $0.00'),
        cell(1, '$0.00', 'Balance', 'S03 | VACATION CLUB | $0.00'),
      ]),
      ['Balance'],
    );
    expect(rows).toEqual([{ Balance: '$0.00' }, { Balance: '$0.00' }]);
  });

  it('keeps two BYTE-IDENTICAL rows separate — a duplicate posting is two postings', () => {
    // The failure this guards: a ledger showing the same amount posted twice
    // on the same day with the same description. Keyed on row TEXT the second
    // row overwrites the first and readTable reports one transaction where the
    // screen shows two — a reconciliation that silently balances.
    const dupe = '2026-08-14 | ACH DEBIT — CITY UTILITIES | $118.42';
    const rows = extractTable(
      obs([
        idCell(0, '2026-08-14', 'Date', 't0r1', dupe),
        idCell(1, '$118.42', 'Amount', 't0r1', dupe),
        idCell(2, '2026-08-14', 'Date', 't0r2', dupe),
        idCell(3, '$118.42', 'Amount', 't0r2', dupe),
      ]),
      ['Date', 'Amount'],
    );
    expect(rows).toEqual([
      { Date: '2026-08-14', Amount: '$118.42' },
      { Date: '2026-08-14', Amount: '$118.42' },
    ]);
  });

  it('keeps rows that share a >160-character prefix separate, with their own balances', () => {
    // nearText is truncated at 160 chars by the walker, so on a wide table the
    // discriminating column falls off the end. Two members with long names and
    // long addresses then produce the SAME key, and the surviving Balance is
    // whichever cell the walker reached last — the right member's row carrying
    // the wrong member's money.
    const prefix = 'A'.repeat(150);
    const truncated = `${prefix} | SAME`.slice(0, 160);
    const rows = extractTable(
      obs([
        idCell(0, 'ANNA', 'Member', 't0r1', truncated),
        idCell(1, '$1.00', 'Balance', 't0r1', truncated),
        idCell(2, 'ANNE', 'Member', 't0r2', truncated),
        idCell(3, '$999.00', 'Balance', 't0r2', truncated),
      ]),
      ['Member', 'Balance'],
    );
    expect(rows).toEqual([
      { Member: 'ANNA', Balance: '$1.00' },
      { Member: 'ANNE', Balance: '$999.00' },
    ]);
  });

  it('does not merge rows across frames that happen to share a rowId', () => {
    // rowIds restart at t0r0 in every document, so an unscoped read over a
    // frameset would otherwise fuse the menu frame's table into the work
    // frame's, row for row.
    const menu = [{ name: 'menu', url: 'http://x/nav' }];
    const rows = extractTable(
      obs([
        idCell(0, '$4,821.97', 'Balance', 't0r1', 'S00 | $4,821.97'),
        idCell(1, '$0.00', 'Balance', 't0r1', 'S00 | $4,821.97', menu),
      ]),
      ['Balance'],
    );
    expect(rows).toEqual([{ Balance: '$4,821.97' }, { Balance: '$0.00' }]);
  });

  it('falls back to row text when an observation predates rowId — and says so', () => {
    // DOCUMENTED LIMITATION, not a guarantee: an old trace has no row identity,
    // so identical row text still collapses. The fallback exists so such traces
    // extract something at all; anything recorded by the current walker takes
    // the rowId path above and is not subject to this.
    const same = 'S02 | HOLIDAY CLUB | $0.00';
    const rows = extractTable(
      obs([cell(0, '$0.00', 'Balance', same), cell(1, '$0.00', 'Balance', same)]),
      ['Balance'],
    );
    expect(rows).toHaveLength(1);
  });

  it('omits a requested column that exists nowhere, rather than reporting it blank', () => {
    const rows = extractTable(obs([idCell(0, 'S00', 'Share', 't0r1', S00)]), ['Share', 'Hold Amount']);
    expect(rows).toEqual([{ Share: 'S00' }]);
    expect('Hold Amount' in rows[0]!).toBe(false);
  });

  it('resolves a header that appears twice to the LEFTMOST matching cell', () => {
    // Legacy screens repeat headers ("Amount" over a debit and a credit
    // column). Neither column is more correct, so the tie is broken by screen
    // order — stable across runs, unlike "whichever was walked last".
    const rows = extractTable(
      obs([
        idCell(0, 'TRF-0042', 'Ref', 't0r1', 'TRF-0042 | $25.00 | $0.00'),
        idCell(1, '$25.00', 'Amount', 't0r1', 'TRF-0042 | $25.00 | $0.00'),
        idCell(2, '$0.00', 'Amount', 't0r1', 'TRF-0042 | $25.00 | $0.00'),
      ]),
      ['Ref', 'Amount'],
    );
    expect(rows).toEqual([{ Ref: 'TRF-0042', Amount: '$25.00' }]);
  });

  it('leaves a column absent from a row absent, rather than borrowing another row\'s value', () => {
    const rows = extractTable(
      obs([
        cell(0, 'S00', 'Share', S00),
        cell(1, 'OPEN', 'Status', S00),
        cell(2, 'S01', 'Share', S01),
      ]),
      ['Share', 'Status'],
    );
    expect(rows).toEqual([{ Share: 'S00', Status: 'OPEN' }, { Share: 'S01' }]);
    expect('Status' in rows[1]!).toBe(false);
  });
});
