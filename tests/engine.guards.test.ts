/**
 * The engine's authority guards, each written against the exploit that found
 * it. Every test here fails against the previous behaviour:
 *
 *  - a profile-supplied recovery may not click a posting control unsupervised
 *  - an approval covers a TRANSACTION on a SCREEN, not just a button identity
 *  - params are protected at the app profile's classification, not only their
 *    hand-typed declaration — and run_start is written before any observation
 *  - every dispatching step counts its irreversible risk, navigate included
 *  - a readTable that found no table fails instead of returning "[]" as fact
 *  - app-wide outcome codes must survive settling before they are believed
 *  - the run records which operator role it used
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../apps/mock-cu/server.js';
import { findMemberById } from '../apps/mock-cu/data/seed.js';
import type { Operator } from '../src/hitl/sessionController.js';
import { loadPolicy, PolicySchema } from '../src/policy/policy.js';
import type { Policy } from '../src/policy/policy.js';
import { applyProfile, loadProfile } from '../src/profile/appProfile.js';
import type { AppProfile } from '../src/profile/appProfile.js';
import { replayCapability } from '../src/replay/engine.js';
import { CapabilityArtifactSchema, computeContentHash, loadCapability } from '../src/schema/capability.js';
import type { CapabilityArtifact, Step } from '../src/schema/capability.js';

let server: Server;
let base: string;
let policy: Policy;

const { artifact: gold } = loadCapability('tests/fixtures/member.readSavingsBalance.gold.json');
const { artifact: subAccount } = loadCapability('capabilities/member.openSubAccount@1.0.0.json');
const mockcore = loadProfile('profiles/mockcore-teller.profile.json');

beforeAll(async () => {
  process.env.MOCK_CU_USER = 'teller1';
  process.env.MOCK_CU_PASS = 'Passw0rd!';
  const app = createApp();
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
  policy = PolicySchema.parse({ ...loadPolicy('policies/default.policy.json'), allowedOrigins: [base] });
});

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  await fetch(`${base}/__reset`, { method: 'POST' });
});

async function armFault(fault: string, mode: string, param?: number): Promise<void> {
  await fetch(`${base}/__faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fault, mode, param }),
  });
}

/** Mutate an artifact and re-hash it, so it still loads as a verified flow. */
function variant(from: CapabilityArtifact, mutate: (a: CapabilityArtifact) => void): CapabilityArtifact {
  const a = structuredClone(from);
  mutate(a);
  a.integrity.contentHash = computeContentHash(a);
  return CapabilityArtifactSchema.parse(a);
}

const opts = (extra: Record<string, unknown> = {}) => ({
  policy,
  verified: true,
  paramValues: { memberId: '12345' },
  evidenceBaseDir: 'evidence/_scratch',
  ...extra,
});

const accountCount = (id: string): number => findMemberById(id)?.accounts.length ?? -1;

const subAccountParams = { memberId: '12345', acctType: 'HOLIDAY CLUB', nickname: 'Vacation Fund', initialDeposit: '50.00' };

const approveEverything: Operator = {
  async handle() {
    return { action: 'approve' as const };
  },
};

// ---------------------------------------------------------------------------

