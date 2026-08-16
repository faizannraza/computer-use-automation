/** Catalog entries are derived entirely from the artifact's own contract. */
import { describe, expect, it } from 'vitest';
import { buildCatalog, findByName } from '../src/catalog/catalog.js';

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
