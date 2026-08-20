/**
 * The run registry: a queryable view over evidence that is already on disk,
 * plus the in-memory state for runs this process is driving.
 *
 * Everything here is fabricated evidence in a temp directory — the point is
 * that history is reconstructed from what a run WROTE, so a discovery run
 * recorded by the CLI long before this API existed still lists.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../src/api/runStore.js';
import type { RunKind } from '../src/api/runStore.js';
import type { ReplayResult } from '../src/schema/result.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'cu-runstore-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function runDir(kind: RunKind, runId: string): string {
  const dir = path.join(base, kind, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeResult(kind: RunKind, runId: string, result: Record<string, unknown>): void {
  writeFileSync(path.join(runDir(kind, runId), 'result.json'), JSON.stringify(result), 'utf8');
}

function writeJsonl(kind: RunKind, runId: string, events: Record<string, unknown>[]): void {
  writeFileSync(
    path.join(runDir(kind, runId), 'run.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
}

function replayResult(runId: string, over: Record<string, unknown> = {}): ReplayResult {
  return {
    capabilityId: 'member.readBalances',
    version: '1.0.0',
    runId,
    evidenceDir: path.join(base, 'replay', runId),
    status: 'success',
    outputs: { shares: 'S00 $4,821.97' },
    stepsRun: [
      { stepId: 's1', intent: 'sign on', status: 'ok', ms: 120 },
      { stepId: 's2', intent: 'look up member', status: 'failed', ms: 90 },
    ],
    recoveriesUsed: [],
    interventions: [],
    irreversibleCompleted: false,
    startedAt: '2026-03-01T10:00:00.000Z',
    finishedAt: '2026-03-01T10:00:30.000Z',
    ...over,
  } as ReplayResult;
}

describe('history reconstructed from evidence on disk', () => {
  it('lists BOTH a replay (result.json) and a discovery run (run.jsonl only)', () => {
    writeResult('replay', '20260301-100000-aaaa', {
      status: 'success',
      capabilityId: 'member.readBalances',
      version: '1.0.0',
      startedAt: '2026-03-01T10:00:00.000Z',
      finishedAt: '2026-03-01T10:00:30.000Z',
      stepsRun: [
        { stepId: 's1', intent: 'a', status: 'ok', ms: 1 },
        { stepId: 's2', intent: 'b', status: 'failed', ms: 2 },
      ],
      interventions: [
        { id: 'int-01', kind: 'approve_risky', reason: 'r', resolution: 'approve', humanActions: 0, heldForMs: 5 },
      ],
    });
    writeJsonl('discovery', '20260201-090000-bbbb', [
      { ts: '2026-02-01T09:00:00.000Z', type: 'run_start', goal: 'find how to place an account hold' },
      { ts: '2026-02-01T09:04:00.000Z', type: 'run_result', status: 'compiled' },
    ]);

    const store = new RunStore(base);
    const runs = store.list();
    expect(runs).toHaveLength(2);

    const replay = runs.find((r) => r.runId === '20260301-100000-aaaa');
    expect(replay?.kind).toBe('replay');
    expect(replay?.status).toBe('success');
    expect(replay?.capabilityId).toBe('member.readBalances');
    expect(replay?.stepsOk).toBe(1); // only the 'ok' step counts
    expect(replay?.interventions).toBe(1);
    expect(replay?.durationMs).toBe(30_000);

    const discovery = runs.find((r) => r.runId === '20260201-090000-bbbb');
    expect(discovery?.kind).toBe('discovery');
    expect(discovery?.status).toBe('compiled');
    // A discovery run has no capability id — it identifies itself by its goal.
    expect(discovery?.capabilityId).toContain('(discovery) find how to place an account hold');
    expect(discovery?.durationMs).toBe(240_000);
  });

  it('orders a mixed history newest first, on one normalized key', () => {
    writeResult('replay', '20260101-000000-old1', { status: 'success', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z' });
    writeResult('replay', '20260401-000000-new1', { status: 'failed', startedAt: '2026-04-01T00:00:00.000Z', finishedAt: '2026-04-01T00:01:00.000Z' });
    writeJsonl('discovery', '20260201-000000-mid1', [
      { ts: '2026-02-01T00:00:00.000Z', type: 'run_start', goal: 'g' },
      { ts: '2026-02-01T00:01:00.000Z', type: 'run_result', status: 'compiled' },
    ]);
    writeJsonl('discovery', '20260301-000000-mid2', [
      { ts: '2026-03-01T00:00:00.000Z', type: 'run_start', goal: 'g2' },
    ]);

    const store = new RunStore(base);
    expect(store.list().map((r) => r.runId)).toEqual([
      '20260401-000000-new1',
      '20260301-000000-mid2',
      '20260201-000000-mid1',
      '20260101-000000-old1',
    ]);
  });

  it('honours the kind filter and the limit', () => {
    writeResult('replay', '20260401-000000-r1', { status: 'success', startedAt: '2026-04-01T00:00:00.000Z', finishedAt: '2026-04-01T00:00:10.000Z' });
    writeResult('replay', '20260301-000000-r2', { status: 'success', startedAt: '2026-03-01T00:00:00.000Z', finishedAt: '2026-03-01T00:00:10.000Z' });
    writeJsonl('discovery', '20260201-000000-d1', [{ ts: '2026-02-01T00:00:00.000Z', type: 'run_start', goal: 'g' }]);

    const store = new RunStore(base);
    expect(store.list(100, 'discovery').map((r) => r.runId)).toEqual(['20260201-000000-d1']);
    expect(store.list(100, 'replay').map((r) => r.runId)).toEqual(['20260401-000000-r1', '20260301-000000-r2']);
    expect(store.list(1).map((r) => r.runId)).toEqual(['20260401-000000-r1']);
  });

  it('a malformed result.json neither throws nor poisons the rest of the listing', () => {
    // Truncated mid-write — exactly what a killed process leaves behind.
    writeFileSync(path.join(runDir('replay', '20260301-000000-trunc'), 'result.json'), '{"status": "succ', 'utf8');
    writeJsonl('replay', '20260301-000000-trunc', [
      { ts: '2026-03-01T00:00:00.000Z', type: 'run_start', capability: 'member.readBalances@1.0.0' },
      { ts: '2026-03-01T00:00:20.000Z', type: 'run_result', status: 'failed' },
    ]);
    // A directory with nothing salvageable at all.
    writeFileSync(path.join(runDir('replay', '20260302-000000-empty'), 'result.json'), 'not json either', 'utf8');
    // A stray file where a run directory would be (a .DS_Store, say).
    writeFileSync(path.join(base, 'replay', '.DS_Store'), 'junk', 'utf8');
    writeResult('replay', '20260401-000000-good', { status: 'success', startedAt: '2026-04-01T00:00:00.000Z', finishedAt: '2026-04-01T00:00:05.000Z' });

    const store = new RunStore(base);
    const runs = store.list();
    expect(runs.map((r) => r.runId)).toContain('20260401-000000-good');
    // The truncated result falls back to the JSONL rather than being lost.
    const salvaged = runs.find((r) => r.runId === '20260301-000000-trunc');
    expect(salvaged?.status).toBe('failed');
    expect(salvaged?.capabilityId).toBe('member.readBalances');
    // Nothing readable, and no stray file, ever reaches the listing.
    expect(runs.map((r) => r.runId)).not.toContain('20260302-000000-empty');
    expect(runs.map((r) => r.runId)).not.toContain('.DS_Store');
  });

  it('a result.json whose status is missing falls through to the JSONL', () => {
    writeResult('replay', '20260301-000000-nost', { status: '' });
    writeJsonl('replay', '20260301-000000-nost', [
      { ts: '2026-03-01T00:00:00.000Z', type: 'run_start', capability: 'member.transferFunds@2.0.0' },
      { ts: '2026-03-01T00:00:09.000Z', type: 'run_result', status: 'escalated' },
    ]);
    const store = new RunStore(base);
    const run = store.list()[0];
    expect(run?.status).toBe('escalated');
    expect(run?.version).toBe('2.0.0');
    expect(run?.durationMs).toBe(9000);
  });

  it('does not list a run twice when it is both live in memory and on disk', () => {
    const runId = '20260401-120000-live';
    writeResult('replay', runId, { status: 'success', startedAt: '2026-04-01T12:00:00.000Z', finishedAt: '2026-04-01T12:00:20.000Z' });

    const store = new RunStore(base);
    store.start(runId, 'replay', 'member.readBalances', '1.0.0');
    const runs = store.list();
    expect(runs.filter((r) => r.runId === runId)).toHaveLength(1);
    // The in-memory record wins: it is the one that knows the run is still going.
    expect(runs.find((r) => r.runId === runId)?.live).toBe(true);
    expect(runs.find((r) => r.runId === runId)?.status).toBe('running');
  });

  it('an empty or missing evidence tree lists nothing rather than throwing', () => {
    const store = new RunStore(path.join(base, 'does-not-exist'));
    expect(store.list()).toEqual([]);
  });
});

describe('live runs: lifecycle and detail', () => {
  it('finish() folds the result into the summary and ends the run', () => {
    const store = new RunStore(base);
    store.start('run-live-1', 'replay', 'member.readBalances', '1.0.0');
    expect(store.isLive('run-live-1')).toBe(true);

    store.finish('run-live-1', replayResult('run-live-1'));
    const summary = store.list().find((r) => r.runId === 'run-live-1');
    expect(summary?.status).toBe('success');
    expect(summary?.live).toBe(false);
    expect(summary?.stepsOk).toBe(1);
    expect(summary?.durationMs).toBe(30_000);
    expect(store.isLive('run-live-1')).toBe(false);
    expect(store.result('run-live-1')?.runId).toBe('run-live-1');
  });

  it('fail() records the error and publishes it as an event', () => {
    const store = new RunStore(base);
    store.start('run-dead', 'replay', 'member.readBalances', '1.0.0');
    const seen: string[] = [];
    store.subscribe('run-dead', (line) => seen.push(line));

    store.fail('run-dead', 'browser vanished');
    expect(store.list().find((r) => r.runId === 'run-dead')?.status).toBe('error');
    expect(store.isLive('run-dead')).toBe(false);
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0] ?? '{}')).toMatchObject({ type: 'run_error', reason: 'browser vanished' });
  });

  it('finish()/publish() on an unknown run are no-ops, not throws', () => {
    const store = new RunStore(base);
    expect(() => store.publish('nobody', 'x')).not.toThrow();
    expect(() => store.finish('nobody', replayResult('nobody'))).not.toThrow();
    expect(() => store.fail('nobody', 'x')).not.toThrow();
    expect(store.result('nobody')).toBeUndefined();
    expect(store.isLive('nobody')).toBe(false);
  });

  it('detail() prefers the REDACTED on-disk result over the in-memory one', () => {
    const runId = '20260401-130000-det';
    const store = new RunStore(base);
    store.start(runId, 'replay', 'member.readBalances', '1.0.0');
    store.publish(runId, JSON.stringify({ type: 'step_start', stepId: 's1' }));
    store.finish(runId, replayResult(runId, { outputs: { shares: '$4,821.97' } }));

    // The evidence channel is redacted; the caller channel is not. History
    // renders the former.
    writeResult('replay', runId, { status: 'success', outputs: { shares: '[REDACTED:financial]' } });

    const detail = store.detail(runId);
    expect(JSON.stringify(detail?.result)).toContain('[REDACTED:financial]');
    expect(JSON.stringify(detail?.result)).not.toContain('4,821.97');
    expect(detail?.summary.runId).toBe(runId);
  });

  it('detail() of a live run with no file on disk yet replays its buffer', () => {
    const store = new RunStore(base);
    store.start('run-buf', 'replay', 'member.readBalances', '1.0.0');
    store.publish('run-buf', JSON.stringify({ type: 'run_start' }));
    store.publish('run-buf', 'this line is not JSON and is skipped');
    store.publish('run-buf', JSON.stringify({ type: 'step_ok', stepId: 's1' }));

    const detail = store.detail('run-buf');
    expect(detail?.events).toEqual([{ type: 'run_start' }, { type: 'step_ok', stepId: 's1' }]);
  });

  it('detail() of an unknown run is undefined', () => {
    expect(new RunStore(base).detail('nope')).toBeUndefined();
  });

  it('detail() reads run.jsonl for a finished run, skipping a torn final line', () => {
    const runId = '20260401-140000-jsonl';
    writeFileSync(
      path.join(runDir('replay', runId), 'run.jsonl'),
      [JSON.stringify({ ts: '2026-04-01T14:00:00.000Z', type: 'run_start', capability: 'member.readBalances@1.0.0' }), '{"type":"step_st'].join('\n'),
      'utf8',
    );
    const detail = new RunStore(base).detail(runId);
    expect(detail?.events).toHaveLength(1);
    expect(detail?.events[0]).toMatchObject({ type: 'run_start' });
  });
});

describe('subscribing to a run', () => {
  it('delivers events emitted after the subscription, and replays the history', () => {
    const store = new RunStore(base);
    store.start('run-sub', 'replay', 'member.readBalances', '1.0.0');
    store.publish('run-sub', 'before-1');
    store.publish('run-sub', 'before-2');

    const seen: string[] = [];
    const { history } = store.subscribe('run-sub', (line) => seen.push(line));
    expect(history).toEqual(['before-1', 'before-2']);
    expect(seen).toEqual([]); // history is returned, not double-delivered

    store.publish('run-sub', 'after-1');
    store.publish('run-sub', 'after-2');
    expect(seen).toEqual(['after-1', 'after-2']);
  });

  it('a subscriber attached AFTER the run finished sees each event exactly once', () => {
    const store = new RunStore(base);
    store.start('run-done', 'replay', 'member.readBalances', '1.0.0');
    store.publish('run-done', JSON.stringify({ type: 'run_start' }));
    store.publish('run-done', JSON.stringify({ type: 'step_ok', stepId: 's1' }));
    store.finish('run-done', replayResult('run-done'));

    // The finished-run path is the history one: isLive() is the switch the
    // stream endpoint uses to choose between replaying and subscribing.
    expect(store.isLive('run-done')).toBe(false);
    const detail = store.detail('run-done');
    expect(detail?.events).toEqual([{ type: 'run_start' }, { type: 'step_ok', stepId: 's1' }]);

    // And the buffer that a late subscriber would receive holds the same
    // events once — no event is both replayed and streamed.
    const seen: string[] = [];
    const { history } = store.subscribe('run-done', (line) => seen.push(line));
    expect(history).toHaveLength(2);
    expect(seen).toEqual([]);
  });

  it('unsubscribing stops delivery', () => {
    const store = new RunStore(base);
    store.start('run-unsub', 'replay', 'member.readBalances', '1.0.0');
    const seen: string[] = [];
    const { unsubscribe } = store.subscribe('run-unsub', (line) => seen.push(line));

    store.publish('run-unsub', 'one');
    unsubscribe();
    store.publish('run-unsub', 'two');
    expect(seen).toEqual(['one']);
    expect(() => unsubscribe()).not.toThrow(); // idempotent
  });

  it('subscribing to an unknown run is inert rather than an error', () => {
    const store = new RunStore(base);
    const { history, unsubscribe } = store.subscribe('nobody', () => {
      throw new Error('must never be called');
    });
    expect(history).toEqual([]);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('one throwing subscriber does not stall the run or the other subscribers', () => {
    const store = new RunStore(base);
    store.start('run-throw', 'replay', 'member.readBalances', '1.0.0');
    const seen: string[] = [];
    store.subscribe('run-throw', () => {
      throw new Error('this client is broken');
    });
    store.subscribe('run-throw', (line) => seen.push(line));

    // The engine calls publish(): a dead dashboard must not take the run down.
    expect(() => store.publish('run-throw', 'a')).not.toThrow();
    expect(() => store.publish('run-throw', 'b')).not.toThrow();
    expect(seen).toEqual(['a', 'b']);
    expect(store.detail('run-throw')?.summary.status).toBe('running');
  });
});
