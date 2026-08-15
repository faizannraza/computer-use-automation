/**
 * Tenant-overlay merge: additive and narrow by construction. An overlay can
 * re-rank locators, extend waits, add recoveries, and bind values — the
 * schema gives it no way to change what a capability does.
 */
import { describe, expect, it } from 'vitest';
import { loadCapability } from '../src/schema/capability.js';
import { TenantOverlaySchema, applyOverlay, satisfiesCaret } from '../src/schema/overlay.js';

const { artifact } = loadCapability('tests/fixtures/member.readSavingsBalance.gold.json');

const overlay = TenantOverlaySchema.parse({
  tenantId: 'tenant-x',
  extends: { capabilityId: 'member.readSavingsBalance', versionRange: '^1' },
  bindings: { baseUrl: 'http://tenant-x.example:4173', region: 'us-west' },
  patches: [
    { op: 'prependStrategy', stepId: 's6', locator: { s: 'roleName', role: 'button', name: 'Find Member' } },
    { op: 'overrideWait', stepId: 's3', timeoutMs: 15000 },
    {
      op: 'addRecovery',
      recovery: {
        code: 'TENANT_MOTD',
        description: 'Tenant-specific message of the day',
        when: { c: 'textPresent', pattern: 'Message of the Day' },
        handler: { kind: 'dismiss', target: { framePath: [], strategies: [{ s: 'roleName', role: 'link', name: 'OK' }] } },
      },
    },
  ],
});

describe('applyOverlay', () => {
  it('binds tenant values and applies all three patch kinds', () => {
    const resolved = applyOverlay(artifact, overlay);
    expect(resolved.bindings['baseUrl']).toBe('http://tenant-x.example:4173');
    expect(resolved.bindings['region']).toBe('us-west');
    const s6 = resolved.artifact.steps.find((s) => s.id === 's6')!;
    if (!('target' in s6.action)) throw new Error('s6 lost its target');
    expect(s6.action.target.strategies[0]).toMatchObject({ s: 'roleName', name: 'Find Member' });
    expect(resolved.artifact.steps.find((s) => s.id === 's3')!.wait.timeoutMs).toBe(15000);
    expect(resolved.artifact.recoveries.map((r) => r.code)).toContain('TENANT_MOTD');
  });

  it('never mutates the base artifact', () => {
    const before = JSON.stringify(artifact);
    applyOverlay(artifact, overlay);
    expect(JSON.stringify(artifact)).toBe(before);
  });

  it('rejects an overlay for a different capability', () => {
    const wrong = { ...overlay, extends: { ...overlay.extends, capabilityId: 'member.other' } };
    expect(() => applyOverlay(artifact, wrong)).toThrow(/cannot apply/);
  });

  it('rejects an overlay whose version range the artifact does not satisfy', () => {
    const wrong = { ...overlay, extends: { ...overlay.extends, versionRange: '^2' } };
    expect(() => applyOverlay(artifact, wrong)).toThrow(/requires \^2/);
  });

  it('rejects patches targeting unknown steps', () => {
    const bad = TenantOverlaySchema.parse({
      ...overlay,
      patches: [{ op: 'overrideWait', stepId: 's99', timeoutMs: 1 }],
    });
    expect(() => applyOverlay(artifact, bad)).toThrow(/unknown step/);
  });

  it("the schema itself refuses patch ops that could change behavior (no 'replaceAction')", () => {
    expect(() =>
      TenantOverlaySchema.parse({
        ...overlay,
        patches: [{ op: 'replaceAction', stepId: 's6', action: { kind: 'navigate', url: 'http://evil' } }],
      }),
    ).toThrow();
  });
});

describe('satisfiesCaret', () => {
  it('matches on major and respects minimums', () => {
    expect(satisfiesCaret('1.0.0', '^1')).toBe(true);
    expect(satisfiesCaret('1.4.2', '^1.2.0')).toBe(true);
    expect(satisfiesCaret('1.1.0', '^1.2.0')).toBe(false);
    expect(satisfiesCaret('2.0.0', '^1')).toBe(false);
  });
});
