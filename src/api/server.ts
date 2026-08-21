/**
 * The capability API: capabilities recorded once, exposed as a callable
 * surface an agent invokes by name with typed args, plus the observability to
 * watch it work.
 *
 * One process serves the API, the dashboard and the chat UI. That is a
 * deliberate choice, not a shortcut — the system's boundaries are the Surface
 * seam, the ActionGate and the artifact, and none of them get sharper by being
 * split across ports.
 *
 * Security posture (a demo surface that fronts a banking automation). Stated
 * as the boundary it actually is, because the previous version of this comment
 * claimed more than it delivered:
 *  - The listener binds 127.0.0.1, so nothing off this machine can connect.
 *  - Every request must carry a loopback `Host` header. A loopback bind alone
 *    does NOT keep a web page out: under DNS rebinding, `attacker.com` resolves
 *    to 127.0.0.1 and the attacker's JS is same-origin with this server —
 *    absent CORS and a JSON content type are then irrelevant, because there is
 *    no cross-origin request left to block and responses are readable. The
 *    `Host` header is the one part of that attack the attacker cannot forge
 *    from a browser, so it is what the guard checks.
 *  - Resolving an intervention requires that intervention's one-time nonce,
 *    served only from its own route (never from the listing).
 *  - There is NO authentication. Any process or page that reaches this port
 *    with a loopback Host is trusted completely. That is the boundary: this is
 *    an operator's workstation surface, not a multi-tenant service.
 */
import 'dotenv/config';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { loadCatalog } from '../catalog/catalog.js';
import { HttpOperator } from './httpOperator.js';
import {
  InvocationError,
  artifactFor,
  entryFor,
  escalatingRecoveries,
  evidencePath,
  loadContext,
  mergedArtifactFor,
  pausesForHuman,
  roleForRun,
  shapeOutputs,
  startInvocation,
} from './invoke.js';
import type { ApiContext } from './invoke.js';
import { RunStore } from './runStore.js';
import { handleChat } from '../chat/chatAgent.js';
import type { ReplayResult } from '../schema/result.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '../../web');

export interface ServerOptions {
  profileFile?: string;
  capabilitiesDir?: string;
  evidenceBaseDir?: string;
  policyFile?: string;
  port?: number;
  interventionTimeoutMs?: number;
  /** Opt in to harness fault injection over HTTP (default: CU_ALLOW_INJECT=1). */
  allowInject?: boolean;
}

/** Hostnames a `Host` header may name for this to be a loopback request. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * The chatbot's request body. Bounded on purpose: `max(50)` and the 20k
 * per-message cap keep an unauthenticated local caller from turning one POST
 * into a large Anthropic bill, and `.strict()` refuses the extra keys that
 * would otherwise reach the planner's context as content the model treats as
 * its own prior tool output.
 */
const ChatRequestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(20_000),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    mode: z.enum(['llm', 'scripted']).optional(),
  })
  .strict();

/**
 * The hostname a `Host` header names, with any port stripped.
 * `[::1]:4180` → `::1`; `127.0.0.1:4180` → `127.0.0.1`; `::1` → `::1`.
 */
export function hostHeaderHostname(host: string): string {
  const raw = host.trim().toLowerCase();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(raw);
  if (bracketed) return bracketed[1] ?? '';
  // An unbracketed literal with several colons is a bare IPv6 address, not
  // host:port — splitting it on the last colon would corrupt it into `::`.
  const colons = raw.length - raw.replaceAll(':', '').length;
  return colons === 1 ? raw.slice(0, raw.lastIndexOf(':')) : raw;
}

export function isLoopbackHost(host: string | undefined): boolean {
  // A request with no Host is HTTP/1.0 or hand-rolled; nothing this server
  // serves needs it, and allowing it would be a hole around the check.
  if (host === undefined || host === '') return false;
  return LOOPBACK_HOSTS.has(hostHeaderHostname(host));
}