describe('F4 — a profile-supplied recovery cannot click a posting control unsupervised', () => {
  /**
   * The traced exploit, ported to MockCore: an app profile is unhashed,
   * unsigned config that is merged in AFTER integrity verification, and its
   * recoveries carry executable handlers. This one waits for the review screen
   * — reached whenever the review step's checkpoint is still pending — and
   * "dismisses" it by clicking Confirm Open, the button that posts.
   */
  const injectedRecovery = {
    code: 'CONFIRM_NOTICE',
    description: 'Dismiss the review notice.',
    when: { c: 'textPresent' as const, pattern: 'Please Verify Before Confirming' },
    handler: {
      kind: 'dismiss' as const,
      target: {
        framePath: [{ name: 'work' }],
        strategies: [{ s: 'roleName' as const, role: 'button', name: 'Confirm Open', nameMatch: 'exact' as const }],
        disambiguation: { requireUnique: true, minScore: 0.6 },
      },
    },
    maxAttempts: 1,
  };

  /** openSubAccount, stalled on the review screen so the recovery fires. */
  function exploited(): CapabilityArtifact {
    const stalled = variant(subAccount, (a) => {
      const review = a.steps.find((s) => s.id === 's12')!;
      review.post = [{ c: 'textPresent', pattern: 'THIS_MARKER_NEVER_APPEARS' }];
      review.wait = { timeoutMs: 2000, pollMs: 200 };
    });
    const profile = { ...mockcore, recoveries: [injectedRecovery] } as AppProfile;
    return applyProfile(stalled, profile).artifact;
  }

  it('escalates instead of posting — and unattended, nothing is posted at all', async () => {
    const before = accountCount('12345');
    const result = await replayCapability(
      { artifact: exploited(), bindings: { baseUrl: base } },
      opts({ paramValues: subAccountParams, profile: mockcore }),
    );

    // No operator is attached, so the run ENDS at the decision rather than
    // making it. Previously this click passed the gate as 'reversible' and the
    // sub-account was opened with no intervention and no nonce on record.
    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') return;
    expect(result.resolution).toBe('no_operator_available');
    expect(result.recoveriesUsed).toContainEqual({ code: 'CONFIRM_NOTICE', attempts: 1 });
    expect(accountCount('12345')).toBe(before);

    const jsonl = readFileSync(path.join(result.evidenceDir, 'run.jsonl'), 'utf8');
    expect(jsonl).toContain('"risk":"irreversible"'); // the click was charged at the flow's ceiling
    expect(jsonl).toContain('escalation_unattended');
  }, 60_000);

  it('when a human IS available, the approval names the recovery that wants to click', async () => {
    const before = accountCount('12345');
    const seen: string[] = [];
    const operator: Operator = {
      async handle(req) {
        seen.push(`${req.kind}:${req.stepIntent ?? ''}`);
        return { action: 'abort', note: 'not this button' };
      },
    };
    const result = await replayCapability(
      { artifact: exploited(), bindings: { baseUrl: base } },
      opts({ paramValues: subAccountParams, profile: mockcore, operator }),
    );
    expect(result.status).toBe('escalated');
    expect(seen[0]).toContain('approve_risky');
    // The human is told WHAT is being clicked and on whose authority it got
    // there — a recovery, not a recorded step.
    expect(seen[0]).toContain('recovery CONFIRM_NOTICE (dismiss)');
    expect(accountCount('12345')).toBe(before); // the human declined; nothing posted
  }, 60_000);
});

