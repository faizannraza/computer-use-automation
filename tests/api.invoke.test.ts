/**
 * The single invocation path every caller goes through: parameter contract,
 * output shaping, the evidence-path guard, and the concurrency bound.
 *
 * Offline by construction — every run started here is refused on its params
 * before a browser could exist, which is exactly the boundary the engine
 * promises ("caller-side: params missing or malformed, no browser launched").
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvocationError, artifactFor, evidencePath, loadContext, shapeOutputs, startInvocation } from '../src/api/invoke.js';
import type { ApiContext } from '../src/api/invoke.js';
import { RunStore } from '../src/api/runStore.js';
import type { CapabilityArtifact } from '../src/schema/capability.js';

const PROFILE = 'profiles/meridian-core.profile.json';
const CAPABILITIES = 'capabilities-meridian';

let evidenceDir: string;
let ctx: ApiContext;
const savedEnv: Record<string, string | undefined> = {};

function context(maxConcurrentRuns = 4): ApiContext {
  return loadContext({
    profileFile: PROFILE,
    capabilitiesDir: CAPABILITIES,
    evidenceBaseDir: evidenceDir,
    store: new RunStore(evidenceDir),
    maxConcurrentRuns,
  });
}

beforeAll(() => {
  evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'cu-invoke-'));
  // Credentials the profile's default role resolves from — dummy values, since
  // no run here ever reaches a sign-on screen.
  for (const key of ['MERIDIAN_TELLER_ID', 'MERIDIAN_TELLER_PASSWORD']) {
    savedEnv[key] = process.env[key];
    process.env[key] = 'test-only';
  }
  ctx = context();
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(evidenceDir, { recursive: true, force: true });
});

describe('the parameter contract is refused, never silently trimmed', () => {
  it('names the offending param when one was not declared', () => {
    try {
      startInvocation(ctx, { name: 'member.readBalances', params: { memberId: '100234', memberID: '100234' } });
      expect.unreachable('an undeclared param must not start a run');
    } catch (err) {
      expect(err).toBeInstanceOf(InvocationError);
      if (!(err instanceof InvocationError)) return;
      expect(err.status).toBe(400);
      expect(err.message).toContain('memberID'); // the typo is named
      expect(err.message).toContain('Declared:');
      expect(err.message).toContain('memberId'); // ...next to what was meant
    }
  });

  it('refuses every unknown param at once rather than one per round trip', () => {
    expect(() => startInvocation(ctx, { name: 'member.readBalances', params: { alpha: '1', beta: '2' } })).toThrow(
      /unknown param\(s\): alpha, beta/,
    );
  });

  it('refuses an unknown capability name', () => {
    expect(() => startInvocation(ctx, { name: 'member.doesNotExist', params: {} })).toThrow(/no capability named/);
  });

  it('refuses an unknown operator role before anything starts', () => {
    try {
      startInvocation(ctx, { name: 'member.readBalances', params: { memberId: '100234' }, options: { role: 'auditor' } });
      expect.unreachable('an unknown role must not start a run');
    } catch (err) {
      expect(err).toBeInstanceOf(InvocationError);
      if (!(err instanceof InvocationError)) return;
      expect(err.status).toBe(400);
      expect(err.message).toContain("no operator role 'auditor'");
    }
  });

  it('fails a missing required param as INVALID_PARAMS, without launching a browser', async () => {
    const started = startInvocation(ctx, { name: 'member.readBalances', params: {} });
    const result = await started.done;
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('INVALID_PARAMS');
    expect(result.failure.observed).toContain("required param 'memberId' was not supplied");
    expect(result.stepsRun).toEqual([]);
    // The run is on record in the store even though it never got off the ground.
    expect(ctx.store.list().find((r) => r.runId === started.runId)?.status).toBe('failed');
  });

  it('fails a param that violates its declared pattern', async () => {
    const result = await startInvocation(ctx, { name: 'member.readBalances', params: { memberId: 'not-a-number' } }).done;
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('INVALID_PARAMS');
    expect(result.failure.observed).toContain("param 'memberId' does not match");
  });
});

describe('the concurrency bound is a real resource limit', () => {
  it('refuses a run beyond the cap with 429, and releases the slot afterwards', async () => {
    const bounded = context(1); // one browser session at a time
    const first = startInvocation(bounded, { name: 'member.readBalances', params: {} });

    // The slot is taken until the first run reaches a terminal state.
    try {
      startInvocation(bounded, { name: 'member.readBalances', params: {} });
      expect.unreachable('the second concurrent run must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(InvocationError);
      if (!(err instanceof InvocationError)) return;
      expect(err.status).toBe(429);
      expect(err.message).toContain('already driving 1 browser session(s)');
    }

    await first.done;
    // Released: the next caller gets in.
    const second = startInvocation(bounded, { name: 'member.readBalances', params: {} });
    expect(second.runId).not.toBe(first.runId);
    await second.done;
  });
});

describe('shapeOutputs at the contract edge', () => {
  const base = (): CapabilityArtifact => structuredClone(artifactFor(ctx, 'member.readBalances'));

  function withTableOutput(): CapabilityArtifact {
    const artifact = base();
    const shares = artifact.outputs['shares'];
    if (!shares) throw new Error('fixture changed: member.readBalances no longer declares a shares output');
    artifact.outputs = { shares: { ...shares, type: 'table' } };
    return artifact;
  }

  it('parses a declared table back into structure, and leaves scalars alone', () => {
    const artifact = withTableOutput();
    artifact.outputs['confirmation'] = {
      type: 'string',
      description: 'Confirmation number',
      sensitivity: 'none',
      source: { stepId: 's9', transform: 'none' },
    };
    const shaped = shapeOutputs(artifact, {
      shares: JSON.stringify([{ share: 'S00', balance: '$4,821.97' }]),
      confirmation: 'CN-100234',
    });
    expect(shaped['shares']).toEqual([{ share: 'S00', balance: '$4,821.97' }]);
    expect(shaped['confirmation']).toBe('CN-100234');
  });

  it('keeps the raw string when a table value will not parse, rather than dropping it', () => {
    const shaped = shapeOutputs(withTableOutput(), { shares: 'S00 REGULAR SAVINGS $4,821.97' });
    expect(shaped['shares']).toBe('S00 REGULAR SAVINGS $4,821.97');
  });

  it('passes through a value the artifact never declared', () => {
    const shaped = shapeOutputs(base(), { undeclared: '{"a":1}' });
    expect(shaped['undeclared']).toBe('{"a":1}'); // not parsed: only tables are
  });

  it('shapes nothing when there is nothing to shape', () => {
    expect(shapeOutputs(base(), {})).toEqual({});
  });
});

describe('evidencePath is confined to one run directory', () => {
  const root = (kind: string, runId: string): string => path.resolve(ctx.evidenceBaseDir, kind, runId);

  it('resolves a file inside the run', () => {
    expect(evidencePath(ctx, 'replay', '20260401-120000-abcd', 'steps/s1.png')).toBe(
      path.join(root('replay', '20260401-120000-abcd'), 'steps', 's1.png'),
    );
    // '.' is the run directory itself — how the evidence LISTING asks for it.
    expect(evidencePath(ctx, 'replay', '20260401-120000-abcd', '.')).toBe(root('replay', '20260401-120000-abcd'));
  });

  it('refuses relative traversal out of the run', () => {
    for (const rel of ['..', '../', '../../etc/passwd', 'steps/../../../secrets.json', './../../.env']) {
      expect(() => evidencePath(ctx, 'replay', '20260401-120000-abcd', rel)).toThrow(/outside the run directory/);
    }
  });

  it('refuses an absolute path', () => {
    for (const rel of ['/etc/passwd', path.join(os.homedir(), '.ssh', 'id_rsa'), path.resolve(ctx.evidenceBaseDir, 'replay')]) {
      expect(() => evidencePath(ctx, 'replay', '20260401-120000-abcd', rel)).toThrow(/outside the run directory/);
    }
  });

  it('refuses traversal smuggled through the RUN KIND or the RUN ID', () => {
    // These build the root the containment check is measured against: a '..'
    // here moves the root itself, so validating only the relative part would
    // confine the read to a directory the CALLER picked.
    expect(() => evidencePath(ctx, '..', '.', '.env')).toThrow(/unknown run kind/);
    expect(() => evidencePath(ctx, '../..', 'etc', 'passwd')).toThrow(/unknown run kind/);
    expect(() => evidencePath(ctx, 'replay', '..', '.env')).toThrow(/invalid run id/);
    expect(() => evidencePath(ctx, 'replay', '../..', 'etc/passwd')).toThrow(/invalid run id/);
    expect(() => evidencePath(ctx, 'replay', '.', 'anything')).toThrow(/invalid run id/);
    expect(() => evidencePath(ctx, 'replay', '/etc', 'passwd')).toThrow(/invalid run id/);
  });

  it('refuses a kind that is not a run kind at all', () => {
    expect(() => evidencePath(ctx, 'meridian', '20260401-120000-abcd', 'run.jsonl')).toThrow(/unknown run kind/);
    expect(() => evidencePath(ctx, '', '20260401-120000-abcd', 'run.jsonl')).toThrow(/unknown run kind/);
  });

  it('does not treat a sibling directory with the same prefix as inside the run', () => {
    // `<root>-other` starts with `<root>` as a STRING but is a different run.
    expect(() => evidencePath(ctx, 'replay', '20260401-120000-abcd', '../20260401-120000-abcd-other/result.json')).toThrow(
      /outside the run directory/,
    );
  });
});
