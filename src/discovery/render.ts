/**
 * Rendering observations for the model: a compact, indexed element map plus
 * the screenshot. The model acts on refs from THIS rendering — the same
 * numbering the recorder and surface share.
 */
import type { Observation, ObservedElement } from '../core/types.js';

const MAX_ELEMENTS = 150;
const MAX_TEXT = 1500;
const MAX_ROW_TEXT = 80;

/**
 * Shorten a row's text on a CELL boundary, never inside one.
 *
 * Redaction is exact-string substitution over registered needles, applied at
 * the write boundary. A value cut mid-string no longer matches its needle, so
 * a length limit applied carelessly turns into a data leak: truncating
 * `E-mail: | ada.lovelace@example.com` to 80 characters once shipped
 * `ada.lovelacn@example.c` in cleartext — one character short of matching, and
 * enough to identify the member. So a cell is included whole or not at all.
 *
 * `cellTexts` is the authoritative list of whole cells. Falling back to
 * splitting `nearText` is for observations recorded before that field existed;
 * it is imperfect (a cell containing a `|` shifts the split) but it is still
 * cell-aligned, which is the property that matters here.
 */
function rowTextForModel(el: ObservedElement): string {
  const cells = el.cellTexts ?? el.nearText?.split(' | ') ?? [];
  const kept: string[] = [];
  let used = 0;
  for (const cell of cells) {
    const cost = used === 0 ? cell.length : cell.length + 3;
    if (used + cost > MAX_ROW_TEXT) break;
    kept.push(cell);
    used += cost;
  }
  return kept.join(' | ');
}

function renderElement(el: ObservedElement): string {
  const bits: string[] = [`[${el.ref}] ${el.role} ${JSON.stringify(el.name)}`];
  if (el.label !== undefined && el.label !== el.name) bits.push(`label=${JSON.stringify(el.label)}`);
  if (el.value !== undefined && el.value !== '') bits.push(`value=${JSON.stringify(el.value)}`);
  if (el.options !== undefined) bits.push(`options=[${el.options.map((o) => JSON.stringify(o)).join(', ')}]`);
  if (el.colHeader !== undefined) bits.push(`col=${JSON.stringify(el.colHeader)}`);
  if (el.nearText !== undefined && el.nearText !== el.name) {
    const row = rowTextForModel(el);
    if (row) bits.push(`row=${JSON.stringify(row)}`);
  }
  const frame = el.framePath.map((f) => f.name ?? '?').join('/');
  if (frame) bits.push(`frame=${frame}`);
  return '  ' + bits.join(' ');
}

export function renderObservationText(obs: Observation): string {
  const lines: string[] = [
    `[observation #${obs.seq}]`,
    `location: ${obs.location}`,
    `title: ${obs.title || '(none)'}`,
  ];
  if (obs.dialog) {
    lines.push(`!! OPEN ${obs.dialog.kind.toUpperCase()} DIALOG: ${JSON.stringify(obs.dialog.text)}`);
    lines.push('   (page is blocked until you answer_dialog)');
  }
  const interesting = obs.elements.filter(
    (e) => e.interactive || ['heading', 'rowheader', 'columnheader', 'cell'].includes(e.role),
  );
  lines.push(`elements (${interesting.length}${interesting.length > MAX_ELEMENTS ? `, showing ${MAX_ELEMENTS}` : ''}):`);
  for (const el of interesting.slice(0, MAX_ELEMENTS)) lines.push(renderElement(el));
  const text = obs.visibleText.replace(/\s+/g, ' ').slice(0, MAX_TEXT);
  if (text) lines.push(`visible text: ${text}`);
  return lines.join('\n');
}

/** Text + screenshot content blocks for a tool_result. */
export function renderObservationBlocks(obs: Observation): ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } })[] {
  const blocks: ReturnType<typeof renderObservationBlocks> = [{ type: 'text', text: renderObservationText(obs) }];
  if (obs.screenshot) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: obs.screenshot.toString('base64') },
    });
  }
  return blocks;
}
