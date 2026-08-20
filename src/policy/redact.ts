/**
 * Sensitivity-driven redaction, applied at the WRITE BOUNDARY (evidence
 * logger, recorder) rather than at call sites — one place to audit, no way
 * to forget. Secret values never appear in any serialized output; PII is
 * masked to a recognizable stub.
 */

export type Sensitivity = 'none' | 'internal' | 'pii' | 'secret';

/** Increasing order of protection — the only place the ranking is written down. */
const RANK: Sensitivity[] = ['none', 'internal', 'pii', 'secret'];

/**
 * The stronger of two sensitivities. Every cross-check between what one source
 * declares about a value and what another knows about it must RAISE, never
 * lower: a declaration is a claim about the minimum protection a value needs,
 * so disagreement resolves towards the stricter claim rather than the newer one.
 */
export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return RANK.indexOf(a) >= RANK.indexOf(b) ? a : b;
}

export function maskValue(name: string, value: string, sensitivity: Sensitivity): string {
  switch (sensitivity) {
    case 'none':
    case 'internal':
      return value;
    case 'pii':
      return value.length > 2 ? `***${value.slice(-2)}` : '***';
    case 'secret':
      return `«secret:${name}»`;
  }
}

interface Substitution {
  needle: string;
  replacement: string;
}

export class Redactor {
  private subs: Substitution[] = [];
  private readonly known = new Set<string>();

  /**
   * Register a sensitive value; every future write is scrubbed of it.
   * Returns true when the value was newly registered.
   *
   * Registration is idempotent because field classification re-sweeps every
   * observation: without deduping, the substitution list would grow without
   * bound over a long run and re-sort on each write.
   */
  register(name: string, value: string, sensitivity: Sensitivity): boolean {
    if (sensitivity === 'none' || sensitivity === 'internal') return false;
    // Values shorter than 4 chars would over-redact unrelated evidence text
    // (timestamps, ids); such values are masked at explicit call sites only.
    if (value.length < 4) return false;
    if (this.known.has(value)) return false;
    this.known.add(value);
    const replacement = maskValue(name, value, sensitivity);
    this.subs.push({ needle: value, replacement });
    // Writes are JSON-serialized, which escapes quotes/backslashes/newlines —
    // register the escaped form too so such values cannot slip through.
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) {
      this.subs.push({ needle: escaped, replacement: JSON.stringify(replacement).slice(1, -1) });
    }
    // Longest needles first so substrings of other secrets don't mangle them.
    this.subs.sort((a, b) => b.needle.length - a.needle.length);
    return true;
  }

  apply(text: string): string {
    let out = text;
    for (const { needle, replacement } of this.subs) {
      out = out.split(needle).join(replacement);
    }
    return out;
  }
}
