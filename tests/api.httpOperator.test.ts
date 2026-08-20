/**
 * The HTTP operator seam — specifically its nonce, which is the only thing
 * standing between an unauthenticated local POST and an irreversible banking
 * action. Everything here is offline: `handle()` never touches the session it
 * is handed, so a bare object stands in for the live page.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HttpOperator } from '../src/api/httpOperator.js';
import { Redactor } from '../src/policy/redact.js';
import type { OperatorSessionAccess } from '../src/hitl/sessionController.js';
import type { InterventionKind, InterventionRequest, OperatorAction } from '../src/schema/result.js';

/** The operator surface reads nothing off the session, so this is enough. */
const session = {} as OperatorSessionAccess;

let seq = 0;

function request(options: OperatorAction[], kind: InterventionKind = 'approve_risky'): InterventionRequest {
  seq += 1;
  return {
    id: `int-${String(seq).padStart(2, '0')}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    kind,
    origin: 'replay',
    capabilityId: 'member.transferFunds',
    version: '1.0.0',
    runId: 'run-under-test',
    stepId: 's7',
    stepIntent: 'Post the transfer',
    reason: 'irreversible step awaits a human decision',
    suggestedResolution: 'Approve to post the transfer, or abort to leave the funds where they are.',
    options,
    observationSummary: 'Review screen: $250.00 from S00 REGULAR SAVINGS to S01 CHECKING',
  };
}

/** The registry is keyed globally; a request id is only run-local. */
function keyFor(id: string): string {
  const open = HttpOperator.list().find((o) => o.request.id === id);
  if (!open) throw new Error(`no open intervention '${id}'`);
  return open.key;
}

function nonceFor(id: string): string {
  const nonce = HttpOperator.nonceFor(keyFor(id));
  if (nonce === undefined) throw new Error(`no nonce for '${id}'`);
  return nonce;
}

afterEach(async () => {
  // Settle anything a test left open so no promise (or timer) outlives it.
  for (const open of HttpOperator.list()) {
    HttpOperator.resolve(open.key, 'abort', HttpOperator.nonceFor(open.key) ?? '', 'test cleanup');
  }
  await Promise.resolve();
});

describe('HttpOperator: the nonce is the gate on irreversible actions', () => {
  it('refuses a resolution with NO nonce, and leaves the intervention open', async () => {
    const op = new HttpOperator('run-1', { timeoutMs: 60_000 });
    const req = request(['approve', 'abort']);
    const pending = op.handle(req, session);

    const outcome = HttpOperator.resolve(keyFor(req.id), 'approve', '');
    expect(outcome).toEqual({ ok: false, error: 'invalid or missing approval nonce' });
    // Still awaiting a human: the refusal must not have settled anything.
    expect(HttpOperator.list().map((o) => o.request.id)).toContain(req.id);

    HttpOperator.resolve(keyFor(req.id), 'abort', nonceFor(req.id));
    await expect(pending).resolves.toMatchObject({ action: 'abort' });
  });

  it('refuses a WRONG nonce — including another intervention’s valid one', async () => {
    const op = new HttpOperator('run-1', { timeoutMs: 60_000 });
    const a = request(['approve', 'abort']);
    const b = request(['approve', 'abort']);
    const pendingA = op.handle(a, session);
    const pendingB = op.handle(b, session);

    expect(HttpOperator.resolve(keyFor(a.id), 'approve', 'not-the-nonce')).toEqual({
      ok: false,
      error: 'invalid or missing approval nonce',
    });
    // A nonce is scoped to ONE intervention: holding one must not approve another.
    expect(HttpOperator.resolve(keyFor(a.id), 'approve', nonceFor(b.id))).toEqual({
      ok: false,
      error: 'invalid or missing approval nonce',
    });
    expect(nonceFor(a.id)).not.toBe(nonceFor(b.id));

    HttpOperator.resolve(keyFor(a.id), 'abort', nonceFor(a.id));
    HttpOperator.resolve(keyFor(b.id), 'abort', nonceFor(b.id));
    await expect(pendingA).resolves.toMatchObject({ action: 'abort' });
    await expect(pendingB).resolves.toMatchObject({ action: 'abort' });
  });

  it('settles the waiting run with the chosen action when the nonce is right', async () => {
    const op = new HttpOperator('run-1', { timeoutMs: 60_000 });
    const req = request(['approve', 'abort']);
    const pending = op.handle(req, session);

    expect(HttpOperator.resolve(keyFor(req.id), 'approve', nonceFor(req.id), 'verified with the member by phone')).toEqual({
      ok: true,
    });
    await expect(pending).resolves.toEqual({ action: 'approve', note: 'verified with the member by phone' });
  });

  it('omits the note entirely when none is given (rather than sending undefined)', async () => {
    const op = new HttpOperator('run-1', { timeoutMs: 60_000 });
    const req = request(['approve', 'abort']);
    const pending = op.handle(req, session);
    HttpOperator.resolve(keyFor(req.id), 'approve', nonceFor(req.id));
    const resolution = await pending;
    expect(resolution).toEqual({ action: 'approve' });
    expect(Object.hasOwn(resolution, 'note')).toBe(false);
  });

  it('refuses an action the intervention never OFFERED', async () => {
    const op = new HttpOperator('run-1', { timeoutMs: 60_000 });
    const req = request(['approve', 'abort']);
    const pending = op.handle(req, session);

    const outcome = HttpOperator.resolve(keyFor(req.id), 'resume', nonceFor(req.id));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("'resume' is not offered");
    expect(outcome.error).toContain('approve, abort');
    expect(HttpOperator.list().map((o) => o.request.id)).toContain(req.id);

    HttpOperator.resolve(keyFor(req.id), 'abort', nonceFor(req.id));
    await expect(pending).resolves.toMatchObject({ action: 'abort' });
  });

  it('refuses an unknown intervention id', () => {
    expect(HttpOperator.resolve('int-does-not-exist', 'approve', 'anything')).toEqual({
      ok: false,
      error: "no open intervention 'int-does-not-exist'",
    });
  });

  it('refuses a SECOND resolution — an approval cannot be replayed', async () => {
    const op = new HttpOperator('run-1', { timeoutMs: 60_000 });
    const req = request(['approve', 'abort']);
    const pending = op.handle(req, session);
    const key = keyFor(req.id);
    const nonce = nonceFor(req.id);

    expect(HttpOperator.resolve(key, 'approve', nonce)).toEqual({ ok: true });
    // Same key, same (now spent) nonce: refused, so the promise cannot settle twice.
    expect(HttpOperator.resolve(key, 'approve', nonce)).toEqual({
      ok: false,
      error: `no open intervention '${key}'`,
    });
    // ...and the nonce route stops answering for it at the same moment.
    expect(HttpOperator.nonceFor(key)).toBeUndefined();
    await expect(pending).resolves.toEqual({ action: 'approve' });
  });

  it('removes the intervention from list() the moment it is resolved', async () => {
    const op = new HttpOperator('run-1', { timeoutMs: 60_000 });
    const req = request(['approve', 'abort']);
    const pending = op.handle(req, session);
    expect(HttpOperator.list().map((o) => o.request.id)).toContain(req.id);

    HttpOperator.resolve(keyFor(req.id), 'abort', nonceFor(req.id));
    expect(HttpOperator.list().map((o) => o.request.id)).not.toContain(req.id);
    await pending;
  });

  it('mints an unguessable, single-use nonce that is not derivable from the request', async () => {
    const op = new HttpOperator('run-1', { timeoutMs: 60_000 });
    const req = request(['approve', 'abort']);
    const pending = op.handle(req, session);
    const open = HttpOperator.list().find((o) => o.request.id === req.id);
    expect(open).toBeDefined();
    if (!open) return;

    const nonce = HttpOperator.nonceFor(open.key);
    expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // The nonce is a separate field, never smeared into the request payload
    // that the run writes to evidence and the engine logs — and, since the
    // listing is an unauthenticated read, never on the listing at all.
    expect(JSON.stringify(open.request)).not.toContain(nonce);
    expect(JSON.stringify(open)).not.toContain(nonce);
    expect(Object.hasOwn(open, 'nonce')).toBe(false);
    expect(open.runId).toBe('run-1');
    expect(open.key).toBe(`run-1:${req.id}`);

    HttpOperator.resolve(open.key, 'abort', nonce ?? '');
    await pending;
  });
});

describe('HttpOperator: two runs may raise the SAME intervention id', () => {
  /** `SessionController` numbers per RUN, so `int-01` twice is normal traffic. */
  function intervention(id: string, runId: string): InterventionRequest {
    return { ...request(['approve', 'abort']), id, runId };
  }

  it('keeps both registered, resolvable and independently addressable', async () => {
    const a = new HttpOperator('run-A', { timeoutMs: 60_000 });
    const b = new HttpOperator('run-B', { timeoutMs: 60_000 });
    const reqA = intervention('int-01', 'run-A');
    const reqB = intervention('int-01', 'run-B');
    const pendingA = a.handle(reqA, session);
    const pendingB = b.handle(reqB, session);

    // Neither evicted the other: the old id-keyed Map held exactly one entry.
    const open = HttpOperator.list().filter((o) => o.request.id === 'int-01');
    expect(open).toHaveLength(2);
    expect(open.map((o) => o.key).sort()).toEqual(['run-A:int-01', 'run-B:int-01']);

    const nonceA = HttpOperator.nonceFor('run-A:int-01') ?? '';
    const nonceB = HttpOperator.nonceFor('run-B:int-01') ?? '';
    expect(nonceA).not.toBe(nonceB);
    // A's nonce cannot resolve B, even though the two share an id.
    expect(HttpOperator.resolve('run-B:int-01', 'approve', nonceA)).toEqual({
      ok: false,
      error: 'invalid or missing approval nonce',
    });

    expect(HttpOperator.resolve('run-A:int-01', 'approve', nonceA)).toEqual({ ok: true });
    await expect(pendingA).resolves.toMatchObject({ action: 'approve' });
    // B survived A settling, and still holds its own nonce.
    expect(HttpOperator.list().map((o) => o.key)).toEqual(['run-B:int-01']);
    expect(HttpOperator.resolve('run-B:int-01', 'abort', nonceB)).toEqual({ ok: true });
    await expect(pendingB).resolves.toMatchObject({ action: 'abort' });
  });

  it('lets one run TIME OUT without cancelling the other run’s timer', async () => {
    // The old `finish` looked its entry up by id, so the short-timeout run
    // cleared and deleted whichever entry currently held `int-01` — the OTHER
    // run — leaving that run's promise unsettled forever, its browser parked
    // mid-transaction, and its concurrency slot burned.
    const shortLived = new HttpOperator('run-short', { timeoutMs: 25 });
    const longLived = new HttpOperator('run-long', { timeoutMs: 250 });
    const pendingShort = shortLived.handle(intervention('int-01', 'run-short'), session);
    const pendingLong = longLived.handle(intervention('int-01', 'run-long'), session);

    await expect(pendingShort).resolves.toMatchObject({ action: 'abort' });
    // The long run must still be waiting on ITS OWN timer, not deleted.
    expect(HttpOperator.list().map((o) => o.key)).toEqual(['run-long:int-01']);
    // ...and it must eventually settle rather than hang.
    await expect(pendingLong).resolves.toMatchObject({ action: 'abort' });
    expect(HttpOperator.list()).toHaveLength(0);
  });
});

describe('HttpOperator: the listing is redacted like the evidence log', () => {
  it('scrubs regulated values out of the on-screen summary it publishes', async () => {
    const redactor = new Redactor();
    redactor.register('memberName', 'MARGARET OKONKWO', 'pii');
    redactor.register('operatorPassword', 'hunter2-supervisor', 'secret');
    const op = new HttpOperator('run-redacted', { timeoutMs: 60_000, redactor });
    const req: InterventionRequest = {
      ...request(['approve', 'abort']),
      observationSummary:
        'at /transfer; headings: MARGARET OKONKWO | REGULAR SAVINGS; text: "MARGARET OKONKWO 47 Alder Way $4,821.97…"',
      reason: 'confirm the transfer for MARGARET OKONKWO',
    };
    const pending = op.handle(req, session);

    const open = HttpOperator.list().find((o) => o.request.id === req.id);
    const serialized = JSON.stringify(open);
    expect(serialized).not.toContain('MARGARET OKONKWO');
    expect(serialized).not.toContain('hunter2-supervisor');
    // Masked, not dropped: the operator still sees which screen they are on.
    expect(open?.request.observationSummary).toContain('***WO');
    expect(open?.request.observationSummary).toContain('$4,821.97');
    // The in-memory request the ENGINE holds is untouched — this is a view.
    expect(req.observationSummary).toContain('MARGARET OKONKWO');

    HttpOperator.resolve(open?.key ?? '', 'abort', HttpOperator.nonceFor(open?.key ?? '') ?? '');
    await pending;
  });
});

describe('HttpOperator: what this surface can and cannot honour', () => {
  it('never offers resume — an HTTP client has no live page to work on', async () => {
    const op = new HttpOperator('run-1', { timeoutMs: 60_000 });
    const req = request(['resume', 'abort'], 'human_action_required');
    const pending = op.handle(req, session);

    const open = HttpOperator.list().find((o) => o.request.id === req.id);
    expect(open?.options).toEqual(['abort']);
    // The request itself still records what the engine would accept; only the
    // offered set is narrowed.
    expect(open?.request.options).toEqual(['resume', 'abort']);

    HttpOperator.resolve(keyFor(req.id), 'abort', nonceFor(req.id));
    await expect(pending).resolves.toMatchObject({ action: 'abort' });
  });

  it('always adds abort, so an intervention is never unresolvable', async () => {
    const op = new HttpOperator('run-1', { timeoutMs: 60_000 });
    const req = request(['resume'], 'agent_stuck');
    const pending = op.handle(req, session);
    expect(nonceFor(req.id)).toBeTruthy();
    expect(HttpOperator.list().find((o) => o.request.id === req.id)?.options).toEqual(['abort']);
    HttpOperator.resolve(keyFor(req.id), 'abort', nonceFor(req.id));
    await expect(pending).resolves.toMatchObject({ action: 'abort' });
  });

  it('times out to ABORT — the safe default is never an approval', async () => {
    const raised: string[] = [];
    const resolved: string[] = [];
    const op = new HttpOperator('run-timeout', {
      timeoutMs: 25,
      onRaised: (open) => raised.push(open.request.id),
      onResolved: (key) => resolved.push(key),
    });
    const req = request(['approve', 'abort']);

    const resolution = await op.handle(req, session);
    expect(resolution.action).toBe('abort');
    expect(resolution.note).toContain('no operator resolved this');
    expect(raised).toEqual([req.id]);
    expect(resolved).toEqual([`run-timeout:${req.id}`]);
    // Timed out means gone: a late POST with the original nonce cannot approve it.
    expect(HttpOperator.list().map((o) => o.request.id)).not.toContain(req.id);
    expect(HttpOperator.resolve(`run-timeout:${req.id}`, 'approve', 'anything').ok).toBe(false);
  });
});
