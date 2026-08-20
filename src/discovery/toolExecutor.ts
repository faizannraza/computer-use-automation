/**
 * The discovery tool executor — the HARNESS half of the discovery loop.
 *
 * The model proposes tool calls; this class is everything that happens to
 * them: validation, gated execution against the surface, recording, the
 * grounding rules (declare_outcome markers verified against the live screen),
 * and sensitive-read masking. It is deliberately separate from the Anthropic
 * loop in agent.ts so the entire harness is testable without a model or an
 * API key — "the model is a participant in the harness, not the author of
 * the output" is a property of the import graph, not a comment.
 */
import type { Observation } from '../core/types.js';
import type { RunLog } from '../evidence/runLog.js';
import type { SessionController } from '../hitl/sessionController.js';
import type { ActionGate } from '../policy/actionGate.js';
import { PolicyViolation } from '../policy/actionGate.js';
import type { Redactor } from '../policy/redact.js';
import { maskValue } from '../policy/redact.js';
import { summarizeObservation } from '../replay/detectors.js';
import type { OutputHint } from './compile.js';
import type { Recorder } from './recorder.js';
import { digestOf, recordedElementOf } from './recorder.js';
import { renderObservationBlocks } from './render.js';
import type { Surface } from '../surface/surface.js';

const CAPABILITY_ID_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const OUTCOME_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

export type ToolResultBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };

export interface ToolOutcome {
  blocks: ToolResultBlock[];
  isError?: boolean;
  finished?: 'done' | 'gave_up';
}

export interface ToolExecutorDeps {
  surface: Surface;
  gate: ActionGate;
  recorder: Recorder;
  log: RunLog;
  redactor: Redactor;
  /** Resolved values for every declared param (env-sourced ones included). */
  paramValues: Record<string, string>;
  outputHints: Record<string, OutputHint>;
  /**
   * Human-in-the-loop for DISCOVERY: when present, an irreversible click that
   * the gate refuses with RISK_NEEDS_ESCALATION pauses the recording and
   * routes the same approve_risky intervention replay uses — so risky flows
   * can be discovered, not only replayed. Without it, the model receives the
   * policy refusal as a tool error and must steer (the pre-HITL behavior).
   */
  controller?: SessionController;
  /** Discovery run id, carried on interventions so evidence ties together. */
  runId: string;
}

export class DiscoveryToolExecutor {
  private giveUpReasonValue = '';
  /**
   * Identities of controls a human operator DECLINED this run. The risk
   * label on a click comes from the model, so the refusal must not depend on
   * it: once declined, a control may never be activated again this run,
   * whatever flag a later call carries.
   */
  private readonly refusedTargets = new Set<string>();

  constructor(private readonly deps: ToolExecutorDeps) {}

  /** Why the model gave up, when it did. */
  get giveUpReason(): string {
    return this.giveUpReasonValue;
  }

