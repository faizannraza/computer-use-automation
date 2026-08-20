/**
 * The condition vocabulary — ONE language for every kind of "is the surface
 * in state X?" question the system asks. Step postconditions (checkpoints),
 * business-outcome detectors, recovery triggers, anomaly screens, and the
 * final success criteria are all Conditions evaluated by the same function
 * over the same Observation. That uniformity is what keeps the replay
 * engine's classification logic coherent.
 *
 * String fields may contain `{placeholders}` resolved against the
 * invocation's params/bindings at evaluation time (e.g. textPresent
 * "Member {memberId}").
 */
import { z } from 'zod';
import type { FrameHint, TargetRef } from './locators.js';
import { FrameHintSchema, TargetRefSchema } from './locators.js';

export type Condition =
  | { c: 'textPresent'; pattern: string; regex?: boolean; frame?: FrameHint }
  | { c: 'textAbsent'; pattern: string; regex?: boolean; frame?: FrameHint }
  | { c: 'elementPresent'; target: TargetRef }
  | { c: 'urlMatches'; pattern: string }
  | { c: 'dialogOpen'; textPattern?: string }
  | { c: 'all'; of: Condition[] }
  | { c: 'any'; of: Condition[] };

const leaf = {
  // `frame` scopes the text check to one frame (matched against the TAIL of
  // each frame's path, like locator frame hints): "this text, in the work
  // frame" — so nav chrome can never satisfy a checkpoint about the work
  // area. Omitted = whole surface (backward compatible).
  textPresent: z
    .object({
      c: z.literal('textPresent'),
      pattern: z.string().min(1),
      regex: z.boolean().optional(),
      frame: FrameHintSchema.optional(),
    })
    .strict(),
  textAbsent: z
    .object({
      c: z.literal('textAbsent'),
      pattern: z.string().min(1),
      regex: z.boolean().optional(),
      frame: FrameHintSchema.optional(),
    })
    .strict(),
  elementPresent: z.object({ c: z.literal('elementPresent'), target: TargetRefSchema }).strict(),
  urlMatches: z.object({ c: z.literal('urlMatches'), pattern: z.string().min(1) }).strict(),
  dialogOpen: z.object({ c: z.literal('dialogOpen'), textPattern: z.string().optional() }).strict(),
};

// Recursive union: z.lazy for the nested combinators, with an explicit type
// annotation because TypeScript cannot infer through the recursion.
export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion('c', [
    leaf.textPresent,
    leaf.textAbsent,
    leaf.elementPresent,
    leaf.urlMatches,
    leaf.dialogOpen,
    z.object({ c: z.literal('all'), of: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ c: z.literal('any'), of: z.array(ConditionSchema).min(1) }).strict(),
  ]),
) as unknown as z.ZodType<Condition>;
