/**
 * The capability artifact: a typed, versioned, reviewable contract for one
 * reusable flow — the central data model of this system.
 *
 * Design principles (each is argued in REPORT.md):
 *  - It is a CONTRACT an agent can call, not a step list: typed params in,
 *    typed outputs back, named business outcomes a caller must handle.
 *  - Expected business outcomes and known recoverable conditions are
 *    FIRST-CLASS top-level sections — "no such member" is a result the
 *    schema can express, so replay can never misreport it as a crash.
 *  - Steps speak semantic actions and semantic target descriptors; nothing
 *    in an artifact names a driver technology (the one exception, the
 *    `structural` locator, is explicitly surface-tagged).
 *  - Sensitivity annotations on params/outputs drive redaction everywhere;
 *    `secret` values are never serialized into artifacts — they resolve
 *    from the environment at invocation time.
 *  - Versioned (semver: patch = locator/wait tuning, minor = new optional
 *    param/outcome/recovery, major = contract change) and integrity-hashed.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConditionSchema } from './conditions.js';
import { TargetRefSchema } from './locators.js';

// ---------- contract: params & outputs ----------

export const SensitivitySchema = z.enum(['none', 'internal', 'pii', 'secret']);

export const ParamSpecSchema = z
  .object({
    type: z.enum(['string', 'integer', 'money', 'enum']),
    description: z.string(),
    required: z.boolean().default(true),
    /** Regex the caller-supplied value must match. */
    pattern: z.string().optional(),
    values: z.array(z.string()).optional(), // for type 'enum'
    example: z.string().optional(),
    sensitivity: SensitivitySchema.default('none'),
    /**
     * 'caller': supplied per invocation. 'env': resolved from the named
     * environment variable at replay time — the mechanism that keeps
     * credentials out of artifacts entirely.
     */
    source: z.enum(['caller', 'env']).default('caller'),
    env: z.string().optional(),
  })
  .strict()
  .refine((p) => p.source !== 'env' || p.env !== undefined, { message: "source 'env' requires the env var name" })
  .refine((p) => !(p.source === 'caller' && p.sensitivity === 'secret'), {
    message: 'secret params must come from the environment, never from a serialized call',
  })
  .refine(
    (p) => {
      if (p.pattern === undefined) return true;
      try {
        new RegExp(p.pattern);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'pattern must be a valid regular expression' },
  )
  .refine((p) => p.type !== 'enum' || (p.values !== undefined && p.values.length > 0), {
    message: "type 'enum' requires a non-empty values list",
  });

export const OutputSpecSchema = z
  .object({
    type: z.enum(['string', 'integer', 'money']),
    description: z.string(),
    sensitivity: SensitivitySchema.default('none'),
    source: z
      .object({
        stepId: z.string(),
        transform: z.enum(['none', 'trim']).default('none'),
      })
      .strict(),
  })
  .strict();

// ---------- outcomes, recoveries, anomalies ----------

export const OutcomeSpecSchema = z
  .object({
    /** Machine-readable code the calling agent switches on, e.g. MEMBER_NOT_FOUND. */
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    description: z.string(),
    when: ConditionSchema,
    terminal: z.literal(true).default(true),
    /** Literal outputs this outcome yields to the caller, if any. */
    outputs: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const RecoveryHandlerSchema = z.discriminatedUnion('kind', [
  // Dismiss a known interstitial/notice by activating a control.
  z.object({ kind: z.literal('dismiss'), target: TargetRefSchema }).strict(),
  // Answer a known-safe native dialog deliberately.
  z.object({ kind: z.literal('answerDialog'), accept: z.boolean() }).strict(),
  // Start the whole run over (entrypoint onwards) — e.g. session expiry.
  // The engine refuses this if any completed step was irreversible.
  z.object({ kind: z.literal('restartRun') }).strict(),
  // Bring a human into the loop: this state can only be cleared by a person
  // acting on the live session (e.g. supervisor authorization). With no
  // operator attached, the run ends as 'escalated' rather than guessing.
  z.object({ kind: z.literal('escalate'), suggestion: z.string() }).strict(),
]);

export const RecoverySpecSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    description: z.string(),
    when: ConditionSchema,
    handler: RecoveryHandlerSchema,
    maxAttempts: z.number().int().positive().default(2),
  })
  .strict();

/** States that are always hard failures — detected fast instead of timing out. */
export const AnomalySpecSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    description: z.string(),
    when: ConditionSchema,
  })
  .strict();

// ---------- steps ----------

export const BindingSchema = z.union([
  z.object({ param: z.string() }).strict(),
  z.object({ literal: z.string() }).strict(),
]);

