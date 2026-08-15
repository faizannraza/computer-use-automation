/**
 * Rendering observations for the model: a compact, indexed element map plus
 * the screenshot. The model acts on refs from THIS rendering — the same
 * numbering the recorder and surface share.
 */
import type { Observation, ObservedElement } from '../core/types.js';

const MAX_ELEMENTS = 150;
const MAX_TEXT = 1500;

function renderElement(el: ObservedElement): string {
  const bits: string[] = [`[${el.ref}] ${el.role} ${JSON.stringify(el.name)}`];
  if (el.label !== undefined && el.label !== el.name) bits.push(`label=${JSON.stringify(el.label)}`);
  if (el.value !== undefined && el.value !== '') bits.push(`value=${JSON.stringify(el.value)}`);
  if (el.options !== undefined) bits.push(`options=[${el.options.map((o) => JSON.stringify(o)).join(', ')}]`);
  if (el.colHeader !== undefined) bits.push(`col=${JSON.stringify(el.colHeader)}`);
  if (el.nearText !== undefined && el.nearText !== el.name) bits.push(`row=${JSON.stringify(el.nearText.slice(0, 80))}`);
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