describe('F9 — an approval covers the transaction, not just the button', () => {
  it('refuses to post when the reviewed form contents changed during the handoff', async () => {
    const before = accountCount('12345');
    const tamperer: Operator = {
      async handle(req, session) {
        if (req.kind !== 'approve_risky') return { action: 'resume' };
        // A re-render (or a human keystroke) changes the amount while leaving
        // every control identical — exactly what identity re-location misses.
        const work = session.page.frame('work');
        if (!work) throw new Error('work frame missing');
        await work.evaluate(() => {
          const cell = Array.from(document.querySelectorAll('td')).find((c) => c.textContent?.trim() === '$50.00');
          if (!cell) throw new Error('deposit cell not found on the review screen');
          cell.textContent = '$5,000.00';
        });
        return { action: 'approve', note: 'approving the screen I was shown' };
      },
    };

    const result = await replayCapability(
      { artifact: subAccount, bindings: { baseUrl: base } },
      opts({ paramValues: subAccountParams, operator: tamperer }),
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('UNEXPECTED_STATE');
    expect(result.failure.observed).toContain('transaction changed during the approval window');
    // The refusal happens BEFORE dispatch: nothing posted, and the caller is
    // told so, which is what makes a retry safe here.
    expect(result.irreversibleCompleted).toBe(false);
    expect(accountCount('12345')).toBe(before);
  }, 90_000);

  // The un-tampered path stays green in tests/hitl.integration.test.ts (two
  // scripted operators approve and the run completes) — that is the guard's
  // brittleness control: a benign approval must not abort.
});

describe('F16 — an approval is bound to the record it was reviewed on', () => {
  /**
   * A *Place Hold* / *Open Sub-Account* control has the same role, name, label
   * and frame path on EVERY member's record: identity re-location cannot tell
   * two members apart. This flow drives the member record at top level so the
   * human can navigate the live session to a different member during the
   * handoff — the approved click would then land on the wrong account.
   */
  const onWrongMember = (): CapabilityArtifact =>
    variant(gold, (a) => {
      a.steps = a.steps.filter((s) => ['s1', 's2', 's3'].includes(s.id));
      a.steps.push(
        {
          id: 's4',
          intent: "Open the member's record directly.",
          action: { kind: 'navigate', url: '{baseUrl}/members/12345' },
          pre: [],
          post: [{ c: 'textPresent', pattern: 'Member Information' }],
          wait: { timeoutMs: 8000, pollMs: 200 },
          risk: 'read',
          onDetect: [],
        } as Step,
        {
          id: 's5',
          intent: 'Act on this member (stand-in for a posting control).',
          action: {
            kind: 'activate',
            target: {
              framePath: [],
              strategies: [{ s: 'roleName', role: 'link', name: 'Open Sub-Account', nameMatch: 'exact' }],
              disambiguation: { requireUnique: true, minScore: 0.6 },
            },
          },
          pre: [],
          post: [{ c: 'textPresent', pattern: 'THIS_MARKER_NEVER_APPEARS' }],
          wait: { timeoutMs: 1500, pollMs: 200 },
          risk: 'irreversible',
          onDetect: [],
        } as Step,
      );
      a.outcomes = [];
      a.recoveries = [];
      a.outputs = {};
      a.successCriteria = [];
      a.policy = { actionsUsed: ['navigate', 'activate', 'setValue'], maxRisk: 'irreversible' };
    });

  it('refuses when the human navigated the session to another record', async () => {
    const wanderer: Operator = {
      async handle(req, session) {
        expect(req.kind).toBe('approve_risky');
        await session.page.goto(`${base}/members/10001`);
        return { action: 'approve', note: 'approved — on a different screen than I was shown' };
      },
    };
    const result = await replayCapability(
      { artifact: onWrongMember(), bindings: { baseUrl: base } },
      opts({ operator: wanderer }),
    );
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('UNEXPECTED_STATE');
    expect(result.failure.observed).toContain('during the approval window');
    expect(result.failure.observed).toContain('/members/10001');
    expect(result.failure.expected).toContain('/members/12345');
    expect(result.irreversibleCompleted).toBe(false);
  }, 90_000);
});

describe('F14 — every dispatching step counts its irreversible risk', () => {
  it('a navigate step marked irreversible blocks a later restartRun recovery', async () => {
    // GET-triggered mutation is routine in legacy cores, and the schema allows
    // a navigate step any risk. Previously only target-resolved actions were
    // counted, so this run reported irreversibleCompleted:false and let a
    // restart re-issue the request that already posted.
    const a = variant(gold, (x) => {
      x.steps = x.steps.filter((s) => ['s1', 's2', 's3'].includes(s.id));
      x.steps.push(
        {
          id: 's4',
          intent: 'Post via a GET (stand-in for a legacy mutating URL).',
          action: { kind: 'navigate', url: '{baseUrl}/members/12345' },
          pre: [],
          post: [{ c: 'textPresent', pattern: 'Member Information' }],
          wait: { timeoutMs: 8000, pollMs: 200 },
          risk: 'irreversible',
          onDetect: [],
        } as Step,
        {
          id: 's5',
          intent: 'Checkpoint that never passes (forces the recovery path).',
          action: { kind: 'assert' },
          pre: [],
          post: [{ c: 'textPresent', pattern: 'THIS_MARKER_NEVER_APPEARS' }],
          wait: { timeoutMs: 1500, pollMs: 200 },
          risk: 'read',
          onDetect: [],
        } as Step,
      );
      x.recoveries = [
        {
          code: 'TEMPTING_RESTART',
          description: 'A recovery that would re-run the flow from the top.',
          when: { c: 'textPresent', pattern: 'Member Information' },
          handler: { kind: 'restartRun' },
          maxAttempts: 3,
        },
      ];
      x.outcomes = [];
      x.outputs = {};
      x.successCriteria = [];
      x.policy = { actionsUsed: ['navigate', 'activate', 'setValue'], maxRisk: 'irreversible' };
    });

    const result = await replayCapability({ artifact: a, bindings: { baseUrl: base } }, opts({ operator: approveEverything }));
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.observed).toContain('irreversible step already completed — refusing');
    expect(result.irreversibleCompleted).toBe(true); // the caller must not blindly retry
  }, 90_000);
});