export const StepActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string() }).strict(), // url is a template
  z.object({ kind: z.literal('activate'), target: TargetRefSchema }).strict(),
  z.object({ kind: z.literal('setValue'), target: TargetRefSchema, value: BindingSchema }).strict(),
  z.object({ kind: z.literal('choose'), target: TargetRefSchema, option: BindingSchema }).strict(),
  z.object({ kind: z.literal('read'), target: TargetRefSchema, into: z.string() }).strict(),
  z.object({ kind: z.literal('assert') }).strict(), // pure checkpoint: pre/post only
]);

export const StepSchema = z
  .object({
    id: z.string().min(1),
    /** One human-readable line: what this step means. The review surface. */
    intent: z.string(),
    action: StepActionSchema,
    /** Cheap state guards checked before acting. */
    pre: z.array(ConditionSchema).default([]),
    /** The checkpoint: the postcondition polled for after acting. */
    post: z.array(ConditionSchema).default([]),
    wait: z
      .object({
        timeoutMs: z.number().int().positive().default(8000),
        pollMs: z.number().int().positive().default(250),
      })
      .strict()
      .default({ timeoutMs: 8000, pollMs: 250 }),
    risk: z.enum(['read', 'reversible', 'irreversible']),
    /** Outcome codes to watch for while waiting on this step's postcondition. */
    onDetect: z.array(z.string()).default([]),
  })
  .strict()
  .refine((s) => !(s.action.kind === 'navigate' || s.action.kind === 'activate') || s.post.length > 0, {
    message: 'state-transition steps (navigate/activate) must declare a postcondition checkpoint',
  });

// ---------- identity, provenance, policy requirements ----------

const SEMVER = /^\d+\.\d+\.\d+$/;

export const CapabilityMetaSchema = z
  .object({
    /** Stable logical name, namespaced by domain noun: member.readSavingsBalance */
    id: z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/),
    /**
     * Semver with stated semantics — patch: locator/wait/detector tuning
     * (callers unaffected); minor: new optional param, outcome, or recovery
     * (callers should re-read the contract); major: param/output shape change
     * (callers must migrate).
     */
    version: z.string().regex(SEMVER),
    title: z.string(),
    /** Written for both audiences: a human reviewer and a calling agent. */
    description: z.string(),
    /** The vendor product this flow drives — NOT the tenant; tenants bind via overlays. */
    app: z
      .object({
        appId: z.string(),
        vendor: z.string(),
        uiVersionObserved: z.string().optional(),
      })
      .strict(),
    surface: z.enum(['web']),
    entrypoint: z
      .object({
        kind: z.literal('url'),
        /** Template — '{baseUrl}' comes from tenant bindings, never hardcoded. */
        value: z.string(),
      })
      .strict(),
  })
  .strict();

