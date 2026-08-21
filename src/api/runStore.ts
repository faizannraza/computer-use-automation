/**
 * Run registry: what is happening now, what happened before, and how a live
 * view subscribes to either.
 *
 * Evidence on disk stays the source of truth — this is a queryable view over
 * it. In-memory state covers runs this process is driving (so a dashboard can
 * watch them arrive); the disk index covers everything ever recorded, which is
 * how discovery runs — produced by the CLI, long before the server existed —
 * show up in the same history as replays.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RecoveryUse, ReplayResult } from '../schema/result.js';

export type RunKind = 'discovery' | 'replay';
export type RunStatus = 'running' | 'success' | 'business_outcome' | 'escalated' | 'failed' | 'compiled' | 'gave_up' | 'error' | 'unknown';

export interface RunSummary {
  runId: string;
  kind: RunKind;
  status: RunStatus;
  capabilityId?: string;
  version?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  stepsOk?: number;
  interventions?: number;
  /**
   * Which recoveries the run had to apply, and how many attempts each took.
   *
   * A run that limped to 'success' through two SESSION_EXPIRED restarts is a
   * materially different event from a clean one — it is the "recoverable"
   * state the console is supposed to show — and the summary carried nothing to
   * tell them apart, so history rendered them identically. Codes rather than a
   * bare count, because WHICH condition recurred is the part that says whether
   * the target app is drifting. Absent (not `[]`) when the run recorded no
   * recovery information at all, which is honest for evidence written before
   * this field existed.
   */
  recoveries?: RecoveryUse[];
  /** Present for in-flight runs driven by this process. */
  live?: boolean;
  evidenceDir: string;
}

type Listener = (line: string) => void;

interface LiveRun {
  summary: RunSummary;
  /** Called once when the run reaches a terminal state, so a subscriber can
   * close its stream. Without this a LIVE subscriber never learns the run
   * ended — the event lines simply stop — and a viewer waits forever for a
   * result it already has on disk. */
  doneListeners: Set<() => void>;
  /** Redacted event lines already emitted, so a late subscriber gets the run
   * from its beginning rather than from whenever it happened to connect. */
  buffer: string[];
  listeners: Set<Listener>;
  result?: ReplayResult;
}

const MAX_BUFFERED_EVENTS = 2000;

export class RunStore {
  private readonly live = new Map<string, LiveRun>();

  constructor(private readonly evidenceBaseDir: string) {}

  /** Register a run this process is about to drive. */
  start(runId: string, kind: RunKind, capabilityId: string, version: string): void {
    this.live.set(runId, {
      summary: {
        runId,
        kind,
        status: 'running',
        capabilityId,
        version,
        startedAt: new Date().toISOString(),
        live: true,
        evidenceDir: path.join(this.evidenceBaseDir, kind, runId),
      },
      buffer: [],
      listeners: new Set(),
      doneListeners: new Set(),
    });
  }

  /**
   * Feed one redacted event line in. Never throws and never blocks: a slow or
   * dead subscriber must not stall the replay engine that is calling this.
   */
  publish(runId: string, line: string): void {
    const run = this.live.get(runId);
    if (!run) return;
    if (run.buffer.length < MAX_BUFFERED_EVENTS) run.buffer.push(line);
    for (const listener of run.listeners) {
      try {
        listener(line);
      } catch {
        /* a broken client is not the run's problem */
      }
    }
  }

  finish(runId: string, result: ReplayResult): void {
    const run = this.live.get(runId);
    if (!run) return;
    run.result = result;
    run.summary = {
      ...run.summary,
      status: result.status,
      finishedAt: result.finishedAt,
      durationMs: Date.parse(result.finishedAt) - Date.parse(result.startedAt),
      stepsOk: result.stepsRun.filter((s) => s.status === 'ok').length,
      interventions: result.interventions.length,
      recoveries: result.recoveriesUsed,
      live: false,
    };
    this.announceDone(run);
  }