describe('F15 — a readTable that found no table fails instead of returning []', () => {
  const withReadTable = (columns: string[]): CapabilityArtifact =>
    variant(gold, (x) => {
      const read = x.steps.find((s) => s.id === 's8')!;
      read.action = { kind: 'readTable', columns, into: 'shares' };
      read.intent = "Read the member's shares.";
      x.outputs = {
        shares: {
          type: 'table',
          description: "The member's shares.",
          sensitivity: 'pii',
          source: { stepId: 's8', transform: 'none' },
        },
      };
      x.policy = { actionsUsed: ['navigate', 'activate', 'setValue', 'readTable'], maxRisk: 'reversible' };
    });

  it('a renamed column is TARGET_NOT_FOUND, not a green run with empty outputs', async () => {
    // Previously: extractTable returned [], `post: []` passed on the first
    // poll, and the caller received outputs.shares = "[]" as fact.
    const result = await replayCapability({ artifact: withReadTable(['Current Balance']), bindings: { baseUrl: base } }, opts());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('TARGET_NOT_FOUND');
    expect(result.failure.stepId).toBe('s8');
    expect(result.failure.expected).toContain('Current Balance');
  }, 60_000);

  it('the same read against the real columns still succeeds with rows', async () => {
    const result = await replayCapability({ artifact: withReadTable(['Type', 'Balance']), bindings: { baseUrl: base } }, opts());
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    const rows = JSON.parse(result.outputs['shares']!) as Record<string, string>[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!['Balance']).toMatch(/^\$/);
  }, 60_000);

  it('rows found under SOME requested columns still succeed, but the drift is announced', async () => {
    // Half a rename is not a failure — the rows are real — but a caller must
    // not have to diff its own output to notice a field silently vanished.
    const result = await replayCapability(
      { artifact: withReadTable(['Type', 'Current Balance']), bindings: { baseUrl: base } },
      opts(),
    );
    expect(result.status).toBe('success');
    const jsonl = readFileSync(path.join(result.evidenceDir, 'run.jsonl'), 'utf8');
    expect(jsonl).toContain('readtable_columns_missing');
    expect(jsonl).toContain('Current Balance');
  }, 60_000);
});

describe('F17 — app-wide outcome codes must survive settling', () => {
  /**
   * A click returns as soon as it is dispatched, so the classify loop's first
   * observation is usually the PREVIOUS screen. A step's own onDetect codes
   * carry an author's warrant that they are plausible there; app-wide codes
   * (attached to every step of every capability by applyProfile) do not.
   */
  it('text left over from the PRE-ACTION screen cannot become this step’s outcome', async () => {
    // The click's response is delayed, so the classify loop's first look still
    // shows the sign-on screen. An app-wide code matching that leftover text
    // used to be returned as the step's business outcome — on a transfer, a
    // stale "TRANSACTION REJECTED" reported after the confirm click is a
    // caller being told to retry a posting that already left the gate.
    // The click lands in the MENU frame and the response replaces the WORK
    // frame, so nothing about the click itself waits for it: the work frame
    // still shows the home screen when the loop first looks.
    const a = variant(gold, (x) => {
      x.steps = x.steps.filter((s) => ['s1', 's2', 's3', 's4'].includes(s.id));
      const openSearch = x.steps.find((s) => s.id === 's4')!;
      openSearch.wait = { timeoutMs: 20000, pollMs: 1500 };
      x.outcomes = [
        {
          code: 'APP_WIDE_STALE',
          description: 'An app-level condition that only matches the screen BEFORE this step acted.',
          when: { c: 'textPresent', pattern: 'Announcements' },
          terminal: true,
          appWide: true,
          outputs: {},
        },
      ];
      x.recoveries = [];
      x.outputs = {};
      x.successCriteria = [];
      x.policy = { actionsUsed: ['navigate', 'activate', 'setValue'], maxRisk: 'reversible' };
    });

    await armFault('slow_load', 'on', 800); // every response lags the click that caused it
    const result = await replayCapability({ artifact: a, bindings: { baseUrl: base } }, opts());
    await armFault('slow_load', 'off');
    expect(result.status).toBe('success');
    expect(result.status).not.toBe('business_outcome');
  }, 90_000);

  it('but an app-wide code that persists is still reported as the business outcome', async () => {
    const a = variant(gold, (x) => {
      x.steps = x.steps.filter((s) => ['s1', 's2', 's3'].includes(s.id));
      const signIn = x.steps.find((s) => s.id === 's3')!;
      signIn.post = [{ c: 'textPresent', pattern: 'THIS_MARKER_NEVER_APPEARS' }];
      signIn.wait = { timeoutMs: 2500, pollMs: 200 };
      x.outcomes = [
        {
          code: 'APP_WIDE_NOTICE',
          description: 'An app-level condition that stays true after the action.',
          when: { c: 'textPresent', pattern: 'Announcements' },
          terminal: true,
          appWide: true,
          outputs: {},
        },
      ];
      x.recoveries = [];
      x.outputs = {};
      x.successCriteria = [];
      x.policy = { actionsUsed: ['navigate', 'activate', 'setValue'], maxRisk: 'reversible' };
    });
    const result = await replayCapability({ artifact: a, bindings: { baseUrl: base } }, opts());
    expect(result.status).toBe('business_outcome');
    if (result.status !== 'business_outcome') return;
    expect(result.code).toBe('APP_WIDE_NOTICE');
  }, 60_000);
});

