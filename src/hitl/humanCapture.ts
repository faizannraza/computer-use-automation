/**
 * Human-action capture: while a human holds the live session, document-level
 * listeners in every frame report what they do — click/change/submit with a
 * structural description of the target. values are never captured, only
 * their length: the human may type things (supervisor PINs, ad-hoc lookups)
 * that no policy ever cleared for logging.
 *
 * Capture is event-level, not keystroke-perfect — we want a record of what
 * the human touched, not a replayable macro. Very fast navigations can drop
 * an event; that limit is documented rather than fought.
 */
import type { Frame, Page } from 'playwright';

export interface HumanActionEvent {
  kind: 'click' | 'change' | 'submit';
  target: string;
  valueLength?: number;
}

const CAPTURE_SOURCE = String.raw`(() => {
  if (window.__cuCapOn) return; window.__cuCapOn = true;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const describe = (el) => {
    if (!el || !el.tagName) return 'unknown';
    const tag = el.tagName.toLowerCase();
    let label = '';
    try {
      const id = el.getAttribute && el.getAttribute('id');
      if (id) { const l = document.querySelector('label[for="' + CSS.escape(id) + '"]'); if (l) label = norm(l.textContent); }
      if (!label && el.closest) { const c = el.closest('td,th'); const p = c && c.previousElementSibling; if (p) label = norm(p.textContent); }
    } catch (_) { /* describing must never break the page */ }
    const type = el.getAttribute ? (el.getAttribute('type') || '') : '';
    const caption = tag === 'input'
      ? (type === 'submit' || type === 'button' ? (el.value || '') : '')
      : norm(el.textContent).slice(0, 40);
    return tag + (type ? '[' + type + ']' : '') + (label ? ' label="' + label + '"' : '') + (caption ? ' "' + caption + '"' : '');
  };
  const send = (data) => { try { window.__cuHumanEvent(data); } catch (_) { /* binding gone */ } };
  document.addEventListener('click', (e) => send({ kind: 'click', target: describe(e.target) }), true);
  document.addEventListener('change', (e) => {
    const t = e.target;
    send({ kind: 'change', target: describe(t), valueLength: t && t.value !== undefined ? String(t.value).length : 0 });
  }, true);
  document.addEventListener('submit', (e) => send({ kind: 'submit', target: describe(e.target) }), true);
})()`;

export class HumanCapture {
  private active = false;
  private bindingExposed = false;
  private navListener: ((frame: Frame) => void) | undefined;

  constructor(
    private readonly page: Page,
    private readonly onEvent: (e: HumanActionEvent) => void,
  ) {}

  async start(): Promise<void> {
    if (!this.bindingExposed) {
      // exposeBinding registers once for the page's lifetime, all frames,
      // surviving navigations; the `active` flag scopes capture to handoffs
      // (agent-driven events between handoffs are filtered out here).
      await this.page.exposeBinding('__cuHumanEvent', (_source, data: HumanActionEvent) => {
        if (this.active) this.onEvent(data);
      });
      this.bindingExposed = true;
    }
    this.active = true;
    await this.injectAll();
    this.navListener = (frame) => {
      void frame.evaluate(CAPTURE_SOURCE).catch(() => undefined);
    };
    this.page.on('framenavigated', this.navListener);
  }

  stop(): void {
    this.active = false;
    if (this.navListener) {
      this.page.off('framenavigated', this.navListener);
      this.navListener = undefined;
    }
  }

  private async injectAll(): Promise<void> {
    for (const frame of this.page.frames()) {
      try {
        await frame.evaluate(CAPTURE_SOURCE);
      } catch {
        /* frame mid-navigation — the framenavigated hook catches it next */
      }
    }
  }
}