export const ProvenanceSchema = z
  .object({
    recordedAt: z.string(),
    recordedBy: z
      .object({
        kind: z.enum(['llm-discovery', 'hand-authored']),
        model: z.string().optional(),
        discoveryRunId: z.string().optional(),
      })
      .strict(),
    evidenceRef: z.string().optional(),
    /** Draft artifacts refuse unattended replay unless explicitly allowed. */
    approval: z
      .object({
        state: z.enum(['draft', 'approved']),
        by: z.string().optional(),
        at: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export const PolicyRequirementsSchema = z
  .object({
    /** Action kinds this capability performs — checked against the runtime policy up front. */
    actionsUsed: z.array(z.enum(['navigate', 'activate', 'setValue', 'choose', 'read', 'answerDialog'])),
    /** The riskiest step in the flow — lets a caller/policy judge the capability at a glance. */
    maxRisk: z.enum(['read', 'reversible', 'irreversible']),
  })
  .strict();

// ---------- the artifact ----------

export const CapabilityArtifactSchema = z
  .object({
    schemaVersion: z.literal('1'),
    capability: CapabilityMetaSchema,
    provenance: ProvenanceSchema,
    params: z.record(z.string(), ParamSpecSchema),
    outputs: z.record(z.string(), OutputSpecSchema),
    outcomes: z.array(OutcomeSpecSchema).default([]),
    recoveries: z.array(RecoverySpecSchema).default([]),
    anomalies: z.array(AnomalySpecSchema).default([]),
    policy: PolicyRequirementsSchema,
    steps: z.array(StepSchema).min(1),
    /** The final checkpoint asserted after the last step. */
    successCriteria: z.array(ConditionSchema).default([]),
    /** sha256 of the canonical JSON (integrity excluded). Tamper evidence, not access control. */
    integrity: z.object({ contentHash: z.string() }).strict(),
  })
  .strict()
  .superRefine((a, ctx) => {
    const outcomeCodes = new Set(a.outcomes.map((o) => o.code));
    const stepIds = new Set(a.steps.map((s) => s.id));
    if (stepIds.size !== a.steps.length) {
      ctx.addIssue({ code: 'custom', message: 'step ids must be unique' });
    }
    for (const step of a.steps) {
      for (const code of step.onDetect) {
        if (!outcomeCodes.has(code)) {
          ctx.addIssue({ code: 'custom', message: `step ${step.id} onDetect references unknown outcome '${code}'` });
        }
      }
      if (step.action.kind === 'read' && !(step.action.into in a.outputs)) {
        ctx.addIssue({ code: 'custom', message: `step ${step.id} reads into undeclared output '${step.action.into}'` });
      }
    }
    for (const [name, out] of Object.entries(a.outputs)) {
      const src = a.steps.find((s) => s.id === out.source.stepId);
      if (!src || src.action.kind !== 'read') {
        ctx.addIssue({ code: 'custom', message: `output '${name}' must source from a read step (got '${out.source.stepId}')` });
      } else if (src.action.into !== name) {
        ctx.addIssue({
          code: 'custom',
          message: `output '${name}' sources step '${src.id}', but that step reads into '${src.action.into}' — the output would never be produced`,
        });
      }
    }
    // Detector codes are engine keys (attempt counters, onDetect lookups):
    // they must be unique across outcomes, recoveries, AND anomalies.
    const allCodes = [
      ...a.outcomes.map((o) => o.code),
      ...a.recoveries.map((r) => r.code),
      ...a.anomalies.map((x) => x.code),
    ];
    if (new Set(allCodes).size !== allCodes.length) {
      ctx.addIssue({ code: 'custom', message: 'outcome/recovery/anomaly codes must be unique across the artifact' });
    }
    // The policy block is a self-declaration the engine's pre-flight guard
    // trusts — so the schema verifies it against the steps.
    const usedKinds = new Set(
      a.steps.map((s) => s.action.kind).filter((k): k is Exclude<typeof k, 'assert'> => k !== 'assert'),
    );
    for (const kind of usedKinds) {
      if (!a.policy.actionsUsed.includes(kind)) {
        ctx.addIssue({ code: 'custom', message: `policy.actionsUsed omits '${kind}', which the steps use` });
      }
    }
    const riskRank = { read: 0, reversible: 1, irreversible: 2 } as const;
    const maxStepRisk = a.steps.reduce((m, s) => Math.max(m, riskRank[s.risk]), 0);
    if (riskRank[a.policy.maxRisk] < maxStepRisk) {
      ctx.addIssue({ code: 'custom', message: 'policy.maxRisk understates the riskiest step' });
    }
    // Every {placeholder} in executable fields must resolve from declared
    // params or the reserved baseUrl binding — a typo'd placeholder must be
    // a load-time error, never a mid-run failure after mutations.
    const executable = JSON.stringify({
      entrypoint: a.capability.entrypoint,
      steps: a.steps,
      successCriteria: a.successCriteria,
      outcomes: a.outcomes.map((o) => o.when),
      recoveries: a.recoveries,
      anomalies: a.anomalies,
    });
    const declared = new Set([...Object.keys(a.params), 'baseUrl']);
    const unknown = new Set<string>();
    for (const m of executable.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
      if (!declared.has(m[1]!)) unknown.add(m[1]!);
    }
    for (const name of unknown) {
      ctx.addIssue({ code: 'custom', message: `placeholder {${name}} does not resolve from declared params or baseUrl` });
    }
  });

export type Sensitivity = z.infer<typeof SensitivitySchema>;
export type ParamSpec = z.infer<typeof ParamSpecSchema>;
export type OutputSpec = z.infer<typeof OutputSpecSchema>;
export type OutcomeSpec = z.infer<typeof OutcomeSpecSchema>;
export type RecoverySpec = z.infer<typeof RecoverySpecSchema>;
export type AnomalySpec = z.infer<typeof AnomalySpecSchema>;
export type Binding = z.infer<typeof BindingSchema>;
export type Step = z.infer<typeof StepSchema>;
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

// ---------- integrity & loading ----------

/** Canonical JSON: recursively key-sorted, `integrity` excluded. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== 'integrity')
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeContentHash(artifact: unknown): string {
  return createHash('sha256').update(canonicalize(artifact)).digest('hex');
}

export interface LoadedCapability {
  artifact: CapabilityArtifact;
  /** True when the stored content hash matches the recomputed one. */
  verified: boolean;
}

export function loadCapability(file: string): LoadedCapability {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const artifact = CapabilityArtifactSchema.parse(raw);
  return { artifact, verified: computeContentHash(artifact) === artifact.integrity.contentHash };
}
