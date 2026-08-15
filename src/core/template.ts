/**
 * Placeholder substitution for artifact strings: `{name}` resolves against
 * the invocation's params + tenant bindings. Unresolved placeholders are an
 * error, not a silent passthrough — a mis-parameterized artifact must fail
 * loudly at the offending step, never act on a literal "{memberId}".
 */

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

export function applyTemplate(text: string, subst: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    const value = subst[name];
    if (value === undefined) {
      throw new Error(`unresolved placeholder {${name}} — not among params/bindings [${Object.keys(subst).join(', ')}]`);
    }
    return value;
  });
}

/** Deep-substitute every string in a (JSON-shaped) value. Returns a copy. */
export function substituteDeep<T>(value: T, subst: Record<string, string>): T {
  if (typeof value === 'string') return applyTemplate(value, subst) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, subst)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substituteDeep(v, subst);
    return out as unknown as T;
  }
  return value;
}
