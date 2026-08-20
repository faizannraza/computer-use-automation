/**
 * Multi-run stability: aggregate N deterministic replays of one capability
 * into a flakiness signal (the brief's multi-run-stability stretch goal).
 *
 * The interesting aggregate is the per-step strategy-index distribution —
 * the drift signal each replay already records, summed. A step that resolves
 * at index 0 in some runs and index 2 in others is telling you the UI (or
 * the locator) is unstable BEFORE it ever fails outright. Status flapping
 * and inconsistent outputs are the louder signals on top.
 */
import type { ReplayResult } from '../schema/result.js';

export interface StepStability {
  stepId: string;
  /** How many of the N runs reached this step. */
  runs: number;
  /** strategyIndex → how many runs resolved there. One key = stable. */
  strategyIndexCounts: Record<string, number>;
  msP50: number;
  msP95: number;
}

export interface StabilityReport {
  capabilityId: string;
  version: string;
  runs: number;
  runIds: string[];
  /** status → count, with business outcomes broken out by code and failures by class. */
  statuses: Record<string, number>;
  /** True when every successful run produced identical outputs. */
  outputsConsistent: boolean;
  steps: StepStability[];
  verdict: 'stable' | 'flaky';
  reasons: string[];
}

export function buildStabilityReport(results: ReplayResult[]): StabilityReport {
  if (results.length === 0) throw new Error('stability report needs at least one result');
  const first = results[0]!;
  const reasons: string[] = [];

  // Failures keyed by class: TARGET_NOT_FOUND flapping with
  // POSTCONDITION_TIMEOUT is instability even though both are 'failed'.
  const statuses: Record<string, number> = {};
  for (const r of results) {
    const key =
      r.status === 'business_outcome' ? `business_outcome:${r.code}` : r.status === 'failed' ? `failed:${r.failure.class}` : r.status;
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  if (Object.keys(statuses).length > 1) {
    reasons.push(`status flapped across runs: ${Object.entries(statuses).map(([k, v]) => `${k}×${v}`).join(', ')}`);
  }

  // 'stable' is a certificate about a capability that WORKS. Runs that all
  // failed identically are reproducible, but there is nothing to certify.
  const completed = results.filter((r) => r.status === 'success' || r.status === 'business_outcome').length;
  if (completed === 0) {
    reasons.push(`no run completed (${Object.keys(statuses).join(', ')}) — reproducible failure is not stability`);
  }

  const successOutputs = results.filter((r) => r.status === 'success').map((r) => JSON.stringify(r.outputs));
  const outputsConsistent = new Set(successOutputs).size <= 1;
  if (!outputsConsistent) reasons.push('successful runs returned different outputs');

  // Per-step aggregation across runs (steps identified by id). Intents are
  // deliberately NOT copied into the report: they are post-substitution
  // strings, and this report is the one evidence file written outside the
  // redacted RunLog path — step ids carry no values.
  const byStep = new Map<string, { strategyIdx: number[]; ms: number[] }>();
  for (const r of results) {
    for (const t of r.stepsRun) {
      const entry = byStep.get(t.stepId) ?? { strategyIdx: [], ms: [] };
      if (t.strategyIndex !== undefined) entry.strategyIdx.push(t.strategyIndex);
      entry.ms.push(t.ms);
      byStep.set(t.stepId, entry);
    }
  }
  const steps: StepStability[] = [...byStep.entries()].map(([stepId, e]) => {
    const strategyIndexCounts: Record<string, number> = {};
    for (const i of e.strategyIdx) strategyIndexCounts[String(i)] = (strategyIndexCounts[String(i)] ?? 0) + 1;
    if (Object.keys(strategyIndexCounts).length > 1) {
      reasons.push(`step ${stepId} resolved at different ladder ranks across runs (${Object.keys(strategyIndexCounts).join(', ')}) — locator drift`);
    }
    return {
      stepId,
      runs: e.ms.length,
      strategyIndexCounts,
      msP50: percentile(e.ms, 50),
      msP95: percentile(e.ms, 95),
    };
  });
  // Same statuses but different step coverage = the runs diverged mid-flow
  // (e.g. the same failure class at different steps).
  const coverage = new Set(steps.map((s) => s.runs));
  if (coverage.size > 1 && Object.keys(statuses).length === 1) {
    reasons.push('runs diverged mid-flow: identical statuses but different steps were reached');
  }

  return {
    capabilityId: first.capabilityId,
    version: first.version,
    runs: results.length,
    runIds: results.map((r) => r.runId),
    statuses,
    outputsConsistent,
    steps,
    verdict: reasons.length === 0 ? 'stable' : 'flaky',
    reasons,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}
