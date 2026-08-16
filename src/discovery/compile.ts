/**
 * The compiler: recorded trace → capability artifact. DETERMINISTIC CODE,
 * no LLM anywhere — the model contributed action intents and the capability
 * identity (prose), but everything executable in the artifact is derived
 * mechanically from recorded evidence:
 *
 *  - prune:        probe actions (exceptional-state exploration) and
 *                  retracted actions never enter the step spine
 *  - parameterize: recorded literals, URL segments, and locator anchors that
 *                  exactly match a declared caller-param value become
 *                  {param} bindings / {placeholder} templates — value
 *                  matching only, no judgment calls
 *  - canonicalize: the recorded origin becomes {baseUrl}; checkpoints are
 *                  mined from observed state deltas (markers that appeared
 *                  after an action and were absent before)
 *
 * The result must round-trip through CapabilityArtifactSchema — a compiled
 * artifact is schema-legal or compilation fails.
 */
import type { CapabilityArtifact, OutcomeSpec, ParamSpec, Sensitivity, Step } from '../schema/capability.js';
import { CapabilityArtifactSchema, computeContentHash } from '../schema/capability.js';
import type { Condition } from '../schema/conditions.js';
import type { Locator, TargetRef } from '../schema/locators.js';
import type { DiscoveryTrace, RecordedAction, RecordedElement, StateDigest } from './recorder.js';

export interface OutputHint {
  type?: 'string' | 'integer' | 'money';
  sensitivity?: Sensitivity;
}

export interface CompileInputs {
  trace: DiscoveryTrace;
  /** Full param specs (the capability's declared contract inputs). */
  paramSpecs: Record<string, ParamSpec>;
  /** Values of caller-sourced params only — the value-matching domain. */
  callerParamValues: Record<string, string>;
  outputHints: Record<string, OutputHint>;
  baseUrl: string;
  model: string;
  discoveryRunId: string;
  app: { appId: string; vendor: string };
  version: string;
}

export interface CompileReport {
  spineActions: number;
  prunedProbeActions: number;
  parameterizations: string[];
  outcomeAttachments: { code: string; stepId: string }[];
  notes: string[];
}

