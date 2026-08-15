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

export async function collectFrame(frame: Frame): Promise<FrameCollectResult> {
  return frame.evaluate(() => {
    const store: Element[] = [];
    const out: Record<string, unknown>[] = [];
    const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
    const txt = (el: Element): string => norm(el.textContent);
    const vis = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none';
    };
    const bbox = (el: Element): Record<string, number> => {
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
    const isBoldCell = (el: Element): boolean =>
      el.tagName === 'TH' || parseInt(getComputedStyle(el).fontWeight, 10) >= 600;
    const labelOf = (el: Element): string | undefined => {
      const id = el.getAttribute('id');
      if (id) {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab) return txt(lab);
      }
      const wrap = el.closest('label');
      if (wrap) return txt(wrap);
      // Legacy fallback: the preceding table cell usually carries the label.
      const cell = el.closest('td,th');
      const prev = cell?.previousElementSibling;
      if (prev && txt(prev)) return txt(prev);
      return undefined;
    };
    const rowTextOf = (el: Element): string | undefined => {
      const tr = el.closest('tr');
      if (!tr) return undefined;
      const joined = norm(
        Array.from((tr as HTMLTableRowElement).cells)
          .map((c) => c.textContent)
          .join(' | '),
      ).slice(0, 160);
      return joined || undefined;
    };
    const push = (el: Element, role: string, name: string, extra: Record<string, unknown>): void => {
      if (!vis(el)) return;
      store.push(el);
      const rec: Record<string, unknown> = { role, name: name || '', bbox: bbox(el), ...extra };
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
        const sel = el as HTMLSelectElement;
        const options = Array.from(sel.options).map((o) => norm(o.textContent)).filter((t) => t !== '');
        const value = sel.selectedIndex >= 0 ? norm(sel.options[sel.selectedIndex]?.textContent) : '';
        push(el, 'combobox', labelOf(el) ?? sel.name, { interactive: true, label: labelOf(el), value, options });
        continue;
      }
      if (tag === 'TEXTAREA') {
        const ta = el as HTMLTextAreaElement;
        push(el, 'textbox', labelOf(el) ?? ta.name, { interactive: true, label: labelOf(el), value: norm(ta.value) });
        continue;
      }
      const input = el as HTMLInputElement;
      const type = (input.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'hidden') continue;
      if (type === 'submit' || type === 'button' || type === 'reset') {
        push(el, 'button', input.value || 'Submit', { interactive: true, nearText: rowTextOf(el) });
        continue;
      }
      if (type === 'checkbox' || type === 'radio') {
        push(el, type, labelOf(el) ?? input.name, {
          interactive: true,
          label: labelOf(el),
          value: input.checked ? 'checked' : 'unchecked',
        });
        continue;
      }
      // Text-like inputs. Password values are sensitive by definition: never observed.
      push(el, 'textbox', labelOf(el) ?? input.name, {
        interactive: true,
        label: labelOf(el),
        ...(type === 'password' ? {} : { value: norm(input.value) }),
      });
    }

    // Headings.
    for (const el of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
      push(el, 'heading', txt(el), { interactive: false });
    }

    // Tables: header detection + cell anchoring. Heuristics on purpose —
    // legacy screens have no semantics to rely on, so we mine convention:
    // a row of ≥2 uniformly-bold cells near the top is a header row.
    for (const table of Array.from(document.querySelectorAll('table'))) {
      const rows = Array.from((table as HTMLTableElement).rows);
      let headerIdx = -1;
      let headers: (string | undefined)[] = [];
      for (let i = 0; i < Math.min(rows.length, 3); i++) {
        const cells = Array.from(rows[i]!.cells);
        if (cells.length >= 2 && cells.every(isBoldCell)) headerIdx = i;
      }
      if (headerIdx >= 0) {
        headers = [];
        let col = 0;
        for (const c of Array.from(rows[headerIdx]!.cells)) {
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

    (window as unknown as { __cuEls: Element[] }).__cuEls = store;
    return {
      els: out as unknown as RawElement[],
      visibleText: norm(document.body ? document.body.innerText : '').slice(0, 8000),
      title: document.title,
    };
  });
}
