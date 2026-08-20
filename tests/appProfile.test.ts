/**
 * App profiles: the artifact that has to carry "pointing at a new application
 * is configuration, not a rewrite". Both shipped profiles are exercised here —
 * a profile only proves something if something actually loads through it.
 */
import { describe, expect, it } from 'vitest';
import { applyProfile, envOverridesForRole, loadProfile, policyPathFor } from '../src/profile/appProfile.js';
import { loadPolicy } from '../src/policy/policy.js';
import { loadCapability } from '../src/schema/capability.js';
import { Redactor } from '../src/policy/redact.js';
import { classifiedElementRefs, classifyObservation } from '../src/policy/classify.js';
import type { Observation } from '../src/core/types.js';

const MERIDIAN = 'profiles/meridian-core.profile.json';
const MOCKCORE = 'profiles/mockcore-teller.profile.json';

describe('shipped profiles', () => {
  it('both parse, and each names a policy that exists and loads', () => {
    for (const file of [MERIDIAN, MOCKCORE]) {
      const profile = loadProfile(file);
      expect(profile.appId.length).toBeGreaterThan(0);
      const policy = loadPolicy(policyPathFor(file, profile));
      expect(policy.allowedOrigins.length).toBeGreaterThan(0);
      // A profile that allowed an origin its own policy forbids would be a
      // configuration that cannot run.
      expect(policy.allowedOrigins.some((o) => profile.baseUrl.startsWith(o))).toBe(true);
    }
  });

  it('describes two different fault-injection mechanisms — which is why it is an adapter', () => {
    // The first target arms faults on its own endpoint; MERIDIAN takes a
    // per-request query parameter. Same concept, incompatible mechanics: this
    // is the one place adapting to a new app is genuinely adapter-shaped.
    expect(loadProfile(MOCKCORE).faultInjection?.kind).toBe('endpoint');
    expect(loadProfile(MERIDIAN).faultInjection?.kind).toBe('queryParam');
  });

  it('resolves per-role credentials into env overrides without touching process.env', () => {
    const profile = loadProfile(MERIDIAN);
    process.env['MERIDIAN_SUPERVISOR_ID'] = 'super1';
    process.env['MERIDIAN_SUPERVISOR_PASSWORD'] = 'password';
    const overrides = envOverridesForRole(profile, 'supervisor');
    expect(overrides).toEqual({ MERIDIAN_OPERATOR_ID: 'super1', MERIDIAN_OPERATOR_PASSWORD: 'password' });
    expect(process.env['MERIDIAN_OPERATOR_ID']).toBeUndefined();
  });

  it('refuses an unknown role rather than silently signing on as someone else', () => {
    expect(() => envOverridesForRole(loadProfile(MERIDIAN), 'auditor')).toThrow(/no operator role 'auditor'/);
  });
});

describe('merging app-level handling into a capability', () => {
  // The MockCore profile is applied to a REAL shipped artifact, so the
  // abstraction is exercised against two apps rather than described twice.
  const { artifact } = loadCapability('capabilities/member.readSavingsBalance@1.0.0.json');

  it('adds the app profile recoveries a flow did not declare for itself', () => {
    const profile = loadProfile(MERIDIAN);
    const before = artifact.recoveries.length;
    const merged = applyProfile(artifact, profile);
    expect(merged.artifact.recoveries.length).toBe(before + (profile.recoveries?.length ?? 0));
    expect(merged.addedRecoveries).toContain('SESSION_EXPIRED');
    expect(merged.addedAnomalies).toContain('APPLICATION_ERROR');
    // The source artifact is never mutated — merging returns a copy.
    expect(artifact.recoveries.length).toBe(before);
  });

  it('never lets a profile shadow handling the flow declares itself', () => {
    // Detector codes are engine keys: two entries sharing one would share an
    // attempt budget, so the artifact's own handling must win.
    const profile = loadProfile(MERIDIAN);
    const withOwn = structuredClone(artifact);
    withOwn.recoveries.push({
      code: 'SESSION_EXPIRED',
      description: 'flow-specific handling',
      when: { c: 'textPresent', pattern: 'anything' },
      handler: { kind: 'restartRun' },
      maxAttempts: 1,
    });
    const merged = applyProfile(withOwn, profile);
    expect(merged.addedRecoveries).not.toContain('SESSION_EXPIRED');
    expect(merged.artifact.recoveries.filter((r) => r.code === 'SESSION_EXPIRED')).toHaveLength(1);
    expect(merged.artifact.recoveries.find((r) => r.code === 'SESSION_EXPIRED')?.description).toBe('flow-specific handling');
  });

  it('rejects a profile whose conditions reference params the capability lacks', () => {
    // Caught at load: otherwise an unresolved placeholder surfaces mid-run as
    // a SURFACE_ERROR — "the driver stopped working" — for a config typo.
    const profile = structuredClone(loadProfile(MERIDIAN));
    profile.recoveries = [
      {
        code: 'BOGUS',
        description: 'references an undeclared param',
        when: { c: 'textPresent', pattern: 'Member {accountNumber}' },
        handler: { kind: 'restartRun' },
        maxAttempts: 1,
      },
    ];
    expect(() => applyProfile(artifact, profile)).toThrow(/\{accountNumber\}/);
  });
});

describe('field classification (redacting data no capability declared)', () => {
  const observation = (): Observation => ({
    seq: 1,
    location: 'https://web-sample.interface-hiring.com/members/100234',
    title: 'Member Record',
    elements: [
      { ref: 0, role: 'cell', name: 'E-mail:', framePath: [], interactive: false, nearText: 'E-mail: | ada.lovelace@example.com | Phone: | 555-0101' },
      { ref: 1, role: 'cell', name: 'ada.lovelace@example.com', framePath: [], interactive: false, nearText: 'E-mail: | ada.lovelace@example.com | Phone: | 555-0101' },
      { ref: 2, role: 'cell', name: '$2,500.00', framePath: [], interactive: false, colHeader: 'Balance', nearText: '100234-S0001 | Regular Shares | $2,500.00 | OPEN' },
      { ref: 3, role: 'cell', name: 'OPEN', framePath: [], interactive: false, colHeader: 'Status', nearText: '100234-S0001 | Regular Shares | $2,500.00 | OPEN' },
    ],
    visibleText: 'E-mail: ada.lovelace@example.com Phone: 555-0101 $2,500.00 OPEN',
    at: new Date().toISOString(),
  });

  it('registers a balance and an e-mail that were never a param or an output', () => {
    const profile = loadProfile(MERIDIAN);
    const redactor = new Redactor();
    const obs = observation();
    expect(classifyObservation(obs, profile.dataClassification, redactor)).toBeGreaterThan(0);
    const written = redactor.apply(JSON.stringify(obs));
    expect(written).not.toContain('ada.lovelace@example.com');
    expect(written).not.toContain('$2,500.00');
    // Non-classified text is untouched — over-redaction is its own failure.
    expect(written).toContain('OPEN');
  });

  it('is idempotent across the many observations of a single run', () => {
    const profile = loadProfile(MERIDIAN);
    const redactor = new Redactor();
    const first = classifyObservation(observation(), profile.dataClassification, redactor);
    const second = classifyObservation(observation(), profile.dataClassification, redactor);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it('marks the classified elements for screenshot masking', () => {
    const refs = classifiedElementRefs(observation(), loadProfile(MERIDIAN).dataClassification);
    expect(refs).toContain(1); // the e-mail value, found via its label neighbour
    expect(refs).toContain(2); // the balance cell, found via its column header
    expect(refs).not.toContain(3); // status is not regulated data
  });
});