  /**
   * Mark a run that died OUTSIDE the engine's own failure handling — a browser
   * that would not launch, an evidence directory that could not be created, a
   * surface that threw on close.
   *
   * The reason is deliberately not forwarded to subscribers. Every other line
   * on this stream came through `RunLog`, which redacts at the write boundary;
   * this one never touched a redactor, because the run died before (or after)
   * the engine owned one. Playwright's errors quote the page they were driving,
   * so forwarding `err.message` verbatim would make this the single event on
   * the server capable of streaming regulated text to every subscriber — and
   * `publish` also buffers it, so it would replay to every later subscriber too.
   *
   * The operator loses nothing: the detail goes to the console they started the
   * server in, which is the one place already trusted with unredacted output.
   */
  fail(runId: string, reason: string): void {
    const run = this.live.get(runId);
    if (!run) return;
    run.summary = { ...run.summary, status: 'error', finishedAt: new Date().toISOString(), live: false };
    console.error(`[run ${runId}] died outside the engine: ${reason}`);
    this.publish(
      runId,
      JSON.stringify({
        ts: new Date().toISOString(),
        type: 'run_error',
        reason: 'the run ended before the engine could report on it — see the server console for the cause',
      }),
    );
    this.announceDone(run);
  }

  /** Terminal signal, delivered after the last event line so a subscriber sees
   * the whole run before it is told the run is over. A throwing subscriber is
   * ignored for the same reason `publish` ignores one: a broken client is not
   * the run's problem. */
  private announceDone(run: LiveRun): void {
    for (const done of run.doneListeners) {
      try {
        done();
      } catch {
        /* ignore */
      }
    }
    run.doneListeners.clear();
  }

  result(runId: string): ReplayResult | undefined {
    return this.live.get(runId)?.result;
  }

  /**
   * Subscribe to a run's events. Replays what has already happened, then
   * streams the rest; returns an unsubscribe function.
   */
  subscribe(
    runId: string,
    listener: Listener,
    onDone?: () => void,
  ): { history: string[]; unsubscribe: () => void } {
    const run = this.live.get(runId);
    if (!run) return { history: [], unsubscribe: () => undefined };
    run.listeners.add(listener);
    if (onDone) run.doneListeners.add(onDone);
    return {
      history: [...run.buffer],
      unsubscribe: () => {
        run.listeners.delete(listener);
        if (onDone) run.doneListeners.delete(onDone);
      },
    };
  }

  isLive(runId: string): boolean {
    return this.live.get(runId)?.summary.status === 'running';
  }

  /**
   * All runs, newest first: in-flight and completed from this process, plus
   * everything on disk. Disk entries are parsed from the evidence a run
   * already writes — no separate database to drift out of sync with it.
   */
  list(limit = 100, kind?: RunKind): RunSummary[] {
    const seen = new Map<string, RunSummary>();
    for (const run of this.live.values()) {
      if (kind === undefined || run.summary.kind === kind) seen.set(run.summary.runId, run.summary);
    }
    for (const k of ['replay', 'discovery'] as const) {
      if (kind !== undefined && kind !== k) continue;
      const dir = path.join(this.evidenceBaseDir, k);
      if (!existsSync(dir)) continue;
      for (const runId of readdirSync(dir)) {
        if (seen.has(runId)) continue;
        const runDir = path.join(dir, runId);
        try {
          if (!statSync(runDir).isDirectory()) continue;
          const summary = summarizeFromDisk(runId, k, runDir);
          if (summary) seen.set(runId, summary);
        } catch {
          /* an unreadable directory is skipped rather than breaking the list */
        }
      }
    }
    // Sort on a single normalized key: epoch milliseconds, from whichever
    // source the run has. runIds are stamped `YYYYMMDD-HHMMSS-x` and startedAt
    // is ISO, so comparing them as STRINGS — even zero-padded — puts every
    // id-only run above every timestamped one, because a 14-digit calendar
    // stamp outranks a 13-digit epoch. Normalising to one numeric scale is the
    // whole point of having a key function.
    const sortKey = (r: RunSummary): number => {
      const fromStamp = r.startedAt !== undefined ? Date.parse(r.startedAt) : NaN;
      return Number.isNaN(fromStamp) ? runIdToEpoch(r.runId) : fromStamp;
    };
    return [...seen.values()]
      .sort((a, b) => sortKey(b) - sortKey(a) || (a.runId < b.runId ? 1 : -1))
      .slice(0, limit);
  }