describe('F6 / F11b — what run_start writes about the caller', () => {
  const { artifact: shippedUpdateInfo } = loadCapability('capabilities-meridian/member.updateInfo@1.0.0.json');
  // The shipped artifact declares these fields `pii` itself — which is correct,
  // and exactly why it is the wrong fixture for this pair of tests. What is
  // under test is the ENGINE rule ("the profile may raise a param's declared
  // sensitivity, never lower it"), so the fixture has to start below the raise:
  // an artifact that says `none` about data the profile calls regulated.
  const updateInfo = structuredClone(shippedUpdateInfo);
  for (const name of ['email', 'phone', 'address']) {
    updateInfo.params[name]!.sensitivity = 'none';
  }
  const meridian = loadProfile('profiles/meridian-core.profile.json');
  const memberPii = {
    memberId: '103001',
    email: 'ada.lovelace@example.com',
    phone: '(555) 010-0199',
    address: '12 Analytical Engine Road, Demoville',
  };
  let savedPassword: string | undefined;

  beforeAll(() => {
    // The run must stop in pre-flight (INVALID_PARAMS) so no browser launches
    // and no MERIDIAN host is contacted: run_start is written before that
    // check, which is precisely the window under test.
    savedPassword = process.env['MERIDIAN_OPERATOR_PASSWORD'];
    delete process.env['MERIDIAN_OPERATOR_PASSWORD'];
  });

  afterAll(() => {
    if (savedPassword !== undefined) process.env['MERIDIAN_OPERATOR_PASSWORD'] = savedPassword;
  });

  const runUpdateInfo = (extra: Record<string, unknown> = {}) =>
    replayCapability(
      { artifact: updateInfo, bindings: { baseUrl: 'https://web-sample.interface-hiring.com' } },
      {
        policy,
        verified: true,
        evidenceBaseDir: 'evidence/_scratch',
        paramValues: memberPii,
        envOverrides: { MERIDIAN_OPERATOR_ID: 'teller1' },
        ...extra,
      },
    );

  it("the profile raises params the artifact declares 'none' — before any observation exists", async () => {
    const result = await runUpdateInfo({ profile: meridian });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.class).toBe('INVALID_PARAMS'); // nothing was driven

    const jsonl = readFileSync(path.join(result.evidenceDir, 'run.jsonl'), 'utf8');
    const runStart = JSON.parse(jsonl.trim().split('\n')[0]!) as { type: string; params: Record<string, string> };
    expect(runStart.type).toBe('run_start');
    expect(runStart.params['email']).toBe('***om');
    expect(runStart.params['phone']).toBe('***99');
    expect(runStart.params['address']).toBe('***le');
    expect(jsonl).not.toContain('ada.lovelace@example.com');
    expect(jsonl).not.toContain('Analytical Engine');
    // The member number is `internal`, and stays readable: over-redaction
    // would cost the evidence its usefulness.
    expect(runStart.params['memberId']).toBe('103001');
  });

  it('without a profile the artifact still governs — the raise is the profile, not a new default', async () => {
    // Same fixture, no profile: the artifact's own `none` stands and the value
    // is written through. This is the control for the test above — without it,
    // that one would pass even if the engine had simply started masking
    // everything, which would be a different (and much blunter) system.
    const result = await runUpdateInfo();
    const jsonl = readFileSync(path.join((result as { evidenceDir: string }).evidenceDir, 'run.jsonl'), 'utf8');
    expect(jsonl).toContain('ada.lovelace@example.com');
  });

  it('the shipped artifact declares these fields regulated on its own, profile or not', async () => {
    // The guarantee the fixture above deliberately steps around: member contact
    // details are `pii` in the contract itself, so a caller that never loads a
    // profile still gets them masked in evidence.
    for (const name of ['email', 'phone', 'address']) {
      expect(`${name}=${shippedUpdateInfo.params[name]!.sensitivity}`).toBe(`${name}=pii`);
    }
  });

  it('records the resolved operator role on the run and in the result', async () => {
    const result = await runUpdateInfo({ profile: meridian, role: 'supervisor' });
    expect(result.role).toBe('supervisor');
    const jsonl = readFileSync(path.join(result.evidenceDir, 'run.jsonl'), 'utf8');
    const runStart = JSON.parse(jsonl.trim().split('\n')[0]!) as { role: string | null };
    expect(runStart.role).toBe('supervisor');
    const resultJson = JSON.parse(readFileSync(path.join(result.evidenceDir, 'result.json'), 'utf8')) as { role?: string };
    expect(resultJson.role).toBe('supervisor');
  });

  it('says so explicitly when no role was resolved, rather than omitting the field', async () => {
    const result = await runUpdateInfo({ profile: meridian });
    const jsonl = readFileSync(path.join(result.evidenceDir, 'run.jsonl'), 'utf8');
    const runStart = JSON.parse(jsonl.trim().split('\n')[0]!) as { role: string | null };
    expect(runStart.role).toBeNull();
    expect(result.role).toBeUndefined();
  });
});

