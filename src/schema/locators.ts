/**
 * Target descriptors: how a recorded step identifies the control it acts on.
 *
 * A TargetRef is an ORDERED STACK of locator strategies, most robust first.
 * The strategies are semantic (roles, labels, text anchors, table geometry) —
 * meaningful on any surface that exposes accessibility semantics, which is
 * why the same artifact can extend to legacy web or desktop drivers. The one
 * deliberate exception, `structural`, is a surface-tagged last resort (raw
 * CSS on web) that other surfaces simply skip.
 *
 * The recorded `snapshot` (text context, geometry, screenshot crop) exists
 * for human review and drift detection — it is NEVER used for resolution.
 */
import { z } from 'zod';

export const FrameHintSchema = z
  .object({
    name: z.string().optional(),
    urlPattern: z.string().optional(),
  })
  .strict()
  // An empty hint would match EVERY frame — a condition that looks scoped in
  // review but is effectively unscoped. Require at least one discriminator.
  .refine((h) => h.name !== undefined || h.urlPattern !== undefined, {
    message: 'a frame hint must specify name and/or urlPattern — an empty hint matches every frame',
  });

export const LocatorSchema = z.discriminatedUnion('s', [
  // Accessibility role + accessible name: the primary, most portable strategy.
  z
    .object({
      s: z.literal('roleName'),
      role: z.string(),
      name: z.string(),
      nameMatch: z.enum(['exact', 'contains']).default('exact'),
    })
    .strict(),
  // Control found via its associated label text (form fields).
  z
    .object({
      s: z.literal('labelText'),
      label: z.string(),
    })
    .strict(),
  // Element anchored by nearby text: itself ('self') or its row/surroundings.
  z
    .object({
      s: z.literal('textAnchor'),
      text: z.string(),
      relation: z.enum(['self', 'rowOf', 'near']),
      targetRole: z.string().optional(),
    })
    .strict(),
  // Table-cell addressing: the cell under a column header, in the row
  // containing anchor text. The workhorse for legacy table-soup screens.
  z
    .object({
      s: z.literal('tableCell'),
      rowAnchor: z
        .object({
          text: z.string(),
          /**
           * How the anchor matches a row. 'exact' requires a cell in the row
           * whose OWN text equals the anchor; the default (absent) matches any
           * row whose text CONTAINS it.
           *
           * Substring matching collides when one row's identifier contains
           * another's — observed live: a share `100234-S0001-3` made the
           * anchor `100234-S0001` match two different shares' balances, and
           * the engine correctly refused to guess between them. Optional (not
           * defaulted) so existing artifacts keep their content hashes.
           */
          match: z.enum(['contains', 'exact']).optional(),
        })
        .strict(),
      columnHeader: z.string(),
    })
    .strict(),
  // Surface-specific structural fallback. Explicitly tagged with the surface
  // it belongs to so other surfaces skip it instead of misinterpreting it.
  z
    .object({
      s: z.literal('structural'),
      surface: z.literal('web'),
      css: z.string(),
    })
    .strict(),
]);

export const BboxPctSchema = z
  .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
  .strict();

export const TargetRefSchema = z
  .object({
    /** Innermost-last frame hints; matched against the tail of an element's actual frame path. */
    framePath: z.array(FrameHintSchema).default([]),
    /** Ordered locator stack — first strategy that yields exactly one confident candidate wins. */
    strategies: z.array(LocatorSchema).min(1),
    disambiguation: z
      .object({
        requireUnique: z.literal(true).default(true),
        minScore: z.number().min(0).max(1).default(0.6),
      })
      .strict()
      .default({ requireUnique: true, minScore: 0.6 }),
    /** Review/drift evidence only — never consulted for resolution. */
    snapshot: z
      .object({
        textContext: z.string(),
        bboxPct: BboxPctSchema.optional(),
        screenshotRef: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type FrameHint = z.infer<typeof FrameHintSchema>;
export type Locator = z.infer<typeof LocatorSchema>;
export type TargetRef = z.infer<typeof TargetRefSchema>;