export function createApiApp(opts: ServerOptions = {}): { app: express.Express; ctx: ApiContext } {
  const allowInject = opts.allowInject ?? process.env['CU_ALLOW_INJECT'] === '1';
  /**
   * Presentation pacing for runs this server drives. A run started from the
   * CHATBOT cannot ask for it — the planner chooses a capability and its
   * parameters and nothing else, deliberately — so pacing is the operator's
   * decision, made once here. The dashboard's own form still overrides it per
   * invocation. Unset in production: a replay runs headless at full speed.
   */
  const demoSlowMo = Number(process.env['CU_DEMO_SLOW_MO'] ?? '');
  const demoPacing =
    Number.isFinite(demoSlowMo) && demoSlowMo > 0
      ? { slowMoMs: demoSlowMo, headed: process.env['CU_DEMO_HEADED'] === '1' }
      : process.env['CU_DEMO_HEADED'] === '1'
        ? { headed: true }
        : undefined;
  const store = new RunStore(opts.evidenceBaseDir ?? 'evidence');
  // The two defaults are a PAIR and must move together: the artifacts in
  // `capabilities-meridian/` were recorded against MERIDIAN CORE, and the
  // profile supplies that app's credentials, recoveries and origin allowlist.
  // The previous default paired the MERIDIAN profile with `capabilities/` (two
  // MockCore recordings), so a bare `npm run api` served flows whose origins
  // the policy denies. `.env.example` ships the same pairing.
  const ctx = loadContext({
    profileFile: opts.profileFile ?? 'profiles/meridian-core.profile.json',
    capabilitiesDir: opts.capabilitiesDir ?? 'capabilities-meridian',
    evidenceBaseDir: opts.evidenceBaseDir ?? 'evidence',
    store,
    ...(opts.policyFile !== undefined ? { policyFile: opts.policyFile } : {}),
    ...(opts.interventionTimeoutMs !== undefined ? { interventionTimeoutMs: opts.interventionTimeoutMs } : {}),
    ...(demoPacing !== undefined ? { demoPacing } : {}),
  });

  const app = express();
  app.disable('x-powered-by');

  // FIRST, ahead of every route and both static mounts: a page served from
  // `attacker.com` whose DNS has been flipped to 127.0.0.1 reaches this
  // listener, and its requests carry `Host: attacker.com`. A browser will not
  // let script forge that header, so this is what separates the operator's own
  // tab from a rebound one. It does NOT authenticate anyone: a local process
  // can set any Host it likes, and is trusted by design (see the header).
  app.use((req, res, next) => {
    if (!isLoopbackHost(req.headers.host)) {
      res.status(403).json({ error: 'this API answers loopback Host headers only' });
      return;
    }
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  const fail = (res: Response, err: unknown): void => {
    if (err instanceof InvocationError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  };

  // ---- what this deployment is pointed at ----
  app.get('/api/profile', (_req, res) => {
    const catalog = loadCatalog(ctx.capabilitiesDir);
    res.json({
      appId: ctx.profile.appId,
      vendor: ctx.profile.vendor,
      title: ctx.profile.title,
      baseUrl: ctx.profile.baseUrl,
      roles: Object.keys(ctx.profile.credentials?.roles ?? {}),
      defaultRole: ctx.profile.credentials?.defaultRole,
      faultKinds: ctx.profile.faultInjection?.kinds ?? [],
      // What the APP can be made to do vs. what this deployment will accept
      // from an HTTP caller. The dashboard hides its fault controls on this.
      injectEnabled: allowInject,
      transactionToken: ctx.profile.transactionToken?.fieldName,
      policy: {
        allowedOrigins: ctx.policy.allowedOrigins,
        deniedPathPrefixes: ctx.policy.deniedPathPrefixes,
        allowedActions: ctx.policy.allowedActions,
        irreversibleActionMode: ctx.policy.irreversibleActionMode,
      },
      appRecoveries: (ctx.profile.recoveries ?? []).map((r) => ({ code: r.code, description: r.description })),
      appAnomalies: (ctx.profile.anomalies ?? []).map((a) => ({ code: a.code, description: a.description })),
      // The broken artifacts ride on THIS route, not on /api/capabilities.
      // /api/capabilities is an agent's tool list: everything in it must be
      // callable, so a file that does not load has no honest representation
      // there and adding one invites a caller to invoke it. /api/profile is
      // already the "what is this deployment, and what is wrong with it"
      // surface (policy, roles, fault flag) that the dashboard loads first, so
      // that is where an operator is told a recording is unusable.
      catalog: { dir: ctx.capabilitiesDir, callable: catalog.entries.length, broken: catalog.broken },
    });
  });

  // ---- the agent-facing catalog ----
  // 200 with the CALLABLE entries even when siblings are broken: one malformed
  // artifact used to 500 this route, /api/capabilities/:name, invoke AND
  // health, so a reviewer saw a dashboard that loaded next to an empty catalog
  // with nothing anywhere saying why.
  app.get('/api/capabilities', (_req, res) => {
    res.json(loadCatalog(ctx.capabilitiesDir).entries);
  });

  app.get('/api/capabilities/:name', (req, res) => {
    try {
      const { entries, broken } = loadCatalog(ctx.capabilitiesDir);
      const entry = entries.find((e) => e.name === req.params.name);
      if (!entry) {
        // A name that matches a file which did not load answers 422 with the
        // schema error, rather than a 404 that sends the operator hunting for
        // a recording that is sitting right there.
        const bad = broken.find((b) => b.name === req.params.name);
        if (bad) {
          res.status(422).json({ error: `capability '${req.params.name}' is recorded in '${bad.file}' but that artifact does not load: ${bad.error}`, file: bad.file });
          return;
        }
        res.status(404).json({ error: `no capability '${req.params.name}'` });
        return;
      }
      res.json({ ...entry, artifact: artifactFor(ctx, req.params.name) });
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * Invoke by name with typed args.
   *
   * A capability that can PAUSE FOR A HUMAN is forced async: a decision that
   * may take minutes must not ride on an open HTTP request that an
   * intermediary will cut. "Can pause" is asked of the artifact AFTER the app
   * profile is merged — see `pausesForHuman` — because the profile is what
   * adds the escalating recoveries, and the raw file has not seen it.
   */
  app.post('/api/capabilities/:name/invoke', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { params?: Record<string, string>; options?: Record<string, unknown> };
    const name = String(req.params.name);
    try {
      // 404 unknown, 422 present-but-unloadable — never a 500, and never a
      // silent "not found" for an artifact that exists with a schema error.
      const entry = entryFor(ctx, name);
      // Fault injection rewrites requests against the LIVE target so the app
      // returns a forced error — a harness affordance that sits below the
      // ActionGate, and had no business being reachable by an unauthenticated
      // caller. The CLI's `--inject` goes straight to the engine and is
      // unaffected; a replayed artifact still cannot reach injection at all.
      if (body.options?.['inject'] !== undefined && !allowInject) {
        res.status(400).json({
          error: 'fault injection is not enabled on this server; start it with CU_ALLOW_INJECT=1 to allow options.inject',
        });
        return;
      }
      // The artifact AS IT WILL RUN. `entry.maxRisk` alone was the old test,
      // and it missed every read-only capability that the profile's
      // SUPERVISOR_OVERRIDE_REQUIRED recovery can park on a human.
      const merged = mergedArtifactFor(ctx, name);
      const escalating = escalatingRecoveries(merged);
      const wantsAsync = body.options?.['async'] === true || pausesForHuman(merged);
      const started = startInvocation(ctx, {
        name,
        params: body.params ?? {},
        options: (body.options ?? {}) as never,
      });

      if (wantsAsync) {
        started.done.catch(() => undefined); // failures are reported through the run record
        res.status(202).json({
          runId: started.runId,
          status: 'running',
          async: true,
          reason:
            entry.maxRisk === 'irreversible'
              ? 'This capability contains an irreversible step: it will pause for human approval before anything posts. Watch the run or poll it.'
              : escalating.length > 0
                ? `This capability can pause for a human (recoveries: ${escalating.join(', ')}), so it is dispatched asynchronously rather than holding this request open for the intervention timeout. Watch the run or poll it.`
                : 'Run started.',
          stream: `/api/runs/${started.runId}/stream`,
        });
        return;
      }

      const result = await started.done;
      res.json(shapeResult(ctx, name, result));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- runs: history, detail, live stream, evidence ----
  // `role` is a property of the INVOCATION, not of the artifact, so it is not
  // reconstructible from evidence written before the engine logged it. Runs
  // this process started carry it; older runs and runs from other processes
  // simply have no field, which is honest rather than guessed.
  const withRole = <T extends { runId: string }>(summary: T): T & { role?: string } => {
    const role = roleForRun(summary.runId);
    return role !== undefined ? { ...summary, role } : summary;
  };

  app.get('/api/runs', (req, res) => {
    const limit = Math.min(Number(req.query['limit'] ?? 100) || 100, 500);
    const requested = req.query['kind'];
    const kind = requested === 'discovery' || requested === 'replay' ? requested : undefined;
    res.json(ctx.store.list(limit, kind).map(withRole));
  });

  app.get('/api/runs/:runId', (req, res) => {
    const detail = ctx.store.detail(req.params.runId);
    if (!detail) {
      res.status(404).json({ error: `no run '${req.params.runId}'` });
      return;
    }
    res.json({ ...detail, summary: withRole(detail.summary) });
  });

  /** Server-sent events: the run's history, then everything as it happens. */
  app.get('/api/runs/:runId/stream', (req, res) => {
    const live = ctx.store.isLive(String(req.params.runId));
    // Resolve BEFORE committing to a 200. A run id that does not exist is not
    // a run with no events: streaming an empty history and a `done` renders a
    // finished, blank run in the console, while `GET /api/runs/:runId` 404s the
    // very same id. Once writeHead has gone out there is no status left to send.
    if (!live && ctx.store.detail(String(req.params.runId)) === undefined) {
      res.status(404).json({ error: `no run '${String(req.params.runId)}'` });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (line: string): void => {
      res.write(`data: ${line}\n\n`);
    };
    if (!live) {
      // A finished run: replay its recorded events so history renders through
      // the same view as a live run. Deliberately NOT combined with the live
      // buffer — sending both delivered every event twice.
      const detail = ctx.store.detail(String(req.params.runId));
      for (const event of detail?.events ?? []) send(JSON.stringify(event));
      res.write('event: done\ndata: {}\n\n');
      res.end();
      return;
    }
    // A live run has to ANNOUNCE its end. Without the `done` event the lines
    // simply stop arriving, the client never learns the run finished, and it
    // never fetches the structured result — so the outputs panel stays empty
    // for exactly the runs a person watched happen.
    // `finish` closes over `keepAlive` and `unsubscribe`, both declared below:
    // it is passed to `subscribe` as a callback, so it has to be defined first.
    // Safe because `subscribe` only REGISTERS the callback — the earliest call
    // is the explicit one after the declarations.
    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      res.write('event: done\ndata: {}\n\n');
      res.end();
      // Drop the listener in the same breath as ending the response. Leaving it
      // registered until `req.on('close')` fires leaves a window in which a
      // publish writes to an ended response — and that raises an ASYNC error on
      // the response object, which `publish`'s try/catch cannot catch.
      unsubscribe();
    };
    const { history, unsubscribe } = ctx.store.subscribe(String(req.params.runId), send, finish);
    for (const line of history) send(line);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
    keepAlive.unref?.();
    // The run may have finished between isLive() above and subscribing here.
    if (!ctx.store.isLive(String(req.params.runId))) finish();
    req.on('close', () => {
      closed = true;
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // Express 5 requires a NAMED wildcard; `splat` arrives as path segments.
  app.get('/api/runs/:kind/:runId/evidence/*splat', (req, res) => {
    try {
      const splat = (req.params as unknown as Record<string, string | string[]>)['splat'];
      const rel = Array.isArray(splat) ? splat.join('/') : String(splat ?? '');
      const file = evidencePath(ctx, String(req.params.kind), String(req.params.runId), rel);
      if (!existsSync(file)) {
        res.status(404).json({ error: 'no such evidence file' });
        return;
      }
      if (file.endsWith('.png')) res.type('png');
      else if (file.endsWith('.json')) res.type('json');
      else res.type('text/plain');
      createReadStream(file).pipe(res);
    } catch (err) {
      fail(res, err);
    }
  });

  /** List a run's evidence files, so a viewer can browse the audit trail
   * without reconstructing filenames from the event stream. */
  app.get('/api/runs/:kind/:runId/evidence', (req, res) => {
    try {
      const root = evidencePath(ctx, String(req.params.kind), String(req.params.runId), '.');
      if (!existsSync(root)) {
        res.status(404).json({ error: 'no such run' });
        return;
      }
      const walk = (dir: string, prefix = ''): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
            : [`${prefix}${entry.name}`],
        );
      res.json({ runId: req.params.runId, files: walk(root).sort() });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- human-in-the-loop, preserved through the new surface ----
  /**
   * Open interventions. Carries NO nonce: this is an unauthenticated read, and
   * a nonce handed out here would be one GET away from approving a transfer —
   * which is the whole thing the nonce exists to prevent. `HttpOperator.list()`
   * has already run the payload through the run's redactor.
   *
   * `key` is what addresses an intervention on the two routes below;
   * `id` remains the run-local id (`int-01`), which is NOT unique across runs.
   */
  app.get('/api/interventions', (_req, res) => {
    res.json(
      HttpOperator.list().map((open) => ({
        ...open.request,
        key: open.key,
        options: open.options,
        raisedAt: open.raisedAt,
        runId: open.runId,
        // The dashboard needs a URL, not an evidence-relative path.
        screenshotUrl:
          open.request.screenshotRef !== undefined
            ? `/api/runs/${open.request.origin ?? 'replay'}/${open.runId}/evidence/${open.request.screenshotRef}`
            : undefined,
      })),
    );
  });

  /**
   * The approval nonce for one intervention, fetched at approve time.
   *
   * Splitting it off the listing is worth only what the transport guard in
   * front of it is worth: it means a caller must name a specific intervention
   * rather than harvest every nonce from a listing it was polling anyway. With
   * the Host check above, a rebound cross-origin page cannot reach either.
   */
  app.get('/api/interventions/:key/nonce', (req, res) => {
    const nonce = HttpOperator.nonceFor(String(req.params.key));
    if (nonce === undefined) {
      res.status(404).json({ error: `no open intervention '${req.params.key}'` });
      return;
    }
    res.json({ key: req.params.key, nonce });
  });

  app.post('/api/interventions/:key/resolve', (req, res) => {
    const body = (req.body ?? {}) as { action?: string; note?: string; nonce?: string };
    const outcome = HttpOperator.resolve(
      String(req.params.key),
      body.action as never,
      body.nonce ?? '',
      body.note,
    );
    res.status(outcome.ok ? 200 : 400).json(outcome);
  });

  // ---- the chatbot's back end ----
  app.post('/api/chat', async (req, res) => {
    // Every artifact, policy, overlay and profile in this repo is Zod-validated;
    // this body was the one shape that went through unchecked, straight into
    // `req.messages.map(...)`. That made `{}` a 500 with a raw JS error, and it
    // let a caller hand the planner arbitrary content blocks — forged
    // tool_results included — in the context it reasons over. `.strict()`
    // matters more than the field types here: it is what refuses the extra key.
    const parsed = ChatRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: `invalid chat request: ${parsed.error.issues[0]?.message ?? 'bad shape'}` });
      return;
    }
    try {
      // Spread conditionally rather than passing `mode: undefined`, which
      // `exactOptionalPropertyTypes` treats as a different thing from absent.
      res.json(
        await handleChat(ctx, {
          messages: parsed.data.messages,
          ...(parsed.data.mode !== undefined ? { mode: parsed.data.mode } : {}),
        }),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  /**
   * `ok` is about THIS PROCESS: it is serving, and it answers even when every
   * artifact in the directory is malformed (it used to 500 on the first one).
   * The artifacts get their own two counts, because "the API is up" and "the
   * recordings load" are different questions and a health check that conflates
   * them can only answer one of them honestly.
   */
  app.get('/api/health', (_req, res) => {
    const { entries, broken } = loadCatalog(ctx.capabilitiesDir);
    res.json({
      ok: true,
      app: ctx.profile.appId,
      capabilities: entries.length,
      brokenCapabilities: broken.length,
      broken: broken.map((b) => ({ file: b.file, error: b.error })),
    });
  });

  // ---- static surfaces ----
  // Mounted unconditionally: resolving at request time means the UIs are
  // served even if they were added after the process started.
  app.use('/chat', express.static(path.join(WEB_ROOT, 'chat')));
  app.use('/', express.static(path.join(WEB_ROOT, 'dashboard')));

  // ---- the last word on any error ----
  // Without this, anything that throws before a route can answer — a malformed
  // JSON body, an over-large body, an unexpected route failure — falls through
  // to Express's default handler, which serves `err.stack` as HTML whenever
  // NODE_ENV is unset. That is every script in package.json. The trace names
  // the operator's home directory, the checkout path and the dependency
  // layout, and it is the one channel on this server that has never passed
  // through a redactor. It is also, during a demo, on a projector.
  //
  // Four arguments, and `next` unused: Express identifies an error handler by
  // arity alone, so the parameter has to stay.
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
    // A 4xx is the caller's own malformed request, so its message is safe and
    // useful. A 5xx is ours: say nothing, and keep the detail server-side.
    const message = status >= 400 && status < 500 ? ((err as Error).message ?? 'bad request') : 'internal error';
    if (status >= 500) console.error('[api] unhandled error:', err);
    if (!res.headersSent) res.status(status).json({ error: message });
  });

  return { app, ctx };
}

/** The caller-facing shape of a finished run. */
export function shapeResult(ctx: ApiContext, name: string, result: ReplayResult): unknown {
  const artifact = artifactFor(ctx, name);
  const base = {
    runId: result.runId,
    capabilityId: result.capabilityId,
    version: result.version,
    status: result.status,
    evidenceDir: result.evidenceDir,
    stepsRun: result.stepsRun,
    recoveriesUsed: result.recoveriesUsed,
    interventions: result.interventions,
    irreversibleCompleted: result.irreversibleCompleted,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  };
  // Outputs reach the CALLER unredacted — an invoking agent is entitled to the
  // value it asked for. Evidence on disk is redacted; these are two channels
  // by design, exactly as the CLI's stdout and its run log are.
  if (result.status === 'success' || result.status === 'business_outcome') {
    return {
      ...base,
      outputs: shapeOutputs(artifact, result.outputs),
      ...(result.status === 'business_outcome' ? { code: result.code, message: result.message } : {}),
    };
  }
  if (result.status === 'failed') return { ...base, failure: result.failure };
  return { ...base, interventionId: result.interventionId, reason: result.reason, resolution: result.resolution };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // An EMPTY env var means "not configured", not "configure me with an empty
  // string". `cp .env.example .env` leaves the optional keys present-but-blank,
  // and `CU_POLICY=` alone was enough to crash a fresh clone on first run with
  // an ENOENT on path `''` — the first thing a new reader would ever see.
  const env = (name: string): string | undefined => {
    const raw = process.env[name];
    return raw !== undefined && raw.trim() !== '' ? raw : undefined;
  };
  const port = Number(env('CU_API_PORT') ?? 4180);
  const { app, ctx } = createApiApp({
    ...(env('CU_APP_PROFILE') !== undefined ? { profileFile: env('CU_APP_PROFILE')! } : {}),
    ...(env('CU_EVIDENCE_DIR') !== undefined ? { evidenceBaseDir: env('CU_EVIDENCE_DIR')! } : {}),
    ...(env('CU_CAPABILITIES_DIR') !== undefined ? { capabilitiesDir: env('CU_CAPABILITIES_DIR')! } : {}),
    ...(env('CU_POLICY') !== undefined ? { policyFile: env('CU_POLICY')! } : {}),
  });
  // Loopback bind AND a loopback-Host check: the bind stops the network, the
  // Host check stops a rebound browser tab.
  app.listen(port, '127.0.0.1', () => {
    console.log(`capability API  → http://127.0.0.1:${port}/api/capabilities`);
    console.log(`dashboard       → http://127.0.0.1:${port}/`);
    console.log(`chatbot         → http://127.0.0.1:${port}/chat/`);
    console.log(`target          → ${ctx.profile.title} (${ctx.profile.baseUrl})`);
    console.log(
      process.env['CU_ALLOW_INJECT'] === '1'
        ? 'fault injection → ENABLED over HTTP (CU_ALLOW_INJECT=1) — harness mode, do not run this against production'
        : 'fault injection → disabled over HTTP (set CU_ALLOW_INJECT=1 to allow options.inject)',
    );
    const slow = Number(process.env['CU_DEMO_SLOW_MO'] ?? '');
    if ((Number.isFinite(slow) && slow > 0) || process.env['CU_DEMO_HEADED'] === '1') {
      console.log(
        `demo pacing     → every run ${process.env['CU_DEMO_HEADED'] === '1' ? 'HEADED' : 'headless'}` +
          `${Number.isFinite(slow) && slow > 0 ? `, slow-mo ${slow}ms` : ''} — presentation mode, not production`,
      );
    }
  });
}
