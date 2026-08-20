/** Catalog entries are derived entirely from the artifact's own contract. */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog, findByName, loadCatalog } from '../src/catalog/catalog.js';

describe('capability catalog', () => {
  const entries = buildCatalog();

  it('lists both shipped capabilities', () => {
    expect(entries.map((e) => e.name).sort()).toEqual(['member.openSubAccount', 'member.readSavingsBalance']);
  });

  it('derives a typed input schema from caller params (env params excluded)', () => {
    const read = findByName('member.readSavingsBalance');
    expect(read.inputSchema.required).toEqual(['memberId']);
    expect(read.inputSchema.properties['memberId']).toMatchObject({ type: 'string', pattern: '^[0-9]+$' });
    expect(read.inputSchema.properties).not.toHaveProperty('operatorPassword');
    expect(read.inputSchema.additionalProperties).toBe(false);
  });

  it('tells the calling agent about outputs, outcomes, and risk', () => {
    const read = findByName('member.readSavingsBalance');
    expect(read.description).toContain('savingsBalance (money)');
    expect(read.description).toContain('MEMBER_NOT_FOUND');
    const open = findByName('member.openSubAccount');
    expect(open.maxRisk).toBe('irreversible');
    expect(open.description).toContain('IRREVERSIBLE');
    expect(open.inputSchema.properties['acctType']).toMatchObject({
      enum: ['REGULAR SAVINGS', 'CHECKING', 'MONEY MARKET', 'HOLIDAY CLUB'],
    });
  });

  it('surfaces the approval state so a caller can gate on it', () => {
    for (const e of entries) expect(['draft', 'approved']).toContain(e.approval);
  });

  it('throws a clear error for unknown capability names', () => {
    expect(() => findByName('member.doesNotExist')).toThrow(/no capability named/);
  });
});

/**
 * One unloadable artifact used to throw out of `buildCatalog`, which took
 * every consumer with it — the API's catalog, health and invoke routes all
 * 500'd on a directory that also held perfectly good recordings. A catalog is
 * a bag of independently recorded artifacts; its failure mode has to be
 * per-artifact.
 */
describe('a broken artifact costs exactly one entry', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cu-catalog-'));
    copyFileSync('capabilities/member.readSavingsBalance@1.0.0.json', path.join(dir, 'member.readSavingsBalance@1.0.0.json'));
    // Schema-valid JSON, invalid artifact: exactly what the newer refusals
    // (a readTable step's output must be `type: 'table'`, a detector may not
    // match on redacted text) produce from a recording made before them.
    writeFileSync(path.join(dir, 'member.brokenFlow@1.0.0.json'), JSON.stringify({ capability: { id: 'member.brokenFlow' } }), 'utf8');
    // Not even JSON — the other way a file in this directory goes wrong.
    writeFileSync(path.join(dir, 'member.truncated@1.0.0.json'), '{"capability":', 'utf8');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('still returns every VALID entry', () => {
    const { entries, broken } = loadCatalog(dir);
    expect(entries.map((e) => e.name)).toEqual(['member.readSavingsBalance']);
    expect(buildCatalog(dir).map((e) => e.name)).toEqual(['member.readSavingsBalance']);
    expect(broken).toHaveLength(2);
  });

  it('names the file and quotes the error for each broken one', () => {
    const { broken } = loadCatalog(dir);
    const bad = broken.find((b) => b.name === 'member.brokenFlow');
    expect(bad?.file).toBe(path.join(dir, 'member.brokenFlow@1.0.0.json'));
    expect(bad?.error).toBeTruthy();
    // The presumed name comes from the FILE, since the artifact's own id is
    // exactly what could not be read.
    expect(broken.map((b) => b.name).sort()).toEqual(['member.brokenFlow', 'member.truncated']);
  });

  it('reports a broken name as broken, not as missing', () => {
    expect(() => findByName('member.brokenFlow', dir)).toThrow(/failed to load from .*member\.brokenFlow@1\.0\.0\.json/);
    expect(() => findByName('member.neverRecorded', dir)).toThrow(/no capability named/);
    expect(findByName('member.readSavingsBalance', dir).name).toBe('member.readSavingsBalance');
  });

  it('reports an unreadable DIRECTORY as one broken entry rather than throwing', () => {
    const { entries, broken } = loadCatalog(path.join(dir, 'no-such-directory'));
    expect(entries).toEqual([]);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.error).toMatch(/ENOENT|no such file/i);
  });
});
