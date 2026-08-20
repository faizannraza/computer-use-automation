/**
 * Locator resolution ladder.
 *
 * Strategies are tried strictly in recorded order. The first strategy that
 * yields exactly one confident candidate wins. Two candidates within an
 * epsilon of each other is a hard TARGET_AMBIGUOUS failure — falling through
 * to a weaker strategy to "break the tie" would be guessing, and guessing is
 * the one thing a deterministic replay engine must never do in a banking app.
 *
 * Resolution is a pure function over the Observation, so the entire ladder
 * is unit-testable without a browser. The single exception — the `structural`
 * strategy (raw CSS) — cannot be evaluated against an Observation, so callers
 * inject an async `structuralHits` lookup; when none is provided (pure/unit
 * contexts, non-web surfaces) the strategy is skipped.
 */
import type { FramePathEntry, Observation, ObservedElement } from '../../core/types.js';
import type { FrameHint, Locator, TargetRef } from '../../schema/locators.js';
import type { CandidateInfo, Resolution, ResolutionFailure } from '../surface.js';
import { globToRegExp } from '../../core/template.js';

/** How close two scores can be before we refuse to pick between them. */
const AMBIGUITY_EPSILON = 0.1;
const STRUCTURAL_SCORE = 0.7;

export type StructuralLookup = (css: string, framePath: FrameHint[]) => Promise<number[]>;

interface Candidate {
  el: ObservedElement;
  score: number;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Frame hints match against the TAIL of an actual frame path (innermost
 * frames) — shared by locator resolution (element frame paths) and
 * frame-scoped text conditions (per-frame text). */
export function frameMatches(hints: FrameHint[], framePath: FramePathEntry[]): boolean {
  if (hints.length === 0) return true;
  if (hints.length > framePath.length) return false;
  const tail = framePath.slice(framePath.length - hints.length);
  return hints.every((hint, i) => {
    const entry = tail[i]!;
    if (hint.name !== undefined && hint.name !== entry.name) return false;
    if (hint.urlPattern !== undefined && !globToRegExp(hint.urlPattern).test(entry.url)) return false;
    return true;
  });
}

/** Geometry sanity vs the recorded snapshot: a small nudge, never a decider. */
function geometryModifier(target: TargetRef, el: ObservedElement): number {
  const recorded = target.snapshot?.bboxPct;
  const actual = el.bboxPct;
  if (!recorded || !actual) return 0;
  const dx = recorded.x + recorded.w / 2 - (actual.x + actual.w / 2);
  const dy = recorded.y + recorded.h / 2 - (actual.y + actual.h / 2);
  const dist = Math.hypot(dx, dy);
  if (dist < 5) return 0.05;
  if (dist > 40) return -0.05;
  return 0;
}

/** Match one semantic strategy against the observation. Pure. */
export function matchStrategy(loc: Locator, target: TargetRef, obs: Observation): Candidate[] {
  const pool = obs.elements.filter((el) => frameMatches(target.framePath, el.framePath));
  const cands: Candidate[] = [];
  for (const el of pool) {
    let score = 0;
    switch (loc.s) {
      case 'roleName': {
        if (el.role !== loc.role) break;
        if (norm(el.name) === norm(loc.name)) score = 1.0;
        else if (loc.nameMatch === 'contains' && norm(el.name).includes(norm(loc.name))) score = 0.8;
        break;
      }
      case 'labelText': {
        if (el.label !== undefined && norm(el.label) === norm(loc.label)) score = 0.95;
        break;
      }
      case 'textAnchor': {
        if (loc.targetRole !== undefined && el.role !== loc.targetRole) break;
        if (loc.relation === 'self') {
          if (norm(el.name) === norm(loc.text)) score = 0.9;
          else if (norm(el.name).includes(norm(loc.text))) score = 0.7;
        } else {
          // 'rowOf' and 'near' both resolve through nearby anchor text on web.
          if (el.nearText !== undefined && norm(el.nearText).includes(norm(loc.text))) score = 0.85;
        }
        break;
      }
      case 'tableCell': {
        if (el.role !== 'cell' && el.role !== 'rowheader') break;
        if (el.colHeader === undefined || norm(el.colHeader) !== norm(loc.columnHeader)) break;
        if (el.nearText !== undefined && norm(el.nearText).includes(norm(loc.rowAnchor.text))) score = 0.9;
        break;
      }
      case 'structural':
        break; // handled by the injected lookup, never here
    }
    if (score > 0) cands.push({ el, score: clamp01(score + geometryModifier(target, el)) });
  }
  return cands;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function toInfo(c: Candidate): CandidateInfo {
  return { ref: c.el.ref, role: c.el.role, name: c.el.name, score: Number(c.score.toFixed(3)) };
}

/**
 * Walk the strategy ladder. Returns which strategy fired and at what score —
 * a step that used to resolve at strategy 0 and now needs strategy 2 is the
 * drift signal, logged for free on every replay.
 */
export async function resolveTarget(
  target: TargetRef,
  obs: Observation,
  structuralHits?: StructuralLookup,
): Promise<Resolution | ResolutionFailure> {
  const nearMisses: Candidate[] = [];
  for (let i = 0; i < target.strategies.length; i++) {
    const loc = target.strategies[i]!;
    let cands: Candidate[];
    if (loc.s === 'structural') {
      if (!structuralHits) continue;
      const refs = await structuralHits(loc.css, target.framePath);
      cands = refs
        .map((ref) => obs.elements.find((el) => el.ref === ref))
        .filter((el): el is ObservedElement => el !== undefined && frameMatches(target.framePath, el.framePath))
        .map((el) => ({ el, score: STRUCTURAL_SCORE }));
    } else {
      cands = matchStrategy(loc, target, obs);
    }
    const confident = cands
      .filter((c) => c.score >= target.disambiguation.minScore)
      .sort((a, b) => b.score - a.score);
    nearMisses.push(...cands);
    if (confident.length === 1) {
      return { ok: true, ref: confident[0]!.el.ref, strategyIndex: i, strategy: loc.s, score: confident[0]!.score };
    }
    if (confident.length > 1) {
      const [top, second] = [confident[0]!, confident[1]!];
      if (top.score - second.score > AMBIGUITY_EPSILON) {
        return { ok: true, ref: top.el.ref, strategyIndex: i, strategy: loc.s, score: top.score };
      }
      return {
        ok: false,
        reason: 'ambiguous',
        candidates: confident.slice(0, 5).map(toInfo),
        detail: `strategy ${i} (${loc.s}) matched ${confident.length} near-equal candidates — refusing to guess`,
      };
    }
  }
  return {
    ok: false,
    reason: 'not_found',
    candidates: nearMisses
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(toInfo),
    detail: `no strategy (${target.strategies.map((s) => s.s).join(' → ')}) produced a confident match`,
  };
}
