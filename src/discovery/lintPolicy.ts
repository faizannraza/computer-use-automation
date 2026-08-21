/**
 * Which of the compiler's notes are a veto, and which are a second opinion.
 *
 * The compiler already critiques its own output — it says when a checkpoint is
 * weak, when a locator rung can never match, when a value was only half
 * substituted. Those notes were written to a JSON file beside the trace,
 * printed once at discovery time, and then never consulted again: `cu approve`
 * did not read them, and nothing re-read them when the compiler later learned
 * to emit a note it could not emit before.
 *
 * That is how `member.placeHold` shipped with a fallback rung anchored on
 * `***da` — a redacted member name, so a locator that cannot match any live
 * screen — on its irreversible confirm step.
 *
 * Lives in its own module rather than in `cli.ts` because `cli.ts` is a script
 * with a top-level `await dispatch()`: importing it to test this would run it.
 */

export interface BlockingLint {
  pattern: RegExp;
  why: string;
}

/**
 * A note blocks when it asserts the artifact is DEFECTIVE, not when it asks for
 * judgement. "This checkpoint is short" is a judgement call a reviewer can
 * reasonably wave through. "This rung can never match" is a statement that part
 * of the artifact is inert — approving it means shipping a fallback that cannot
 * fall back, and no amount of reviewer judgement changes that.
 */
export const BLOCKING_LINTS: BlockingLint[] = [
  {
    pattern: /can never match/i,
    why: 'a locator rung that cannot resolve is a fallback that will not catch anything',
  },
  {
    pattern: /pins this capability to the record it was recorded against/i,
    why: 'a half-substituted identifier makes the capability work only for the record it was recorded on',
  },
];

/** The subset of `notes` that must not be approved past without saying so. */
export function blockingLints(notes: readonly string[]): { note: string; why: string }[] {
  return notes.flatMap((note) => {
    const hit = BLOCKING_LINTS.find((b) => b.pattern.test(note));
    return hit ? [{ note, why: hit.why }] : [];
  });
}
