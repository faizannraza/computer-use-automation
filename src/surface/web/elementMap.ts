/**
 * Frame-level element mapping: an in-page walker that computes implicit
 * accessibility semantics (WAI-ARIA role mapping + accessible names) from
 * the live DOM, enriched with geometry and row/column anchor text.
 *
 * Why not read the browser's accessibility tree over CDP? For legacy markup
 * — table layouts, no ARIA attributes — the AX tree *is* this implicit
 * mapping, minus the anchors and geometry we need for disambiguation and
 * drift evidence. Computing it in one in-page pass yields the same semantics
 * without fragile AX-node → DOM-node → box-model joins across framesets.
 * A desktop surface would produce the same shape from UIA/AX APIs instead.
 *
 * The walker is shipped as a plain JS source string, not a serialized
 * closure: build tooling (tsx, vitest, bundlers) transforms closures and can
 * inject helper references (e.g. esbuild's `__name`) that do not exist in
 * the page and blow up evaluate() at runtime. A string is immune to every
 * transform — what you read here is exactly what runs in the frame.
 *
 * The walker stashes matched DOM nodes on `window.__cuEls` so actions can be
 * dispatched later to exactly the element that was observed (by index),
 * through the driver's real input pipeline.
 */
import type { Frame } from 'playwright';

export interface RawElement {
  role: string;
  name: string;
  value?: string;
  label?: string;
  interactive: boolean;
  bbox?: { x: number; y: number; w: number; h: number };
  nearText?: string;
  colHeader?: string;
  /** Stable-within-an-observation identity of the row this cell sits in. */
  rowId?: string;
  /** The row's cells as discrete strings (see ObservedElement.cellTexts). */
  cellTexts?: string[];
  options?: string[];
  optionValues?: string[];
}

export interface FrameCollectResult {
  els: RawElement[];
  visibleText: string;
  title: string;
}