  /** A run's detail: the structured result plus its recorded event stream. */
  detail(runId: string): { summary: RunSummary; result?: unknown; events: unknown[] } | undefined {
    const liveRun = this.live.get(runId);
    const summary = liveRun?.summary ?? this.list(1000).find((r) => r.runId === runId);
    if (!summary) return undefined;
    const events: unknown[] = [];
    const jsonl = path.join(summary.evidenceDir, 'run.jsonl');
    if (existsSync(jsonl)) {
      for (const line of readFileSync(jsonl, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          /* a partially-written final line during a live run */
        }
      }
    } else {
      for (const line of liveRun?.buffer ?? []) {
        try {
          events.push(JSON.parse(line));
        } catch {
          /* ignore */
        }
      }
    }
    // Prefer the ON-DISK result: /api/runs is the EVIDENCE channel, and
    // evidence is redacted. The in-memory result carries real values and is
    // the CALLER channel — it is returned from an invoke, not from history.
    // Without this, the same run rendered differently before and after a
    // restart, and a dashboard on a projector showed unmasked balances.
    const resultFile = path.join(summary.evidenceDir, 'result.json');
    const result = existsSync(resultFile) ? safeJson(readFileSync(resultFile, 'utf8')) : liveRun?.result;
    return { summary, ...(result !== undefined ? { result } : {}), events };
  }
}

/**
 * `20260820-112518-h5mg` → epoch milliseconds, so it can be compared against a
 * parsed ISO `startedAt` on one scale. Run ids are stamped in LOCAL time
 * (`newRunId`), and this reconstructs them the same way. A run with neither a
 * parseable id nor a timestamp sorts last rather than first — an unreadable
 * run should not pin itself to the top of the history forever.
 */
function runIdToEpoch(runId: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(runId);
  if (!m) return 0;
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reconstruct a summary from what a run already wrote. Reads `result.json`
 * when present (replays), and otherwise mines the JSONL — which is how a
 * discovery run, whose shape predates this API entirely, still lists.
 */
function summarizeFromDisk(runId: string, kind: RunKind, dir: string): RunSummary | undefined {
  const base: RunSummary = { runId, kind, status: 'unknown', evidenceDir: dir };
  const resultFile = path.join(dir, 'result.json');
  if (existsSync(resultFile)) {
    const parsed = safeJson(readFileSync(resultFile, 'utf8')) as ReplayResult | undefined;
    if (parsed?.status) {
      return {
        ...base,
        status: parsed.status,
        capabilityId: parsed.capabilityId,
        version: parsed.version,
        startedAt: parsed.startedAt,
        finishedAt: parsed.finishedAt,
        durationMs: Date.parse(parsed.finishedAt) - Date.parse(parsed.startedAt),
        stepsOk: parsed.stepsRun?.filter((s) => s.status === 'ok').length ?? 0,
        interventions: parsed.interventions?.length ?? 0,
        ...(parsed.recoveriesUsed !== undefined ? { recoveries: parsed.recoveriesUsed } : {}),
      };
    }
  }
  const jsonl = path.join(dir, 'run.jsonl');
  if (!existsSync(jsonl)) return undefined;
  const lines = readFileSync(jsonl, 'utf8').split('\n').filter((l) => l.trim());
  let summary = base;
  // Recoveries mined from the event stream, for a run with no result.json —
  // one aborted mid-flight, or a discovery run, whose shape predates the
  // result contract. `attempt` is the engine's per-code counter, so the
  // highest one seen IS the number of attempts that code took.
  const recoveries = new Map<string, number>();
  for (const line of lines) {
    const event = safeJson(line) as
      | { type?: string; ts?: string; capability?: string; status?: string; goal?: string; code?: string; attempt?: number }
      | undefined;
    if (!event?.type) continue;
    if (event.type === 'recovery_applied' && event.code) {
      recoveries.set(event.code, Math.max(recoveries.get(event.code) ?? 0, event.attempt ?? 1));
    }
    if (event.type === 'run_start') {
      const [id, version] = (event.capability ?? '').split('@');
      summary = {
        ...summary,
        ...(event.ts !== undefined ? { startedAt: event.ts } : {}),
        ...(id ? { capabilityId: id } : {}),
        ...(version ? { version } : {}),
        // A discovery run identifies itself by its goal rather than a capability.
        ...(event.goal !== undefined && !id ? { capabilityId: `(discovery) ${event.goal.slice(0, 60)}` } : {}),
      };
    }
    if (event.type === 'run_result') {
      summary = {
        ...summary,
        status: (event.status as RunStatus) ?? 'unknown',
        ...(event.ts !== undefined ? { finishedAt: event.ts } : {}),
      };
    }
  }
  if (summary.startedAt && summary.finishedAt) {
    summary.durationMs = Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
  }
  if (recoveries.size > 0) {
    summary.recoveries = [...recoveries].map(([code, attempts]) => ({ code, attempts }));
  }
  return summary;
}
