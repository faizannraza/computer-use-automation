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
import type { AppProfile } from '../profile/appProfile.js';
import type { DiscoveryTrace, MarkerInfo, RecordedAction, RecordedElement, StateDigest } from './recorder.js';

export interface OutputHint {
  type?: 'string' | 'integer' | 'money';
  sensitivity?: Sensitivity;
}

/**
 * The placeholder description a caller param starts life with, before the
 * compiler has seen which on-screen field it binds to. It lives here rather
 * than in the CLI that writes it because the compiler has to RECOGNISE it: a
 * description that is still this string is one nobody has authored, and is
 * therefore safe to replace with something the recording actually knows. A
 * human-written description always wins — the compiler improves on silence,
 * it does not overrule an author.
 */
/**
 * Model-authored prose, made readable again after redaction.
 *
 * Intents, titles and descriptions are written by the model and pass through
 * the redactor on their way into the trace — so a secret whose VALUE happens to
 * be an ordinary English word rewrites the prose that merely mentions the word.
 * MERIDIAN's credential field is labelled "Password:", the demo operator's
 * password IS the word `password`, and the model dutifully wrote "Enter
 * operator password." — which reached the artifact as
 * "Enter operator «secret:operatorPassword»." That is not a leak; it is a false
 * positive, and it is the FIRST line a reviewer reads on every step list.
 *
 * The mask is rewritten to the artifact's own placeholder syntax, `{param}`,
 * which is what the token actually means: "the value of this declared param
 * stood here". Nothing is recovered and nothing is guessed — a mask cannot be
 * un-redacted — the reference is simply spelled in the notation the rest of the
 * artifact already uses. Applied to prose only; conditions and locators keep
 * their masks, and the schema refuses to load an artifact whose DETECTOR
 * matches on redacted text, because there the mask is a genuine defect.
 */
export function readableProse(text: string): string {
  return (
    text
      .replace(/«secret:([a-zA-Z][a-zA-Z0-9_]*)»/g, '{$1}')
      // Recording-session provenance, stripped. The model is told during
      // discovery that a human pre-authorised the posting steps, and it
      // helpfully repeats that in the step's intent — so the artifact ends up
      // describing the SESSION THAT CAPTURED IT rather than the step. That is
      // wrong on its own terms, and actively misleading where the intent is
      // displayed: on the approval card, above the button, an operator being
      // asked to sign off reads "(pre-authorised for recording)". Whether a
      // recording was pre-authorised is a fact about that run, and it is
      // already recorded where it belongs — the intervention_resolved event in
      // the run log, with the authoriser's name. Narrow on purpose: only a
      // parenthetical, only one that names pre-authorisation or recording.
      .replace(/\s*\((?=[^)]*(?:pre-authoris|pre-authoriz|for recording))[^)]*\)/gi, '')
      .replace(/\s+([.,;:])/g, '$1')
      .trim()
  );
}

