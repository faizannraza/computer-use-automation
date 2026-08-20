/**
 * The compiler is deterministic code — so it gets deterministic tests: a
 * synthetic recorded trace exercising pruning (probe exclusion),
 * parameterization by value-matching, checkpoint mining from state deltas,
 * locator-ladder construction, and outcome attachment.
 */
import { describe, expect, it } from 'vitest';
import { computeContentHash } from '../src/schema/capability.js';
import { ParamSpecSchema } from '../src/schema/capability.js';
import { compileTrace } from '../src/discovery/compile.js';
import type { DiscoveryTrace, RecordedAction, StateDigest } from '../src/discovery/recorder.js';

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
  memberId: ParamSpecSchema.parse({ type: 'string', description: 'member number', sensitivity: 'internal', source: 'caller', pattern: '^[0-9]+$', example: '12345' }),
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
