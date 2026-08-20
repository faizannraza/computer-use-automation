/**
 * The compiler is deterministic code — so it gets deterministic tests: a
 * synthetic recorded trace exercising pruning (probe exclusion),
 * parameterization by value-matching, checkpoint mining from state deltas,
 * locator-ladder construction, and outcome attachment.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../src/schema/capability.js';
import { ParamSpecSchema } from '../src/schema/capability.js';
import { compileTrace, genericCallerParamDescription } from '../src/discovery/compile.js';
import type { DiscoveryTrace, RecordedAction, StateDigest } from '../src/discovery/recorder.js';
import { AppProfileSchema } from '../src/profile/appProfile.js';
import { evaluateCondition } from '../src/replay/detectors.js';
import type { Observation, ObservedElement } from '../src/core/types.js';

const BASE = 'http://localhost:4173';

// Markers are frame-tagged, exactly as digestOf records them: 'menu' is the
// persistent nav chrome, 'work' is the frame the flow actually happens in.
const loginDigest: StateDigest = { location: `${BASE}/login`, title: 'Sign In', markers: [{ text: 'MockCore™ Teller — Operator Sign In' }] };
const homeDigest: StateDigest = { location: `${BASE}/`, title: 'MockCore', markers: [{ text: 'Main Menu', frame: 'menu' }, { text: 'Announcements', frame: 'work' }] };
const searchDigest: StateDigest = { location: `${BASE}/`, title: 'MockCore', markers: [{ text: 'Main Menu', frame: 'menu' }, { text: 'Member Search', frame: 'work' }] };
const resultsDigest: StateDigest = { location: `${BASE}/`, title: 'MockCore', markers: [{ text: 'Main Menu', frame: 'menu' }, { text: 'Member Search', frame: 'work' }, { text: 'Member No.', frame: 'work' }, { text: 'Standing', frame: 'work' }] };
const detailDigest: StateDigest = { location: `${BASE}/`, title: 'MockCore', markers: [{ text: 'Main Menu', frame: 'menu' }, { text: 'Member Information', frame: 'work' }, { text: 'Accounts', frame: 'work' }, { text: 'Balance', frame: 'work' }] };
const notFoundDigest: StateDigest = { location: `${BASE}/`, title: 'MockCore', markers: [{ text: 'Main Menu', frame: 'menu' }, { text: 'Member Search', frame: 'work' }] };

let seq = 0;
function act(a: Omit<RecordedAction, 'seq' | 'probe'> & { probe?: boolean }): RecordedAction {
  seq += 1;
  return { probe: false, ...a, seq };
}

const workFrame = [{ name: 'work', url: `${BASE}/members/search` }];

const trace: DiscoveryTrace = {
  goal: 'test goal',
  actions: [
    act({ kind: 'navigate', intent: 'Open the sign-in screen', risk: 'read', url: `${BASE}/login`, before: { location: 'about:blank', title: '', markers: [] }, after: loginDigest }),
    act({
      kind: 'setValue', intent: 'Enter operator id', risk: 'reversible',
      element: { role: 'textbox', name: 'Operator ID', label: 'Operator ID', framePath: [] },
      value: { param: 'operatorId' }, before: loginDigest, after: loginDigest,
    }),
    act({
      kind: 'activate', intent: 'Sign in', risk: 'reversible',
      element: { role: 'button', name: 'Sign In', framePath: [] },
      before: loginDigest, after: homeDigest,
    }),
    act({
      kind: 'setValue', intent: 'Enter the member number', risk: 'reversible',
      element: { role: 'textbox', name: 'Member No. or Name', label: 'Member No. or Name', framePath: workFrame },
      value: { literal: '12345' }, before: searchDigest, after: searchDigest,
    }),
    act({
      kind: 'activate', intent: 'Run the search', risk: 'reversible',
      element: { role: 'button', name: 'Search', framePath: workFrame },
      before: searchDigest, after: resultsDigest,
    }),
    act({
      kind: 'activate', intent: 'Open the member', risk: 'read',
      element: { role: 'link', name: '12345', nearText: '12345 | Alexis Testmember | 1987-03-14 | GOOD', framePath: workFrame },
      before: resultsDigest, after: detailDigest,
    }),
    act({
      kind: 'read', intent: 'Read the savings balance', risk: 'read',
      element: { role: 'cell', name: '$4,821.97', nearText: 'S00 | REGULAR SAVINGS | Primary Savings | $4,821.97 | 2011-06-02', colHeader: 'Balance', framePath: workFrame },
      outputName: 'savingsBalance', readValue: '$4,821.97', before: detailDigest, after: detailDigest,
    }),
    // ---- probe (excluded from the spine, grounds the outcome) ----
    act({ probe: true, probeCode: 'MEMBER_NOT_FOUND', kind: 'setValue', intent: 'Probe: enter unknown member', risk: 'reversible', element: { role: 'textbox', name: 'Member No. or Name', label: 'Member No. or Name', framePath: workFrame }, value: { literal: '99999' }, before: detailDigest, after: detailDigest }),
    act({ probe: true, probeCode: 'MEMBER_NOT_FOUND', kind: 'activate', intent: 'Probe: search unknown member', risk: 'reversible', element: { role: 'button', name: 'Search', framePath: workFrame }, before: detailDigest, after: notFoundDigest }),
  ],
  outcomes: [
    { code: 'MEMBER_NOT_FOUND', description: 'No member matched.', marker: 'No members matched your search.', observedIn: notFoundDigest },
  ],
  done: { capabilityId: 'member.readSavingsBalance', title: 'Read savings balance', description: 'Looks up a member and reads the savings balance.' },
};

const paramSpecs = {
  // The CLI's placeholder, verbatim — this is what a real discovery run hands
  // the compiler, and it is the string the compiler is allowed to replace.
  memberId: ParamSpecSchema.parse({ type: 'string', description: genericCallerParamDescription('memberId'), sensitivity: 'internal', source: 'caller', pattern: '^[0-9]+$', example: '12345' }),
  operatorId: ParamSpecSchema.parse({ type: 'string', description: 'operator', sensitivity: 'internal', source: 'env', env: 'MOCK_CU_USER' }),
};

function compiled() {
  return compileTrace({
    trace,
    paramSpecs,
    callerParamValues: { memberId: '12345' },
    outputHints: { savingsBalance: { type: 'money', sensitivity: 'pii' } },
    baseUrl: BASE,
    model: 'claude-opus-4-8',
    discoveryRunId: 'testrun',
    app: { appId: 'mockcore-teller', vendor: 'MockCore' },
    version: '1.0.0',
  });
}

describe('compileTrace', () => {
  it('produces a schema-valid, hash-verified draft artifact', () => {
    const { artifact } = compiled();
    expect(artifact.provenance.approval.state).toBe('draft');
    expect(artifact.provenance.recordedBy.kind).toBe('llm-discovery');
    expect(computeContentHash(artifact)).toBe(artifact.integrity.contentHash);
  });

  it('declares the implicit entrypoint navigation in policy.actionsUsed', () => {
    const { artifact } = compiled();
    // No compiled step navigates (the entry nav is the entrypoint, not a
    // step), yet every replay navigates — the self-declaration says so.
    expect(artifact.steps.every((s) => s.action.kind !== 'navigate')).toBe(true);
    expect(artifact.policy.actionsUsed).toContain('navigate');
  });

  it('canonicalizes the entrypoint origin and excludes probe actions from the spine', () => {
    const { artifact, report } = compiled();
    expect(artifact.capability.entrypoint.value).toBe('{baseUrl}/login');
    expect(artifact.steps).toHaveLength(6); // 7 spine actions minus the entry navigation
    expect(report.prunedProbeActions).toBe(2);
    expect(artifact.steps.every((s) => !s.intent.startsWith('Probe:'))).toBe(true);
  });

  it('parameterizes typed literals and locator anchors by value-matching', () => {
    const { artifact } = compiled();
    const typing = artifact.steps.find((s) => s.action.kind === 'setValue' && s.intent.includes('member number'))!;
    if (typing.action.kind !== 'setValue') throw new Error('unexpected');
    expect(typing.action.value).toEqual({ param: 'memberId' });
    const link = artifact.steps.find((s) => s.intent === 'Open the member')!;
    if (!('target' in link.action)) throw new Error('unexpected');
    expect(link.action.target.strategies[0]).toMatchObject({ s: 'roleName', name: '{memberId}' });
    expect(link.action.target.strategies[1]).toMatchObject({ s: 'textAnchor', text: '{memberId}', relation: 'rowOf' });
  });

  it('never anchors on recorded neighbor data (names/dates) — only parameterized anchors', () => {
    const { artifact } = compiled();
    const json = JSON.stringify(artifact.steps);
    expect(json).not.toContain('Alexis Testmember');
    expect(json).not.toContain('1987-03-14');
  });

  it('mines checkpoints from observed marker deltas, scoped to the frame they appeared in', () => {
    const { artifact } = compiled();
    const signIn = artifact.steps.find((s) => s.intent === 'Sign in')!;
    expect(signIn.post).toContainEqual({ c: 'textPresent', pattern: 'Announcements', frame: { name: 'work' } });
    const open = artifact.steps.find((s) => s.intent === 'Open the member')!;
    expect(open.post.map((p) => JSON.stringify(p))).toContain(
      JSON.stringify({ c: 'textPresent', pattern: 'Member Information', frame: { name: 'work' } }),
    );
  });

  it('prefers the most specific markers: same frame as the action, then longest text', () => {
    const { artifact } = compiled();
    // After opening the member, three new work-frame markers appeared:
    // "Member Information" (18), "Accounts" (8), "Balance" (7). The compiler
    // must take the LONGEST two — short markers are the least specific.
    const open = artifact.steps.find((s) => s.intent === 'Open the member')!;
    expect(open.post.map((p) => (p.c === 'textPresent' ? p.pattern : ''))).toEqual(['Member Information', 'Accounts']);
  });

  it('marker freshness is per frame: chrome text reappearing in the work frame still yields a scoped checkpoint', () => {
    // "Member Search" lives permanently in the nav chrome; after the click it
    // ALSO appears in the work frame. Text-only freshness would discard it
    // and fall back to urlMatches (always true in a frameset — an empty
    // checkpoint). Per-frame freshness keeps it, scoped to 'work'.
    const chromeEchoTrace: DiscoveryTrace = {
      goal: 'per-frame freshness',
      actions: [
        act({ kind: 'navigate', intent: 'Open the app', risk: 'read', url: `${BASE}/login`, before: { location: 'about:blank', title: '', markers: [] }, after: loginDigest }),
        act({
          kind: 'activate', intent: 'Open Member Search', risk: 'read',
          element: { role: 'link', name: 'Member Search', framePath: [{ name: 'menu', url: `${BASE}/nav` }] },
          before: { location: `${BASE}/`, title: 'MockCore', markers: [{ text: 'Member Search', frame: 'menu' }] },
          after: { location: `${BASE}/`, title: 'MockCore', markers: [{ text: 'Member Search', frame: 'menu' }, { text: 'Member Search', frame: 'work' }] },
        }),
      ],
      outcomes: [],
      done: { capabilityId: 'freshness.case', title: 't', description: 'd' },
    };
    const { artifact } = compileTrace({
      trace: chromeEchoTrace,
      paramSpecs: {},
      callerParamValues: {},
      outputHints: {},
      baseUrl: BASE,
      model: 'test',
      discoveryRunId: 'freshrun',
      app: { appId: 'mockcore-teller', vendor: 'MockCore' },
      version: '1.0.0',
    });
    expect(artifact.steps[0]!.post).toEqual([{ c: 'textPresent', pattern: 'Member Search', frame: { name: 'work' } }]);
  });

  it('never substitutes a stand-in into the middle of a decimal', () => {
    const decimalTrace = structuredClone(trace);
    decimalTrace.outcomes = [
      { code: 'MEMBER_NOT_FOUND', description: 'n', marker: 'Reference 99999.00 rejected for member 99999.', observedIn: notFoundDigest },
    ];
    const { artifact } = compileTrace({
      trace: decimalTrace,
      paramSpecs,
      callerParamValues: { memberId: '12345' },
      outputHints: { savingsBalance: { type: 'money', sensitivity: 'pii' } },
      baseUrl: BASE,
      model: 'claude-opus-4-8',
      discoveryRunId: 'testrun',
      app: { appId: 'mockcore-teller', vendor: 'MockCore' },
      version: '1.0.0',
    });
    // "99999.00" is an amount, not the member id — untouched. The standalone
    // "99999." (sentence period, no digit after) IS the entity — substituted.
    expect(artifact.outcomes[0]!.when).toEqual({
      c: 'textPresent',
      pattern: 'Reference 99999.00 rejected for member {memberId}.',
    });
  });

  it('notes operator-DECLINED irreversible actions so a reviewer knows the flow may be partial', () => {
    const declinedTrace = structuredClone(trace);
    declinedTrace.declinedInterventions = [{ id: 'int-01', intent: 'Confirm opening the sub-account' }];
    const { report } = compileTrace({
      trace: declinedTrace,
      paramSpecs,
      callerParamValues: { memberId: '12345' },
      outputHints: { savingsBalance: { type: 'money', sensitivity: 'pii' } },
      baseUrl: BASE,
      model: 'claude-opus-4-8',
      discoveryRunId: 'testrun',
      app: { appId: 'mockcore-teller', vendor: 'MockCore' },
      version: '1.0.0',
    });
    expect(report.notes.some((n) => n.includes('DECLINED') && n.includes('int-01') && n.includes('partial'))).toBe(true);
  });

  it('lints checkpoints that had to assert markers outside the action frame', () => {
    // A work-frame click whose only new marker appeared in the nav chrome:
    // the checkpoint still compiles, but the report flags it for review.
    const chromeTrace: DiscoveryTrace = {
      goal: 'lint test',
      actions: [
        act({ kind: 'navigate', intent: 'Open the app', risk: 'read', url: `${BASE}/login`, before: { location: 'about:blank', title: '', markers: [] }, after: loginDigest }),
        act({
          kind: 'activate', intent: 'Click something in the work frame', risk: 'reversible',
          element: { role: 'button', name: 'Refresh', framePath: workFrame },
          before: searchDigest,
          after: { ...searchDigest, markers: [...searchDigest.markers, { text: 'Session refreshed', frame: 'menu' }] },
        }),
      ],
      outcomes: [],
      done: { capabilityId: 'lint.case', title: 't', description: 'd' },
    };
    const { report } = compileTrace({
      trace: chromeTrace,
      paramSpecs: {},
      callerParamValues: {},
      outputHints: {},
      baseUrl: BASE,
      model: 'test',
      discoveryRunId: 'lintrun',
      app: { appId: 'mockcore-teller', vendor: 'MockCore' },
      version: '1.0.0',
    });
    expect(report.notes.some((n) => n.includes('may be non-specific') && n.includes("'work'"))).toBe(true);
  });

  it('builds table-cell targeting for reads (never keyed on the data itself)', () => {
    const { artifact } = compiled();
    const read = artifact.steps.find((s) => s.action.kind === 'read')!;
    if (read.action.kind !== 'read') throw new Error('unexpected');
    expect(read.action.target.strategies[0]).toEqual({
      s: 'tableCell',
      // 'exact': the anchor is a whole recorded cell, so it must BE that cell —
      // a substring anchor collides when one row's id contains another's.
      rowAnchor: { text: 'S00', match: 'exact' },
      columnHeader: 'Balance',
    });
    expect(artifact.outputs['savingsBalance']).toMatchObject({ type: 'money', sensitivity: 'pii' });
  });

  it('compiles a table read into a targetless readTable step declaring a table output', () => {
    // A readTable is addressed by column header, not by a control: the step
    // carries no target, and the output it feeds is a table regardless of what
    // the serialized rows happen to look like.
    const tableTrace = structuredClone(trace);
    tableTrace.actions.push(
      act({
        kind: 'readTable', intent: 'List the shares with balances and statuses', risk: 'read',
        columns: ['Share', 'Description', 'Balance', 'Status'],
        outputName: 'shares',
        readValue: JSON.stringify([{ Share: 'S00', Description: 'Primary Savings', Balance: '$4,821.97', Status: 'OPEN' }]),
        before: detailDigest, after: detailDigest,
      }),
    );
    const { artifact } = compileTrace({
      trace: tableTrace,
      paramSpecs,
      callerParamValues: { memberId: '12345' },
      outputHints: { savingsBalance: { type: 'money', sensitivity: 'pii' } },
      baseUrl: BASE,
      model: 'claude-opus-4-8',
      discoveryRunId: 'testrun',
      app: { appId: 'mockcore-teller', vendor: 'MockCore' },
      version: '1.0.0',
    });
    const step = artifact.steps.find((s) => s.action.kind === 'readTable')!;
    expect(step.action).toEqual({
      kind: 'readTable',
      columns: ['Share', 'Description', 'Balance', 'Status'],
      into: 'shares',
    });
    expect(step.post).toEqual([]); // a read observes; it does not transition state
    expect(artifact.outputs['shares']).toEqual({
      type: 'table',
      description: 'List the shares with balances and statuses',
      sensitivity: 'none',
      source: { stepId: step.id, transform: 'trim' },
    });
    expect(artifact.policy.actionsUsed).toContain('readTable');
    expect(computeContentHash(artifact)).toBe(artifact.integrity.contentHash);
  });

  it('attaches declared outcomes to the step whose control triggered them in the probe', () => {
    const { artifact, report } = compiled();
    const search = artifact.steps.find((s) => s.intent === 'Run the search')!;
    expect(search.onDetect).toContain('MEMBER_NOT_FOUND');
    expect(report.outcomeAttachments).toContainEqual({ code: 'MEMBER_NOT_FOUND', stepId: search.id });
    expect(artifact.outcomes[0]).toMatchObject({ code: 'MEMBER_NOT_FOUND', when: { c: 'textPresent', pattern: 'No members matched your search.' } });
  });

  it('parameterizes outcome markers that echo the probe entity — flagged for review', () => {
    // The probe searched 99999 (the stand-in for {memberId}); an app whose
    // not-found message echoes the entity would pin the detector to 99999
    // forever. The compiler substitutes the stand-in and flags the decision.
    const echoTrace = structuredClone(trace);
    echoTrace.outcomes = [
      { code: 'MEMBER_NOT_FOUND', description: 'No member matched.', marker: 'Member 99999 was not found on this system.', observedIn: notFoundDigest },
    ];
    const { artifact, report } = compileTrace({
      trace: echoTrace,
      paramSpecs,
      callerParamValues: { memberId: '12345' },
      outputHints: { savingsBalance: { type: 'money', sensitivity: 'pii' } },
      baseUrl: BASE,
      model: 'claude-opus-4-8',
      discoveryRunId: 'testrun',
      app: { appId: 'mockcore-teller', vendor: 'MockCore' },
      version: '1.0.0',
    });
    expect(artifact.outcomes[0]!.when).toEqual({ c: 'textPresent', pattern: 'Member {memberId} was not found on this system.' });
    expect(report.notes.some((n) => n.includes('MEMBER_NOT_FOUND') && n.includes('review before approval'))).toBe(true);
    // The entity-free marker in the main trace is left untouched (no note).
    const { artifact: normal, report: normalReport } = compiled();
    expect(normal.outcomes[0]!.when).toEqual({ c: 'textPresent', pattern: 'No members matched your search.' });
    expect(normalReport.notes.every((n) => !n.includes('marker was parameterized'))).toBe(true);
  });

  it('surfaces human-approved discovery actions in the compile report', () => {
    const approvedTrace = structuredClone(trace);
    const search = approvedTrace.actions.find((a) => a.intent === 'Run the search')!;
    search.risk = 'irreversible';
    search.approvedIntervention = 'int-01';
    const { report } = compileTrace({
      trace: approvedTrace,
      paramSpecs,
      callerParamValues: { memberId: '12345' },
      outputHints: { savingsBalance: { type: 'money', sensitivity: 'pii' } },
      baseUrl: BASE,
      model: 'claude-opus-4-8',
      discoveryRunId: 'testrun',
      app: { appId: 'mockcore-teller', vendor: 'MockCore' },
      version: '1.0.0',
    });
    expect(report.notes.some((n) => n.includes('human-approved during discovery') && n.includes('int-01'))).toBe(true);
  });

  it('parameterizes success criteria and keeps them from the final spine state', () => {
    const { artifact } = compiled();
    expect(artifact.successCriteria.length).toBeGreaterThan(0);
    expect(JSON.stringify(artifact.successCriteria)).not.toContain('99999');
  });
});

/**
 * Substitution ORDER. A param whose value is a prefix of another param's value
 * wins the span in a naive reduce, leaving the longer value half-templated —
 * and the hardcoded half pins the artifact to the recording session.
 *
 * This is the defect that shipped `member.transferFunds` with a final
 * postcondition of `textPresent "{memberId}-S0001:"`: replayed against any
 * other share pair the transfer POSTED and then reported POSTCONDITION_TIMEOUT,
 * telling the caller the money had not moved while it had.
 */
