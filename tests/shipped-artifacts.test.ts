/**
 * Every artifact this repo ships, checked as a set — for the properties that
 * are NOT its content hash.
 *
 * Integrity is already covered: `schema.test.ts` sweeps both directories and
 * hash-verifies every file, and `compiled-artifact.test.ts` proves one artifact
 * generalizes by replaying it. What nothing asserted is the rest of the
 * contract a reviewer is being asked to trust — that the shipped set is
 * approved by a named human, that anything claiming to be LLM-discovered can
 * point at the run that produced it, that the filename agrees with the id
 * inside, and that `policy.actionsUsed` — which a reviewer reads INSTEAD of the
 * step list — does not under-report what the steps actually do.
 *
 * Deliberately discovers files from disk rather than listing them. A capability
 * recorded next month is covered the moment it is committed, which is the only
 * way a suite like this stays true.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCapability } from '../src/schema/capability.js';

const DIRS = ['capabilities', 'capabilities-meridian'];

const shipped = DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ dir, file: path.join(dir, f) })),
);

describe('shipped capability artifacts', () => {
  it('finds every directory of artifacts the repo claims to ship', () => {
    // A directory renamed or emptied would otherwise turn this whole file into
    // a suite that asserts nothing and still passes.
    expect(shipped.filter((s) => s.dir === 'capabilities-meridian')).toHaveLength(7);
    expect(shipped.filter((s) => s.dir === 'capabilities')).toHaveLength(2);
  });

  it('records all seven MERIDIAN capabilities from a real discovery run', () => {
    // The claim the write-up makes about the deliverable, asserted rather than
    // asserted-about: none of the seven was written by hand and back-filled.
    for (const { file, dir } of shipped) {
      if (dir !== 'capabilities-meridian') continue;
      const { artifact } = loadCapability(file);
      expect(artifact.provenance.recordedBy.kind, `${file}`).toBe('llm-discovery');
    }
  });

  it.each(shipped)('$file is approved, attributable, and correctly named', ({ file }) => {
    const { artifact } = loadCapability(file);

    // Approved: a draft is loadable but must not be callable without an
    // explicit opt-in, so the shipped set is approved by a named human.
    expect(artifact.provenance.approval?.state, `${file}: not approved`).toBe('approved');
    expect(artifact.provenance.approval?.by ?? '').not.toBe('');

    // Provenance is honest about itself. `capabilities/` still carries one
    // openly hand-authored MockCore artifact; what must never happen is an
    // artifact CLAIMING discovery without the run that would prove it, since
    // that claim is what `cu recompile` is offered against.
    if (artifact.provenance.recordedBy.kind === 'llm-discovery') {
      expect(artifact.provenance.evidenceRef ?? '', `${file}: claims discovery with no evidenceRef`).not.toBe('');
      expect(artifact.provenance.recordedBy.discoveryRunId ?? '').not.toBe('');
    }

    // The filename encodes id@version. A mismatch means a copy that was edited
    // but not renamed — the exact shape of a stale artifact shadowing a good one.
    expect(path.basename(file)).toBe(`${artifact.capability.id}@${artifact.capability.version}.json`);
  });

  it('declares every action its steps actually use', () => {
    // policy.actionsUsed is what a reviewer reads instead of the step list, and
    // what the gate cross-checks. It must not under-report.
    for (const { file } of shipped) {
      const { artifact } = loadCapability(file);
      const used = new Set(artifact.steps.map((s) => s.action.kind));
      for (const kind of used) {
        expect(artifact.policy.actionsUsed, `${file}: step uses '${kind}', not declared in policy.actionsUsed`).toContain(
          kind,
        );
      }
    }
  });

  it('never commits a masked value into a step, which would replay as literal asterisks', () => {
    // The redactor runs over discovery traces; if a marker or a param example
    // survived into a committed step value, replay would type `***` into a live
    // banking form. The schema refuses to LOAD such an artifact, so this asserts
    // the shipped set never regressed into needing that refusal.
    const masked = /\*\*\*|«secret:/;
    for (const { file } of shipped) {
      const { artifact } = loadCapability(file);
      for (const step of artifact.steps) {
        const value = 'value' in step.action ? step.action.value : undefined;
        if (typeof value === 'string') {
          expect(masked.test(value), `${file}: step ${step.id} has a redacted literal as its value`).toBe(false);
        }
      }
    }
  });
});
