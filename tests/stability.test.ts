/** Multi-run stability aggregation — pure over ReplayResults, no browser. */
import { describe, expect, it } from 'vitest';
import { buildStabilityReport } from '../src/replay/stability.js';
import type { ReplayResult, StepTrace } from '../src/schema/result.js';

function trace(stepId: string, strategyIndex: number, ms: number): StepTrace {
  return { stepId, intent: `intent ${stepId}`, status: 'ok', strategyIndex, strategy: 'roleName', score: 1, ms };
}

function success(runId: string, outputs: Record<string, string>, steps: StepTrace[]): ReplayResult {
  return {
    capabilityId: 'member.readSavingsBalance',
    version: '1.0.0',
    runId,
    evidenceDir: `evidence/replay/${runId}`,
    status: 'success',
    outputs,
    stepsRun: steps,
    recoveriesUsed: [],
    interventions: [],
    irreversibleCompleted: false,
    startedAt: '2026-08-19T00:00:00Z',
    finishedAt: '2026-08-19T00:00:03Z',
  };
}

describe('buildStabilityReport', () => {
  it('identical successful runs are stable, with per-step timing percentiles', () => {
    const report = buildStabilityReport([
      success('r1', { savingsBalance: '$4,821.97' }, [trace('s1', 0, 100), trace('s2', 0, 200)]),
      success('r2', { savingsBalance: '$4,821.97' }, [trace('s1', 0, 120), trace('s2', 0, 180)]),
      success('r3', { savingsBalance: '$4,821.97' }, [trace('s1', 0, 110), trace('s2', 0, 220)]),
    ]);
    expect(report.verdict).toBe('stable');
    expect(report.reasons).toEqual([]);
    expect(report.statuses).toEqual({ success: 3 });
    expect(report.outputsConsistent).toBe(true);
    const s1 = report.steps.find((s) => s.stepId === 's1')!;
    expect(s1.strategyIndexCounts).toEqual({ '0': 3 });
    expect(s1.msP50).toBe(110);
    expect(s1.msP95).toBe(120);
  });

  it('strategy-rank drift across runs is flaky even when every run succeeded', () => {
    const report = buildStabilityReport([
      success('r1', { savingsBalance: '$4,821.97' }, [trace('s1', 0, 100)]),
      success('r2', { savingsBalance: '$4,821.97' }, [trace('s1', 2, 100)]),
    ]);
    expect(report.verdict).toBe('flaky');
    expect(report.reasons.some((r) => r.includes('s1') && r.includes('locator drift'))).toBe(true);
    expect(report.steps[0]!.strategyIndexCounts).toEqual({ '0': 1, '2': 1 });
  });

  it('status flapping and inconsistent outputs are named reasons', () => {
    const failed: ReplayResult = {
      ...success('r2', {}, [trace('s1', 0, 100)]),
      status: 'failed',
      failure: { class: 'POSTCONDITION_TIMEOUT', expected: 'x', observed: 'y' },
    } as ReplayResult;
    const report = buildStabilityReport([
      success('r1', { savingsBalance: '$1.00' }, [trace('s1', 0, 100)]),
      failed,
      success('r3', { savingsBalance: '$2.00' }, [trace('s1', 0, 100)]),
    ]);
    expect(report.verdict).toBe('flaky');
    expect(report.statuses).toEqual({ success: 2, failed: 1 });
    expect(report.reasons.some((r) => r.includes('status flapped'))).toBe(true);
    expect(report.reasons.some((r) => r.includes('different outputs'))).toBe(true);
  });

  it('business outcomes are broken out by code, and one consistent code is stable', () => {
    const outcome = (runId: string): ReplayResult => ({
      ...success(runId, {}, [trace('s1', 0, 100)]),
      status: 'business_outcome',
      code: 'MEMBER_NOT_FOUND',
      message: 'no such member',
      outputs: {},
    });
    const report = buildStabilityReport([outcome('r1'), outcome('r2')]);
    expect(report.statuses).toEqual({ 'business_outcome:MEMBER_NOT_FOUND': 2 });
    expect(report.verdict).toBe('stable');
  });
});
