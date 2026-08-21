/**
 * Approval is the moment a human takes responsibility for an artifact, and it
 * was the one step in the pipeline that never showed them what the compiler had
 * already found.
 *
 * This is not hypothetical. `member.placeHold`'s step s13 — the irreversible
 * "Apply Hold" click — ships with a `textAnchor` rung anchored on `***da`, a
 * redacted member name. It can never match a live screen, so the fallback that
 * exists to catch a renamed button cannot catch anything. Today's compiler says
 * so in as many words. It shipped because that lint was written *after* the
 * artifact was recorded and approved, and nothing re-reads the notes at
 * approval time or ever again.
 *
 * Most of this is unit-tested against `blockingLints` directly. Only the exit
 * code needs the real CLI, and that test deliberately spawns ONE subprocess:
 * four of them ran the browser-driving suites out of CPU and made
 * `hitl.integration` flaky, which is a poor trade for coverage of a `switch`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockingLints } from '../src/discovery/lintPolicy.js';

const REDACTED_RUNG =
  's13: strategy 1 (textAnchor) anchors on redacted text and can never match at replay — it will always fall through to the next rung';
const VOLATILE_RUNG =
  's5: locator rung 0 matches on "OPR TELLER1 | BR MAIN-001 | 08/20/2026 20:31:36 | SID 7086C867", which carries a timestamp or session id from the recording — it can never match again, so this step will always resolve at a lower rung; re-record or drop the rung';
const HALF_SUB =
  'possible half-substituted value "{memberId}-S0001": a {param} placeholder runs straight into further identifier characters, so part of a recorded identifier is hardcoded — that fragment pins this capability to the record it was recorded against; review before approval';
const ADVISORY = 's3: checkpoint may be non-specific — unscoped short marker "1."; review before approval';
const HUMAN_APPROVED =
  's13: irreversible action was human-approved during discovery (intervention int-01) — replay will escalate it the same way under the default policy';

describe('which compiler notes are a veto', () => {
  it('blocks a locator rung that can never match — both ways of producing one', () => {
    // Redacted text and recording-session text are different causes with the
    // same consequence: a fallback rung that is inert from the day it shipped.
    expect(blockingLints([REDACTED_RUNG]).map((b) => b.note)).toEqual([REDACTED_RUNG]);
    expect(blockingLints([VOLATILE_RUNG]).map((b) => b.note)).toEqual([VOLATILE_RUNG]);
  });

  it('blocks a half-substituted identifier — the defect that moved money once', () => {
    const [hit] = blockingLints([HALF_SUB]);
    expect(hit?.why).toContain('only for the record it was recorded on');
  });

  it('lets judgement calls through', () => {
    // A short checkpoint and a discovery-time human approval are things a
    // reviewer can reasonably accept. Blocking them would train people to pass
    // --acknowledge-lints by reflex, which would be worse than having no gate.
    expect(blockingLints([ADVISORY, HUMAN_APPROVED])).toEqual([]);
  });

  it('reports every blocking note, not just the first', () => {
    expect(blockingLints([ADVISORY, REDACTED_RUNG, HALF_SUB, HUMAN_APPROVED])).toHaveLength(2);
  });

  it('says nothing about an artifact the compiler had nothing to say about', () => {
    expect(blockingLints([])).toEqual([]);
  });
});

describe('cu approve, end to end', () => {
  it('exits 65 and leaves the artifact unapproved', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cu-approve-'));
    const artifact = path.join(dir, 'artifact.json');
    copyFileSync('capabilities-meridian/member.placeHold@1.0.0.json', artifact);
    writeFileSync(path.join(dir, 'compile-report.json'), JSON.stringify({ notes: [ADVISORY, REDACTED_RUNG] }));
    const parsed = JSON.parse(readFileSync(artifact, 'utf8')) as { provenance: { evidenceRef: string } };
    parsed.provenance.evidenceRef = dir;
    writeFileSync(artifact, JSON.stringify(parsed, null, 2));

    let code = 0;
    let out = '';
    try {
      out = execFileSync('npx', ['tsx', 'src/cli.ts', 'approve', artifact, '--by', 'Test Reviewer'], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      code = e.status;
      out = `${e.stdout}${e.stderr}`;
    }

    expect(code).toBe(65);
    expect(out).toContain('REFUSING to approve');
    // Both notes are shown, so a reviewer sees the whole picture, not just the veto.
    expect(out).toContain('may be non-specific');
    // A refused approval that still wrote the file would be worse than no gate.
    const after = JSON.parse(readFileSync(artifact, 'utf8')) as { provenance: { approval?: { by?: string } } };
    expect(after.provenance.approval?.by).not.toBe('Test Reviewer');
  });
});
