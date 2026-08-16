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
  options?: string[];
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
  const rowTextOf = (el) => {
    const tr = el.closest('tr');
    if (!tr) return undefined;
    const joined = norm(Array.from(tr.cells).map((c) => c.textContent).join(' | ')).slice(0, 160);
    return joined || undefined;
  };
  const push = (el, role, name, extra) => {
    if (!vis(el)) return;
    store.push(el);
    const rec = Object.assign({ role, name: name || '', bbox: bbox(el) }, extra);
    out.push(rec);
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
      const options = Array.from(el.options).map((o) => norm(o.textContent)).filter((t) => t !== '');
      const value = el.selectedIndex >= 0 ? norm(el.options[el.selectedIndex].textContent) : '';
      push(el, 'combobox', labelOf(el) || el.name || '', { interactive: true, label: labelOf(el), value, options });
      continue;
    }
    if (tag === 'TEXTAREA') {
      push(el, 'textbox', labelOf(el) || el.name || '', { interactive: true, label: labelOf(el), value: norm(el.value) });
      continue;
    }
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'hidden') continue;
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
  for (const table of Array.from(document.querySelectorAll('table'))) {
    const rows = Array.from(table.rows);
    let headerIdx = -1;
    let headers = [];
    for (let i = 0; i < Math.min(rows.length, 3); i++) {
      const cells = Array.from(rows[i].cells);
      if (cells.length >= 2 && cells.every(isBoldCell)) headerIdx = i;
    }
    if (headerIdx >= 0) {
      headers = [];
      let col = 0;
      for (const c of Array.from(rows[headerIdx].cells)) {
        const span = c.colSpan || 1;
        for (let k = 0; k < span; k++) headers[col + k] = txt(c);
        col += span;
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
      const rowText = norm(cells.map((c) => c.textContent).join(' | ')).slice(0, 160);
      let col = 0;
      for (const c of cells) {
        const span = c.colSpan || 1;
        const t = txt(c);
        // Cells wrapping interactive controls are represented by the control.
        if (t && !c.querySelector('a,button,input,select,textarea') && !c.querySelector('table')) {
          push(c, isBoldCell(c) ? 'rowheader' : 'cell', t, {
            interactive: false,
            nearText: rowText,
            colHeader: headers[col],
          });
        }
        col += span;
      }
    });
  }

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
