/**
 * App profiles: everything that is true of a TARGET APPLICATION rather than of
 * a particular recorded flow.
 *
 * Tenant overlays already answer "this institution runs the vendor product
 * with a different skin and a different base URL". A profile answers the layer
 * above: "this is what the vendor product itself does" — how it carries
 * transaction tokens, which operator roles exist, which runtime conditions it
 * throws and how a replay should classify them, which on-screen fields are
 * regulated data, and how the harness can force a fault.
 *
 * Pointing the core at a new application should be writing one of these, not
 * editing the engine. That claim is the whole point of the file, so anything
 * that cannot be expressed here is worth calling out as genuine coupling.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AnomalySpecSchema, OutcomeSpecSchema, RecoverySpecSchema } from '../schema/capability.js';
import type { CapabilityArtifact } from '../schema/capability.js';

/** A named operator role and the environment variables holding its credentials. */
const RoleSchema = z
  .object({
    idEnv: z.string().min(1),
    passwordEnv: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

/**
 * Fields whose on-screen values are regulated data. Classification is by
 * LABEL (form/record fields) or COLUMN HEADER (table cells) because those are
 * what a legacy screen actually exposes — there are no ids to key on.
 *
 * This is what lets redaction cover data the flow never declared: a name
 * search lists OTHER members, and none of them are a param or an output.
 *
 * `labelPatterns` exists because a fixed list cannot name a label that VARIES
 * PER RECORD. A transfer receipt labels each new balance with the share it
 * belongs to ("101555-S0001:"), so the regulated value is addressed by a label
 * no profile author can enumerate. Patterns are regular expressions matched
 * case-sensitively against the label as rendered, and must be ANCHORED: an
 * unanchored pattern turns every label on the screen into regulated data and
 * redacts the evidence into uselessness.
 */
const ClassifiedFieldsSchema = z
  .object({
    labels: z.array(z.string()).optional(),
    labelPatterns: z
      .array(
        z.string().min(1).refine(
          (p) => {
            try {
              new RegExp(p);
              return true;
            } catch {
              return false;
            }
          },
          { message: 'labelPatterns entries must be valid regular expressions' },
        ),
      )
      .optional(),
    columns: z.array(z.string()).optional(),
  })
  .strict();

export const AppProfileSchema = z
  .object({
    appId: z.string().min(1),
    vendor: z.string().min(1),
    title: z.string().min(1),
    /** Default binding for `{baseUrl}`; a tenant overlay may override it. */
    baseUrl: z.string().url(),
    /** Path to the runtime policy this app is normally driven under. */
    policy: z.string().min(1),

    /**
     * Credential indirection. Artifacts declare their operator params against
     * STABLE env names (`operatorIdEnv`); a role maps those onto the real
     * per-role variables. Selecting a role therefore never edits an artifact
     * and never mutates process.env — it produces a per-invocation override.
     */
    credentials: z
      .object({
        operatorIdEnv: z.string().min(1),
        operatorPasswordEnv: z.string().min(1),
        roles: z.record(z.string(), RoleSchema),
        defaultRole: z.string().min(1),
      })
      .strict()
      .optional(),

    /**
     * Per-transaction hidden token carried by this app's forms. Driving the
     * real UI submits it for free (the browser posts the form), so this exists
     * to ASSERT it — a form rendered without one must fail loudly rather than
     * post something the server will reject.
     */
    transactionToken: z.object({ fieldName: z.string().min(1), note: z.string().optional() }).strict().optional(),

    /**
     * How the harness forces a runtime fault. This is the one piece of genuine
     * per-app adaptation: our first target exposed a POST endpoint, this one
     * takes a query parameter, and a third might need a proxy.
     */
    faultInjection: z
      .discriminatedUnion('kind', [
        // The fault is requested on the request itself (a query parameter the
        // app honours per-request) — armable on any step, including a POST.
        z
          .object({
            kind: z.literal('queryParam'),
            param: z.string().min(1),
            kinds: z.array(z.string().min(1)).min(1),
            note: z.string().optional(),
          })
          .strict(),
        // The fault is armed out-of-band against a control endpoint the app
        // exposes for testing, then fires on subsequent requests.
        z
          .object({
            kind: z.literal('endpoint'),
            path: z.string().min(1),
            method: z.enum(['POST', 'GET']),
            kinds: z.array(z.string().min(1)).min(1),
            note: z.string().optional(),
          })
          .strict(),
      ])
      .optional(),

    dataClassification: z
      .object({ pii: ClassifiedFieldsSchema.optional(), financial: ClassifiedFieldsSchema.optional() })
      .strict()
      .optional(),

    /** Runtime conditions that belong to the APP, not to any one flow. */
    outcomes: z.array(OutcomeSpecSchema).optional(),
    recoveries: z.array(RecoverySpecSchema).optional(),
    anomalies: z.array(AnomalySpecSchema).optional(),
  })
  .strict();

export type AppProfile = z.infer<typeof AppProfileSchema>;

export function loadProfile(file: string): AppProfile {
  return AppProfileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** Resolve the policy path a profile names, relative to the profile file. */
export function policyPathFor(profileFile: string, profile: AppProfile): string {
  return path.isAbsolute(profile.policy) ? profile.policy : path.resolve(path.dirname(profileFile), '..', profile.policy);
}

/**
 * Per-invocation env overrides that make an artifact run as a given role.
 * Throws rather than silently falling back, because "the supervisor action
 * quietly ran as a teller" is exactly the failure this indirection exists to
 * prevent.
 */
export function envOverridesForRole(profile: AppProfile, role?: string): Record<string, string> {
  const creds = profile.credentials;
  if (!creds) return {};
  const wanted = role ?? creds.defaultRole;
  const spec = creds.roles[wanted];
  if (!spec) {
    throw new Error(`profile '${profile.appId}' has no operator role '${wanted}' (roles: ${Object.keys(creds.roles).join(', ')})`);
  }
  const id = process.env[spec.idEnv];
  const password = process.env[spec.passwordEnv];
  if (!id || !password) {
    throw new Error(`role '${wanted}' needs ${spec.idEnv} and ${spec.passwordEnv} in the environment`);
  }
  return { [creds.operatorIdEnv]: id, [creds.operatorPasswordEnv]: password };
}

/**
 * The role an invocation actually signs on as, with the profile's default
 * filled in. Callers record THIS on the run rather than the raw caller-supplied
 * value: every role reaches the artifact through the same two env var names, so
 * an audit for "which runs used supervisor authority" is otherwise defeated by
 * a run that simply left the role blank and took the default.
 */
export function resolvedRoleName(profile: AppProfile, role?: string): string | undefined {
  return role ?? profile.credentials?.defaultRole;
}

export interface ProfileMergeResult {
  artifact: CapabilityArtifact;
  /** Codes the profile contributed — logged as evidence and shown in results. */
  addedOutcomes: string[];
  addedRecoveries: string[];
  addedAnomalies: string[];
}

/**
 * Merge app-level runtime handling into an artifact.
 *
 * Applied AFTER integrity verification, exactly like a tenant overlay — which
 * means a hash-verified artifact is not necessarily byte-identical to what
 * executes. That is a real consequence worth stating rather than hiding: the
 * hash proves the recorded flow is unmodified; the profile and overlay are the
 * two declared, reviewable channels that may add handling around it, and both
 * announce what they added in the run's evidence.
 *
 * Say it plainly, because "hash-verified" invites the opposite reading: a
 * PROFILE IS EXECUTABLE CONFIGURATION, NOT DATA. The recoveries merged in here
 * carry handlers — a `dismiss` handler is a locator ladder plus a click, aimed
 * at whatever control it resolves — and this file is unhashed and unsigned. The
 * content hash therefore bounds the RECORDED FLOW, not the run: a profile edit
 * adds behaviour to every capability that loads it, without invalidating a
 * single artifact hash. It belongs to the same review class as the artifacts
 * themselves, and the engine treats its clicks accordingly (a recovery handler
 * dispatches at the artifact's declared risk ceiling, so one aimed at a posting
 * control escalates for human approval rather than passing the gate as a
 * harmless dismissal — see tryRecoveries in the replay engine).
 */
export function applyProfile(artifact: CapabilityArtifact, profile: AppProfile): ProfileMergeResult {
  const merged: CapabilityArtifact = structuredClone(artifact);
  const taken = new Set<string>([
    ...merged.outcomes.map((o) => o.code),
    ...merged.recoveries.map((r) => r.code),
    ...merged.anomalies.map((a) => a.code),
  ]);
  const addedOutcomes: string[] = [];
  const addedRecoveries: string[] = [];
  const addedAnomalies: string[] = [];

  for (const outcome of profile.outcomes ?? []) {
    if (taken.has(outcome.code)) continue;
    taken.add(outcome.code);
    // App-level outcomes are checked on every step: the flow never declared
    // them, so no step's onDetect will.
    merged.outcomes.push({ ...outcome, appWide: true });
    addedOutcomes.push(outcome.code);
  }

  for (const rec of profile.recoveries ?? []) {
    // The artifact wins: a flow that declares its own handling for a condition
    // has more context than the app-wide default, and detector codes are
    // engine keys — two entries sharing one code would share an attempt budget.
    if (taken.has(rec.code)) continue;
    taken.add(rec.code);
    merged.recoveries.push(rec);
    addedRecoveries.push(rec.code);
  }
  for (const anomaly of profile.anomalies ?? []) {
    if (taken.has(anomaly.code)) continue;
    taken.add(anomaly.code);
    merged.anomalies.push(anomaly);
    addedAnomalies.push(anomaly.code);
  }

  // Placeholders in profile-supplied conditions must resolve from the
  // artifact's own params (plus the reserved baseUrl binding). Without this
  // check a typo surfaces mid-run as a SURFACE_ERROR — "the driver stopped
  // working" — which is a badly misleading diagnosis for a config mistake.
  const declared = new Set([...Object.keys(merged.params), 'baseUrl']);
  const injected = JSON.stringify({ o: profile.outcomes ?? [], r: profile.recoveries ?? [], a: profile.anomalies ?? [] });
  for (const m of injected.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
    if (!declared.has(m[1]!)) {
      throw new Error(
        `profile '${profile.appId}' references {${m[1]}}, which capability '${artifact.capability.id}' does not declare`,
      );
    }
  }

  return { artifact: merged, addedOutcomes, addedRecoveries, addedAnomalies };
}
