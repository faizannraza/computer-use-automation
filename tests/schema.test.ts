/** The artifact schema's own guarantees: integrity, contract cross-checks. */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CapabilityArtifactSchema,
  ParamSpecSchema,
  StepSchema,
  computeContentHash,
  loadCapability,
} from '../src/schema/capability.js';

const GOLD = 'tests/fixtures/member.readSavingsBalance.gold.json';

describe('the hash rule (tripwire for every future schema change)', () => {
  // loadCapability parses THEN hashes the parsed object, so a new `.default()`
  // field anywhere in the schema silently rewrites canonical JSON for every
  // artifact ever produced and breaks its stored hash — making committed
  // capabilities unreplayable. New fields must be `.optional()`.
  // BOTH directories, deliberately. `capabilities/` holds the two MockCore
  // artifacts and neither uses readTable, appWide, choose-by-value or
  // requiresRole — so a `.default()` added to any of the NEW vocabulary would
  // leave those two byte-identical, keep this suite green, and quietly make all
  // seven MERIDIAN capabilities unreplayable in production.
  for (const dir of ['capabilities', 'capabilities-meridian']) {
    it(`every shipped artifact in ${dir}/ still hash-verifies`, () => {
      const shipped = readdirSync(dir).filter((f) => f.endsWith('.json'));
      expect(`${dir} has artifacts: ${shipped.length > 0}`).toBe(`${dir} has artifacts: true`);
      for (const file of shipped) {
        const { artifact, verified } = loadCapability(path.join(dir, file));
        // Named per file so a failure says WHICH artifact broke.
        expect(`${file}=${verified}`).toBe(`${file}=true`);
        expect(computeContentHash(artifact)).toBe(artifact.integrity.contentHash);
      }
    });
  }
});

/**
 * A detector whose marker was redacted can never match a live screen, so it
 * withdraws the handling it appears to declare — invisibly, until the one run
 * that needed it reports a hard failure instead of a named outcome.
 *
 * This is not hypothetical. MERIDIAN's sign-on error reads "Invalid operator ID
 * or password.", and the demo operator's credential IS the word `password`, so
 * the mined marker was stored as "Invalid operator ID or «secret:operatorPassword»."
 * and a bad login reported POSTCONDITION_TIMEOUT rather than BAD_CREDENTIALS.
 */
describe('detectors cannot match on redacted text', () => {
  const load = (): Record<string, unknown> =>
    JSON.parse(readFileSync(GOLD, 'utf8')) as Record<string, unknown>;

  it('accepts the gold artifact as-is', () => {
    expect(() => CapabilityArtifactSchema.parse(load())).not.toThrow();
  });

  it.each([
    ['outcomes', '«secret:operatorPassword»'],
    ['outcomes', '***97'],
    ['recoveries', '«secret:operatorPassword»'],
    ['anomalies', '***'],
  ])('rejects a %s marker containing %s', (section, masked) => {
    const a = load();
    const spec = {
      code: 'POISONED',
      description: 'a marker that redaction masked',
      when: { c: 'textPresent', pattern: `Invalid operator ID or ${masked}.` },
      ...(section === 'outcomes' ? { terminal: true, outputs: {} } : {}),
      ...(section === 'recoveries' ? { handler: { kind: 'restartRun' }, maxAttempts: 1 } : {}),
    };
    (a[section] as unknown[]) = [...((a[section] as unknown[]) ?? []), spec];
    expect(() => CapabilityArtifactSchema.parse(a)).toThrow(/can never fire/);
  });

  it('leaves an ordinary marker alone', () => {
    const a = load();
    (a['outcomes'] as unknown[]) = [
      ...((a['outcomes'] as unknown[]) ?? []),
      { code: 'FINE', description: 'ordinary', when: { c: 'textPresent', pattern: 'Invalid operator ID or' }, terminal: true, outputs: {} },
    ];
    expect(() => CapabilityArtifactSchema.parse(a)).not.toThrow();
  });
});