const WALKER_SOURCE = String.raw`(() => {
  const store = [];
  const out = [];
  const norm = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  const txt = (el) => norm(el.textContent);
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const bbox = (el) => {
    const r = el.getBoundingClientRect();
    const W = Math.max(1, window.innerWidth);
    const H = Math.max(1, window.innerHeight);
    return {
      x: Number(((100 * r.x) / W).toFixed(1)),
      y: Number(((100 * r.y) / H).toFixed(1)),
      w: Number(((100 * r.width) / W).toFixed(1)),
      h: Number(((100 * r.height) / H).toFixed(1)),
    };
  };
  const isBoldCell = (el) =>
    el.tagName === 'TH' || parseInt(getComputedStyle(el).fontWeight, 10) >= 600;
  const labelOf = (el) => {
    const id = el.getAttribute('id');
    if (id) {
      const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lab) return txt(lab);
    }
    const wrap = el.closest('label');
    if (wrap) return txt(wrap);
    // Legacy fallback: the preceding table cell usually carries the label.
    const cell = el.closest('td,th');
    const prev = cell ? cell.previousElementSibling : null;
    if (prev && txt(prev)) return txt(prev);
    return undefined;
  };
  // Payload budgets for row anchor text. Both are CELL-BOUNDARY budgets: see
  // takeCells.
  const ROW_TEXT_BUDGET = 160;
  const CELL_LIST_BUDGET = 600;
  const MAX_CELLS = 40;
  /**
   * Take whole cells until the next one would blow the budget, then stop.
   *
   * WHY NEVER MID-CELL: redaction is exact-string substitution over registered
   * needles, applied at the write boundary. A value cut in half no longer
   * matches its needle, so it is written out in cleartext — a length limit
   * silently becomes a disclosure of the regulated value's prefix (and of the
   * row that identifies whose it is). Whole-or-absent is the only rule that
   * keeps a value matchable. A single cell bigger than the budget is therefore
   * DROPPED, not shortened, even though that costs the row its anchor text.
   */
  const takeCells = (texts, budget) => {
    const kept = [];
    let used = 0;
    for (const t of texts) {
      const cost = kept.length === 0 ? t.length : t.length + 3; // ' | '
      if (used + cost > budget) break;
      kept.push(t);
      used += cost;
    }
    return kept;
  };
  const cellTextsOf = (tr) =>
    takeCells(Array.from(tr.cells).slice(0, MAX_CELLS).map(txt), CELL_LIST_BUDGET);
  const rowTextOf = (el) => {
    const tr = el.closest('tr');
    if (!tr) return undefined;
    const joined = takeCells(cellTextsOf(tr), ROW_TEXT_BUDGET).join(' | ');
    return joined || undefined;
  };
  // INVARIANT: store[] and out[] are index-coupled — an observation ref is an
  // index into both, and act() dispatches to store[ref]. Every emit must
  // append to BOTH, or every later ref on the page acts on the wrong node.
  // All pushes go through emit() so that coupling cannot be broken by accident.
  const emit = (el, role, name, extra) => {
    store.push(el);
    out.push(Object.assign({ role, name: name || '' }, extra));
  };
  const push = (el, role, name, extra) => {
    if (!vis(el)) return;
    emit(el, role, name, Object.assign({ bbox: bbox(el) }, extra));
  };

  // Interactive controls (implicit ARIA role mapping).
  for (const el of Array.from(document.querySelectorAll('a[href], button, input, select, textarea'))) {
    const tag = el.tagName;
    if (tag === 'A') {
      push(el, 'link', txt(el), { interactive: true, nearText: rowTextOf(el) });
      continue;
    }
    if (tag === 'BUTTON') {
      push(el, 'button', txt(el), { interactive: true });
      continue;
    }
    if (tag === 'SELECT') {
      // NOT filtered: options[] and optionValues[] are index-aligned, so a
      // recorded label can be mapped to its underlying value.
      const options = Array.from(el.options).map((o) => norm(o.textContent));
      // Option VALUES are captured too: legacy selects routinely put volatile
      // data in the visible label ("100234-S0001 - Regular Shares ($2,500.00)")
      // while the value attribute carries the stable identifier. Selecting by
      // label would re-break every time a balance changed.
      const optionValues = Array.from(el.options).map((o) => o.value);
      const value = el.selectedIndex >= 0 ? norm(el.options[el.selectedIndex].textContent) : '';
      push(el, 'combobox', labelOf(el) || el.name || '', { interactive: true, label: labelOf(el), value, options, optionValues });
      continue;
    }
    if (tag === 'TEXTAREA') {
      push(el, 'textbox', labelOf(el) || el.name || '', { interactive: true, label: labelOf(el), value: norm(el.value) });
      continue;
    }
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'hidden') {
      // Hidden fields are observed for ASSERTION only — legacy cores carry
      // per-transaction tokens in them, and a flow needs to verify one is
      // present before submitting. Deliberately emitted with:
      //   - no value (a security token must never enter an observation,
      //     a trace, or evidence — presence and length are enough),
      //   - no label (labelText scores 0.95; a hidden field inheriting a
      //     neighbouring cell's label would collide with the real control),
      //   - no bbox (0x0 at 0,0 would feed the geometry tie-breaker noise).
      // Bypasses vis() because a hidden input is 0x0 by definition.
      var hname = el.getAttribute('name') || '';
      emit(el, 'hidden', hname, { interactive: false, value: '(present:' + String(el.value || '').length + ')' });
      continue;
    }
    if (type === 'submit' || type === 'button' || type === 'reset') {
      push(el, 'button', el.value || 'Submit', { interactive: true, nearText: rowTextOf(el) });
      continue;
    }
    if (type === 'checkbox' || type === 'radio') {
      push(el, type, labelOf(el) || el.name || '', {
        interactive: true,
        label: labelOf(el),
        value: el.checked ? 'checked' : 'unchecked',
      });
      continue;
    }
    // Text-like inputs. Password values are sensitive by definition: never observed.
    const extra = { interactive: true, label: labelOf(el) };
    if (type !== 'password') extra.value = norm(el.value);
    push(el, 'textbox', labelOf(el) || el.name || '', extra);
  }

  // Headings.
  for (const el of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
    push(el, 'heading', txt(el), { interactive: false });
  }

  // Tables: header detection + cell anchoring. Heuristics on purpose —
  // legacy screens have no semantics to rely on, so we mine convention:
  // a row of >=2 uniformly-bold cells near the top is a header row.
  Array.from(document.querySelectorAll('table')).forEach((table, ti) => {
    const rows = Array.from(table.rows);
    // OCCUPANCY GRID. tr.cells is the row's *markup* cells, which is not the
    // row's visual columns: a cell in an earlier row carrying rowSpan >= 2
    // still occupies a column here while contributing no entry to tr.cells.
    // Counting markup cells therefore shifts every later cell in the row one
    // column to the left — and a column header is how this system decides
    // that a string is a Balance rather than a Status. So resolve each cell's
    // real column index up front, carrying rowSpan claims down the table.
    //   grid[r][c]    -> the cell occupying visual column c of row r
    //                    (possibly inherited from an earlier row's rowSpan)
    //   startCol[r][i]-> visual column where rows[r].cells[i] begins
    // Does NOT model: rowSpan="0" (spans to end of section — near-extinct and
    // treated as 1 by every engine we target), nor <col>/<colgroup> hints,
    // which carry no bearing on which cell lands where.
    const grid = [];
    const startCol = [];
    const carry = []; // carry[c] = { cell, left: rows still claimed by a rowSpan }
    for (let r = 0; r < rows.length; r++) {
      const line = [];
      const starts = [];
      let c0 = 0;
      for (const cell of Array.from(rows[r].cells)) {
        while (carry[c0] && carry[c0].left > 0) {
          line[c0] = carry[c0].cell;
          c0 += 1;
        }
        const cspan = cell.colSpan || 1;
        const rspan = cell.rowSpan || 1;
        for (let k = 0; k < cspan; k++) {
          line[c0 + k] = cell;
          // rspan (not rspan-1) because the row-end decrement below runs for
          // this row too; a plain cell lands back at 0 and claims nothing.
          carry[c0 + k] = { cell: cell, left: rspan };
        }
        starts.push(c0);
        c0 += cspan;
      }
      // Columns still claimed to the RIGHT of this row's last markup cell.
      for (let c1 = c0; c1 < carry.length; c1++) {
        if (carry[c1] && carry[c1].left > 0) line[c1] = carry[c1].cell;
      }
      for (let c1 = 0; c1 < carry.length; c1++) {
        if (carry[c1] && carry[c1].left > 0) carry[c1].left -= 1;
      }
      grid.push(line);
      startCol.push(starts);
    }

    let headerIdx = -1;
    let headers = [];
    for (let i = 0; i < Math.min(rows.length, 3); i++) {
      const cells = Array.from(rows[i].cells);
      if (cells.length >= 2 && cells.every(isBoldCell)) headerIdx = i;
    }
    if (headerIdx >= 0) {
      // Read the header row off the grid, not off its own cells: a two-tier
      // header ("Share ID" as rowspan=2 beside a colspan=2 "Amounts" group)
      // leaves the tier-1 cell occupying a column of the tier-2 row, and it
      // is that inherited cell that names the column. colSpan fan-out is the
      // grid's doing, so it keeps working unchanged.
      const line = grid[headerIdx];
      for (let c = 0; c < line.length; c++) {
        if (line[c]) headers[c] = txt(line[c]);
      }
    }
    rows.forEach((tr, ri) => {
      const cells = Array.from(tr.cells);
      if (ri === headerIdx) {
        for (const c of cells) {
          if (txt(c)) push(c, 'columnheader', txt(c), { interactive: false });
        }
        return;
      }
      // Cells as DISCRETE strings, each one WHOLE. rowText below is lossy
      // twice over — it is budget-truncated, and any cell whose own text
      // contains '|' is indistinguishable from a cell boundary once joined, so
      // splitting it recovers the wrong cells. Consumers that need the cells
      // read these instead. Bounded by dropping trailing cells (never by
      // cutting one), because this rides along on every cell of every row.
      const cellTexts = cellTextsOf(tr);
      // Derived from the same whole cells, so nearText is always a cell-aligned
      // prefix of cellTexts — a value is wholly in it or wholly out of it.
      const rowText = takeCells(cellTexts, ROW_TEXT_BUDGET).join(' | ');
      // Row IDENTITY, not row text: two rows of a ledger can be character-for-
      // character identical (a duplicate posting) and must still read back as
      // two rows. Table ordinal + row ordinal is stable for one observation,
      // which is the only lifetime a ref is valid for anyway.
      const rowId = 't' + ti + 'r' + ri;
      const starts = startCol[ri];
      cells.forEach((c, ci) => {
        const t = txt(c);
        // Cells wrapping interactive controls are represented by the control.
        if (t && !c.querySelector('a,button,input,select,textarea') && !c.querySelector('table')) {
          // Label association for VALUE cells: on a label:value screen the
          // preceding bold cell names this one ("Confirmation:" | "TRF-0042").
          // Without it the only way to address a value is by its own text —
          // i.e. by the data you are trying to read, which changes every run.
          const prevCell = c.previousElementSibling;
          const cellLabel = !isBoldCell(c) && prevCell && isBoldCell(prevCell) ? txt(prevCell) : undefined;
          push(c, isBoldCell(c) ? 'rowheader' : 'cell', t, {
            interactive: false,
            // Empty means "no anchor text for this row" (every cell was over
            // budget), not "the row is blank" — an empty anchor would match
            // every row, so report none, same as rowTextOf does.
            nearText: rowText || undefined,
            cellTexts: cellTexts,
            rowId: rowId,
            colHeader: headers[starts[ci]],
            label: cellLabel,
          });
        }
      });
    });
  });

  window.__cuEls = store;
  return {
    els: out,
    visibleText: norm(document.body ? document.body.innerText : '').slice(0, 8000),
    title: document.title,
  };
})()`;

export async function collectFrame(frame: Frame): Promise<FrameCollectResult> {
  return (await frame.evaluate(WALKER_SOURCE)) as FrameCollectResult;
}
