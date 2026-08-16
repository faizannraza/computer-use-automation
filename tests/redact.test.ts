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