describe('capability artifact', () => {
  it('the gold artifact parses and its content hash verifies', () => {
    const { artifact, verified } = loadCapability(GOLD);
    expect(artifact.capability.id).toBe('member.readSavingsBalance');
    expect(verified).toBe(true);
  });

  it('tampering after hashing is detectable', () => {
    const { artifact } = loadCapability(GOLD);
    const tampered = structuredClone(artifact);
    tampered.steps[0]!.intent = 'Do something else entirely';
    expect(computeContentHash(tampered)).not.toBe(tampered.integrity.contentHash);
  });

  it('hashing is order-insensitive (canonical JSON)', () => {
    expect(computeContentHash({ b: 1, a: [{ y: 2, x: 3 }] })).toBe(computeContentHash({ a: [{ x: 3, y: 2 }], b: 1 }));
  });

  it('rejects secret params that would be supplied by the caller (serialized)', () => {
    expect(() =>
      ParamSpecSchema.parse({ type: 'string', description: 'x', sensitivity: 'secret', source: 'caller' }),
    ).toThrow(/secret params/);
  });

  it('rejects state-transition steps without a postcondition checkpoint', () => {
    expect(() =>
      StepSchema.parse({
        id: 's1',
        intent: 'click something',
        action: { kind: 'activate', target: { framePath: [], strategies: [{ s: 'roleName', role: 'button', name: 'Go' }] } },
        risk: 'read',
      }),
    ).toThrow(/postcondition/);
  });

  it('rejects onDetect references to undeclared outcomes', () => {
    const { artifact } = loadCapability(GOLD);
    const bad = structuredClone(artifact) as Record<string, unknown>;
    (bad['steps'] as { onDetect: string[] }[])[5]!.onDetect = ['NO_SUCH_OUTCOME'];
    expect(() => CapabilityArtifactSchema.parse(bad)).toThrow(/unknown outcome/);
  });

  it('rejects duplicate outcome/recovery/anomaly codes (engine keys)', () => {
    const { artifact } = loadCapability(GOLD);
    const bad = structuredClone(artifact);
    bad.anomalies.push({ code: 'SESSION_TIMEOUT', description: 'dup of a recovery code', when: { c: 'textPresent', pattern: 'x' } });
    expect(() => CapabilityArtifactSchema.parse(bad)).toThrow(/codes must be unique/);
  });

  it('rejects outputs whose source read step writes a different name', () => {
    const { artifact } = loadCapability(GOLD);
    const bad = structuredClone(artifact);
    const readStep = bad.steps.find((st) => st.action.kind === 'read')!;
    if (readStep.action.kind === 'read') readStep.action.into = 'savingsBalance';
    bad.outputs['other'] = { ...bad.outputs['savingsBalance']! };
    expect(() => CapabilityArtifactSchema.parse(bad)).toThrow(/would never be produced/);
  });

  it('rejects policy self-declarations that understate the steps', () => {
    const { artifact } = loadCapability(GOLD);
    const noKind = structuredClone(artifact);
    noKind.policy.actionsUsed = noKind.policy.actionsUsed.filter((a) => a !== 'setValue');
    expect(() => CapabilityArtifactSchema.parse(noKind)).toThrow(/actionsUsed omits/);
    const lowRisk = structuredClone(artifact);
    lowRisk.policy.maxRisk = 'read';
    expect(() => CapabilityArtifactSchema.parse(lowRisk)).toThrow(/understates/);
  });

  it('rejects template placeholders that resolve from nothing (typo protection)', () => {
    const { artifact } = loadCapability(GOLD);
    const bad = structuredClone(artifact);
    bad.successCriteria.push({ c: 'textPresent', pattern: 'Member {membrId}' });
    expect(() => CapabilityArtifactSchema.parse(bad)).toThrow(/\{membrId\} does not resolve/);
  });

  it('rejects params with uncompilable regex patterns and enums without values', () => {
    expect(() =>
      ParamSpecSchema.parse({ type: 'string', description: 'x', pattern: '([', sensitivity: 'none', source: 'caller' }),
    ).toThrow(/valid regular expression/);
    expect(() => ParamSpecSchema.parse({ type: 'enum', description: 'x', sensitivity: 'none', source: 'caller' })).toThrow(
      /requires a non-empty values/,
    );
  });

  it('rejects outputs that do not source from a read step', () => {
    const { artifact } = loadCapability(GOLD);
    const bad = structuredClone(artifact) as { outputs: Record<string, { source: { stepId: string } }> };
    bad.outputs['savingsBalance']!.source.stepId = 's3';
    expect(() => CapabilityArtifactSchema.parse(bad)).toThrow(/must source from a read step/);
  });
});

