/**
 * The discovery agent: an LLM-driven observe → decide → act loop against the
 * live surface. Claude sees rendered observations (indexed element map +
 * screenshot), decides, and calls tools; every action goes through the SAME
 * ActionGate as replay — the model has no privileged path to the surface.
 *
 * The run is recorded (recorder.ts) and compiled (compile.ts) into a draft
 * capability artifact. The model's transcript is evidence, never the
 * artifact.
 */
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { RunLog } from '../evidence/runLog.js';
import { ActionGate, PolicyViolation } from '../policy/actionGate.js';
import type { Policy } from '../policy/policy.js';
import { Redactor, maskValue } from '../policy/redact.js';
import type { ParamSpec } from '../schema/capability.js';
import type { Observation } from '../core/types.js';
import { PlaywrightWebSurface } from '../surface/web/playwrightSurface.js';
import { compileTrace } from './compile.js';
import type { OutputHint } from './compile.js';
import { Recorder, digestOf, recordedElementOf } from './recorder.js';
import { renderObservationBlocks } from './render.js';
import { DISCOVERY_TOOLS } from './tools.js';

const CAPABILITY_ID_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const OUTCOME_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

export interface DiscoveryOptions {
  goal: string;
  paramSpecs: Record<string, ParamSpec>;
  /** Values for caller-sourced params (env-sourced resolve from process.env). */
  paramValues: Record<string, string>;
  outputHints: Record<string, OutputHint>;
  policy: Policy;
  baseUrl: string;
  headed?: boolean;
  maxTurns?: number;
  evidenceBaseDir?: string;
  model?: string;
  saveDir?: string;
  app?: { appId: string; vendor: string };
  artifactVersion?: string;
}

export interface DiscoveryRunResult {
  status: 'compiled' | 'gave_up' | 'exhausted' | 'error';
  runId: string;
  evidenceDir: string;
  artifactPath?: string;
  reason?: string;
  usage: { inputTokens: number; outputTokens: number; turns: number };
}

const SYSTEM_PROMPT = `You are a computer-use discovery agent operating a legacy bank back-office web application through a constrained tool interface. Your successful run will be compiled into a deterministic, replayable automation artifact, so work the way a careful human operator would.

Rules:
- One action at a time. Give every action a clear one-line intent — it becomes the human-readable step description in the compiled artifact.
- Act on elements by their [ref] from the latest observation. Prefer semantically meaningful controls (labeled fields, named buttons/links, table cells under headers). If two controls look identical, stop and look again rather than guessing.
- Parameters: the task lists named parameters. When a field should receive a parameter's value, call type with param=<name> instead of literal text — always for credentials/secrets (their values are injected by the harness; you never see them), and for any value the capability should take as an input at replay time.
- Stay on the application origin you were given. Policy blocks everything else, including any /__ paths.
- If a native dialog opens, read its text and answer_dialog deliberately.
- Clicks that would commit a permanent business change (posting transactions, final confirmations) must be marked irreversible=true.
- Extract requested data with read into a well-named output.
- If the task asks you to probe an exceptional state (e.g. a not-found case), call begin_probe first, perform the probe, then declare_outcome with a marker you can literally see on screen. Probe actions are excluded from the replayable flow.
- If you took a wrong turn, navigate back on the app's own controls and use revise to retract the wrong recorded actions.
- Finish with declare_done (capability_id like 'member.readSavingsBalance') once the goal is fully accomplished, or give_up with a precise reason if you are stuck.`;