describe('parameterization order (longest value first)', () => {
  const shareDigest: StateDigest = {
    location: `${BASE}/transfer/receipt`,
    title: 'Receipt',
    markers: [{ text: 'TRANSFER POSTED' }, { text: '101555-S0001:' }],
  };
  const beforePost: StateDigest = { location: `${BASE}/transfer/review`, title: 'Review', markers: [{ text: 'CONFIRM FUNDS TRANSFER' }] };

  const prefixTrace: DiscoveryTrace = {
    goal: 'prefix collision',
    actions: [
      act({ kind: 'navigate', intent: 'Open the app', risk: 'read', url: `${BASE}/`, before: { location: 'about:blank', title: '', markers: [] }, after: beforePost }),
      act({
        kind: 'activate', intent: 'Post the transfer', risk: 'irreversible',
        // The row text carries BOTH values, with the shorter one a strict
        // prefix of the longer one and delimited by the '-'.
        element: { role: 'button', name: 'Post Transfer', nearText: '101555 | 101555-S0001 | posted', framePath: [] },
        before: beforePost, after: shareDigest,
      }),
    ],
    outcomes: [],
    done: { capabilityId: 'member.transferFunds', title: 't', description: 'd' },
  };

  const prefixParams = {
    memberId: ParamSpecSchema.parse({ type: 'string', description: genericCallerParamDescription('memberId'), sensitivity: 'internal', source: 'caller', example: '101555' }),
    fromShare: ParamSpecSchema.parse({ type: 'string', description: genericCallerParamDescription('fromShare'), sensitivity: 'internal', source: 'caller', example: '101555-S0001' }),
  };

  function compilePrefix() {
    return compileTrace({
      trace: prefixTrace,
      paramSpecs: prefixParams,
      // Declaration order deliberately puts the SHORTER value first — the
      // order a real `--param memberId=… --param fromShare=…` produces.
      callerParamValues: { memberId: '101555', fromShare: '101555-S0001' },
      outputHints: {},
      baseUrl: BASE,
      model: 'test',
      discoveryRunId: 'prefixrun',
      app: { appId: 'meridian-core', vendor: 'Cornerstone' },
      version: '1.0.0',
    });
  }

  it('the longer param value wins the span, whatever order the params were declared in', () => {
    const { artifact } = compilePrefix();
    const posted = artifact.steps.find((s) => s.intent === 'Post the transfer')!;
    const patterns = posted.post.map((p) => (p.c === 'textPresent' ? p.pattern : ''));
    // The whole share id becomes ONE placeholder. The old ordering produced
    // "{memberId}-S0001:" — a placeholder plus a hardcoded share.
    expect(patterns).toContain('{fromShare}:');
    // Nothing EXECUTABLE may carry the recorded share id. (`params.*.example`
    // legitimately still records it — that is the recorded value, and it is
    // what makes the artifact re-derivable.)
    const executable = JSON.stringify({ steps: artifact.steps, successCriteria: artifact.successCriteria });
    expect(executable).not.toContain('{memberId}-S0001');
    expect(executable).not.toContain('S0001');
  });

  it('still parameterizes the shorter value where it stands alone', () => {
    const { artifact } = compilePrefix();
    // The row anchor sees "101555 | 101555-S0001 | posted": both must bind.
    const posted = artifact.steps.find((s) => s.intent === 'Post the transfer')!;
    const json = JSON.stringify(posted.action);
    expect(json).toContain('{fromShare}');
    expect(json).toContain('{memberId}');
  });

  it('the success criteria mined from the final state are fully templated too', () => {
    const { artifact } = compilePrefix();
    expect(JSON.stringify(artifact.successCriteria)).toContain('{fromShare}');
    expect(JSON.stringify(artifact.successCriteria)).not.toContain('S0001');
  });

  it('lints a placeholder that runs into further identifier characters', () => {
    // A recorded identifier whose suffix NO param declares: reordering cannot
    // fix it, so the compiler must say so before a human approves it.
    const strayTrace = structuredClone(prefixTrace);
    strayTrace.actions[1]!.after = {
      ...shareDigest,
      markers: [{ text: 'TRANSFER POSTED' }, { text: '101555-S0002:' }],
    };
    const { report } = compileTrace({
      trace: strayTrace,
      paramSpecs: prefixParams,
      callerParamValues: { memberId: '101555', fromShare: '101555-S0001' },
      outputHints: {},
      baseUrl: BASE,
      model: 'test',
      discoveryRunId: 'strayrun',
      app: { appId: 'meridian-core', vendor: 'Cornerstone' },
      version: '1.0.0',
    });
    expect(report.notes.some((n) => n.includes('half-substituted') && n.includes('{memberId}-S0002'))).toBe(true);
  });

  it('does not lint ordinary prose or URL templates', () => {
    const { report } = compiled();
    expect(report.notes.every((n) => !n.includes('half-substituted'))).toBe(true);
  });
});