export function genericCallerParamDescription(name: string): string {
  return `Caller-supplied parameter '${name}'.`;
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
  /**
   * The target application's profile, when the run had one. The compiler reads
   * exactly one thing from it — `transactionToken.fieldName` — to decide
   * whether a posting step should assert the app's per-transaction token (see
   * the transaction-token block below). Optional: without a profile the
   * compiler behaves exactly as it did before, which is what keeps every
   * profile-less trace (MockCore, the unit fixtures) compiling unchanged.
   */
  profile?: AppProfile;
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
  //
  // LONGEST VALUE FIRST — this ordering is load-bearing, not tidiness.
  // Substitution is a reduce over these entries, so the FIRST param whose
  // value matches wins the span and every later param sees a string that no
  // longer contains it. Token boundaries do not save you when one param's
  // value is a PREFIX of another's ending at a boundary character: with
  // memberId=101555 and fromShare=101555-S0001, "101555" is delimited by the
  // '-', so in declaration order memberId consumed it and the receipt marker
  // "101555-S0001:" compiled to "{memberId}-S0001:" — half a placeholder and
  // half a hardcoded share from the recording session.
  //
  // That is not a cosmetic defect. It shipped a member.transferFunds whose
  // final postcondition could only match the shares it was recorded with, so
  // a transfer between any other pair POSTED and then reported
  // POSTCONDITION_TIMEOUT — the caller told the money did not move while it
  // had. Longest-first makes the most specific value claim its span before a
  // shorter one can, which is the substitution-order rule EVERY templating
  // pass needs; all of paramize's consumers (locator anchors, row anchors,
  // snapshot context, canonicalUrl, outcome markers) inherit the fix here.
  //
  // Equal-length values cannot be prefixes of one another, so their relative
  // order is irrelevant to this bug; the sort is stable, so they keep
  // declaration order and compilation stays deterministic.
  const paramEntries = Object.entries(inputs.callerParamValues)
    .filter(([, v]) => v.length >= 3)
    .sort(([, a], [, b]) => b.length - a.length);
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

  // ---- per-transaction token assertion ----
  /**
   * Legacy cores carry a per-transaction token in a hidden field on their
   * transactional forms (MERIDIAN: `<input type="hidden" name="_token">`).
   * Driving the real UI submits it for free — the browser posts the form the
   * operator sees — so there is nothing to read, store or reconstruct. What a
   * capability CAN do is ASSERT one is there before it posts, so a form served
   * without a token fails as a named PRECONDITION_FAILED on the step that
   * would have posted, instead of posting something the core rejects one screen
   * later, where the failure is a generic error page and the diagnosis a guess.
   *
   * WHICH STEPS GET IT — two conditions, both required:
   *
   *  1. The step ACTIVATES A `button`. A legacy screen posts by activating a
   *     submit control, and the walker maps `<button>` and `input[type=submit]`
   *     to role 'button'; navigation (Member Inquiry, Select, Funds Transfer)
   *     is a role 'link' GET, which carries no token and needs none. Typing and
   *     choosing steps are excluded too: they mutate the form locally and post
   *     nothing, so an assertion there would add a way to fail and no safety.
   *
   *  2. The token field was ACTUALLY OBSERVED in the state the step acts on
   *     (recorded in the before-digest by `digestOf`). This half is not
   *     belt-and-braces, it is the difference between a guard and an
   *     unrunnable capability: MERIDIAN's sign-on and member-search forms POST
   *     and carry NO `_token` — the token is on the transactional forms only.
   *     A flat "every posting step" rule would have pinned an unsatisfiable
   *     condition onto the Sign On and Search steps of all seven capabilities.
   *     So the compiler asserts only what the recording saw, exactly like every
   *     other condition it emits.
   *
   * What this does NOT cover: a form posted by a scripted `<a>` (observed as
   * role 'link', so no assertion); an `input[type=reset]`, which is role
   * 'button' and collects a harmless assertion it will always pass; and a
   * screen carrying TWO token fields, where `requireUnique` — the only
   * disambiguation mode the schema offers — makes the check report ambiguity
   * rather than pass. All three surface at review or on the first replay, which
   * is the direction an assertion is supposed to fail.
   */
  const tokenField = inputs.profile?.transactionToken?.fieldName;
  const tokenAsserted: string[] = [];
  const tokenSkipped: string[] = [];

  function transactionTokenPre(id: string, action: RecordedAction): Condition[] {
    if (tokenField === undefined) return [];
    if (action.kind !== 'activate' || action.element?.role !== 'button') return [];
    const seen = action.before.hiddenFields?.find((h) => h.name === tokenField);
    if (seen === undefined) {
      tokenSkipped.push(id);
      return [];
    }
    tokenAsserted.push(id);
    return [
      {
        c: 'elementPresent',
        target: {
          framePath: seen.frame !== undefined ? [{ name: seen.frame }] : [],
          strategies: [{ s: 'roleName', role: 'hidden', name: tokenField, nameMatch: 'exact' }],
          // Written out rather than left to the schema default, like every
          // other target this compiler builds: the artifact is hashed BEFORE
          // it is parsed, so a key Zod would materialise afterwards is a key
          // the stored hash does not cover and the artifact fails its own
          // integrity check on first load.
          disambiguation: { requireUnique: true, minScore: 0.6 },
        },
      },
    ];
  }

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
  // A locator rung pinned to data that only existed during the recording can
  // never match again. It is not fatal — the ladder falls through to the next
  // rung — which is exactly why it needs saying: the step keeps working while
  // silently losing its most robust strategy, and the strategy rank the console
  // reports for it is permanently one worse than the artifact claims to offer.
  //
  // The two carriers seen on this target are a clock and a session id, both in
  // MERIDIAN's status bar (`OPR TELLER1 | BR MAIN-001 | 08/20/2026 20:31:36 |
  // SID 7086C867`), which is a tempting anchor precisely because it is unique.
  for (const step of steps) {
    const strategies = 'target' in step.action ? (step.action.target?.strategies ?? []) : [];
    strategies.forEach((strategy, rung) => {
      const text = 'name' in strategy ? strategy.name : 'text' in strategy ? strategy.text : undefined;
      if (typeof text !== 'string') return;
      const volatile =
        /\b\d{1,2}\/\d{1,2}\/\d{4}\b/.test(text) || /\b\d{1,2}:\d{2}:\d{2}\b/.test(text) || /\bSID\s+[0-9A-F]{6,}\b/i.test(text);
      if (!volatile) return;
      report.notes.push(
        `${step.id}: locator rung ${rung} matches on ${JSON.stringify(text)}, which carries a timestamp or session id from the recording — it can never match again, so this step will always resolve at a lower rung; re-record or drop the rung`,
      );
    });
  }

  for (const declined of trace.declinedInterventions ?? []) {
    report.notes.push(
      `intervention ${declined.id}: an irreversible action ("${declined.intent}") was DECLINED by the operator and is absent from the spine — the recorded flow may be partial; review before approval`,
    );
  }
  // The token decision is REPORTED in full, both halves. "Which posting steps
  // did not get the assertion, and why" is the half a reviewer would otherwise
  // have to reconstruct by reading digests — and it is the half that says
  // whether the app really carries a token on every form or only on some.
  if (tokenField !== undefined) {
    if (tokenAsserted.length > 0) {
      report.notes.push(
        `transaction token '${tokenField}': asserted present before ${tokenAsserted.join(', ')} — the form-posting step(s) whose recorded state carried it`,
      );
    }
    if (tokenSkipped.length > 0) {
      report.notes.push(
        `transaction token '${tokenField}': NOT asserted before ${tokenSkipped.join(', ')} — no such hidden field was observed in the state those steps act on, so this app does not put a token on every form; asserting one there would fail every replay`,
      );
    }
    if (tokenAsserted.length === 0 && tokenSkipped.length === 0) {
      report.notes.push(
        `transaction token '${tokenField}': the profile declares one, but this flow activates no button that posts a form — nothing to assert it on`,
      );
    }
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
    const pre: Condition[] = [
      ...(isFirst && action.before.markers.length > 0
        ? [markerCondition(rankMarkers(action.before.markers, actionFrameOf(action))[0]!, `${id}.pre`)]
        : []),
      ...transactionTokenPre(id, action),
    ];
    const post = postConditionsFor(id, action);
    const base = {
      id,
      intent: readableProse(action.intent),
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
        const chosenValue = chosenOptionValue(action);
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

  /**
   * The UNDERLYING VALUE of the option a `choose` recorded — the model may have
   * named either the visible label or the value attribute, and `options` /
   * `optionValues` are index-aligned so a label maps back to its value.
   *
   * Shared by the step compiler and the param-description pass below on
   * purpose: two copies of "which param does this choose bind to?" is two
   * chances to describe a param as one field while binding it to another.
   */
  function chosenOptionValue(action: RecordedAction): string | undefined {
    const chosen = action.option !== undefined && 'literal' in action.option ? action.option.literal : undefined;
    if (chosen === undefined) return undefined;
    const values = action.element?.optionValues ?? [];
    if (values.includes(chosen)) return chosen;
    const at = (action.element?.options ?? []).indexOf(chosen);
    return at >= 0 ? values[at] : undefined;
  }

  /**
   * Which caller param a recorded input action binds to, by the SAME rules the
   * step compiler applies: an explicit {param}, or a literal/option value that
   * exactly equals a caller param's recorded value.
   */
  function paramBoundBy(action: RecordedAction): string | undefined {
    if (action.kind === 'setValue' && action.value !== undefined) {
      if ('param' in action.value) return action.value.param;
      const literal = action.value.literal;
      return paramEntries.find(([, v]) => v === literal)?.[0];
    }
    if (action.kind === 'choose' && action.option !== undefined) {
      if ('param' in action.option) return action.option.param;
      const value = chosenOptionValue(action);
      const byValue = value !== undefined ? paramEntries.find(([, v]) => v === value)?.[0] : undefined;
      if (byValue !== undefined) return byValue;
      return paramEntries.find(([, v]) => v === (action.option as { literal: string }).literal)?.[0];
    }
    return undefined;
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
    // Longest stand-in first, for exactly the reason paramEntries is sorted:
    // these are a second substitution pass over the same string, and a probe
    // value that is a prefix of another probe value would otherwise claim the
    // span and leave the longer one half-templated.
    for (const [name, value] of [...(probeStandIns.get(o.code) ?? [])].sort(([, a], [, b]) => b.length - a.length)) {
      pattern = substituteValue(pattern, name, value, `outcome.${o.code}.marker`);
    }
    if (pattern !== o.marker) {
      report.notes.push(
        `outcome ${o.code}: marker was parameterized ("${o.marker}" → "${pattern}") — a templated detector matches more than the recorded text; review before approval`,
      );
    }
    return {
      code: o.code,
      description: readableProse(o.description),
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

  // ---- caller-param descriptions, seeded from the field the param binds to ----
  /**
   * The catalog's entire claim is that an agent can invoke a capability BY NAME
   * WITHOUT KNOWING THE UI. `"Caller-supplied parameter 'searchBy'"` fails that
   * claim outright: it repeats the param's name back at a caller who already
   * had it. The compiler holds the missing half already — the recorded element
   * for the step a param binds to carries the field's on-screen LABEL, and for
   * a `choose` the options the screen offered — so the description is seeded
   * from the recording instead of from a template.
   *
   * The offered choices go in as PROSE, and DELIBERATELY NOT as `type: 'enum'`
   * with a `values` list. DO NOT "improve" this into an enum. The same code
   * path serves `searchBy` (offered number|name — a genuinely fixed domain) and
   * `fromShare`/`toShare`, whose offered values are ONE MEMBER'S share ids
   * (101555-S0001, 101555-CERT, …). Pinning those as the param's domain
   * compiles a capability that works for member 101555 and rejects every other
   * member, with a validation error on a perfectly legal call. Describing what
   * a recording observed is safe; constraining the contract to it is not, and
   * the compiler cannot tell the two cases apart from one recording.
   */
  const MAX_LISTED_OPTIONS = 12;
  const params: Record<string, ParamSpec> = {};
  for (const [name, spec] of Object.entries(inputs.paramSpecs)) {
    // Env params carry their own (accurate) description, and a description a
    // human wrote outranks anything mined from a screen — only the untouched
    // placeholder is replaced.
    const described =
      spec.source === 'caller' && spec.description === genericCallerParamDescription(name)
        ? describeCallerParam(name)
        : undefined;
    params[name] = described !== undefined ? { ...spec, description: described } : spec;
  }

  /** Prose for one caller param, or undefined to keep whatever it already had. */
  function describeCallerParam(name: string): string | undefined {
    // First binding in the spine wins. A param typed into two fields is one
    // contract input either way, and the first is the one the caller reasons
    // about; probe actions are excluded because a probe's field is not the
    // capability's.
    const action = spine.find((a) => paramBoundBy(a) === name);
    // Trailing punctuation is chrome, not label: legacy screens render
    // "Amount:" / "E-mail:*". No label recorded (an unlabelled control, or a
    // trace older than this) falls back to the generic text — a wrong
    // description is worse than an empty one.
    const label = action?.element?.label?.replace(/[\s:*]+$/, '').trim();
    if (action === undefined || label === undefined || label === '') return undefined;
    if (action.kind !== 'choose') return `Typed into the "${label}" field on screen.`;
    // Which list the caller actually supplies: the compiled step matches by
    // VALUE when the param bound to an option's value, and by visible label
    // otherwise — so listing the other one would advertise inputs that do not
    // work.
    const value = chosenOptionValue(action);
    const boundByValue = value !== undefined && inputs.callerParamValues[name] === value;
    const primary = boundByValue ? (action.element?.optionValues ?? []) : (action.element?.options ?? []);
    const offered = primary.length > 0 ? primary : (action.element?.options ?? []);
    // A select's visible labels can embed regulated data ("… - Regular Shares
    // (***00)"), which redaction has already masked by the time the compiler
    // sees them. Listing masks would put unreadable noise into the one field
    // an agent reads to decide what to send, so the list is dropped whole
    // rather than shipped half-legible.
    if (offered.length === 0 || offered.some((o) => /\*\*\*|«secret:/.test(o))) {
      return `Chosen in the "${label}" field on screen.`;
    }
    const shown = offered.slice(0, MAX_LISTED_OPTIONS);
    const more = offered.length > shown.length ? `, … (${offered.length} offered in all)` : '';
    return `Chosen in the "${label}" field on screen. Offered at recording time: ${shown.join(', ')}${more}.`;
  }

  const artifactRaw = {
    schemaVersion: '1' as const,
    capability: {
      id: trace.done.capabilityId,
      version: inputs.version,
      title: readableProse(trace.done.title),
      description: readableProse(trace.done.description),
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
    params,
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

  // Lint: a {placeholder} that runs STRAIGHT INTO more identifier characters
  // is the fingerprint of a HALF-SUBSTITUTED value — "{memberId}-S0001:" is
  // not a template, it is one param plus a hardcoded fragment of the recording
  // session, and the hardcoded half silently pins the artifact to the record it
  // was recorded against.
  //
  // Longest-value-first substitution (see paramEntries) removes the case where
  // one PARAM's value eats another's. This lint covers the case it cannot: a
  // recorded string that contains a param's value followed by a suffix nothing
  // declares — the share `101555-S0002` on a run whose only params are the
  // member and a different share. That still compiles to a half-placeholder,
  // and it is still wrong; the difference is only that no reordering can fix
  // it, so a human has to see it before approval.
  //
  // Deliberately narrow: only immediate adjacency, optionally across a single
  // '-'. A space, ':' or '/' after a placeholder is ordinary prose or a URL
  // path ("Member {memberId} — Details", "{baseUrl}/members"), and flagging
  // those would bury the real signal.
  const HALF_SUBSTITUTED = /\{[a-zA-Z][a-zA-Z0-9_]*\}-?[A-Za-z0-9]/;
  const halfSubstituted = new Set<string>();
  const scanForHalfSubstitution = (value: unknown): void => {
    if (typeof value === 'string') {
      if (HALF_SUBSTITUTED.test(value)) halfSubstituted.add(value);
    } else if (Array.isArray(value)) {
      for (const v of value) scanForHalfSubstitution(v);
    } else if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value)) scanForHalfSubstitution(v);
    }
  };
  scanForHalfSubstitution({
    entrypoint: artifactRaw.capability.entrypoint,
    steps: artifactRaw.steps,
    successCriteria: artifactRaw.successCriteria,
    outcomes: artifactRaw.outcomes,
  });
  for (const text of [...halfSubstituted].sort()) {
    report.notes.push(
      `possible half-substituted value ${JSON.stringify(text)}: a {param} placeholder runs straight into further identifier characters, so part of a recorded identifier is hardcoded — that fragment pins this capability to the record it was recorded against; review before approval`,
    );
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
