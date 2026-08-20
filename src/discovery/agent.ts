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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RunLog } from '../evidence/runLog.js';
import { SessionController } from '../hitl/sessionController.js';
import type { Operator } from '../hitl/sessionController.js';
import { ActionGate } from '../policy/actionGate.js';
import type { Policy } from '../policy/policy.js';
import { Redactor, maskValue } from '../policy/redact.js';
import type { ParamSpec } from '../schema/capability.js';
import { PlaywrightWebSurface } from '../surface/web/playwrightSurface.js';
import { CapabilityArtifactSchema, computeContentHash } from '../schema/capability.js';
import { compileTrace } from './compile.js';
import type { OutputHint } from './compile.js';
import { Recorder } from './recorder.js';
import { DiscoveryToolExecutor } from './toolExecutor.js';
import { DISCOVERY_TOOLS } from './tools.js';

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
  /**
   * Human-in-the-loop for discovery: when present, irreversible clicks pause
   * the recording for approval on the live session (the same control-token
   * handoff replay uses) — which is what makes risky flows DISCOVERABLE
   * rather than hand-authored. Without it, the gate's refusal reaches the
   * model as a tool error and it must steer around the action.
   */
  operator?: Operator;
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
- Clicks that would commit a permanent business change (posting transactions, final confirmations) must be marked irreversible=true. Under policy such a click may pause while a human operator reviews it: if it is approved it happens exactly once, and if it is declined you must not retry it — steer another way or give_up.
- Extract requested data with read into a well-named output.
- Never restate sensitive on-screen values (balances, member PII) in your intents, descriptions, or outcome markers — refer to them by output name. This is regulated financial data.
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
  // An operator implies a headed session: the invariant lives here at the
  // seam, not only in the CLI — a programmatic caller cannot hand a human a
  // "live window" that does not exist.
  const surface = await PlaywrightWebSurface.launch({ headed: (opts.headed ?? false) || opts.operator !== undefined });
  // Discovery gets the same control-token wiring as replay: while a human
  // holds the session, the gate locks the recording out too.
  const controller = opts.operator ? new SessionController(surface, log, opts.operator) : undefined;
  const gate = new ActionGate(opts.policy, surface, {
    getHolder: () => controller?.holder() ?? 'agent',
    onEvent: (e) => log.event('gate', { kind: e.action.kind, decision: e.decision, location: e.location, risk: e.context.risk }),
  });
  const executor = new DiscoveryToolExecutor({
    surface,
    gate,
    recorder,
    log,
    redactor,
    paramValues,
    outputHints: opts.outputHints,
    runId: log.runId,
    ...(controller !== undefined ? { controller } : {}),
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

  try {
    for (let turn = 1; turn <= maxTurns && !finished; turn++) {
      usage.turns = turn;
      pruneOldImages(messages);
      const response = await client.messages.create({
        model,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        thinking: { type: 'adaptive' },
        tools: DISCOVERY_TOOLS as Anthropic.Messages.Tool[],
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
        const outcome = await executor.handle(tu.name, tu.input as Record<string, unknown>);
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
    log.event('run_result', { status: 'gave_up', reason: executor.giveUpReason });
    return { status: 'gave_up', runId: log.runId, evidenceDir: log.dir, reason: executor.giveUpReason, usage };
  }
  if (finished !== 'done') {
    log.event('run_result', { status: 'exhausted', maxTurns });
    return { status: 'exhausted', runId: log.runId, evidenceDir: log.dir, reason: `no declare_done within ${maxTurns} turns`, usage };
  }

  // ---- compile ----
  // The recorded trace is evidence in its own right: persist it BEFORE
  // compiling, so a compiler defect can never destroy the record of what
  // the (paid) discovery run actually did.
  log.writeJson('trace', recorder.get());
  let compiled;
  try {
    compiled = compileTrace({
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
  } catch (err) {
    const reason = `compile failed: ${err instanceof Error ? err.message : String(err)}`;
    log.event('run_result', { status: 'error', reason });
    return { status: 'error', runId: log.runId, evidenceDir: log.dir, reason, usage };
  }
  const { artifact: compiledArtifact, report } = compiled;
  // Redaction must happen BEFORE hashing: redact the artifact object (a
  // safety net in case any registered sensitive value leaked into
  // model-authored prose), then recompute the content hash so the shipped
  // file is integrity-consistent.
  const artifact = CapabilityArtifactSchema.parse(JSON.parse(redactor.apply(JSON.stringify(compiledArtifact))));
  artifact.integrity.contentHash = computeContentHash(artifact);
  log.writeJson('compile-report', report);
  log.writeJson('artifact', artifact);
  const artifactPath = path.join(
    opts.saveDir ?? 'capabilities',
    `${artifact.capability.id}@${artifact.capability.version}.json`,
  );
  try {
    assertArtifactWritable(artifactPath);
  } catch (err) {
    // The run itself is safe — trace, transcript, compile report, and the
    // compiled draft are all in the evidence dir. Only the capabilities/
    // copy is refused.
    const reason = `${err instanceof Error ? err.message : String(err)} (the compiled draft is preserved at ${log.dir}/artifact.json)`;
    log.event('run_result', { status: 'error', reason });
    return { status: 'error', runId: log.runId, evidenceDir: log.dir, reason, usage };
  }
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  log.event('run_result', { status: 'compiled', artifactPath, usage });
  return { status: 'compiled', runId: log.runId, evidenceDir: log.dir, artifactPath, usage };

  // -------------------------------------------------------------------------

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

/**
 * Discovery output must never silently replace a reviewed capability: an
 * existing APPROVED artifact (or an unreadable file) at the target path
 * refuses the write. Overwriting an existing DRAFT is allowed — that is the
 * normal iterate-on-discovery loop.
 */
export function assertArtifactWritable(file: string): void {
  if (!existsSync(file)) return;
  let state: string | undefined;
  try {
    const existing = JSON.parse(readFileSync(file, 'utf8')) as { provenance?: { approval?: { state?: string } } };
    state = existing.provenance?.approval?.state;
  } catch {
    throw new Error(`refusing to overwrite ${file} — the existing file is not a readable artifact; pass --save-dir <dir> or --artifact-version <semver>`);
  }
  if (state === 'approved') {
    throw new Error(
      `refusing to overwrite ${file} — it is an APPROVED artifact and discovery output is an unreviewed draft; pass --save-dir <dir> or --artifact-version <semver>`,
    );
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
