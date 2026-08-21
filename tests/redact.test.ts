/** Redaction edge cases: serialized-output escaping and over-redaction guards. */
import { describe, expect, it } from 'vitest';
import { Redactor } from '../src/policy/redact.js';

describe('Redactor', () => {
  it('scrubs values even after JSON serialization escapes their characters', () => {
    const r = new Redactor();
    r.register('password', 'pa"ss\\word\nX', 'secret');
    const serialized = JSON.stringify({ note: 'the value pa"ss\\word\nX leaked' });
    const out = r.apply(serialized);
    expect(out).not.toContain('ss\\\\word'); // escaped form gone
    expect(out).toContain('«secret:password»');
    expect(() => JSON.parse(out)).not.toThrow(); // output remains valid JSON
  });

  it('refuses to register values so short they would corrupt unrelated text', () => {
    const r = new Redactor();
    r.register('pin', '12', 'pii');
    expect(r.apply('timestamp 2026-08-12T12:12:12')).toBe('timestamp 2026-08-12T12:12:12');
  });
});

/**
 * The ordering rule, which has the same shape as the compiler bug that once
 * moved money and reported failure.
 *
 * `paramize`'s longest-value-first rule is pinned by three tests, because a
 * shorter param value ate the prefix of a longer one and froze the recording's
 * own share into the contract. The redactor carries the identical rule at
 * `redact.ts:68` — and carried it untested, so mutating the sort away left the
 * whole suite green.
 *
 * The consequence is worse here than in the compiler: this is the write
 * boundary. A short needle applied first leaves the tail of a longer one in
 * cleartext, in the file whose entire job is to prove nothing survived.
 */
describe('needle ordering at the write boundary', () => {
  it('masks the longest needle first, so a short value cannot mangle a longer one', () => {
    const r = new Redactor();
    r.register('memberId', '101555', 'pii'); // registered FIRST, and shorter
    r.register('fromShare', '101555-S0001', 'pii'); // registered second, longer
    const out = r.apply('posted from 101555-S0001 for member 101555');
    // Without the sort this reads `***55-S0001` — the share number survives.
    expect(out).not.toContain('S0001');
    expect(out).toBe('posted from ***01 for member ***55');
  });

  it('holds regardless of registration order', () => {
    const r = new Redactor();
    r.register('fromShare', '101555-S0001', 'pii'); // longer first this time
    r.register('memberId', '101555', 'pii');
    expect(r.apply('101555-S0001')).toBe('***01');
  });
});
