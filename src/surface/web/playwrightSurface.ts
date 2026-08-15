/**
 * Web implementation of the Surface interface, on Playwright.
 *
 * Design notes that matter:
 * - Native dialogs are HELD, not auto-answered. A confirm() in a banking app
 *   must surface as an observed state (`observation.dialog`) that policy and
 *   detectors reason about — auto-accepting is exactly the wrong default.
 * - Actions dispatch to the exact DOM node that was observed (stashed by the
 *   walker), via Playwright's real input pipeline (actionability checks,
 *   trusted events) — not synthetic element.click() from injected JS.
 * - Refs are only valid against the latest observation; acting on a stale
 *   ref after navigation fails loudly instead of clicking the wrong thing.
 */
import type { Browser, Dialog, Frame, Page } from 'playwright';
import { chromium } from 'playwright';
import type { ActResultValue, FramePathEntry, Observation, ObservedElement, SemanticAction } from '../../core/types.js';
import type { TargetRef } from '../../schema/locators.js';
import type { Resolution, ResolutionFailure, Surface } from '../surface.js';
import { collectFrame } from './elementMap.js';
import { resolveTarget } from './locatorResolver.js';

export interface WebSurfaceOptions {
  headed?: boolean;
  viewport?: { width: number; height: number };
}

export class PlaywrightWebSurface implements Surface {
  private constructor(
    private readonly browser: Browser,
    readonly page: Page,
  ) {
    page.on('dialog', (dialog) => {
      // Holding the dialog: no accept/dismiss until an explicit answerDialog
      // action (or a human) decides. Page JS is blocked meanwhile — observe()
      // detects this and reports the dialog instead of hanging.
      this.heldDialog = dialog;
    });
  }

  private heldDialog: Dialog | undefined;
  private seq = 0;
  private lastObs: Observation | undefined;
  private refMap = new Map<number, { frame: Frame; index: number }>();

