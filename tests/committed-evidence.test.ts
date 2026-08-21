/**
 * The evidence directory is a deliverable, not a by-product: the README, the
 * adaptation write-up and `evidence/meridian/README.md` all point a reviewer at
 * specific runs as proof of specific claims. A run directory that lost its
 * `result.json` is a dead link in that argument, and nothing would have said so
 * — the dashboard indexes what it finds and quietly shows less.
 *
 * Driven off `git ls-files` rather than the filesystem, deliberately. The claim
 * being tested is about COMMITTED evidence; local scratch runs under
 * `evidence/_scratch/` are gitignored, and a rehearsal run that is still being
 * written must not fail anyone's test suite.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** Every committed run directory, as `{ dir, kind }`. */
function committedRuns(): { dir: string; kind: 'replay' | 'discovery' }[] {
  const tracked = execFileSync('git', ['ls-files', 'evidence'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const runs = new Map<string, 'replay' | 'discovery'>();
  for (const file of tracked) {
    const parts = file.split('/');
    // `evidence/replay/<id>/…` and `evidence/<app>/replay/<id>/…` both occur,
    // so find the kind segment rather than assuming a depth.
    const i = parts.findIndex((p) => p === 'replay' || p === 'discovery');
    if (i === -1 || parts.length < i + 2) continue;
    runs.set(parts.slice(0, i + 2).join('/'), parts[i] as 'replay' | 'discovery');
  }
  return [...runs].map(([dir, kind]) => ({ dir, kind }));
}

const runs = committedRuns();
const tracked = new Set(execFileSync('git', ['ls-files', 'evidence'], { encoding: 'utf8' }).split('\n').filter(Boolean));

describe('committed evidence', () => {
  it('is present at all', () => {
    // Without this, deleting the whole directory would turn every assertion
    // below into a vacuous pass over an empty list.
    expect(runs.filter((r) => r.kind === 'replay').length).toBeGreaterThanOrEqual(19);
    expect(runs.filter((r) => r.kind === 'discovery').length).toBeGreaterThanOrEqual(7);
  });

  it.each(runs)('$dir carries the files its kind is indexed by', ({ dir, kind }) => {
    // A replay run is cited for its OUTCOME, so it needs the structured result
    // as well as the event log. A discovery run is cited as proof the artifact
    // was compiled rather than written, so it needs the trace's compile report
    // and the draft artifact that came out of it.
    const required =
      kind === 'replay' ? ['result.json', 'run.jsonl'] : ['run.jsonl', 'artifact.json', 'compile-report.json'];
    for (const file of required) {
      expect(tracked.has(`${dir}/${file}`), `${dir} is missing ${file}`).toBe(true);
    }
  });

  it('never commits an empty run', () => {
    // A directory with only a result and no screenshots is not evidence of
    // anything a person could check.
    for (const { dir } of runs) {
      const files = [...tracked].filter((f) => f.startsWith(`${dir}/`));
      expect(files.length, `${dir} has too few files to be evidence`).toBeGreaterThan(2);
    }
  });
});