/**
 * Caller-param descriptions. The Capability-API criterion is "a catalog an
 * agent could invoke BY NAME WITHOUT KNOWING THE UI" — and
 * `"Caller-supplied parameter 'searchBy'"` repeats the name back at a caller
 * who already had it. The compiler holds what is missing: the on-screen label
 * of the field the param binds to, and a choose's offered options.
 */
describe('caller-param descriptions', () => {
  it('seeds the description from the on-screen label of the field it was typed into', () => {
    const { artifact } = compiled();
    expect(artifact.params['memberId']!.description).toBe('Typed into the "Member No. or Name" field on screen.');
  });

  it('leaves env params and human-authored descriptions alone', () => {
    const { artifact } = compiled();
    // Env-sourced: its own description is accurate and is not a placeholder.
    expect(artifact.params['operatorId']!.description).toBe('operator');
    const authored = compileTrace({
      trace,
      paramSpecs: {
        ...paramSpecs,
        memberId: ParamSpecSchema.parse({ ...paramSpecs.memberId, description: 'The member number to look up.' }),
      },
      callerParamValues: { memberId: '12345' },
      outputHints: { savingsBalance: { type: 'money', sensitivity: 'pii' } },
      baseUrl: BASE,
      model: 'test',
      discoveryRunId: 'authoredrun',
      app: { appId: 'mockcore-teller', vendor: 'MockCore' },
      version: '1.0.0',
    });
    expect(authored.artifact.params['memberId']!.description).toBe('The member number to look up.');
  });

  const searchByTrace: DiscoveryTrace = {
    goal: 'search by',
    actions: [
      act({ kind: 'navigate', intent: 'Open the app', risk: 'read', url: `${BASE}/login`, before: { location: 'about:blank', title: '', markers: [] }, after: loginDigest }),
      act({
        kind: 'choose', intent: 'Pick the search mode', risk: 'reversible',
        element: {
          role: 'combobox', name: 'Search by:', label: 'Search by:',
          options: ['Member Number', 'Last Name'], optionValues: ['number', 'name'],
          framePath: workFrame,
        },
        option: { literal: 'name' }, optionBy: 'value',
        before: searchDigest, after: searchDigest,
      }),
      act({
        kind: 'setValue', intent: 'Enter the search value', risk: 'reversible',
        element: { role: 'textbox', name: 'Value:', framePath: workFrame }, // no label recorded
        value: { literal: 'Lovelace' }, before: searchDigest, after: searchDigest,
      }),
    ],
    outcomes: [],
    done: { capabilityId: 'member.inquire', title: 't', description: 'd' },
  };
  const searchByParams = {
    searchBy: ParamSpecSchema.parse({ type: 'string', description: genericCallerParamDescription('searchBy'), sensitivity: 'none', source: 'caller', example: 'name' }),
    query: ParamSpecSchema.parse({ type: 'string', description: genericCallerParamDescription('query'), sensitivity: 'none', source: 'caller', example: 'Lovelace' }),
  };
  const compileSearchBy = () =>
    compileTrace({
      trace: searchByTrace,
      paramSpecs: searchByParams,
      callerParamValues: { searchBy: 'name', query: 'Lovelace' },
      outputHints: {},
      baseUrl: BASE,
      model: 'test',
      discoveryRunId: 'searchbyrun',
      app: { appId: 'meridian-core', vendor: 'Cornerstone' },
      version: '1.0.0',
    });

  it('records a choose param’s offered options as prose', () => {
    const { artifact } = compileSearchBy();
    // The bound-by-VALUE step matches option values, so the VALUES are what a
    // caller supplies — listing the visible labels would advertise inputs that
    // do not work.
    expect(artifact.params['searchBy']!.description).toBe(
      'Chosen in the "Search by" field on screen. Offered at recording time: number, name.',
    );
  });

  it('describes the offered options WITHOUT constraining the param to them', () => {
    // Deliberate: the same code path serves fromShare/toShare, whose offered
    // values are one member's share ids. An enum domain there would compile a
    // capability that rejects every other member.
    const { artifact } = compileSearchBy();
    expect(artifact.params['searchBy']!.type).toBe('string');
    expect(artifact.params['searchBy']!.values).toBeUndefined();
  });

  it('falls back to the generic text when no label was recorded', () => {
    const { artifact } = compileSearchBy();
    expect(artifact.params['query']!.description).toBe(genericCallerParamDescription('query'));
  });
});