export function compileTrace(inputs: CompileInputs): { artifact: CapabilityArtifact; report: CompileReport } {
  const { trace } = inputs;
  if (!trace.done) throw new Error('cannot compile: the discovery run did not declare_done');
  const report: CompileReport = {
    spineActions: 0,
    prunedProbeActions: trace.actions.filter((a) => a.probe).length,
    parameterizations: [],
    outcomeAttachments: [],
    notes: [],
  };

  // ---- parameterization helpers (value matching, nothing cleverer) ----
  // Matching is TOKEN-BOUNDED: a param value only substitutes where it is
  // delimited by non-alphanumerics or string edges, so memberId "123" can
  // never corrupt "S1234" or an unrelated amount.
  const paramEntries = Object.entries(inputs.callerParamValues).filter(([, v]) => v.length >= 3);
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paramize = (s: string, where: string): string => {
    let out = s;
    for (const [name, value] of paramEntries) {
      const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(value)}(?=$|[^A-Za-z0-9])`, 'g');
      if (re.test(out)) {
        re.lastIndex = 0;
        out = out.replace(re, (_m, pre: string) => `${pre}{${name}}`);
        report.parameterizations.push(`${where}: "${value}" → {${name}}`);
      }
    }
    return out;
  };
  const canonicalUrl = (url: string, where: string): string => {
    let out = url.startsWith(inputs.baseUrl) ? '{baseUrl}' + url.slice(inputs.baseUrl.length) : url;
    if (out === '{baseUrl}') out = '{baseUrl}/';
    return paramize(out, where);
  };

  const spine = trace.actions.filter((a) => !a.probe);
  report.spineActions = spine.length;
  if (spine.length === 0) throw new Error('cannot compile: empty step spine');
  if (spine[0]!.kind !== 'navigate') throw new Error('cannot compile: the run must start with a navigation (entrypoint)');
  const entrypointUrl = canonicalUrl(spine[0]!.url!, 'entrypoint');

  // ---- steps ----
  // answerDialog actions are runtime evidence, not replayable steps: known
  // dialogs belong in the artifact's recoveries (a reviewed decision), not
  // silently baked into the spine.
  const steps: Step[] = [];
  const stepForAction = new Map<number, string>(); // action seq → step id
  let stepNo = 0;
  for (const action of spine.slice(1)) {
    if (action.kind === 'answerDialog') {
      report.notes.push(
        `dialog answered during discovery ("${action.intent}") — excluded from the spine; declare a recovery for it after review`,
      );
      continue;
    }
    stepNo += 1;
    const id = `s${stepNo}`;
    stepForAction.set(action.seq, id);
    steps.push(buildStep(id, action, stepNo === 1));
  }

  function buildStep(id: string, action: RecordedAction, isFirst: boolean): Step {
    const pre: Condition[] =
      isFirst && action.before.markers.length > 0
        ? [{ c: 'textPresent', pattern: paramize(action.before.markers[0]!, `${id}.pre`) }]
        : [];
    const post = postConditionsFor(id, action);
    const base = {
      id,
      intent: action.intent,
      pre,
      post,
      wait: { timeoutMs: 8000, pollMs: 250 },
      risk: action.risk,
      onDetect: [] as string[],
    };
    switch (action.kind) {
      case 'navigate':
        return { ...base, action: { kind: 'navigate', url: canonicalUrl(action.url!, `${id}.url`) } };
      case 'activate':
        return { ...base, action: { kind: 'activate', target: buildTarget(id, action.element!, action) } };
      case 'setValue':
        return {
          ...base,
          action: { kind: 'setValue', target: buildTarget(id, action.element!, action), value: bindingFor(action.value!, `${id}.value`) },
        };
      case 'choose':
        return {
          ...base,
          action: { kind: 'choose', target: buildTarget(id, action.element!, action), option: bindingFor(action.option!, `${id}.option`) },
        };
      case 'read':
        return {
          ...base,
          action: { kind: 'read', target: buildTarget(id, action.element!, action), into: action.outputName! },
        };
      case 'answerDialog':
        throw new Error('answerDialog steps are not compiled into the spine (declare a recovery instead)');
    }
  }

  function bindingFor(v: { literal: string } | { param: string }, where: string): { literal: string } | { param: string } {
    if ('param' in v) return v;
    // A literal that exactly equals a caller-param value becomes a {param}
    // binding; partial matches become templated literals.
    for (const [name, value] of paramEntries) {
      if (v.literal === value) {
        report.parameterizations.push(`${where}: literal → {param:${name}}`);
        return { param: name };
      }
    }
    return { literal: paramize(v.literal, where) };
  }

  /**
   * Checkpoints are mined from the observed delta: markers (headings, row/
   * column headers) present after the action and absent before. Falls back
   * to the canonicalized URL when a screen transition left no new markers.
   */
  function postConditionsFor(id: string, action: RecordedAction): Condition[] {
    if (action.kind !== 'activate' && action.kind !== 'navigate') return [];
    const fresh = action.after.markers
      .filter((m) => !action.before.markers.includes(m))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, 2)
      .map((m): Condition => ({ c: 'textPresent', pattern: paramize(m, `${id}.post`) }));
    if (fresh.length > 0) return fresh;
    report.notes.push(`${id}: no new markers after action — using urlMatches checkpoint`);
    return [{ c: 'urlMatches', pattern: canonicalUrl(action.after.location, `${id}.post`) }];
  }

  function buildTarget(id: string, el: RecordedElement, action: RecordedAction): TargetRef {
    const strategies: Locator[] = [];
    const name = paramize(el.name, `${id}.target.name`);
    if ((el.role === 'cell' || el.role === 'rowheader') && el.colHeader !== undefined) {
      // Table extraction: never key on the cell's own text (it IS the data);
      // key on a stable row anchor × the column header.
      strategies.push({
        s: 'tableCell',
        rowAnchor: { text: rowAnchorFor(el, `${id}.target.rowAnchor`) },
        columnHeader: el.colHeader,
      });
    } else if ((el.role === 'textbox' || el.role === 'combobox') && el.label !== undefined) {
      strategies.push({ s: 'labelText', label: el.label });
      strategies.push({ s: 'roleName', role: el.role, name, nameMatch: 'exact' });
    } else {
      strategies.push({ s: 'roleName', role: el.role, name, nameMatch: 'exact' });
      // A row-anchored fallback only when the anchor is parameterized —
      // recorded neighbor data (names, dates) would pin the locator to the
      // recorded entity and break replay with other params.
      if (el.nearText !== undefined) {
        const anchored = paramize(el.nearText, `${id}.target.near`);
        const anchorToken = anchored.split(' | ').find((t) => /\{[a-zA-Z]/.test(t));
        if (anchorToken !== undefined) {
          strategies.push({ s: 'textAnchor', text: anchorToken, relation: 'rowOf', targetRole: el.role });
        }
      }
    }
    return {
      framePath: el.framePath.map((f) => (f.name !== undefined ? { name: f.name } : { urlPattern: canonicalUrl(f.url, `${id}.frame`) })),
      strategies,
      disambiguation: { requireUnique: true, minScore: 0.6 },
      snapshot: {
        textContext: scrubSnapshotContext(el, strategies, `${id}.snapshot`),
        ...(el.bboxPct !== undefined ? { bboxPct: el.bboxPct } : {}),
        ...(action.screenshotRef !== undefined ? { screenshotRef: action.screenshotRef } : {}),
      },
    };
  }

  /**
   * Snapshot context is review/drift evidence — but recorded row text can
   * contain real entity data (names, dates, balances), and raw sensitive
   * data must never persist into artifacts. Keep only load-bearing tokens
   * (param placeholders and tokens the strategies actually anchor on); mask
   * the rest, preserving the row shape for reviewers.
   */
  function scrubSnapshotContext(el: RecordedElement, strategies: Locator[], where: string): string {
    const anchors = new Set<string>();
    for (const s of strategies) {
      if (s.s === 'roleName') anchors.add(s.name);
      if (s.s === 'labelText') anchors.add(s.label);
      if (s.s === 'textAnchor') anchors.add(s.text);
      if (s.s === 'tableCell') {
        anchors.add(s.rowAnchor.text);
        anchors.add(s.columnHeader);
      }
    }
    const raw = el.nearText ?? el.label ?? el.name;
    const tokens = paramize(raw, where).split(' | ');
    return tokens.map((t) => (/\{[a-zA-Z]/.test(t) || anchors.has(t) ? t : '…')).join(' | ');
  }

  function rowAnchorFor(el: RecordedElement, where: string): string {
    const tokens = (el.nearText ?? '').split(' | ').map((t) => t.trim()).filter((t) => t && t !== el.name);
    if (tokens.length === 0) return paramize(el.name, where);
    const paramized = tokens.map((t) => paramize(t, where));
    return paramized.find((t) => /\{[a-zA-Z]/.test(t)) ?? paramized[0]!;
  }

  // ---- outcomes: grounded in probe evidence, attached to the step whose
  // control triggered them (matched by role+name of the probe's activator) ----
  const outcomes: OutcomeSpec[] = trace.outcomes.map((o) => ({
    code: o.code,
    description: o.description,
    when: { c: 'textPresent', pattern: o.marker },
    terminal: true as const,
    outputs: {},
  }));
  for (const declared of trace.outcomes) {
    // Attach each outcome via ITS OWN probe segment (matched by probeCode) —
    // multiple probes in one run each ground their own detector.
    const probeTrigger = [...trace.actions]
      .reverse()
      .find((a) => a.probe && a.probeCode === declared.code && a.kind === 'activate' && a.element !== undefined);
    let attached: Step | undefined;
    if (probeTrigger) {
      const stepId = [...stepForAction.entries()].find(([seq]) => {
        const sp = spine.find((a) => a.seq === seq);
        return (
          sp?.kind === 'activate' &&
          sp.element?.role === probeTrigger.element!.role &&
          sp.element?.name === probeTrigger.element!.name
        );
      })?.[1];
      attached = steps.find((s) => s.id === stepId);
    }
    attached ??= [...steps].reverse().find((s) => s.action.kind === 'activate');
    if (attached) {
      attached.onDetect.push(declared.code);
      report.outcomeAttachments.push({ code: declared.code, stepId: attached.id });
    } else {
      report.notes.push(`outcome ${declared.code} could not be attached to a step`);
    }
  }

  // ---- outputs ----
  const outputs: CapabilityArtifact['outputs'] = {};
  for (const action of spine.filter((a) => a.kind === 'read')) {
    const hint = inputs.outputHints[action.outputName!] ?? {};
    outputs[action.outputName!] = {
      type: hint.type ?? inferType(action.readValue ?? ''),
      description: action.intent,
      sensitivity: hint.sensitivity ?? 'none',
      source: { stepId: stepForAction.get(action.seq)!, transform: 'trim' },
    };
  }

  // ---- success criteria: the final observed state of the spine ----
  const lastDigest: StateDigest = spine[spine.length - 1]!.after;
  const successCriteria: Condition[] = lastDigest.markers
    .slice(0, 3)
    .map((m): Condition => ({ c: 'textPresent', pattern: paramize(m, 'successCriteria') }));

  const artifactRaw = {
    schemaVersion: '1' as const,
    capability: {
      id: trace.done.capabilityId,
      version: inputs.version,
      title: trace.done.title,
      description: trace.done.description,
      app: inputs.app,
      surface: 'web' as const,
      entrypoint: { kind: 'url' as const, value: entrypointUrl },
    },
    provenance: {
      recordedAt: new Date().toISOString(),
      recordedBy: { kind: 'llm-discovery' as const, model: inputs.model, discoveryRunId: inputs.discoveryRunId },
      evidenceRef: `evidence/discovery/${inputs.discoveryRunId}`,
      approval: { state: 'draft' as const },
    },
    params: inputs.paramSpecs,
    outputs,
    outcomes,
    recoveries: [],
    anomalies: [],
    policy: {
      actionsUsed: [...new Set(spine.slice(1).map((a) => a.kind))],
      maxRisk: spine.some((a) => a.risk === 'irreversible')
        ? ('irreversible' as const)
        : spine.some((a) => a.risk === 'reversible')
          ? ('reversible' as const)
          : ('read' as const),
    },
    steps,
    successCriteria,
    integrity: { contentHash: 'PENDING' },
  };
  artifactRaw.integrity.contentHash = computeContentHash(artifactRaw);
  // Round-trip: a compiled artifact is schema-legal or compilation fails.
  const artifact = CapabilityArtifactSchema.parse(artifactRaw);
  return { artifact, report };
}

function inferType(value: string): 'string' | 'integer' | 'money' {
  if (/^\$?[\d,]+\.\d{2}$/.test(value.trim())) return 'money';
  if (/^\d+$/.test(value.trim())) return 'integer';
  return 'string';
}