  static async launch(opts: WebSurfaceOptions = {}): Promise<PlaywrightWebSurface> {
    const browser = await chromium.launch({ headless: !opts.headed });
    const page = await browser.newPage({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
    return new PlaywrightWebSurface(browser, page);
  }

  lastObservation(): Observation | undefined {
    return this.lastObs;
  }

  currentLocation(): string {
    return this.page.url();
  }

  async observe(): Promise<Observation> {
    this.seq += 1;
    const at = new Date().toISOString();

    if (this.heldDialog) {
      // Frame JS is blocked by the pending dialog — walking the DOM would
      // hang. Report the dialog itself; the previous element map is stale.
      const obs: Observation = {
        seq: this.seq,
        location: this.page.url(),
        title: '',
        elements: [],
        visibleText: '',
        dialog: {
          kind: this.heldDialog.type() as 'alert' | 'confirm' | 'prompt' | 'beforeunload',
          text: this.heldDialog.message(),
        },
        at,
      };
      const shot = await this.tryScreenshot();
      if (shot) obs.screenshot = shot;
      this.lastObs = obs;
      this.refMap.clear();
      return obs;
    }

    const elements: ObservedElement[] = [];
    const texts: string[] = [];
    let title = '';
    this.refMap.clear();
    let ref = 0;
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      let collected;
      try {
        collected = await collectFrame(frame);
      } catch {
        continue; // frame navigated away mid-walk — the next observe() sees it
      }
      const framePath = framePathOf(frame);
      if (frame === this.page.mainFrame()) title = collected.title;
      collected.els.forEach((raw, index) => {
        elements.push({
          ref,
          role: raw.role,
          name: raw.name,
          framePath,
          interactive: raw.interactive,
          ...(raw.value !== undefined ? { value: raw.value } : {}),
          ...(raw.label !== undefined ? { label: raw.label } : {}),
          ...(raw.bbox !== undefined ? { bboxPct: raw.bbox } : {}),
          ...(raw.nearText !== undefined ? { nearText: raw.nearText } : {}),
          ...(raw.colHeader !== undefined ? { colHeader: raw.colHeader } : {}),
          ...(raw.options !== undefined ? { options: raw.options } : {}),
        });
        this.refMap.set(ref, { frame, index });
        ref += 1;
      });
      if (collected.visibleText) {
        const marker = frame === this.page.mainFrame() ? '' : `[frame ${frame.name() || frame.url()}] `;
        texts.push(marker + collected.visibleText);
      }
    }

    const obs: Observation = {
      seq: this.seq,
      location: this.page.url(),
      title,
      elements,
      visibleText: texts.join('\n'),
      at,
    };
    const shot = await this.tryScreenshot();
    if (shot) obs.screenshot = shot;
    this.lastObs = obs;
    return obs;
  }

  async resolve(target: TargetRef): Promise<Resolution | ResolutionFailure> {
    const obs = this.lastObs;
    if (!obs) throw new Error('resolve() requires a prior observe()');
    return resolveTarget(target, obs, async (css, framePath) => {
      // Structural (CSS) strategy: query each candidate frame, then map the
      // hits back to observed refs via the walker's stashed element array.
      const refs: number[] = [];
      for (const [refId, loc] of this.refMap) {
        const el = obs.elements.find((e) => e.ref === refId);
        if (!el) continue;
        void framePath; // frame filtering happens in resolveTarget itself
        try {
          const hit = await loc.frame.evaluate(
            ({ selector, index }) => {
              const store = (window as unknown as { __cuEls?: Element[] }).__cuEls ?? [];
              const matches = Array.from(document.querySelectorAll(selector));
              return matches.includes(store[index] as Element);
            },
            { selector: css, index: loc.index },
          );
          if (hit) refs.push(refId);
        } catch {
          // frame gone or bad selector — treat as no hit
        }
      }
      return refs;
    });
  }

  async act(action: SemanticAction): Promise<ActResultValue> {
    switch (action.kind) {
      case 'navigate': {
        // 'commit' rather than 'load': a held dialog (which we deliberately
        // do not auto-answer) blocks the load event forever. Wait for load
        // afterwards, but stop waiting the moment a dialog is being held.
        await this.page.goto(action.url, { waitUntil: 'commit' });
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !this.heldDialog) {
          try {
            await this.page.waitForLoadState('load', { timeout: 100 });
            break;
          } catch {
            /* not loaded yet — re-check for a held dialog */
          }
        }
        return {};
      }
      case 'answerDialog': {
        const dialog = this.heldDialog;
        if (!dialog) throw new Error('answerDialog: no dialog is currently held');
        this.heldDialog = undefined;
        if (action.accept) await dialog.accept(action.promptText);
        else await dialog.dismiss();
        return {};
      }
      case 'read': {
        const el = this.observedElement(action.ref);
        return { readValue: el.value ?? el.name };
      }
      case 'activate': {
        const handle = await this.elementHandle(action.ref);
        await handle.click({ timeout: 5000 });
        return {};
      }
      case 'setValue': {
        const handle = await this.elementHandle(action.ref);
        await handle.fill(action.value, { timeout: 5000 });
        return {};
      }
      case 'choose': {
        const handle = await this.elementHandle(action.ref);
        await handle.selectOption({ label: action.option }, { timeout: 5000 });
        return {};
      }
    }
  }

  async settle(timeoutMs = 5000): Promise<void> {
    if (this.heldDialog) return; // page JS is blocked; there is nothing to settle
    try {
      await this.page.waitForLoadState('load', { timeout: timeoutMs });
    } catch {
      /* still loading — condition-based waits above decide what to do */
    }
    for (const frame of this.page.frames()) {
      try {
        await frame.waitForLoadState('load', { timeout: timeoutMs });
      } catch {
        /* detached or slow frame */
      }
    }
    await this.page.waitForTimeout(150);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private observedElement(ref: number): ObservedElement {
    const el = this.lastObs?.elements.find((e) => e.ref === ref);
    if (!el) throw new Error(`ref ${ref} is not part of the current observation`);
    return el;
  }

  private async elementHandle(ref: number) {
    this.observedElement(ref); // validates ref belongs to the current observation
    const loc = this.refMap.get(ref);
    if (!loc) throw new Error(`ref ${ref} has no live element (stale observation?)`);
    const handle = await loc.frame.evaluateHandle(
      (index) => (window as unknown as { __cuEls?: Element[] }).__cuEls?.[index],
      loc.index,
    );
    const element = handle.asElement();
    if (!element) throw new Error(`ref ${ref} is stale — the page changed since it was observed`);
    return element;
  }

  private async tryScreenshot(): Promise<Buffer | undefined> {
    try {
      return await this.page.screenshot({ timeout: 2000 });
    } catch {
      return undefined; // e.g. render blocked by a held dialog
    }
  }
}

function framePathOf(frame: Frame): FramePathEntry[] {
  const path: FramePathEntry[] = [];
  let current: Frame | null = frame;
  while (current && current.parentFrame()) {
    const name = current.name();
    path.unshift({ url: current.url(), ...(name ? { name } : {}) });
    current = current.parentFrame();
  }
  return path;
}
