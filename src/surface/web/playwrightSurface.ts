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
import { extractTable } from './tableExtract.js';

export interface WebSurfaceOptions {
  headed?: boolean;
  /** Throttle every driver action by this many ms (Playwright slowMo) —
   * presentation aid for headed runs; production replays never set it. */
  slowMoMs?: number;
  viewport?: { width: number; height: number };
}

export class PlaywrightWebSurface implements Surface {
  private constructor(
    private readonly browser: Browser,
    readonly page: Page,
    /**
     * Per-keystroke delay for `setValue`, derived from slowMo. Zero in
     * production, where the value is set in one operation.
     */
    private readonly typeDelayMs = 0,
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
  private pendingInjection: { param: string; kind: string } | undefined;
  private injectionRouted = false;
  /** Element refs to black out for the capture currently being taken. */
  private maskRefs: number[] = [];
  /** Decides those refs from the observation being captured — see setScreenshotMask. */
  private maskClassifier: ((observation: Observation) => number[]) | undefined;

  /**
   * Arm a ONE-SHOT fault injection on the next document request, by appending
   * the target app's documented fault parameter to it.
   *
   * Rewriting the request (rather than only the entrypoint URL) is what makes
   * mid-flow faults reachable: the interesting conditions — a session expiring
   * between review and post, a 500 on the post itself — happen on requests the
   * automation triggers by clicking, which have no URL for a caller to edit.
   * This is a harness affordance; nothing in a recorded artifact can reach it.
   */
  async armFaultInjection(param: string, kind: string): Promise<void> {
    this.pendingInjection = { param, kind };
    if (this.injectionRouted) return;
    this.injectionRouted = true;
    await this.page.route('**/*', async (route) => {
      const armed = this.pendingInjection;
      if (!armed || route.request().resourceType() !== 'document') return route.continue();
      this.pendingInjection = undefined;
      const url = new URL(route.request().url());
      url.searchParams.set(armed.param, armed.kind);
      try {
        const response = await route.fetch({ url: url.toString(), maxRedirects: 0 });
        // A redirect is not the faulted screen — the app bounced us somewhere
        // else before it could render one. Re-arm so the fault lands on the
        // page the operator actually reaches.
        if (response.status() >= 300 && response.status() < 400) this.pendingInjection = armed;
        await route.fulfill({ response });
      } catch {
        await route.continue();
      }
    });
  }

  async resetSession(): Promise<void> {
    await this.page.context().clearCookies();
  }

  /**
   * Install the classifier that decides which elements are masked in evidence
   * screenshots. It runs inside observe(), against the observation whose image
   * is about to be captured and against the refMap generation that image's refs
   * belong to — masking and capture therefore share one generation, and the
   * FIRST capture showing regulated data is already masked.
   */
  setScreenshotMask(classify: (observation: Observation) => number[]): void {
    this.maskClassifier = classify;
  }

  static async launch(opts: WebSurfaceOptions = {}): Promise<PlaywrightWebSurface> {
    const browser = await chromium.launch({
      headless: !opts.headed,
      ...(opts.slowMoMs !== undefined && opts.slowMoMs > 0 ? { slowMo: opts.slowMoMs } : {}),
    });
    const page = await browser.newPage({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
    // Playwright's slowMo throttles each DRIVER OPERATION, and filling a field
    // is one operation — so with slowMo alone a form snaps to its final state
    // instantly and an audience sees nothing happen. When a caller has asked
    // for a paced run, pace the typing too. Derived from slowMo rather than
    // configured separately: one knob, and it stays zero unless someone
    // deliberately slowed the run down.
    const slow = opts.slowMoMs ?? 0;
    const typeDelayMs = slow > 0 ? Math.min(70, Math.max(25, Math.round(slow / 10))) : 0;
    return new PlaywrightWebSurface(browser, page, typeDelayMs);
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
        frameTexts: [],
        dialog: {
          kind: this.heldDialog.type() as 'alert' | 'confirm' | 'prompt' | 'beforeunload',
          text: this.heldDialog.message(),
        },
        at,
      };
      // The element map is stale the moment a dialog is held, so nothing in
      // this capture can be addressed by ref: drop both the map and any mask
      // BEFORE capturing, rather than blacking out nodes by numbers that
      // belonged to the previous generation.
      this.refMap.clear();
      this.maskRefs = [];
      const shot = await this.tryScreenshot();
      if (shot) obs.screenshot = shot;
      this.lastObs = obs;
      return obs;
    }

    const elements: ObservedElement[] = [];
    const texts: string[] = [];
    const frameTexts: { framePath: FramePathEntry[]; text: string }[] = [];
    let title = '';
    this.refMap.clear();
    let ref = 0;
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      let collected;
      try {
        collected = await collectFrame(frame);
      } catch (err) {
        // A frame that detached/navigated mid-walk is a benign race — skip
        // it; the next observe() sees the new state. Anything else (walker
        // bug, transform artifact) must surface loudly, not as a silently
        // empty observation.
        if (frame.isDetached()) continue;
        const msg = err instanceof Error ? err.message : String(err);
        if (/navigat|context was destroyed|detached/i.test(msg)) continue;
        throw new Error(`element walker failed in frame '${frame.name() || frame.url()}': ${msg}`);
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
          // Everything the walker emits must be copied through HERE or it does
          // not exist above the seam — silently, with no error anywhere. The
          // consumers of these two (row identity for table extraction, whole
          // cell strings for classification and truncation) simply see
          // `undefined` and fall back to weaker heuristics.
          ...(raw.colHeader !== undefined ? { colHeader: raw.colHeader } : {}),
          ...(raw.rowId !== undefined ? { rowId: raw.rowId } : {}),
          ...(raw.cellTexts !== undefined ? { cellTexts: raw.cellTexts } : {}),
          ...(raw.options !== undefined ? { options: raw.options } : {}),
          ...(raw.optionValues !== undefined ? { optionValues: raw.optionValues } : {}),
        });
        this.refMap.set(ref, { frame, index });
        ref += 1;
      });
      if (collected.visibleText) {
        const marker = frame === this.page.mainFrame() ? '' : `[frame ${frame.name() || frame.url()}] `;
        texts.push(marker + collected.visibleText);
      }
      // Every successfully-walked frame is recorded, even with empty text: a
      // BLANK observed frame is evidence ("the text is absent"), which is a
      // different fact from an UNOBSERVED frame (no evidence at all) — a
      // scoped textAbsent must distinguish the two.
      frameTexts.push({ framePath, text: collected.visibleText });
    }

    const obs: Observation = {
      seq: this.seq,
      location: this.page.url(),
      title,
      elements,
      visibleText: texts.join('\n'),
      frameTexts,
      at,
    };
    // Classify THIS observation, against the refMap just rebuilt for it, and
    // only then capture: the image and the mask describe the same instant.
    this.maskRefs = this.maskClassifier?.(obs) ?? [];
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
      case 'readTable': {
        // Region read over the latest observation — no DOM round-trip, so it
        // reflects exactly the state the engine classified against.
        const obs = this.lastObs;
        if (!obs) throw new Error('readTable requires a prior observe()');
        const rows = extractTable(obs, action.columns, action.frame);
        return { readValue: JSON.stringify(rows) };
      }
      case 'activate': {
        const handle = await this.elementHandle(action.ref);
        // The classic legacy pattern — onclick="return confirm(...)" — opens
        // a native dialog SYNCHRONOUSLY during the click. We hold dialogs
        // rather than auto-answer, and a held dialog blocks page JS, so the
        // click call itself may never resolve. Race completion against a
        // dialog appearing: if one opened, the click landed and the dialog
        // is simply the next observed state.
        const clickPromise = handle.click({ timeout: 5000 }).then(
          () => ({ ok: true as const }),
          (e: unknown) => ({ ok: false as const, e }),
        );
        for (;;) {
          if (this.heldDialog) return {}; // dialog open — click landed; observe() reports it
          const winner = await Promise.race([
            clickPromise,
            new Promise<'tick'>((r) => setTimeout(() => r('tick'), 50)),
          ]);
          if (winner === 'tick') continue; // click still in flight (bounded by its own 5s timeout)
          if (winner.ok) return {};
          if (this.heldDialog) return {}; // it "failed" only because the dialog blocks the page
          throw winner.e instanceof Error ? winner.e : new Error(String(winner.e));
        }
      }
      case 'setValue': {
        const handle = await this.elementHandle(action.ref);
        if (this.typeDelayMs > 0) {
          // Same end state as fill(), reached visibly. fill() first so the
          // field is cleared and any framework listener sees a reset, then the
          // characters go in one at a time.
          await handle.fill('', { timeout: 5000 });
          // `type` on an ElementHandle rather than Locator.pressSequentially:
          // the gate hands us a ref into the current observation, and turning
          // that back into a Locator would re-query the page and could bind to
          // a different node than the one authorised.
          await handle.type(action.value, { delay: this.typeDelayMs, timeout: 15000 });
          return {};
        }
        await handle.fill(action.value, { timeout: 5000 });
        return {};
      }
      case 'choose': {
        const handle = await this.elementHandle(action.ref);
        await handle.selectOption(
          action.by === 'value' ? { value: action.option } : { label: action.option },
          { timeout: 5000 },
        );
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
      if (this.maskRefs.length > 0) await this.setMaskAttribute(true);
      const png = await this.page.screenshot({ timeout: 3000 });
      if (this.maskRefs.length > 0) await this.setMaskAttribute(false);
      return png;
    } catch {
      return undefined; // e.g. render blocked by a held dialog
    }
  }

  /**
   * Black out classified elements for the duration of a capture. Driven off
   * the walker's stashed nodes, so masking targets exactly the elements the
   * observation classified — no second, selector-based notion of "where the
   * sensitive data is" that could drift from the first.
   */
  private async setMaskAttribute(on: boolean): Promise<void> {
    const byFrame = new Map<Frame, number[]>();
    for (const ref of this.maskRefs) {
      const loc = this.refMap.get(ref);
      if (!loc) continue;
      byFrame.set(loc.frame, [...(byFrame.get(loc.frame) ?? []), loc.index]);
    }
    for (const [frame, indices] of byFrame) {
      await frame
        .evaluate(
          ({ indices: idx, on: enable }) => {
            const store = (window as unknown as { __cuEls?: Element[] }).__cuEls ?? [];
            const STYLE_ID = '__cuMaskStyle';
            if (enable && !document.getElementById(STYLE_ID)) {
              const style = document.createElement('style');
              style.id = STYLE_ID;
              style.textContent = '[data-cu-mask]{background:#1a1a1a !important;color:transparent !important;}';
              (document.head ?? document.documentElement).appendChild(style);
            }
            for (const i of idx) {
              const el = store[i];
              if (!el) continue;
              if (enable) el.setAttribute('data-cu-mask', '1');
              else el.removeAttribute('data-cu-mask');
            }
          },
          { indices, on },
        )
        .catch(() => undefined); // a frame mid-navigation must not fail a capture
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
