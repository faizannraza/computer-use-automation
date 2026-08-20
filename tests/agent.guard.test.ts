/** Discovery must never clobber a reviewed capability: the artifact-write
 * guard refuses APPROVED (and unreadable) targets, allows drafts. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertArtifactWritable } from '../src/discovery/agent.js';

const dir = 'evidence/_scratch/guard-test';
mkdirSync(dir, { recursive: true });

function fileWith(name: string, content: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('assertArtifactWritable', () => {
  it('allows a missing target', () => {
    expect(() => assertArtifactWritable(path.join(dir, 'nope.json'))).not.toThrow();
  });

  it('allows overwriting an existing DRAFT (the iterate-on-discovery loop)', () => {
    const p = fileWith('draft.json', JSON.stringify({ provenance: { approval: { state: 'draft' } } }));
    expect(() => assertArtifactWritable(p)).not.toThrow();
  });

  it('refuses to overwrite an APPROVED artifact, naming the escape hatches', () => {
    const p = fileWith('approved.json', JSON.stringify({ provenance: { approval: { state: 'approved', by: 'reviewer' } } }));
    expect(() => assertArtifactWritable(p)).toThrow(/APPROVED.*--save-dir.*--artifact-version/s);
  });

  it('refuses to overwrite a file it cannot read as an artifact', () => {
    const p = fileWith('garbage.json', 'not json at all {');
    expect(() => assertArtifactWritable(p)).toThrow(/not a readable artifact/);
  });
});