  async handle(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const { surface, gate, recorder, log, redactor, paramValues, outputHints } = this.deps;
    try {
      switch (name) {
        case 'observe': {
          const obs = await surface.observe();
          log.screenshot('observe', obs.screenshot);
          return { blocks: renderObservationBlocks(obs) };
        }
        case 'navigate': {
          const before = digestOf(surface.lastObservation() ?? (await surface.observe()));
          await gate.execute({ kind: 'navigate', url: String(input['url']) }, { risk: 'read' });
          await surface.settle();
          const obs = await surface.observe();
          const shot = log.screenshot('navigate', obs.screenshot);
          recorder.record({
            kind: 'navigate',
            intent: String(input['intent']),
            risk: 'read',
            url: String(input['url']),
            before,
            after: digestOf(obs),
            ...(shot !== undefined ? { screenshotRef: shot } : {}),
          });
          return { blocks: renderObservationBlocks(obs) };
        }
        case 'click': {
          const { obs: beforeObs, el } = this.requireRef(input);
          const irreversible = input['irreversible'] === true;
          // Sticky refusal: the risk label is model-supplied, so a declined
          // control cannot be re-issued as "reversible" to slip past the gate.
          // Keyed on identity + the frame's document URL: pinned to this
          // control on this screen, not to every same-named control in the app.
          if (this.refusedTargets.has(refusalKey(el))) {
            return textOut(
              'This control was DECLINED by the human operator earlier in this run and must not be activated, with any flag. Accomplish the goal another way, or give_up.',
              true,
            );
          }
          const ctx = { risk: irreversible ? ('irreversible' as const) : ('reversible' as const), frameUrl: frameUrlOf(el) };
          let approvedIntervention: string | undefined;
          let humanActionsDuringApproval: number | undefined;
          let approvedTarget: Observation['elements'][number] | undefined;
          let beforeDigest = digestOf(beforeObs);
          try {
            await gate.execute({ kind: 'activate', ref: el.ref }, ctx);
          } catch (err) {
            const controller = this.deps.controller;
            if (!(err instanceof PolicyViolation) || err.code !== 'RISK_NEEDS_ESCALATION' || controller === undefined) {
              throw err;
            }
            // Discovery-time escalation: the SAME approve_risky handoff replay
            // uses — control token flips, the human decides on the live
            // session, and the intervention is written to evidence.
            //
            // The operator approves against a FRESH observation (type/choose
            // deliberately don't re-observe, so the last one may predate the
            // values just entered) and against a harness-derived target
            // identity — the model's intent line is context, not the thing
            // being approved. The element is re-located in the fresh
            // observation by identity; if the screen changed, nothing runs.
            const freshObs = await surface.observe();
            const matches = freshObs.elements.filter((e) => identityKey(e) === identityKey(el));
            if (matches.length === 0) {
              // The escalation observe() renumbered refs — always hand the
              // model the fresh listing alongside the refusal, so its next
              // action is grounded in what the page looks like NOW.
              return {
                blocks: [
                  { type: 'text', text: 'The screen changed before the risky action could be reviewed — nothing was performed. Decide again from this fresh observation:' },
                  ...renderObservationBlocks(freshObs),
                ],
                isError: true,
              };
            }
            if (matches.length > 1) {
              return {
                blocks: [
                  { type: 'text', text: 'Multiple controls share this identity — the harness cannot present an ambiguous irreversible action for human approval. Nothing was performed. Disambiguate first:' },
                  ...renderObservationBlocks(freshObs),
                ],
                isError: true,
              };
            }
            const target = matches[0]!;
            const shot = log.screenshot('intervention', freshObs.screenshot);
            const frameName = target.framePath[target.framePath.length - 1]?.name;
            const resolution = await controller.escalate({
              kind: 'approve_risky',
              origin: 'discovery',
              capabilityId: '(discovery)',
              version: '—',
              runId: this.deps.runId,
              stepIntent: `[model-authored] ${sanitizeForOperator(String(input['intent']))}`,
              reason: `${err.message}; target (harness-verified): ${target.role} ${JSON.stringify(target.name)}${frameName !== undefined ? ` in frame '${frameName}'` : ''}`,
              suggestedResolution:
                'Review the pending irreversible action in the live window — do NOT perform it yourself. approve = the recording performs it exactly once; abort = refuse it (the model must steer another way).',
              options: ['approve', 'abort'],
              observationSummary: summarizeObservation(freshObs),
              ...(shot !== undefined ? { screenshotRef: shot } : {}),
            });
            const record = controller.records[controller.records.length - 1]!;
            if (resolution.action !== 'approve') {
              this.refusedTargets.add(refusalKey(target));
              recorder.recordDeclined(record.id, sanitizeForOperator(String(input['intent'])));
              const postDeclineObs = await surface.observe();
              return {
                blocks: [
                  { type: 'text', text: 'The human operator DECLINED this irreversible action. Do not retry it — with any flag. Accomplish the goal another way, or give_up explaining what was refused. Fresh observation:' },
                  ...renderObservationBlocks(postDeclineObs),
                ],
                isError: true,
              };
            }
            // The handoff may have lasted minutes and the human may have
            // changed the screen in place (no navigation, so refs stay live).
            // The approval binds to the state the human REVIEWED — so before
            // acting, re-observe and re-locate the control; if the identity
            // is no longer unique on the current screen, refuse to act.
            const postApprovalObs = await surface.observe();
            const postMatches = postApprovalObs.elements.filter((e) => identityKey(e) === identityKey(el));
            if (postMatches.length !== 1) {
              return {
                blocks: [
                  { type: 'text', text: 'The screen changed during the approval — the action was NOT performed. Observe the current state and decide again:' },
                  ...renderObservationBlocks(postApprovalObs),
                ],
                isError: true,
              };
            }
            approvedTarget = postMatches[0]!;
            approvedIntervention = record.id;
            if (record.humanActions > 0) humanActionsDuringApproval = record.humanActions;
            beforeDigest = digestOf(postApprovalObs); // the state the approved action actually acts on
            await gate.execute({ kind: 'activate', ref: approvedTarget.ref }, { ...ctx, approved: true });
          }
          await surface.settle();
          const obs = await surface.observe();
          const shot = log.screenshot('click', obs.screenshot);
          recorder.record({
            kind: 'activate',
            intent: String(input['intent']),
            risk: irreversible ? 'irreversible' : 'reversible',
            // On the approval path the element is re-recorded from the state
            // the human approved, so anchors (row text, geometry) are current.
            element: recordedElementOf(approvedTarget ?? el),
            before: beforeDigest,
            after: digestOf(obs),
            ...(shot !== undefined ? { screenshotRef: shot } : {}),
            ...(approvedIntervention !== undefined ? { approvedIntervention } : {}),
            ...(humanActionsDuringApproval !== undefined ? { humanActionsDuringApproval } : {}),
          });
          return { blocks: renderObservationBlocks(obs) };
        }
        case 'type': {
          const { obs: beforeObs, el } = this.requireRef(input);
          const paramName = input['param'] !== undefined ? String(input['param']) : undefined;
          const literal = input['text'] !== undefined ? String(input['text']) : undefined;
          if ((paramName === undefined) === (literal === undefined)) {
            return textOut('Provide exactly one of text or param.', true);
          }
          let value: string;
          if (paramName !== undefined) {
            const v = paramValues[paramName];
            if (v === undefined) return textOut(`Unknown param '${paramName}'.`, true);
            value = v;
          } else {
            value = literal!;
          }
          await gate.execute(
            { kind: 'setValue', ref: el.ref, value },
            { risk: 'reversible', frameUrl: frameUrlOf(el) },
          );
          // No re-observe: typing does not navigate, so refs stay valid — and
          // the model was promised exactly that (see the observe tool's docs).
          const digest = digestOf(beforeObs);
          recorder.record({
            kind: 'setValue',
            intent: String(input['intent']),
            risk: 'reversible',
            element: recordedElementOf(el),
            value: paramName !== undefined ? { param: paramName } : { literal: literal! },
            before: digest,
            after: digest,
          });
          return textOut(
            paramName !== undefined
              ? `Entered {param:${paramName}} into [${el.ref}].`
              : `Entered ${JSON.stringify(literal)} into [${el.ref}].`,
          );
        }
        case 'choose': {
          const { obs: beforeObs, el } = this.requireRef(input);
          const option = String(input['option']);
          await gate.execute(
            { kind: 'choose', ref: el.ref, option },
            { risk: 'reversible', frameUrl: frameUrlOf(el) },
          );
          const digest = digestOf(beforeObs);
          recorder.record({
            kind: 'choose',
            intent: String(input['intent']),
            risk: 'reversible',
            element: recordedElementOf(el),
            option: { literal: option },
            before: digest,
            after: digest,
          });
          return textOut(`Chose ${JSON.stringify(option)} in [${el.ref}].`);
        }
        case 'read': {
          const { obs: beforeObs, el } = this.requireRef(input);
          const outputName = String(input['output_name']);
          if (!/^[a-z][a-zA-Z0-9]*$/.test(outputName)) return textOut('output_name must be lowerCamelCase.', true);
          const hintSensitivity = outputHints[outputName]?.sensitivity ?? 'none';
          const res = await gate.execute(
            { kind: 'read', ref: el.ref },
            { risk: 'read', frameUrl: frameUrlOf(el) },
          );
          const digest = digestOf(beforeObs);
          recorder.record({
            kind: 'read',
            intent: String(input['intent']),
            risk: 'read',
            element: recordedElementOf(el),
            outputName,
            ...(res.readValue !== undefined ? { readValue: res.readValue } : {}),
            before: digest,
            after: digest,
          });
          // Sensitive extractions are registered with the redactor the moment
          // they exist (so trace/transcript/evidence writes mask them) and are
          // shown to the MODEL only in masked form — a value the model never
          // sees is a value it cannot echo into descriptions or intents.
          if ((hintSensitivity === 'pii' || hintSensitivity === 'secret') && res.readValue !== undefined && res.readValue !== '') {
            redactor.register(outputName, res.readValue, hintSensitivity);
            const masked = maskValue(outputName, res.readValue, hintSensitivity);
            return textOut(
              `Read a ${hintSensitivity}-classified value (${JSON.stringify(masked)}) as output '${outputName}'. The raw value is withheld from this transcript by policy — do not attempt to restate it from the screen.`,
            );
          }
          return textOut(`Read ${JSON.stringify(res.readValue ?? '')} as output '${outputName}'.`);
        }
        case 'answer_dialog': {
          const before = digestOf(surface.lastObservation() ?? (await surface.observe()));
          const accept = input['accept'] === true;
          await gate.execute({ kind: 'answerDialog', accept }, { risk: 'reversible' });
          await surface.settle();
          const obs = await surface.observe();
          recorder.record({
            kind: 'answerDialog',
            intent: String(input['intent']),
            risk: 'reversible',
            before,
            after: digestOf(obs),
          });
          return { blocks: renderObservationBlocks(obs) };
        }
        case 'begin_probe': {
          const code = String(input['outcome_code']);
          if (!OUTCOME_CODE_RE.test(code)) return textOut('outcome_code must be SCREAMING_SNAKE.', true);
          recorder.beginProbe(code);
          log.event('probe_started', { code });
          return textOut(`Probe started for ${code}. Actions until declare_outcome are excluded from the replayable flow.`);
        }
        case 'declare_outcome': {
          const code = String(input['code']);
          const marker = String(input['marker']);
          if (!OUTCOME_CODE_RE.test(code)) return textOut('code must be SCREAMING_SNAKE.', true);
          const obs = surface.lastObservation() ?? (await surface.observe());
          if (!obs.visibleText.toLowerCase().includes(marker.toLowerCase())) {
            return textOut(`Marker ${JSON.stringify(marker)} is NOT visible on the current screen — declare only states you are observing.`, true);
          }
          recorder.declareOutcome({ code, description: String(input['description']), marker, observedIn: digestOf(obs) });
          log.event('outcome_declared', { code, marker });
          return textOut(`Outcome ${code} declared (marker verified visible).`);
        }
        case 'revise': {
          const n = Number(input['drop_last']);
          if (!Number.isInteger(n) || n < 1) return textOut('drop_last must be a positive integer.', true);
          const dropped = recorder.retract(n);
          log.event('revised', { requested: n, dropped, reason: String(input['reason']) });
          return textOut(`Retracted ${dropped} recorded action(s).`);
        }
        case 'declare_done': {
          const id = String(input['capability_id']);
          if (!CAPABILITY_ID_RE.test(id)) {
            return textOut("capability_id must be namespaced like 'member.readSavingsBalance'.", true);
          }
          recorder.finish({ capabilityId: id, title: String(input['title']), description: String(input['description']) });
          return { blocks: [{ type: 'text', text: 'Recorded. Compiling the artifact.' }], finished: 'done' };
        }
        case 'give_up': {
          this.giveUpReasonValue = String(input['reason']);
          recorder.giveUp(this.giveUpReasonValue);
          return { blocks: [{ type: 'text', text: 'Understood.' }], finished: 'gave_up' };
        }
        default:
          return textOut(`Unknown tool '${name}'.`, true);
      }
    } catch (err) {
      if (err instanceof PolicyViolation) {
        return textOut(`POLICY: ${err.message}`, true);
      }
      return textOut(`ERROR: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  private requireRef(input: Record<string, unknown>): { obs: Observation; el: Observation['elements'][number] } {
    const obs = this.deps.surface.lastObservation();
    if (!obs) throw new Error('no observation yet — call observe first');
    const ref = Number(input['ref']);
    const el = obs.elements.find((e) => e.ref === ref);
    if (!el) throw new Error(`ref ${ref} is not in the latest observation (it may be stale — observe again)`);
    return { obs, el };
  }
}

function textOut(text: string, isError = false): ToolOutcome {
  return { blocks: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function frameUrlOf(el: Observation['elements'][number]): string | undefined {
  return el.framePath[el.framePath.length - 1]?.url;
}

/** Element identity independent of the observation's ref numbering: role,
 * accessible name, label, and the named frame path. Used to re-locate a
 * control across observations of the SAME screen. */
function identityKey(el: Observation['elements'][number]): string {
  const frames = el.framePath.map((f) => f.name ?? '?').join('/');
  return `${el.role}|${el.name}|${el.label ?? ''}|${frames}`;
}

/** Refusal identity: element identity plus the frame DOCUMENT urls, so a
 * declined control is pinned to its screen — a same-named control on a
 * different screen of the app is a different decision. */
function refusalKey(el: Observation['elements'][number]): string {
  return `${identityKey(el)}|${el.framePath.map((f) => f.url).join('/')}`;
}

/** Operator-facing text from the model is sanitized: control characters
 * (including ANSI escapes) stripped and length capped, so a hostile page
 * steering the model cannot clear or forge the intervention banner. */
function sanitizeForOperator(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 200);
}
