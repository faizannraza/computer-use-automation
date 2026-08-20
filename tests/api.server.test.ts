/**
 * The Express surface, driven over a real loopback socket on an ephemeral
 * port. No browser, no model key, no outbound network: every run in this file
 * is fabricated evidence or an intervention raised directly against the
 * operator.
 *
 * The routes that matter here are the two that reach past the API's own data:
 * evidence serves files off disk, and resolving an intervention releases an
 * irreversible action.
 */
import http from 'node:http';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpOperator } from '../src/api/httpOperator.js';
import { createApiApp } from '../src/api/server.js';
import type { ApiContext } from '../src/api/invoke.js';
import type { OperatorSessionAccess } from '../src/hitl/sessionController.js';
import type { InterventionRequest, ReplayResult } from '../src/schema/result.js';

const RUN_ID = '20260401-120000-abcd';

let tmpRoot: string;
let evidenceBaseDir: string;
let server: Server;
let base: string;
let ctx: ApiContext;
const savedEnv: Record<string, string | undefined> = {};

const get = async (url: string): Promise<Response> => fetch(`${base}${url}`);

/**
 * A GET whose path reaches the server EXACTLY as written. `fetch` normalizes
 * `%2e%2e` away before the request leaves the process, which would quietly
 * defuse the traversal probes below — an attacker's client does no such thing.
 */
async function rawGet(rawPath: string): Promise<{ status: number; body: string }> {
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addr.port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cu-api-'));
  evidenceBaseDir = path.join(tmpRoot, 'evidence');
  // A file the evidence route must never be able to reach: it sits one level
  // above the evidence base, exactly where a real deployment keeps its .env.
  writeFileSync(path.join(tmpRoot, 'secret.txt'), 'ANTHROPIC_API_KEY=sk-super-secret', 'utf8');

  const runDir = path.join(evidenceBaseDir, 'replay', RUN_ID);
  mkdirSync(path.join(runDir, 'steps'), { recursive: true });
  writeFileSync(path.join(runDir, 'run.jsonl'), `${JSON.stringify({ ts: '2026-04-01T12:00:00.000Z', type: 'run_start', capability: 'member.readBalances@1.0.0' })}\n`, 'utf8');
  writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'success', capabilityId: 'member.readBalances', version: '1.0.0', startedAt: '2026-04-01T12:00:00.000Z', finishedAt: '2026-04-01T12:00:20.000Z' }), 'utf8');
  writeFileSync(path.join(runDir, 'steps', 's1.txt'), 'step one evidence', 'utf8');

  // Dummy credentials for the profile's roles: no run in this file reaches a
  // sign-on screen — every one is refused on its params before a browser could
  // exist — but the role indirection resolves them up front.
  for (const key of ['MERIDIAN_TELLER_ID', 'MERIDIAN_TELLER_PASSWORD', 'MERIDIAN_SUPERVISOR_ID', 'MERIDIAN_SUPERVISOR_PASSWORD']) {
    savedEnv[key] = process.env[key];
    process.env[key] = 'test-only';
  }

  const created = createApiApp({
    profileFile: 'profiles/meridian-core.profile.json',
    capabilitiesDir: 'capabilities-meridian',
    evidenceBaseDir,
    interventionTimeoutMs: 60_000,
    allowInject: false,
  });
  ctx = created.ctx;
  await new Promise<void>((resolve) => {
    server = created.app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(async () => {
  for (const open of HttpOperator.list()) {
    HttpOperator.resolve(open.key, 'abort', HttpOperator.nonceFor(open.key) ?? '', 'test cleanup');
  }
  await Promise.resolve();
});

describe('the agent-facing catalog', () => {
  it('GET /api/capabilities lists the catalog with an input schema per entry', async () => {
    const res = await get('/api/capabilities');
    expect(res.status).toBe(200);
    const entries = (await res.json()) as { name: string; inputSchema: { required: string[]; additionalProperties: boolean } }[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.name)).toContain('member.readBalances');
    const balances = entries.find((e) => e.name === 'member.readBalances');
    expect(balances?.inputSchema.required).toContain('memberId');
    // Env-sourced params are infrastructure, never caller input.
    expect(balances?.inputSchema.required).not.toContain('operatorPassword');
    expect(balances?.inputSchema.additionalProperties).toBe(false);
  });

  it('GET /api/capabilities/:name returns the artifact, and 404s an unknown name', async () => {
    const ok = await get('/api/capabilities/member.readBalances');
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { artifact: { capability: { id: string } } }).toMatchObject({
      artifact: { capability: { id: 'member.readBalances' } },
    });

    const missing = await get('/api/capabilities/member.nope');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "no capability 'member.nope'" });
  });

  it('GET /api/health and /api/profile describe what this deployment points at', async () => {
    expect(await (await get('/api/health')).json()).toMatchObject({ ok: true, app: 'meridian-core' });
    const profile = (await (await get('/api/profile')).json()) as { roles: string[]; policy: { allowedOrigins: string[] } };
    expect(profile.roles).toContain('teller');
    expect(profile.policy.allowedOrigins.length).toBeGreaterThan(0);
  });
});

