/**
 * Evidence logger: one JSONL event stream + screenshots + result documents
 * per run. Redaction is applied HERE, at the write boundary — every byte
 * that reaches disk passes through the redactor, so a leak would require a
 * bug in one file, not a forgotten call site somewhere.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Redactor } from '../policy/redact.js';

export type RunKind = 'discovery' | 'replay';

export function newRunId(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
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
  private shotCount = 0;

  constructor(kind: RunKind, opts: RunLogOptions = {}) {
    this.runId = opts.runId ?? newRunId();
    this.redactor = opts.redactor ?? new Redactor();
    this.onEvent = opts.onEvent;
    this.dir = path.join(opts.baseDir ?? 'evidence', kind, this.runId);
    mkdirSync(path.join(this.dir, 'steps'), { recursive: true });
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
    if (!png) return undefined;
    this.shotCount += 1;
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
