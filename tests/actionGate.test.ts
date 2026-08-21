/** Pins every deny path in the gate and checks that denied actions never
 * reach the surface. */
import { describe, expect, it, vi } from 'vitest';
import type { ControlHolder } from '../src/core/types.js';
import { ActionGate, PolicyViolation } from '../src/policy/actionGate.js';
import { PolicySchema } from '../src/policy/policy.js';
import type { Surface } from '../src/surface/surface.js';

const policy = PolicySchema.parse({
  allowedOrigins: ['http://localhost:9999'],
  allowedActions: ['navigate', 'activate', 'setValue', 'read'],
  irreversibleActionMode: 'escalate',
});

function fakeSurface(location = 'http://localhost:9999/members/search'): { surface: Surface; act: ReturnType<typeof vi.fn> } {
  const act = vi.fn(async () => ({}));
  const surface = {
    observe: vi.fn(),
    lastObservation: vi.fn(),
    resolve: vi.fn(),
    act,
    settle: vi.fn(),
    currentLocation: () => location,
    close: vi.fn(),
  } as unknown as Surface;
  return { surface, act };
}

describe('ActionGate', () => {
  it('allows a permitted action and reports it to the audit sink', async () => {
    const { surface, act } = fakeSurface();
    const events: unknown[] = [];
    const gate = new ActionGate(policy, surface, { onEvent: (e) => events.push(e) });
    await gate.execute({ kind: 'activate', ref: 1 }, { risk: 'read' });
    expect(act).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
  });

  it('denies navigation to an origin outside the allowlist', async () => {
    const { surface, act } = fakeSurface();
    const gate = new ActionGate(policy, surface);
    await expect(
      gate.execute({ kind: 'navigate', url: 'https://evil.example.com/x' }, { risk: 'read' }),
    ).rejects.toMatchObject({ code: 'OFF_ORIGIN' });
    expect(act).not.toHaveBeenCalled();
  });

  it('denies the test-harness fault endpoints even on an allowed origin', async () => {
    const { surface } = fakeSurface();
    const gate = new ActionGate(policy, surface);
    await expect(
      gate.execute({ kind: 'navigate', url: 'http://localhost:9999/__faults' }, { risk: 'read' }),
    ).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });

  // A denylist is only as strong as the router it is describing. MERIDIAN's
  // `/settings` — the global fault switch, the one screen the policy names —
  // is served by a legacy stack that routes case-insensitively and collapses
  // repeated slashes. `startsWith` does neither, so `/Settings` reached the
  // very screen `/settings` denies, and did it through the discovery path,
  // where the URL is chosen by a model reading the target's own text.
  it.each(['/__Faults', '/__FAULTS', '//__faults', '/__faults/../__faults'])(
    'denies %s — the same route spelled a way `startsWith` would miss',
    async (pathname) => {
      const { surface, act } = fakeSurface();
      const gate = new ActionGate(policy, surface);
      await expect(
        gate.execute({ kind: 'navigate', url: `http://localhost:9999${pathname}` }, { risk: 'read' }),
      ).rejects.toMatchObject({ code: 'PATH_DENIED' });
      expect(act).not.toHaveBeenCalled();
    },
  );

  it('still allows a path that merely resembles a denied one', async () => {
    // The normalisation must not turn the denylist into a substring match:
    // `/__faultsomething` is a different route and stays reachable.
    const { surface, act } = fakeSurface();
    const gate = new ActionGate(policy, surface);
    await gate.execute({ kind: 'navigate', url: 'http://localhost:9999/members/103001' }, { risk: 'read' });
    expect(act).toHaveBeenCalledOnce();
  });

  it('denies element actions whose target FRAME is off-origin, even on an allowed page', async () => {
    const { surface, act } = fakeSurface(); // page itself is on the allowed origin
    const gate = new ActionGate(policy, surface);
    await expect(
      gate.execute({ kind: 'activate', ref: 3 }, { risk: 'read', frameUrl: 'https://ads.example.com/embed' }),
    ).rejects.toMatchObject({ code: 'OFF_ORIGIN' });
    expect(act).not.toHaveBeenCalled();
    await gate.execute({ kind: 'activate', ref: 3 }, { risk: 'read', frameUrl: 'http://localhost:9999/nav' });
    expect(act).toHaveBeenCalledOnce();
  });

  it('denies actions while the current page has wandered off-origin', async () => {
    const { surface } = fakeSurface('https://phish.example.com/login');
    const gate = new ActionGate(policy, surface);
    await expect(gate.execute({ kind: 'activate', ref: 0 }, { risk: 'read' })).rejects.toMatchObject({
      code: 'OFF_ORIGIN',
    });
  });

  it('denies action kinds missing from the allowlist', async () => {
    const { surface } = fakeSurface();
    const gate = new ActionGate(policy, surface);
    await expect(gate.execute({ kind: 'choose', ref: 0, option: 'X' }, { risk: 'read' })).rejects.toMatchObject({
      code: 'ACTION_KIND_DISALLOWED',
    });
  });

  it('escalates unapproved irreversible actions; executes them once approved', async () => {
    const { surface, act } = fakeSurface();
    const gate = new ActionGate(policy, surface);
    await expect(gate.execute({ kind: 'activate', ref: 9 }, { risk: 'irreversible' })).rejects.toMatchObject({
      code: 'RISK_NEEDS_ESCALATION',
    });
    expect(act).not.toHaveBeenCalled();
    await gate.execute({ kind: 'activate', ref: 9 }, { risk: 'irreversible', approved: true });
    expect(act).toHaveBeenCalledOnce();
  });

  it('blocks irreversible actions outright under policy mode "block"', async () => {
    const { surface } = fakeSurface();
    const gate = new ActionGate(PolicySchema.parse({ ...policy, irreversibleActionMode: 'block' }), surface);
    await expect(gate.execute({ kind: 'activate', ref: 9 }, { risk: 'irreversible' })).rejects.toMatchObject({
      code: 'RISK_BLOCKED',
    });
  });

  it('rejects ALL automation while a human holds the session (the control token)', async () => {
    const { surface, act } = fakeSurface();
    let holder: ControlHolder = 'human';
    const gate = new ActionGate(policy, surface, { getHolder: () => holder });
    await expect(gate.execute({ kind: 'read', ref: 0 }, { risk: 'read' })).rejects.toMatchObject({
      code: 'NOT_IN_CONTROL',
    });
    expect(act).not.toHaveBeenCalled();
    holder = 'agent';
    await gate.execute({ kind: 'read', ref: 0 }, { risk: 'read' });
    expect(act).toHaveBeenCalledOnce();
  });

  it('throws PolicyViolation with a machine-readable code', async () => {
    const { surface } = fakeSurface();
    const gate = new ActionGate(policy, surface);
    try {
      await gate.execute({ kind: 'navigate', url: 'https://evil.example.com' }, { risk: 'read' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyViolation);
    }
  });
});