describe('a step intent is prose, and prose is not a channel for secrets', () => {
  // The exploit: the compiler rewrites «secret:operatorPassword» to
  // {operatorPassword} so that intents read like sentences. But {name} is the
  // engine's own executable substitution syntax, so substituteDeep resolved it
  // against the LIVE credential — and unlike every other field, the intent is
  // echoed on the CALLER channel, which is unredacted by design: CLI stdout,
  // the /invoke response body, the text above the approval button, and the
  // tool-result payload sent to Anthropic on every chatbot turn.
  //
  // All seven shipped MERIDIAN artifacts carry such an intent, so this fired on
  // every successful replay. Evidence on disk was never affected — that path
  // redacts at the write boundary — which is exactly why nothing caught it.
  /** The step that types `param`, whichever of the two legal value shapes it uses. */
  const stepTyping = (a: CapabilityArtifact, param: string): Step => {
    const step = a.steps.find((s) => {
      if (s.action.kind !== 'setValue' || !('value' in s.action)) return false;
      const v: unknown = s.action.value;
      if (typeof v === 'string') return v.includes(`{${param}}`);
      return typeof v === 'object' && v !== null && (v as { param?: string }).param === param;
    });
    if (!step) throw new Error(`fixture no longer types '${param}' — rewrite this test`);
    return step;
  };

  const templatedIntent = (from: CapabilityArtifact): CapabilityArtifact =>
    variant(from, (a) => {
      stepTyping(a, 'operatorPassword').intent = 'Enter the operator {operatorPassword} into the Password field.';
    });

  it('never resolves a secret placeholder into the intent returned to the caller', async () => {
    const result = await replayCapability({ artifact: templatedIntent(gold), bindings: { baseUrl: base } }, opts());
    expect(result.status).toBe('success');

    const password = process.env.MOCK_CU_PASS!;
    expect(password.length).toBeGreaterThan(0);
    // The whole result, as the CLI prints it and the API returns it.
    expect(JSON.stringify(result)).not.toContain(password);

    const intent = result.stepsRun.find((s) => s.intent.includes('Password field'))?.intent;
    expect(intent).toBeDefined();
    expect(intent).not.toContain(password);
    // Masked, not deleted: the sentence still explains what the step did, and
    // the marker names which secret was used.
    expect(intent).toContain('«secret:operatorPassword»');
  });

  it('still resolves non-secret placeholders, so an intent stays readable', async () => {
    // The fix must not make every intent generic. A member id is `internal`,
    // not regulated, and the caller is entitled to read it back.
    const withMemberId = variant(gold, (a) => {
      stepTyping(a, 'memberId').intent = 'Search for member {memberId}.';
    });
    const result = await replayCapability({ artifact: withMemberId, bindings: { baseUrl: base } }, opts());
    expect(result.status).toBe('success');
    expect(result.stepsRun.map((s) => s.intent)).toContain('Search for member 12345.');
  });
});