export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryRunResult> {
  const model = opts.model ?? process.env.CU_MODEL ?? 'claude-opus-4-8';
  const maxTurns = opts.maxTurns ?? 30;
  const redactor = new Redactor();

  // Resolve all params up front (env-sourced ones come from process.env).
  const paramValues: Record<string, string> = {};
  for (const [name, spec] of Object.entries(opts.paramSpecs)) {
    const raw = spec.source === 'env' ? process.env[spec.env!] : opts.paramValues[name];
    if (raw === undefined || raw === '') throw new Error(`param '${name}' has no value (${spec.source})`);
    paramValues[name] = raw;
    redactor.register(name, raw, spec.sensitivity);
  }
  const callerParamValues = Object.fromEntries(
    Object.entries(opts.paramSpecs)
      .filter(([, s]) => s.source === 'caller')
      .map(([n]) => [n, paramValues[n]!]),
  );

  const log = new RunLog('discovery', { baseDir: opts.evidenceBaseDir ?? 'evidence', redactor });
  const recorder = new Recorder(opts.goal);
  const surface = await PlaywrightWebSurface.launch({ headed: opts.headed ?? false });
  const gate = new ActionGate(opts.policy, surface, {
    onEvent: (e) => log.event('gate', { kind: e.action.kind, decision: e.decision, location: e.location, risk: e.context.risk }),
  });
  const client = new Anthropic();
  const usage = { inputTokens: 0, outputTokens: 0, turns: 0 };

  log.event('run_start', {
    goal: opts.goal,
    model,
    params: Object.fromEntries(
      Object.entries(opts.paramSpecs).map(([n, s]) => [n, maskValue(n, paramValues[n]!, s.sensitivity)]),
    ),
  });

  // The parameter briefing: values shown only when non-sensitive.
  const paramLines = Object.entries(opts.paramSpecs).map(([name, spec]) => {
    const shown =
      spec.sensitivity === 'none' || spec.sensitivity === 'internal'
        ? `value: ${JSON.stringify(paramValues[name])}`
        : 'value: (secret — reference with param, never typed literally)';
    return `- ${name} (${spec.sensitivity}): ${spec.description} — ${shown}`;
  });

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `TASK:\n${opts.goal}\n\nPARAMETERS:\n${paramLines.join('\n')}\n\nThe application is served at ${opts.baseUrl}. The browser is currently blank — begin by navigating to the application.`,
        },
      ],
    },
  ];

  let finished: 'done' | 'gave_up' | undefined;
  let giveUpReason = '';

  try {
    for (let turn = 1; turn <= maxTurns && !finished; turn++) {
      usage.turns = turn;
      pruneOldImages(messages);
      const response = await client.messages.create({
        model,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        thinking: { type: 'adaptive' },
        tools: DISCOVERY_TOOLS satisfies Anthropic.Messages.Tool[] as Anthropic.Messages.Tool[],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages,
      });
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      log.event('llm_turn', {
        turn,
        stopReason: response.stop_reason,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });
      if (response.stop_reason === 'refusal') {
        throw new Error('model refused the request (stop_reason: refusal)');
      }
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) {
        // Text-only turn: nudge once toward the tool contract.
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: 'Continue using tools. Finish with declare_done or give_up.' }],
        });
        continue;
      }

      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        log.event('tool_use', { turn, tool: tu.name, input: summarizeInput(tu.input) });
        const outcome = await handleTool(tu.name, tu.input as Record<string, unknown>);
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: outcome.blocks,
          ...(outcome.isError ? { is_error: true } : {}),
        });
        if (outcome.finished) finished = outcome.finished;
      }
      messages.push({ role: 'user', content: results });

      if (usage.inputTokens > 1_500_000 || usage.outputTokens > 300_000) {
        throw new Error('token budget guard tripped — aborting discovery');
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.event('run_error', { reason });
    persistTranscript();
    await surface.close();
    return { status: 'error', runId: log.runId, evidenceDir: log.dir, reason, usage };
  }

  persistTranscript();
  await surface.close();

  if (finished === 'gave_up') {
    log.event('run_result', { status: 'gave_up', reason: giveUpReason });
    return { status: 'gave_up', runId: log.runId, evidenceDir: log.dir, reason: giveUpReason, usage };
  }
  if (finished !== 'done') {
    log.event('run_result', { status: 'exhausted', maxTurns });
    return { status: 'exhausted', runId: log.runId, evidenceDir: log.dir, reason: `no declare_done within ${maxTurns} turns`, usage };
  }

  // ---- compile ----
  const { artifact, report } = compileTrace({
    trace: recorder.get(),
    paramSpecs: opts.paramSpecs,
    callerParamValues,
    outputHints: opts.outputHints,
    baseUrl: opts.baseUrl,
    model,
    discoveryRunId: log.runId,
    app: opts.app ?? { appId: 'mockcore-teller', vendor: 'MockCore' },
    version: opts.artifactVersion ?? '1.0.0',
  });
  log.writeJson('trace', recorder.get());
  log.writeJson('compile-report', report);
  log.writeJson('artifact', artifact);
  const artifactPath = path.join(
    opts.saveDir ?? 'capabilities',
    `${artifact.capability.id}@${artifact.capability.version}.json`,
  );
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  log.event('run_result', { status: 'compiled', artifactPath, usage });
  return { status: 'compiled', runId: log.runId, evidenceDir: log.dir, artifactPath, usage };

  // -------------------------------------------------------------------------

  async function observeAndRecordable(): Promise<Observation> {
    const obs = await surface.observe();
    return obs;
  }

  interface ToolOutcome {
    blocks: ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } })[];
    isError?: boolean;
    finished?: 'done' | 'gave_up';
  }

  function textOut(text: string, isError = false): ToolOutcome {
    return { blocks: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
  }

  async function handleTool(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    try {
      switch (name) {
        case 'observe': {
          const obs = await observeAndRecordable();
          log.screenshot('observe', obs.screenshot);
          return { blocks: renderObservationBlocks(obs) };
        }
        case 'navigate': {
          const before = digestOf(surface.lastObservation() ?? (await observeAndRecordable()));
          await gate.execute({ kind: 'navigate', url: String(input['url']) }, { risk: 'read' });
          await surface.settle();
          const obs = await observeAndRecordable();
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
          const { obs: beforeObs, el } = requireRef(input);
          const irreversible = input['irreversible'] === true;
          await gate.execute({ kind: 'activate', ref: el.ref }, { risk: irreversible ? 'irreversible' : 'reversible' });
          await surface.settle();
          const obs = await observeAndRecordable();
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
          const { obs: beforeObs, el } = requireRef(input);
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
          await gate.execute({ kind: 'setValue', ref: el.ref, value }, { risk: 'reversible' });
          const obs = await observeAndRecordable();
          recorder.record({
            kind: 'setValue',
            intent: String(input['intent']),
            risk: 'reversible',
            element: recordedElementOf(el),
            value: paramName !== undefined ? { param: paramName } : { literal: literal! },
            before: digestOf(beforeObs),
            after: digestOf(obs),
          });
          return textOut(paramName !== undefined ? `Entered {param:${paramName}} into [${el.ref}].` : `Entered ${JSON.stringify(literal)} into [${el.ref}].`);
        }
        case 'choose': {
          const { obs: beforeObs, el } = requireRef(input);
          const option = String(input['option']);
          await gate.execute({ kind: 'choose', ref: el.ref, option }, { risk: 'reversible' });
          const obs = await observeAndRecordable();
          recorder.record({
            kind: 'choose',
            intent: String(input['intent']),
            risk: 'reversible',
            element: recordedElementOf(el),
            option: { literal: option },
            before: digestOf(beforeObs),
            after: digestOf(obs),
          });
          return textOut(`Chose ${JSON.stringify(option)} in [${el.ref}].`);
        }
        case 'read': {
          const { obs: beforeObs, el } = requireRef(input);
          const outputName = String(input['output_name']);
          if (!/^[a-z][a-zA-Z0-9]*$/.test(outputName)) return textOut('output_name must be lowerCamelCase.', true);
          const res = await gate.execute({ kind: 'read', ref: el.ref }, { risk: 'read' });
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
          return textOut(`Read ${JSON.stringify(res.readValue ?? '')} as output '${outputName}'.`);
        }
        case 'answer_dialog': {
          const before = digestOf(surface.lastObservation() ?? (await observeAndRecordable()));
          const accept = input['accept'] === true;
          await gate.execute({ kind: 'answerDialog', accept }, { risk: 'reversible' });
          await surface.settle();
          const obs = await observeAndRecordable();
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
          recorder.beginProbe();
          log.event('probe_started', { code });
          return textOut(`Probe started for ${code}. Actions until declare_outcome are excluded from the replayable flow.`);
        }
        case 'declare_outcome': {
          const code = String(input['code']);
          const marker = String(input['marker']);
          if (!OUTCOME_CODE_RE.test(code)) return textOut('code must be SCREAMING_SNAKE.', true);
          const obs = surface.lastObservation() ?? (await observeAndRecordable());
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
          giveUpReason = String(input['reason']);
          recorder.giveUp(giveUpReason);
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

  function requireRef(input: Record<string, unknown>): { obs: Observation; el: Observation['elements'][number] } {
    const obs = surface.lastObservation();
    if (!obs) throw new Error('no observation yet — call observe first');
    const ref = Number(input['ref']);
    const el = obs.elements.find((e) => e.ref === ref);
    if (!el) throw new Error(`ref ${ref} is not in the latest observation (it may be stale — observe again)`);
    return { obs, el };
  }

  function persistTranscript(): void {
    // Full transcript as evidence, with image payloads elided (screenshots
    // are already stored as files) and redaction applied by the logger.
    const elided = messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? m.content
          : m.content.map((b) => {
              if (b.type === 'image') return { type: 'image', note: '(stored as evidence screenshot)' };
              if (b.type === 'tool_result') {
                return {
                  ...b,
                  content:
                    typeof b.content === 'string'
                      ? b.content
                      : b.content?.map((c) => (c.type === 'image' ? { type: 'image', note: '(stored as evidence screenshot)' } : c)),
                };
              }
              return b;
            }),
    }));
    log.writeJson('transcript', elided);
  }
}

/** Keep only the latest observation's screenshot in context — older images
 * add cost without adding signal (the text rendering remains). */
function pruneOldImages(messages: Anthropic.Messages.MessageParam[]): void {
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i]!;
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        block.content = block.content.map((c) =>
          c.type === 'image' ? { type: 'text', text: '[screenshot omitted from context — see evidence]' } : c,
        );
      }
    }
  }
}

function summarizeInput(input: unknown): Record<string, unknown> {
  const obj = (input ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
  return out;
}