/**
 * The per-transaction token assertion. ADAPTATION.md and the MERIDIAN profile
 * both say the system asserts a token is present before a posting step; until
 * this landed, neither the compiler nor any artifact did.
 */
describe('the per-transaction token assertion', () => {
  const profile = AppProfileSchema.parse(JSON.parse(readFileSync('profiles/meridian-core.profile.json', 'utf8')));

  // MERIDIAN as the replay evidence records it: the SIGN-ON form carries no
  // hidden token, the transfer form and its review screen each carry one.
  const signOn: StateDigest = { location: `${BASE}/`, title: 'Sign On', markers: [{ text: 'OPERATOR SIGN ON' }] };
  const form: StateDigest = { location: `${BASE}/transfer`, title: 'Transfer', markers: [{ text: 'FUNDS TRANSFER' }], hiddenFields: [{ name: '_token' }] };
  const review: StateDigest = { location: `${BASE}/transfer/review`, title: 'Review', markers: [{ text: 'CONFIRM FUNDS TRANSFER' }], hiddenFields: [{ name: '_token' }] };
  const receipt: StateDigest = { location: `${BASE}/transfer/receipt`, title: 'Receipt', markers: [{ text: 'TRANSFER POSTED' }] };

  const tokenTrace: DiscoveryTrace = {
    goal: 'token assertion',
    actions: [
      act({ kind: 'navigate', intent: 'Open the app', risk: 'read', url: `${BASE}/`, before: { location: 'about:blank', title: '', markers: [] }, after: signOn }),
      act({ kind: 'activate', intent: 'Sign On', risk: 'reversible', element: { role: 'button', name: 'Sign On', framePath: [] }, before: signOn, after: form }),
      act({ kind: 'activate', intent: 'Open Funds Transfer', risk: 'read', element: { role: 'link', name: 'Funds Transfer', framePath: [] }, before: form, after: form }),
      act({ kind: 'setValue', intent: 'Enter the amount', risk: 'reversible', element: { role: 'textbox', name: 'Amount:', label: 'Amount:', framePath: [] }, value: { literal: '25.00' }, before: form, after: form }),
      act({ kind: 'activate', intent: 'Continue', risk: 'reversible', element: { role: 'button', name: 'Continue', framePath: [] }, before: form, after: review }),
      act({ kind: 'activate', intent: 'Post Transfer', risk: 'irreversible', element: { role: 'button', name: 'Post Transfer', framePath: [] }, before: review, after: receipt }),
    ],
    outcomes: [],
    done: { capabilityId: 'member.transferFunds', title: 't', description: 'd' },
  };

  const compileToken = (withProfile: boolean) =>
    compileTrace({
      trace: tokenTrace,
      paramSpecs: {},
      callerParamValues: {},
      outputHints: {},
      baseUrl: BASE,
      model: 'test',
      discoveryRunId: 'tokenrun',
      app: { appId: 'meridian-core', vendor: 'Cornerstone' },
      version: '1.0.0',
      ...(withProfile ? { profile } : {}),
    });

  const TOKEN_CONDITION = {
    c: 'elementPresent',
    target: {
      framePath: [],
      strategies: [{ s: 'roleName', role: 'hidden', name: '_token', nameMatch: 'exact' }],
      disambiguation: { requireUnique: true, minScore: 0.6 },
    },
  };

  it('asserts the token before every form-posting step whose state carried one', () => {
    const { artifact } = compileToken(true);
    const cont = artifact.steps.find((s) => s.intent === 'Continue')!;
    const post = artifact.steps.find((s) => s.intent === 'Post Transfer')!;
    expect(cont.pre).toContainEqual(TOKEN_CONDITION);
    expect(post.pre).toContainEqual(TOKEN_CONDITION);
  });

  it('does NOT assert it on a posting step whose form carried no token', () => {
    // MERIDIAN's sign-on form POSTs and has no `_token`. A flat "every posting
    // step" rule would put an unsatisfiable precondition here and make every
    // capability unrunnable at step one.
    const { artifact, report } = compileToken(true);
    const signOnStep = artifact.steps.find((s) => s.intent === 'Sign On')!;
    expect(signOnStep.pre.some((c) => c.c === 'elementPresent')).toBe(false);
    expect(signOnStep.pre.length).toBeGreaterThan(0); // it keeps its marker precondition
    expect(report.notes.some((n) => n.includes("transaction token '_token': NOT asserted") && n.includes('s1'))).toBe(true);
    expect(report.notes.some((n) => n.includes("transaction token '_token': asserted present before s4, s5"))).toBe(true);
  });

  it('does not assert it on navigation or on typing steps', () => {
    // The link and the setValue both act on a page that DOES carry the token —
    // so this is the rule's first half doing the work, not the evidence gate.
    const { artifact } = compileToken(true);
    const link = artifact.steps.find((s) => s.intent === 'Open Funds Transfer')!;
    const typing = artifact.steps.find((s) => s.intent === 'Enter the amount')!;
    expect(link.pre.some((c) => c.c === 'elementPresent')).toBe(false);
    expect(typing.pre).toEqual([]);
  });

  it('emits nothing at all when the run had no app profile', () => {
    const { artifact, report } = compileToken(false);
    expect(JSON.stringify(artifact)).not.toContain('elementPresent');
    expect(report.notes.every((n) => !n.includes('transaction token'))).toBe(true);
  });

  it('stays schema-legal and hash-consistent with the extra precondition', () => {
    const { artifact } = compileToken(true);
    expect(computeContentHash(artifact)).toBe(artifact.integrity.contentHash);
  });

  /**
   * Ground truth. The synthetic trace above asserts what the compiler EMITS;
   * this asserts the emitted condition would actually match MERIDIAN, by
   * evaluating it against element maps captured on the live app during a
   * committed replay of member.transferFunds.
   */
  describe('against the committed MERIDIAN replay evidence', () => {
    // Found rather than hardcoded. Committed evidence is CURATED — runs are
    // pruned and re-recorded as capabilities change — so pinning a run id makes
    // this suite fail for a reason that has nothing to do with the compiler.
    // What the test actually needs is "any committed transferFunds replay that
    // captured element maps", and that is what it looks for.
    const runsDir = 'evidence/meridian/replay';
    const RUN = (() => {
      for (const id of readdirSync(runsDir).sort().reverse()) {
        const steps = path.join(runsDir, id, 'steps');
        const resultFile = path.join(runsDir, id, 'result.json');
        if (!existsSync(steps) || !existsSync(resultFile)) continue;
        const result = JSON.parse(readFileSync(resultFile, 'utf8')) as { capabilityId?: string };
        if (result.capabilityId !== 'member.transferFunds') continue;
        if (readdirSync(steps).some((f) => f.endsWith('.elements.json'))) return steps;
      }
      throw new Error('no committed member.transferFunds replay carries element maps');
    })();
    /** The nth captured element map, by capture order — the file names carry a
     *  running counter and the step they followed, both of which move when a
     *  capability is re-recorded. Position is the stable handle. */
    const dumps = readdirSync(RUN).filter((f) => f.endsWith('.elements.json')).sort();
    const observationFrom = (file: string): Observation => {
      const dump = JSON.parse(readFileSync(path.join(RUN, file), 'utf8')) as { location: string; elements: ObservedElement[] };
      return { seq: 1, location: dump.location, title: '', elements: dump.elements, visibleText: '', at: '1970-01-01T00:00:00.000Z' };
    };
    /** The first captured state whose location is the review screen, and the
     *  one before it — the two states the posting steps act on. */
    const locationOf = (file: string): string =>
      (JSON.parse(readFileSync(path.join(RUN, file), 'utf8')) as { location: string }).location;
    const reviewIdx = dumps.findIndex((f) => locationOf(f).includes('/transfer/review'));
    const tokenCondition = () => {
      const { artifact } = compileToken(true);
      const cond = artifact.steps.find((s) => s.intent === 'Post Transfer')!.pre.find((c) => c.c === 'elementPresent');
      if (cond === undefined) throw new Error('no token condition was emitted');
      return cond;
    };

    it('matches the transfer form — the state the Continue step posts from', async () => {
      expect(reviewIdx).toBeGreaterThan(0);
      expect(await evaluateCondition(tokenCondition(), observationFrom(dumps[reviewIdx - 1]!))).toBe(true);
    });

    it('matches the review screen — the state the Post Transfer step posts from', async () => {
      expect(reviewIdx).toBeGreaterThanOrEqual(0);
      expect(await evaluateCondition(tokenCondition(), observationFrom(dumps[reviewIdx]!))).toBe(true);
    });

    it('does NOT match the sign-on screen — which is why the evidence gate exists', async () => {
      // The first capture of any run is the entrypoint: MERIDIAN's sign-on form
      // posts without a token, so a flat "every posting step" rule would have
      // put an unsatisfiable precondition on step 1 of all seven capabilities.
      expect(await evaluateCondition(tokenCondition(), observationFrom(dumps[0]!))).toBe(false);
    });
  });
});
