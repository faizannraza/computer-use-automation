/**
 * Tenant overlays: how one recorded capability serves many institutions
 * running the same vendor product, configured/branded/versioned differently.
 *
 * The merge is additive and narrow BY CONSTRUCTION: an overlay can bind
 * values (baseUrl), re-rank locators, extend tolerance (waits), and add
 * tenant-specific recoveries — but the schema gives it no way to change
 * actions, params, outputs, outcomes, or risk classes. A tenant override can
 * therefore never silently change what a capability *does*, which is the
 * property that makes fleet-wide reuse reviewable.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { CapabilityArtifact } from './capability.js';
import { RecoverySpecSchema } from './capability.js';
import { LocatorSchema } from './locators.js';

export const OverlayPatchSchema = z.discriminatedUnion('op', [
  // The tenant renamed/re-skinned a control: try their locator first.
  z.object({ op: z.literal('prependStrategy'), stepId: z.string(), locator: LocatorSchema }).strict(),
  // Tenant-specific interstitial or notice the base app doesn't have.
  z.object({ op: z.literal('addRecovery'), recovery: RecoverySpecSchema }).strict(),
  // This tenant's instance is slower — extend one step's tolerance.
  z.object({ op: z.literal('overrideWait'), stepId: z.string(), timeoutMs: z.number().int().positive() }).strict(),
]);

export const TenantOverlaySchema = z
  .object({
    tenantId: z.string().min(1),
    extends: z
      .object({
        capabilityId: z.string(),
        /** Caret range against the base artifact's semver, e.g. "^1.0.0". */
        versionRange: z.string().regex(/^\^\d+(\.\d+){0,2}$/),
      })
      .strict(),
    /** Tenant bindings; baseUrl is mandatory — artifacts never hardcode origins. */
    bindings: z.object({ baseUrl: z.string() }).catchall(z.string()),
    patches: z.array(OverlayPatchSchema).default([]),
  })
  .strict();

export type TenantOverlay = z.infer<typeof TenantOverlaySchema>;

/** A capability ready to execute: base artifact + resolved tenant bindings. */
export interface ResolvedCapability {
  artifact: CapabilityArtifact;
  bindings: Record<string, string>;
  tenantId?: string;
}

export function satisfiesCaret(version: string, range: string): boolean {
  const base = range.slice(1).split('.').map(Number);
  const v = version.split('.').map(Number);
  if ((v[0] ?? 0) !== (base[0] ?? 0)) return false;
  if ((base[0] ?? 0) === 0) {
    // npm semver semantics for 0.x: the leftmost non-zero segment is the
    // compatibility pivot — ^0.2.3 admits 0.2.x >= 0.2.3 but NOT 0.3.0,
    // and ^0.0.3 admits only 0.0.3.
    if (base.length === 1) return true; // "^0"
    if ((v[1] ?? 0) !== (base[1] ?? 0)) return false;
    if (base.length === 2) return true; // "^0.2"
    if ((base[1] ?? 0) === 0) return (v[2] ?? 0) === (base[2] ?? 0);
    return (v[2] ?? 0) >= (base[2] ?? 0);
  }
  for (let i = 1; i < 3; i++) {
    const want = base[i];
    if (want === undefined) return true; // "^1" — any 1.x.x
    const have = v[i] ?? 0;
    if (have > want) return true;
    if (have < want) return false;
  }
  return true;
}

export function applyOverlay(artifact: CapabilityArtifact, overlay: TenantOverlay): ResolvedCapability {
  if (overlay.extends.capabilityId !== artifact.capability.id) {
    throw new Error(
      `overlay for '${overlay.extends.capabilityId}' cannot apply to capability '${artifact.capability.id}'`,
    );
  }
  if (!satisfiesCaret(artifact.capability.version, overlay.extends.versionRange)) {
    throw new Error(
      `overlay requires ${overlay.extends.versionRange} but artifact is ${artifact.capability.version}`,
    );
  }
  const patched: CapabilityArtifact = structuredClone(artifact);
  for (const patch of overlay.patches) {
    switch (patch.op) {
      case 'prependStrategy': {
        const step = patched.steps.find((s) => s.id === patch.stepId);
        if (!step) throw new Error(`overlay patch targets unknown step '${patch.stepId}'`);
        if (!('target' in step.action)) throw new Error(`step '${patch.stepId}' has no target to re-rank`);
        step.action.target.strategies.unshift(patch.locator);
        break;
      }
      case 'addRecovery': {
        const codes = new Set([
          ...patched.outcomes.map((o) => o.code),
          ...patched.recoveries.map((r) => r.code),
          ...patched.anomalies.map((x) => x.code),
        ]);
        if (codes.has(patch.recovery.code)) {
          throw new Error(`overlay recovery '${patch.recovery.code}' duplicates a code already declared by the artifact`);
        }
        patched.recoveries.push(patch.recovery);
        break;
      }
      case 'overrideWait': {
        const step = patched.steps.find((s) => s.id === patch.stepId);
        if (!step) throw new Error(`overlay patch targets unknown step '${patch.stepId}'`);
        step.wait.timeoutMs = patch.timeoutMs;
        break;
      }
    }
  }
  return { artifact: patched, bindings: { ...overlay.bindings }, tenantId: overlay.tenantId };
}

export function loadOverlay(file: string): TenantOverlay {
  return TenantOverlaySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
