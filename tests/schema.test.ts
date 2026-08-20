/** The artifact schema's own guarantees: integrity, contract cross-checks. */
import { readdirSync } from 'node:fs';
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
  it('every shipped artifact still hash-verifies', () => {
    const shipped = readdirSync('capabilities').filter((f) => f.endsWith('.json'));
    expect(shipped.length).toBeGreaterThan(0);
    for (const file of shipped) {
      const { artifact, verified } = loadCapability(path.join('capabilities', file));
      // Named per file so a failure says WHICH artifact broke.
      expect(`${file}=${verified}`).toBe(`${file}=true`);
      expect(computeContentHash(artifact)).toBe(artifact.integrity.contentHash);
    }
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
