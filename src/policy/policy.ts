/**
 * Policy configuration: what the automation is permitted to do, regardless
 * of who is driving (LLM discovery or deterministic replay). Loaded from a
 * reviewable JSON file; validated with the same rigor as artifacts.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const PolicySchema = z
  .object({
    /** Origins the automation may operate on. Everything else is off-limits. */
    allowedOrigins: z.array(z.string()).min(1),
    /** If non-empty, page paths must start with one of these. */
    allowedPathPrefixes: z.array(z.string()).default([]),
    /** Paths the automation must never touch (e.g. the test-harness fault endpoints). */
    deniedPathPrefixes: z.array(z.string()).default(['/__']),
    /** Action kinds the automation may perform at all. */
    allowedActions: z
      .array(z.enum(['navigate', 'activate', 'setValue', 'choose', 'read', 'readTable', 'answerDialog']))
      .min(1),
    /**
     * How to treat irreversible actions:
     *  - block:    refuse outright
     *  - confirm:  allowed only when the invocation was explicitly confirmed up front
     *  - escalate: pause and route to a human for approval (the default — a
     *              person decides, on the live session, with full context)
     */
    irreversibleActionMode: z.enum(['block', 'confirm', 'escalate']).default('escalate'),
    maxStepsPerRun: z.number().int().positive().default(40),
    maxRecoveryAttemptsPerRun: z.number().int().positive().default(5),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

export function loadPolicy(file: string): Policy {
  return PolicySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}