describe('evidence is served only from inside the run directory', () => {
  it('serves a real evidence file', async () => {
    const res = await get(`/api/runs/replay/${RUN_ID}/evidence/steps/s1.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('step one evidence');
  });

  it('lists a run’s evidence files', async () => {
    const res = await get(`/api/runs/replay/${RUN_ID}/evidence`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { files: string[] }).toEqual({
      runId: RUN_ID,
      files: ['result.json', 'run.jsonl', 'steps/s1.txt'],
    });
  });

  it('refuses traversal in the file part of the path', async () => {
    for (const suffix of [
      '..%2f..%2fsecret.txt',
      '%2e%2e/%2e%2e/secret.txt',
      '..%2F..%2Fsecret.txt',
      '../../secret.txt',
      'steps/..%2f..%2f..%2fsecret.txt',
    ]) {
      const res = await rawGet(`/api/runs/replay/${RUN_ID}/evidence/${suffix}`);
      expect([400, 404]).toContain(res.status);
      expect(res.body).not.toContain('sk-super-secret');
    }
  });

  it('refuses traversal smuggled through the run KIND or run ID', async () => {
    // Express decodes %2e%2e into a '..' path PARAM — and kind/runId are what
    // the run directory is built from, so an unvalidated pair walks the root
    // itself out of the evidence tree and serves anything on disk.
    for (const rawPath of [
      `/api/runs/%2e%2e/%2e/evidence/secret.txt`,
      `/api/runs/%2e%2e/%2e%2e/evidence/${path.basename(tmpRoot)}/secret.txt`,
      `/api/runs/..%2f..%2fetc/x/evidence/passwd`,
      `/api/runs/%2e%2e/%2e/evidence`,
      `/api/runs/meridian/${RUN_ID}/evidence/run.jsonl`,
    ]) {
      const res = await rawGet(rawPath);
      expect(res.status).toBe(400);
      expect(res.body).not.toContain('sk-super-secret');
    }
  });

  it('404s a file that does not exist inside a legitimate run', async () => {
    const res = await get(`/api/runs/replay/${RUN_ID}/evidence/steps/nope.png`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such evidence file' });
  });
});

describe('runs: history and the event stream', () => {
  it('GET /api/runs lists what is on disk, and /api/runs/:id 404s an unknown run', async () => {
    const runs = (await (await get('/api/runs')).json()) as { runId: string; kind: string }[];
    expect(runs.map((r) => r.runId)).toContain(RUN_ID);
    expect(runs.find((r) => r.runId === RUN_ID)?.kind).toBe('replay');
    expect((await get('/api/runs/20990101-000000-zzzz')).status).toBe(404);
  });

  it('streams a FINISHED run’s events exactly once, then closes', async () => {
    const runId = 'run-finished-stream';
    ctx.store.start(runId, 'replay', 'member.readBalances', '1.0.0');
    ctx.store.publish(runId, JSON.stringify({ type: 'run_start', seq: 1 }));
    ctx.store.publish(runId, JSON.stringify({ type: 'step_ok', seq: 2 }));
    ctx.store.finish(runId, {
      capabilityId: 'member.readBalances',
      version: '1.0.0',
      runId,
      evidenceDir: path.join(evidenceBaseDir, 'replay', runId),
      status: 'success',
      outputs: {},
      stepsRun: [],
      recoveriesUsed: [],
      interventions: [],
      irreversibleCompleted: false,
      startedAt: '2026-04-01T12:00:00.000Z',
      finishedAt: '2026-04-01T12:00:10.000Z',
    } satisfies ReplayResult);

    const body = await (await get(`/api/runs/${runId}/stream`)).text();
    const payloads = body
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6));
    // Two events, each delivered once — history is replayed OR streamed,
    // never both.
    expect(payloads.filter((p) => p.includes('"seq":1'))).toHaveLength(1);
    expect(payloads.filter((p) => p.includes('"seq":2'))).toHaveLength(1);
    expect(body).toContain('event: done');
  });
});

describe('resolving an intervention requires its nonce', () => {
  const session = {} as OperatorSessionAccess;

  function raise(id: string): { request: InterventionRequest; pending: Promise<unknown> } {
    const request: InterventionRequest = {
      id,
      at: new Date().toISOString(),
      kind: 'approve_risky',
      origin: 'replay',
      capabilityId: 'member.transferFunds',
      version: '1.0.0',
      runId: RUN_ID,
      stepId: 's7',
      stepIntent: 'Post the transfer',
      reason: 'irreversible step awaits a human decision',
      suggestedResolution: 'Approve to post, abort to leave the funds where they are.',
      options: ['approve', 'abort'],
      observationSummary: 'Review: $250.00 from S00 to S01',
      screenshotRef: 'steps/s1.txt',
    };
    const pending = new HttpOperator(RUN_ID, { timeoutMs: 60_000 }).handle(request, session);
    return { request, pending };
  }

  /** The listing no longer carries nonces; the dashboard fetches one per approval. */
  async function nonceOf(key: string): Promise<string> {
    const res = await get(`/api/interventions/${encodeURIComponent(key)}/nonce`);
    if (res.status !== 200) return '';
    return ((await res.json()) as { nonce: string }).nonce;
  }

  async function listing(): Promise<{ id: string; key: string; options: string[]; runId: string; screenshotUrl?: string; observationSummary: string }[]> {
    return (await (await get('/api/interventions')).json()) as never;
  }

  it('refuses a POST with NO nonce and leaves the run waiting', async () => {
    const { request, pending } = raise('int-http-01');
    const key = `${RUN_ID}:${request.id}`;
    const res = await post(`/api/interventions/${encodeURIComponent(key)}/resolve`, { action: 'approve' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid or missing approval nonce' });

    // Still open: the guardrail held.
    expect((await listing()).map((o) => o.key)).toContain(key);

    const nonce = await nonceOf(key);
    expect((await post(`/api/interventions/${encodeURIComponent(key)}/resolve`, { action: 'abort', nonce })).status).toBe(200);
    await expect(pending).resolves.toMatchObject({ action: 'abort' });
  });

  it('refuses a wrong nonce, an unoffered action and an unknown key', async () => {
    const { request, pending } = raise('int-http-02');
    const key = `${RUN_ID}:${request.id}`;
    const url = `/api/interventions/${encodeURIComponent(key)}/resolve`;
    expect((await post(url, { action: 'approve', nonce: 'guessed' })).status).toBe(400);
    const nonce = await nonceOf(key);
    expect((await post(url, { action: 'resume', nonce })).status).toBe(400);
    expect((await post('/api/interventions/int-nobody/resolve', { action: 'approve', nonce })).status).toBe(400);

    expect((await post(url, { action: 'approve', nonce })).status).toBe(200);
    await expect(pending).resolves.toMatchObject({ action: 'approve' });
    // Spent: replaying the same POST cannot approve a second time.
    expect((await post(url, { action: 'approve', nonce })).status).toBe(400);
    // ...and the nonce route no longer answers for a settled intervention.
    expect((await get(`/api/interventions/${encodeURIComponent(key)}/nonce`)).status).toBe(404);
  });

  it('renders an open intervention with the options this surface can honour', async () => {
    const { request, pending } = raise('int-http-03');
    const entry = (await listing()).find((o) => o.id === request.id);
    expect(entry?.options).toEqual(['approve', 'abort']);
    expect(entry?.runId).toBe(RUN_ID);
    expect(entry?.key).toBe(`${RUN_ID}:${request.id}`);
    // The dashboard gets a URL it can fetch, not an evidence-relative path.
    expect(entry?.screenshotUrl).toBe(`/api/runs/replay/${RUN_ID}/evidence/steps/s1.txt`);
    expect((await get(entry?.screenshotUrl ?? '')).status).toBe(200);

    HttpOperator.resolve(entry?.key ?? '', 'abort', await nonceOf(entry?.key ?? ''));
    await pending;
  });

  it('NEVER publishes the nonce on the unauthenticated listing', async () => {
    const { request, pending } = raise('int-http-04');
    const key = `${RUN_ID}:${request.id}`;
    const raw = await (await get('/api/interventions')).text();
    const nonce = await nonceOf(key);

    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    // The whole point: polling the listing must not hand out the secret that
    // stands between an API call and an irreversible transfer.
    expect(raw).not.toContain(nonce);
    expect(raw).not.toContain('"nonce"');
    const entry = (JSON.parse(raw) as Record<string, unknown>[]).find((o) => o['key'] === key);
    expect(entry).toBeDefined();
    expect(Object.hasOwn(entry ?? {}, 'nonce')).toBe(false);

    expect((await post(`/api/interventions/${encodeURIComponent(key)}/resolve`, { action: 'abort', nonce })).status).toBe(200);
    await pending;
  });

  it('404s the nonce route for an intervention that is not open', async () => {
    const res = await get('/api/interventions/run-nobody%3Aint-01/nonce');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no open intervention 'run-nobody:int-01'" });
  });
});

describe('the Host header is the boundary, not the loopback bind', () => {
  /** A request whose Host header is chosen by the caller, as a rebound page's is. */
  async function withHost(host: string, path = '/api/interventions'): Promise<{ status: number; body: string }> {
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: addr.port, path, method: 'GET', headers: { Host: host }, setHost: false },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('rejects a rebound Host on every surface — API, evidence and the static UIs', async () => {
    // DNS rebinding makes `attacker.com` resolve to 127.0.0.1: the connection
    // is loopback and the page is same-origin, so CORS and the JSON content
    // type block nothing. The Host header is the part script cannot forge.
    for (const path of ['/api/interventions', '/api/capabilities', `/api/runs/replay/${RUN_ID}/evidence/run.jsonl`, '/', '/chat/']) {
      const res = await withHost('attacker.example', path);
      expect(res.status).toBe(403);
      expect(res.body).toContain('loopback Host');
    }
  });

  it('rejects a loopback-looking Host that is not loopback, and a missing one', async () => {
    for (const host of ['127.0.0.1.attacker.example', 'localhost.attacker.example', 'evil.com:4180', '0.0.0.0', '']) {
      expect((await withHost(host)).status).toBe(403);
    }
  });

  it('accepts every spelling of loopback an operator’s browser actually sends', async () => {
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    for (const host of ['127.0.0.1', `127.0.0.1:${addr.port}`, 'localhost', `localhost:${addr.port}`, '[::1]', `[::1]:${addr.port}`, 'LocalHost']) {
      expect((await withHost(host, '/api/health')).status).toBe(200);
    }
  });
});

describe('fault injection is a harness affordance, not an API feature', () => {
  /** A second app with the opt-in flag on, so both sides of the gate are real. */
  async function withInjectingServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
    const { app } = createApiApp({
      profileFile: 'profiles/meridian-core.profile.json',
      capabilitiesDir: 'capabilities-meridian',
      evidenceBaseDir,
      interventionTimeoutMs: 60_000,
      allowInject: true,
    });
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') throw new Error('no port');
      return await fn(`http://127.0.0.1:${addr.port}`);
    } finally {
      srv.close();
    }
  }

  it('400s options.inject when the server was not started with CU_ALLOW_INJECT=1', async () => {
    const res = await post('/api/capabilities/member.readBalances/invoke', {
      params: { memberId: '100234' },
      options: { inject: { kind: 'maintenance' } },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('CU_ALLOW_INJECT=1');
  });

  it('refuses it before the run starts, so no browser is launched for it', async () => {
    const before = ((await (await get('/api/runs?limit=500')).json()) as { runId: string }[]).length;
    await post('/api/capabilities/member.readBalances/invoke', {
      params: {},
      options: { inject: { kind: 'maintenance', atStepId: 's6' } },
    });
    expect(((await (await get('/api/runs?limit=500')).json()) as { runId: string }[]).length).toBe(before);
  });

  it('advertises the flag on /api/profile so the console can hide its controls', async () => {
    const off = (await (await get('/api/profile')).json()) as { injectEnabled: boolean; faultKinds: string[] };
    expect(off.injectEnabled).toBe(false);
    expect(off.faultKinds.length).toBeGreaterThan(0); // the APP can still be faulted; this deployment will not do it

    await withInjectingServer(async (url) => {
      const on = (await (await fetch(`${url}/api/profile`)).json()) as { injectEnabled: boolean };
      expect(on.injectEnabled).toBe(true);
    });
  });

  it('accepts options.inject once the flag is on', async () => {
    await withInjectingServer(async (url) => {
      const res = await fetch(`${url}/api/capabilities/member.readBalances/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: {}, options: { inject: { kind: 'maintenance' } } }),
      });
      // Past the gate: it fails on its missing param, not on the flag.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; failure?: { class: string } };
      expect(body.status).toBe('failed');
      expect(body.failure?.class).toBe('INVALID_PARAMS');
    });
  });
});

describe('requiresRole is enforced, and the role a run used is recorded', () => {
  let restrictedDir: string;
  let restricted: Server;
  let restrictedBase: string;

  beforeAll(async () => {
    // A capability that declares the supervisor-only badge the catalog already
    // rendered but nothing ever checked.
    restrictedDir = path.join(tmpRoot, 'capabilities-restricted');
    mkdirSync(restrictedDir, { recursive: true });
    const source = JSON.parse(readFileSync('capabilities-meridian/member.readBalances@1.0.0.json', 'utf8')) as {
      policy: { requiresRole?: string };
    };
    source.policy.requiresRole = 'supervisor';
    writeFileSync(path.join(restrictedDir, 'member.readBalances@1.0.0.json'), JSON.stringify(source), 'utf8');

    const { app } = createApiApp({
      profileFile: 'profiles/meridian-core.profile.json',
      capabilitiesDir: restrictedDir,
      evidenceBaseDir,
      interventionTimeoutMs: 60_000,
      allowInject: false,
    });
    restricted = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = restricted.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    restrictedBase = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => restricted.close());

  const invoke = async (body: unknown): Promise<Response> =>
    fetch(`${restrictedBase}/api/capabilities/member.readBalances/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('refuses the invocation when the caller’s role does not match the artifact’s', async () => {
    // The profile default is 'teller'; nothing was checked before, so a
    // supervisor-only function ran happily on teller credentials.
    const implicit = await invoke({ params: { memberId: '100234' } });
    expect(implicit.status).toBe(403);
    expect(((await implicit.json()) as { error: string }).error).toContain("requiresRole 'supervisor'");

    const explicit = await invoke({ params: { memberId: '100234' }, options: { role: 'teller' } });
    expect(explicit.status).toBe(403);
    expect(((await explicit.json()) as { error: string }).error).toContain("role 'teller'");
  });

  it('admits the matching role, and no run is started for a refused one', async () => {
    const before = ((await (await get('/api/runs?limit=500')).json()) as unknown[]).length;
    await invoke({ params: { memberId: '100234' }, options: { role: 'teller' } });
    expect(((await (await get('/api/runs?limit=500')).json()) as unknown[]).length).toBe(before);

    const ok = await invoke({ params: {}, options: { role: 'supervisor' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { status: string }).toMatchObject({ status: 'failed' });
  });

  it('carries the resolved role into /api/runs and /api/runs/:id', async () => {
    const started = (await (
      await post('/api/capabilities/member.readBalances/invoke', { params: {}, options: { role: 'supervisor', async: true } })
    ).json()) as { runId: string };
    // Wait for the run to reach its terminal state (params fail immediately).
    for (let i = 0; i < 50 && ctx.store.isLive(started.runId); i++) await new Promise((r) => setTimeout(r, 10));

    const listed = ((await (await get('/api/runs?limit=500')).json()) as { runId: string; role?: string }[]).find(
      (r) => r.runId === started.runId,
    );
    expect(listed?.role).toBe('supervisor');

    const detail = (await (await get(`/api/runs/${started.runId}`)).json()) as { summary: { role?: string } };
    expect(detail.summary.role).toBe('supervisor');
  });
});
