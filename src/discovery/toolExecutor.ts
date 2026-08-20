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
import type { ActionGate } from '../policy/actionGate.js';
import { PolicyViolation } from '../policy/actionGate.js';
import type { Redactor } from '../policy/redact.js';
import { maskValue } from '../policy/redact.js';
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
}

export class DiscoveryToolExecutor {
  private giveUpReasonValue = '';

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
          await gate.execute(
            { kind: 'activate', ref: el.ref },
            { risk: irreversible ? 'irreversible' : 'reversible', frameUrl: frameUrlOf(el) },
          );
          await surface.settle();
          const obs = await surface.observe();
          const shot = log.screenshot('click', obs.screenshot);
          recorder.record({
            kind: 'activate',
            intent: String(input['intent']),
            risk: irreversible ? 'irreversible' : 'reversible',
            element: recordedElementOf(el),
            before: digestOf(beforeObs),
            after: digestOf(obs),
            ...(shot !== undefined ? { screenshotRef: shot } : {}),
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
