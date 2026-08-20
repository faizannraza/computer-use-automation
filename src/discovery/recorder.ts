/** Append-only trace of what the agent actually did: accepted actions with
 * element evidence and before/after state digests. The compiler consumes
 * this; nothing in the artifact comes from the model transcript. */
import type { Observation, ObservedElement, RiskClass } from '../core/types.js';

/** What the compiler needs to know about the acted-on element. */
export interface RecordedElement {
  role: string;
  name: string;
  label?: string;
  nearText?: string;
  colHeader?: string;
  framePath: { name?: string; url: string }[];
  bboxPct?: { x: number; y: number; w: number; h: number };
}

/** One checkpoint-marker candidate: what text appeared, and in which frame. */
export interface MarkerInfo {
  text: string;
  /** Innermost frame name the marker was observed in; absent = main frame or unnamed. */
  frame?: string;
}

/** Compact digest of an observation for postcondition mining. */
export interface StateDigest {
  location: string;
  title: string;
  /** Headings / row headers / column headers — checkpoint marker candidates, frame-tagged. */
  markers: MarkerInfo[];
  dialogText?: string;
}

export type RecordedValue = { literal: string } | { param: string };

export interface RecordedAction {
  seq: number;
  kind: 'navigate' | 'activate' | 'setValue' | 'choose' | 'read' | 'answerDialog';
  intent: string;
  risk: RiskClass;
  url?: string;
  element?: RecordedElement;
  value?: RecordedValue;
  option?: RecordedValue;
  outputName?: string;
  readValue?: string;
  /** True while an exceptional-state probe is active — excluded from the step spine. */
  probe: boolean;
  /** Which probe (outcome code) this action belongs to, when probe is true. */
  probeCode?: string;
  before: StateDigest;
  after: StateDigest;
  screenshotRef?: string;
}

export interface DeclaredOutcome {
  code: string;
  description: string;
  marker: string;
  /** Digest of the state in which the marker was verified visible. */
  observedIn: StateDigest;
}

export interface DiscoveryTrace {
  goal: string;
  actions: RecordedAction[];
  outcomes: DeclaredOutcome[];
  done?: { capabilityId: string; title: string; description: string };
  gaveUp?: { reason: string };
}

export function digestOf(obs: Observation): StateDigest {
  const markers: MarkerInfo[] = [];
  const seen = new Set<string>();
  for (const e of obs.elements) {
    if (e.role !== 'heading' && e.role !== 'rowheader' && e.role !== 'columnheader') continue;
    if (e.name.length === 0) continue;
    const frame = e.framePath[e.framePath.length - 1]?.name;
    const key = `${frame ?? ''}\u0000${e.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({ text: e.name, ...(frame !== undefined ? { frame } : {}) });
    if (markers.length >= 40) break;
  }
  return {
    location: obs.location,
    title: obs.title,
    markers,
    ...(obs.dialog ? { dialogText: obs.dialog.text } : {}),
  };
}

export function recordedElementOf(el: ObservedElement): RecordedElement {
  return {
    role: el.role,
    name: el.name,
    framePath: el.framePath,
    ...(el.label !== undefined ? { label: el.label } : {}),
    ...(el.nearText !== undefined ? { nearText: el.nearText } : {}),
    ...(el.colHeader !== undefined ? { colHeader: el.colHeader } : {}),
    ...(el.bboxPct !== undefined ? { bboxPct: el.bboxPct } : {}),
  };
}

export class Recorder {
  private trace: DiscoveryTrace;
  private currentProbeCode: string | undefined;
  private seq = 0;

  constructor(goal: string) {
    this.trace = { goal, actions: [], outcomes: [] };
  }

  beginProbe(outcomeCode: string): void {
    this.currentProbeCode = outcomeCode;
  }

  record(action: Omit<RecordedAction, 'seq' | 'probe' | 'probeCode'>): void {
    this.seq += 1;
    this.trace.actions.push({
      ...action,
      seq: this.seq,
      probe: this.currentProbeCode !== undefined,
      ...(this.currentProbeCode !== undefined ? { probeCode: this.currentProbeCode } : {}),
    });
  }

  /** Retract the last N recorded actions — trailing actions regardless of
   * probe state (the model's "my last actions were wrong" applies to
   * whatever it just did, probe or spine). */
  retract(n: number): number {
    const dropped = Math.min(n, this.trace.actions.length);
    this.trace.actions.splice(this.trace.actions.length - dropped, dropped);
    return dropped;
  }

  declareOutcome(outcome: DeclaredOutcome): void {
    this.trace.outcomes.push(outcome);
    this.currentProbeCode = undefined; // declaring the outcome ends the probe
  }

  finish(done: { capabilityId: string; title: string; description: string }): void {
    this.trace.done = done;
  }

  giveUp(reason: string): void {
    this.trace.gaveUp = { reason };
  }

  get(): DiscoveryTrace {
    return this.trace;
  }
}
