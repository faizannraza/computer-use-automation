/**
 * Sensitivity-driven redaction, applied at the WRITE BOUNDARY (evidence
 * logger, recorder) rather than at call sites — one place to audit, no way
 * to forget. Secret values never appear in any serialized output; PII is
 * masked to a recognizable stub.
 */

export type Sensitivity = 'none' | 'internal' | 'pii' | 'secret';

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

  /** Register a sensitive value; every future write is scrubbed of it. */
  register(name: string, value: string, sensitivity: Sensitivity): void {
    if (sensitivity === 'none' || sensitivity === 'internal') return;
    if (value.length === 0) return;
    this.subs.push({ needle: value, replacement: maskValue(name, value, sensitivity) });
    // Longest needles first so substrings of other secrets don't mangle them.
    this.subs.sort((a, b) => b.needle.length - a.needle.length);
  }

  apply(text: string): string {
    let out = text;
    for (const { needle, replacement } of this.subs) {
      out = out.split(needle).join(replacement);
    }
    return out;
  }
}
