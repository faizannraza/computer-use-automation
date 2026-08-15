/** The artifact schema's own guarantees: integrity, contract cross-checks. */
import { describe, expect, it } from 'vitest';
import {
  CapabilityArtifactSchema,
  ParamSpecSchema,
  StepSchema,
  computeContentHash,
  loadCapability,
} from '../src/schema/capability.js';

const GOLD = 'capabilities/member.readSavingsBalance@1.0.0.json';

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

  it('rejects outputs that do not source from a read step', () => {
    const { artifact } = loadCapability(GOLD);
    const bad = structuredClone(artifact) as { outputs: Record<string, { source: { stepId: string } }> };
    bad.outputs['savingsBalance']!.source.stepId = 's3';
    expect(() => CapabilityArtifactSchema.parse(bad)).toThrow(/must source from a read step/);
  });
});
