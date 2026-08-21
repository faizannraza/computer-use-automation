/**
 * The one architectural claim this repo states in bold, in two documents:
 *
 *   "Discovery and replay never import each other — the artifact is their only
 *    interface."
 *
 * It is the reason the same flow can be recorded by a model and executed
 * without one: if the two engines could reach into each other, "no model in the
 * loop" would be a property of the current call graph rather than of the design.
 *
 * It was quietly false for a while — `discovery/toolExecutor.ts` imported
 * `summarizeObservation` from `replay/detectors.ts`. One import, one direction,
 * a pure formatter, no behavioural consequence at all — and still exactly the
 * kind of claim a reviewer checks with a single grep. The function moved to
 * `core/`, where both engines can share it from underneath.
 *
 * A stated invariant with no test is a comment. This is the test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Every module specifier this file imports from. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/g)].map((m) => m[1]!);
}

/** Resolve a relative specifier against its importer, as a repo-relative path. */
function resolved(file: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return path.normalize(path.join(path.dirname(file), specifier));
}

describe('the discovery/replay boundary', () => {
  it('has files on both sides, so this suite cannot pass vacuously', () => {
    expect(sourceFiles('src/discovery').length).toBeGreaterThan(3);
    expect(sourceFiles('src/replay').length).toBeGreaterThan(2);
  });

  it('discovery never imports replay', () => {
    for (const file of sourceFiles('src/discovery')) {
      for (const spec of importsOf(file)) {
        expect(resolved(file, spec), `${file} imports ${spec}`).not.toContain(`src${path.sep}replay`);
      }
    }
  });

  it('replay never imports discovery', () => {
    for (const file of sourceFiles('src/replay')) {
      for (const spec of importsOf(file)) {
        expect(resolved(file, spec), `${file} imports ${spec}`).not.toContain(`src${path.sep}discovery`);
      }
    }
  });

  it('keeps the replay engine free of the Anthropic SDK', () => {
    // The stronger version of the same claim, and the one a reviewer actually
    // cares about: it is not merely that replay avoids the discovery *folder*,
    // it is that no model client is reachable from the production path at all.
    for (const file of [...sourceFiles('src/replay'), ...sourceFiles('src/policy'), ...sourceFiles('src/surface')]) {
      for (const spec of importsOf(file)) {
        expect(spec, `${file} imports ${spec}`).not.toContain('@anthropic-ai/sdk');
      }
    }
  });
});
