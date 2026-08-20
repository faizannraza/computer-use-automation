/**
 * The compiler: recorded trace → capability artifact. Deterministic code,
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
import type { DiscoveryTrace, MarkerInfo, RecordedAction, RecordedElement, StateDigest } from './recorder.js';

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
  /**
   * Where this run's evidence was actually written, so `provenance.evidenceRef`
   * points at it. Hardcoding `evidence/` produced artifacts whose provenance
   * link resolved nowhere the moment a run used `--evidence-dir` — which the
   * MERIDIAN runs all did. A provenance pointer that does not resolve is worse
   * than none, because it reads as an audit trail and is not one.
   */
  evidenceBaseDir?: string;
  /**
   * The operator role this flow was recorded as, when it was not the app's
   * default. MERIDIAN gates Place Account Hold behind a supervisor, and a
   * capability that only works as a supervisor should SAY so — otherwise the
   * catalog advertises an action that escalates for most callers, and the API
   * has no declared requirement to enforce. Recorded, never inferred: the role
   * is a fact about how the run happened.
   */
  requiresRole?: string;
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
  // Boundaries are non-alphanumerics — but never the inside of a decimal:
  // "100" must not substitute into "100.00" or "3,100" (the lookarounds
  // reject a digit across a '.' or ',' on either side).
  const substituteValue = (s: string, name: string, value: string, where: string): string => {
    const re = new RegExp(`(^|[^A-Za-z0-9])(?<![0-9][.,])${escapeRe(value)}(?=$|[^A-Za-z0-9])(?![.,][0-9])`, 'g');
    if (!re.test(s)) return s;
    re.lastIndex = 0;
    report.parameterizations.push(`${where}: "${value}" → {${name}}`);
    return s.replace(re, (_m, pre: string) => `${pre}{${name}}`);
  };
  const paramize = (s: string, where: string): string =>
    paramEntries.reduce((out, [name, value]) => substituteValue(out, name, value, where), s);
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
    if (action.approvedIntervention !== undefined) {
      report.notes.push(
        `${id}: irreversible action was human-approved during discovery (intervention ${action.approvedIntervention}) — replay will escalate it the same way under the default policy`,
      );
      if ((action.humanActionsDuringApproval ?? 0) > 0) {
        report.notes.push(
          `${id}: the operator also performed ${action.humanActionsDuringApproval} action(s) on the live session during that approval — the recorded before→after transition was not made by the automation alone; review the run's human_action events before approving this artifact`,
        );
      }
    }
  }
  for (const declined of trace.declinedInterventions ?? []) {
    report.notes.push(
      `intervention ${declined.id}: an irreversible action ("${declined.intent}") was DECLINED by the operator and is absent from the spine — the recorded flow may be partial; review before approval`,
    );
  }

  /** Innermost named frame the action's element lived in (undefined = main frame / navigate). */
  function actionFrameOf(action: RecordedAction): string | undefined {
    return action.element?.framePath[action.element.framePath.length - 1]?.name;
  }

  /**
   * Rank checkpoint-marker candidates by specificity: markers in the same
   * frame the action happened in first, then LONGEST text first. (An earlier
   * version preferred the shortest markers — exactly backwards: short markers
   * like "Home" are the least specific text on a screen.)
   */
  function rankMarkers(markers: MarkerInfo[], actionFrame: string | undefined): MarkerInfo[] {
    return [...markers].sort((a, b) => {
      const aSame = a.frame === actionFrame ? 0 : 1;
      const bSame = b.frame === actionFrame ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      return b.text.length - a.text.length || a.text.localeCompare(b.text);
    });
  }

  /** A mined marker becomes a textPresent scoped to the frame it was seen in. */
  function markerCondition(m: MarkerInfo, where: string): Condition {
    return {
      c: 'textPresent',
      pattern: paramize(m.text, where),
      ...(m.frame !== undefined ? { frame: { name: m.frame } } : {}),
    };
  }

  function buildStep(id: string, action: RecordedAction, isFirst: boolean): Step {
    const pre: Condition[] =
      isFirst && action.before.markers.length > 0
        ? [markerCondition(rankMarkers(action.before.markers, actionFrameOf(action))[0]!, `${id}.pre`)]
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
      case 'choose': {
        // Prefer the option's VALUE when a caller param matches one: legacy
        // labels embed balances and descriptions that change between runs,
        // while the value attribute is the record's stable identifier. This is
        // decided from recorded evidence, not guessed.
        // Resolve what was actually chosen to its underlying value, then bind
        // the param that equals it. Matching against *any* offered value would
        // bind every choose step to whichever param happened to come first.
        const labels = action.element?.options ?? [];
        const values = action.element?.optionValues ?? [];
        const chosen = action.option !== undefined && 'literal' in action.option ? action.option.literal : undefined;
        let chosenValue: string | undefined;
        if (chosen !== undefined) {
          if (values.includes(chosen)) chosenValue = chosen;
          else {
            const at = labels.indexOf(chosen);
            if (at >= 0) chosenValue = values[at];
          }
        }
        const byValue = chosenValue !== undefined ? paramEntries.find(([, value]) => value === chosenValue) : undefined;
        if (byValue) {
          report.notes.push(
            `${id}: option bound to {${byValue[0]}} and matched by VALUE — the visible label carries live data and would not survive a balance change`,
          );
          return {
            ...base,
            action: {
              kind: 'choose',
              target: buildTarget(id, action.element!, action),
              option: { param: byValue[0] },
              by: 'value',
            },
          };
        }
        return {
          ...base,
          action: {
            kind: 'choose',
            target: buildTarget(id, action.element!, action),
            option: bindingFor(action.option!, `${id}.option`),
            ...(action.optionBy === 'value' ? { by: 'value' as const } : {}),
          },
        };
      }
      case 'read':
        return {
          ...base,
          action: { kind: 'read', target: buildTarget(id, action.element!, action), into: action.outputName! },
        };
      case 'readTable':
        // Addressed by column header over a region, so there is no target to
        // build. The headers survive verbatim: they are page chrome, not
        // recorded entity data, so parameterizing them would only break them.
        return {
          ...base,
          action: { kind: 'readTable', columns: action.columns!, into: action.outputName! },
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
   * column headers) present after the action and absent before, ranked by
   * specificity (same frame as the action, then longest text) and scoped to
   * the frame they were observed in. Falls back to the canonicalized URL
   * when a screen transition left no new markers. Weak choices are LINTED
   * into the compile report so a reviewer sees them at approval time, not
   * in production.
   */
  function postConditionsFor(id: string, action: RecordedAction): Condition[] {
    if (action.kind !== 'activate' && action.kind !== 'navigate') return [];
    // Freshness is per (frame, text) for frame-tagged markers: the same text
    // pre-existing in the nav chrome must not disqualify a marker that newly
    // appeared in the work frame — the emitted condition is scoped to that
    // frame, so asserting it is precise. Untagged markers keep the stricter
    // text-anywhere rule, because their condition would be unscoped.
    const beforeTexts = new Set(action.before.markers.map((m) => m.text));
    const beforeFramed = new Set(action.before.markers.map((m) => `${m.frame ?? ''}\u0000${m.text}`));
    const actionFrame = actionFrameOf(action);
    const chosen = rankMarkers(
      action.after.markers.filter((m) =>
        m.frame !== undefined ? !beforeFramed.has(`${m.frame}\u0000${m.text}`) : !beforeTexts.has(m.text),
      ),
      actionFrame,
    ).slice(0, 2);
    if (chosen.length === 0) {
      report.notes.push(`${id}: no new markers after action — using urlMatches checkpoint`);
      return [{ c: 'urlMatches', pattern: canonicalUrl(action.after.location, `${id}.post`) }];
    }
    if (actionFrame !== undefined && chosen.every((m) => m.frame !== actionFrame)) {
      report.notes.push(
        `${id}: checkpoint may be non-specific — no new marker appeared in the action's frame ('${actionFrame}'); asserting markers from other frames`,
      );
    }
    for (const m of chosen) {
      if (m.frame === undefined && m.text.length < 8) {
        report.notes.push(
          `${id}: checkpoint may be non-specific — unscoped short marker ${JSON.stringify(m.text)}; review before approval`,
        );
      }
    }
    return chosen.map((m) => markerCondition(m, `${id}.post`));
  }

  function buildTarget(id: string, el: RecordedElement, action: RecordedAction): TargetRef {
    const strategies: Locator[] = [];
    const name = paramize(el.name, `${id}.target.name`);
    if ((el.role === 'cell' || el.role === 'rowheader') && el.colHeader !== undefined) {
      // Table extraction: never key on the cell's own text (it IS the data);
      // key on a stable row anchor × the column header.
      strategies.push({
        s: 'tableCell',
        rowAnchor: rowAnchorFor(el, `${id}.target.rowAnchor`),
        columnHeader: el.colHeader,
      });
    } else if (el.label !== undefined && el.label !== '') {
      // Anything carrying a label — a form control, or a value cell named by
      // its label cell — is addressed by that label first. For a read step
      // this is what keeps the locator off the value being read.
      strategies.push({ s: 'labelText', label: el.label });
      if (action.kind !== 'read') {
        strategies.push({ s: 'roleName', role: el.role, name, nameMatch: 'exact' });
      }
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

  /**
   * Pick the row anchor for a table-cell target. Anchors taken from a whole
   * recorded cell are emitted as `match: 'exact'` — a substring anchor matches
   * any row merely containing it, which collides when one row's id contains
   * another's (live example: share `100234-S0001-3` vs `100234-S0001`).
   */
  function rowAnchorFor(el: RecordedElement, where: string): { text: string; match?: 'exact' } {
    const tokens = (el.nearText ?? '').split(' | ').map((t) => t.trim()).filter((t) => t && t !== el.name);
    if (tokens.length === 0) return { text: paramize(el.name, where) };
    const paramized = tokens.map((t) => paramize(t, where));
    const chosen = paramized.find((t) => /\{[a-zA-Z]/.test(t)) ?? paramized[0]!;
    return { text: chosen, match: 'exact' };
  }

  // ---- outcomes: grounded in probe evidence, attached to the step whose
  // control triggered them (matched by role+name of the probe's activator) ----

  // Probe stand-ins: the literal a probe typed into a field that takes a
  // {param} binding in the spine is that param's stand-in (searching 99999 to
  // probe MEMBER_NOT_FOUND makes 99999 the stand-in for {memberId}). A marker
  // that echoes the probe entity ("Member 99999 was not found") would pin the
  // detector to the recorded entity forever — so stand-ins are substituted
  // with the same token-bounded matching, and the report flags it: templating
  // a detector is a riskier decision than templating a locator, and a
  // reviewer must see it before approval.
  const fieldKey = (el: RecordedElement): string =>
    `${el.role}|${el.label ?? el.name}|${el.framePath[el.framePath.length - 1]?.name ?? ''}`;
  const spineParamFields = new Map<string, string>();
  for (const a of spine) {
    if (a.kind !== 'setValue' || a.value === undefined || a.element === undefined) continue;
    const param =
      'param' in a.value ? a.value.param : paramEntries.find(([, v]) => v === (a.value as { literal: string }).literal)?.[0];
    if (param !== undefined) spineParamFields.set(fieldKey(a.element), param);
  }
  const probeStandIns = new Map<string, [name: string, value: string][]>();
  for (const a of trace.actions) {
    if (!a.probe || a.probeCode === undefined || a.kind !== 'setValue') continue;
    if (a.value === undefined || !('literal' in a.value) || a.value.literal.length < 3 || a.element === undefined) continue;
    const param = spineParamFields.get(fieldKey(a.element));
    if (param === undefined) continue;
    const list = probeStandIns.get(a.probeCode) ?? [];
    list.push([param, a.value.literal]);
    probeStandIns.set(a.probeCode, list);
  }

  const outcomes: OutcomeSpec[] = trace.outcomes.map((o) => {
    let pattern = paramize(o.marker, `outcome.${o.code}.marker`);
    for (const [name, value] of probeStandIns.get(o.code) ?? []) {
      pattern = substituteValue(pattern, name, value, `outcome.${o.code}.marker`);
    }
    if (pattern !== o.marker) {
      report.notes.push(
        `outcome ${o.code}: marker was parameterized ("${o.marker}" → "${pattern}") — a templated detector matches more than the recorded text; review before approval`,
      );
    }
    return {
      code: o.code,
      description: o.description,
      when: { c: 'textPresent', pattern },
      terminal: true as const,
      outputs: {},
    };
  });
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
  // Every extracting action declares its output — a step that reads into an
  // undeclared output is a schema error, so missing a kind here would fail
  // compilation rather than ship a capability that silently returns nothing.
  for (const action of spine.filter((a) => a.kind === 'read' || a.kind === 'readTable')) {
    const hint = inputs.outputHints[action.outputName!] ?? {};
    // A readTable output is a table STRUCTURALLY, so the action's kind wins
    // over the hint rather than the other way round: a hint may name an
    // output's sensitivity, never contradict its shape. (`OutputHint.type`
    // cannot even express 'table'.) Getting this backwards ships a table
    // declared `string`, which reads fine on disk and then silently skips
    // both the per-cell redaction registration and the parse at the API
    // edge — the caller gets a JSON blob where the contract promised rows.
    const isTable = action.kind === 'readTable';
    if (isTable && hint.type) {
      report.notes.push(
        `output ${action.outputName}: ignored --output type '${hint.type}'; a read_table output is always a table`,
      );
    }
    outputs[action.outputName!] = {
      // Inferring a type from a table's serialized JSON would only ever
      // classify the whole table as one string.
      type: isTable ? 'table' : (hint.type ?? inferType(action.readValue ?? '')),
      description: action.intent,
      sensitivity: hint.sensitivity ?? 'none',
      source: { stepId: stepForAction.get(action.seq)!, transform: 'trim' },
    };
  }

  // ---- success criteria: the final observed state of the spine, most
  // specific markers first, scoped to the frames they were seen in ----
  const lastAction = spine[spine.length - 1]!;
  const lastDigest: StateDigest = lastAction.after;
  const successCriteria: Condition[] = rankMarkers(lastDigest.markers, actionFrameOf(lastAction))
    .slice(0, 3)
    .map((m): Condition => markerCondition(m, 'successCriteria'));

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
      evidenceRef: `${inputs.evidenceBaseDir ?? 'evidence'}/discovery/${inputs.discoveryRunId}`,
      approval: { state: 'draft' as const },
    },
    params: inputs.paramSpecs,
    outputs,
    outcomes,
    recoveries: [],
    anomalies: [],
    policy: {
      // The entrypoint navigation is implicit in every capability — declare
      // it so the self-declaration is complete even when no step navigates.
      actionsUsed: [...new Set(['navigate' as const, ...spine.slice(1).map((a) => a.kind)])],
      ...(inputs.requiresRole !== undefined ? { requiresRole: inputs.requiresRole } : {}),
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
  // Lint: a locator strategy that anchors on REDACTED text is dead weight.
  // Redaction runs at the recording boundary, so if a caller param or a
  // classified field appeared in the neighbour text the compiler mined, what
  // survives into the artifact is a mask — and a mask never matches a live
  // page, so that rung silently falls through on every replay. Say so, rather
  // than shipping a locator that looks robust and is not.
  for (const step of steps) {
    const target = 'target' in step.action ? step.action.target : undefined;
    if (!target) continue;
    target.strategies.forEach((strategy, i) => {
      const text = 'text' in strategy ? strategy.text : undefined;
      if (typeof text === 'string' && /\*\*\*|«secret:/.test(text)) {
        report.notes.push(
          `${step.id}: strategy ${i} (${strategy.s}) anchors on redacted text and can never match at replay — it will always fall through to the next rung`,
        );
      }
    });
  }

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