/**
 * The integrity chain, tested at the end nobody was testing.
 *
 * Everything DOWNSTREAM of `verified` is covered: the engine refuses to replay
 * when it is false, the CLI exits non-zero, the API pre-flight rejects. What
 * was never covered is that `loadCapability` ever PRODUCES false — every test
 * loads a genuine on-disk artifact, so the detector itself was only ever
 * observed agreeing. Hard-code `verified: true` and `cu validate`, the API
 * pre-flight and the CI gate all go green on an artifact edited after signing.
 */
describe('tamper detection', () => {
  const tamper = (mutate: (a: Record<string, unknown>) => void): string => {
    const a = JSON.parse(readFileSync(GOLD, 'utf8')) as Record<string, unknown>;
    mutate(a);
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'cu-tamper-')), 'tampered.json');
    writeFileSync(file, JSON.stringify(a, null, 2));
    return file;
  };

  it('verifies an untouched artifact', () => {
    // The control. Without it, a `verified` that returned false unconditionally
    // would pass every assertion below.
    expect(loadCapability(GOLD).verified).toBe(true);
  });

  it('reports verified:false when prose is edited after hashing', () => {
    const file = tamper((a) => {
      (a['capability'] as Record<string, unknown>)['description'] = 'edited after hashing';
    });
    expect(loadCapability(file).verified).toBe(false);
  });

  it('reports verified:false when a STEP is edited after hashing', () => {
    // The case that matters: the executable spine changed, and the hash is the
    // only thing that can say so.
    const file = tamper((a) => {
      const steps = a['steps'] as Record<string, unknown>[];
      steps[0]!['risk'] = 'read';
    });
    expect(loadCapability(file).verified).toBe(false);
  });

  it('reports verified:false when the recorded hash itself is swapped', () => {
    const file = tamper((a) => {
      (a['integrity'] as Record<string, unknown>)['contentHash'] = 'f'.repeat(64);
    });
    expect(loadCapability(file).verified).toBe(false);
  });
});

/**
 * Two `superRefine` rules that shipped without a negative case.
 *
 * The file has negative cases for four of its cross-checks and none for these
 * two — the pattern a mutation audit found across the suite: a rule added to an
 * existing list tends to arrive without the test that proves it fires.
 */
describe('schema cross-checks that had no negative case', () => {
  const shipped = (): Record<string, unknown> =>
    JSON.parse(readFileSync('capabilities-meridian/member.readBalances@1.0.0.json', 'utf8')) as Record<string, unknown>;

  it('rejects a readTable output declared as a scalar', () => {
    // The damage this prevents is two-fold and both halves are silent: the API
    // hands the caller a JSON blob where it promised structure, and the engine
    // skips per-cell redactor registration, so no table cell ever becomes a
    // needle.
    const a = shipped();
    (a['outputs'] as Record<string, Record<string, unknown>>)['shares']!['type'] = 'string';
    expect(() => CapabilityArtifactSchema.parse(a)).toThrow(/table/i);
  });

  it('rejects duplicate step ids', () => {
    // Step ids key the engine's attempt counters and its onDetect lookups, so a
    // duplicate silently corrupts both rather than failing.
    const a = shipped();
    const steps = a['steps'] as Record<string, unknown>[];
    steps.push({ ...steps[0] });
    expect(() => CapabilityArtifactSchema.parse(a)).toThrow(/unique/i);
  });
});
