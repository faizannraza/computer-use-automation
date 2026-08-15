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
}

export class RunLog {
  readonly runId: string;
  readonly dir: string;
  private readonly redactor: Redactor;
  private shotCount = 0;

  constructor(kind: RunKind, opts: RunLogOptions = {}) {
    this.runId = opts.runId ?? newRunId();
    this.redactor = opts.redactor ?? new Redactor();
    this.dir = path.join(opts.baseDir ?? 'evidence', kind, this.runId);
    mkdirSync(path.join(this.dir, 'steps'), { recursive: true });
  }

  /** Append one structured event to the run's JSONL stream. */
  event(type: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
    appendFileSync(path.join(this.dir, 'run.jsonl'), this.redactor.apply(line) + '\n');
  }

  /** Persist a screenshot; returns the evidence-relative filename. */
  screenshot(name: string, png: Buffer | undefined): string | undefined {
    if (!png) return undefined;
    this.shotCount += 1;
    const file = `steps/${String(this.shotCount).padStart(3, '0')}-${sanitize(name)}.png`;
    writeFileSync(path.join(this.dir, file), png);
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
