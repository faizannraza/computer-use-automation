/**
 * Evidence logger: one JSONL event stream + screenshots + result documents
 * per run. Redaction is applied HERE, at the write boundary — every byte
 * that reaches disk passes through the redactor, so a leak would require a
 * bug in one file, not a forgotten call site somewhere.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Redactor } from '../policy/redact.js';

export type RunKind = 'discovery' | 'replay';

/**
 * A run id: a local-time stamp for sortability, plus randomness for uniqueness.
 *
 * The suffix comes from `randomUUID` rather than `Math.random`, and is 8 hex
 * characters rather than 4 base-36 ones — 4.3e9 instead of 1.7e6 within a given
 * second. That matters more than it looks: this id is the primary key in four
 * separate places (the evidence directory on disk, `RunStore.live`, the
 * intervention map's key prefix, and the role table an auditor reads), and
 * nothing detects a collision. Two runs sharing an id do not error — they
 * interleave into one `run.jsonl`, overwrite each other's `result.json`, and
 * overwrite each other's screenshots, which means one run's audit trail ends up
 * linking to an image of a different member's record.
 */
export function newRunId(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export interface RunLogOptions {
  baseDir?: string;
  runId?: string;
  redactor?: Redactor;
  /**
   * Live sink for the event stream (the API's SSE hub subscribes here).
   *
   * It receives the REDACTED, already-serialized line — the same bytes that
   * reach disk. Handing a sink the pre-redaction object would open a second,
   * unaudited write boundary and stream secrets and PII to every connected
   * client, which is exactly what "redaction at one write boundary" exists to
   * prevent. Sinks must not block: never write to a socket from in here.
   */
  onEvent?: (redactedLine: string) => void;
}

export class RunLog {
  readonly runId: string;
  readonly dir: string;
  private readonly redactor: Redactor;
  private readonly onEvent: ((redactedLine: string) => void) | undefined;
  /**
   * Counts CAPTURES, not files written. A screenshot that was suppressed — by
   * the surface's fail-closed masking, or by a render timeout — still consumes
   * a number, so the element map taken at the same moment gets a number of its
   * own instead of silently reusing (and overwriting) the previous step's.
   * The resulting gap in the PNG sequence is itself evidence: it says a capture
   * happened here and no image could be written for it.
   */
  private shotCount = 0;

  constructor(kind: RunKind, opts: RunLogOptions = {}) {
    this.runId = opts.runId ?? newRunId();
    this.redactor = opts.redactor ?? new Redactor();
    this.onEvent = opts.onEvent;
    this.dir = path.join(opts.baseDir ?? 'evidence', kind, this.runId);
    // `recursive: true` creates parents, but it also SUPPRESSES EEXIST — so
    // two runs sharing an id would both proceed happily and silently corrupt
    // one directory. Create the parents recursively and the run directory
    // itself exclusively, so a collision is a loud error rather than a merge.
    mkdirSync(path.dirname(this.dir), { recursive: true });
    try {
      mkdirSync(this.dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(
        code === 'EEXIST'
          ? `evidence directory '${this.dir}' already exists — two runs share the id '${this.runId}'`
          : `evidence directory '${this.dir}' could not be created: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    mkdirSync(path.join(this.dir, 'steps'));
  }

  /** Append one structured event to the run's JSONL stream. */
  event(type: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
    const redacted = this.redactor.apply(line);
    appendFileSync(path.join(this.dir, 'run.jsonl'), redacted + '\n');
    try {
      this.onEvent?.(redacted);
    } catch {
      // A failing live subscriber must never break the run or lose evidence —
      // the JSONL on disk is the source of truth; the stream is only a view.
    }
  }

  /**
   * Persist a screenshot; returns the evidence-relative filename and announces
   * it on the event stream. Announcing here rather than at the call sites is
   * deliberate: the engine discards this return value at four of six call
   * sites, so a live view would otherwise have nothing to hang off.
   */
  screenshot(name: string, png: Buffer | undefined): string | undefined {
    // Increment before the guard: `elements()` pairs with this number, and a
    // suppressed image must not make the pair collide with the step before it.
    this.shotCount += 1;
    if (!png) return undefined;
    const file = `steps/${String(this.shotCount).padStart(3, '0')}-${sanitize(name)}.png`;
    writeFileSync(path.join(this.dir, file), png);
    this.event('screenshot', { name, file });
    return file;
  }

  /**
   * Persist the element map an observation was made of — this surface's
   * equivalent of a DOM snapshot — alongside the screenshot of the same
   * moment, and announce it on the event stream.
   *
   * A screenshot shows what a person would have seen; this shows what the
   * LOCATOR LADDER saw, which is the only thing that explains why a target
   * resolved, resolved to something else, or was refused as ambiguous. Pairing
   * them is what makes a locator failure debuggable after the fact instead of
   * reproducible-only.
   *
   * It goes through the redactor like everything else, so classified values
   * appear here masked — and because classification runs on each observation
   * before anything is written, the needles exist by the time this is called.
   */
  elements(name: string, elements: unknown[], location: string): string {
    const file = `steps/${String(this.shotCount).padStart(3, '0')}-${sanitize(name)}.elements.json`;
    writeFileSync(
      path.join(this.dir, file),
      this.redactor.apply(JSON.stringify({ location, count: elements.length, elements }, null, 2)) + '\n',
    );
    this.event('elements', { name, file, count: elements.length });
    return file;
  }

  /** Write a standalone (redacted) JSON document, e.g. the run result. */
  writeJson(name: string, value: unknown): string {
    const file = `${sanitize(name)}.json`;
    writeFileSync(path.join(this.dir, file), this.redactor.apply(JSON.stringify(value, null, 2)) + '\n');
    return file;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
}
