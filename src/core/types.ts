/**
 * Core vocabulary shared by every layer of the system.
 *
 * These types are surface-agnostic: they describe *what an
 * operator perceives and does* (elements with roles and names, semantic
 * actions like "activate" or "set a value"), never *how* a particular
 * driver accomplishes it (CSS selectors, mouse coordinates, UIA patterns).
 * That separation is the seam that lets the same artifact schema and replay
 * engine extend from a web surface to legacy web or desktop surfaces.
 */

/** One hop of an observed element's actual frame path (top → innermost). */
export interface FramePathEntry {
  name?: string;
  /** Concrete document URL — matched against FrameHint.urlPattern. */
  url: string;
}

/** One perceivable, potentially-actionable element in the current observation. */
export interface ObservedElement {
  /** Index into the current observation's element list. Stable only within one observation. */
  ref: number;
  /** Semantic role, normalized across surfaces (button, link, textbox, combobox, row, cell, heading, dialog…). */
  role: string;
  /** Accessible name: label text, button caption, cell content. */
  name: string;
  /** Value for inputs/selects, if any. */
  value?: string;
  /** Associated label text when distinct from the accessible name. */
  label?: string;
  /** Frame path from the top of the surface to this element's frame. */
  framePath: FramePathEntry[];
  /** Bounding box as percentages of the viewport (0–100), for review/drift evidence — never used for resolution. */
  bboxPct?: { x: number; y: number; w: number; h: number };
  /** True if the element can be acted on (clicked, typed into, chosen). */
  interactive: boolean;
  /** Nearby anchor text (row text, preceding label) to disambiguate repeated controls. */
  nearText?: string;
  /** For table cells: the column header this cell sits under, if detectable. */
  colHeader?: string;
  /** For options/selects: the choices offered. */
  options?: string[];
}

/** A held (not yet answered) native dialog surfaced into the observation. */
export interface ObservedDialog {
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  text: string;
}

/**
 * A point-in-time perception of the surface. This is the ONLY input to
 * condition evaluation, locator resolution, and the discovery agent's
 * decision-making — one shared representation keeps checkpoints, outcome
 * detectors, recovery triggers, and anomaly screens consistent.
 */
export interface Observation {
  /** Monotonic sequence number within a run. */
  seq: number;
  /** Top-level location: URL for web, foreground window title for desktop. */
  location: string;
  /** Document/window title. */
  title: string;
  /** Flattened, frame-aware element map. */
  elements: ObservedElement[];
  /** Visible text content (per frame, concatenated) for textPresent/textAbsent conditions. */
  visibleText: string;
  /**
   * Per-frame visible text, for frame-scoped text conditions: a checkpoint
   * can assert text within one named frame so persistent chrome (nav menus,
   * banners) can never satisfy a condition about the work area.
   */
  frameTexts?: { framePath: FramePathEntry[]; text: string }[];
  /** Native dialog currently held open, if any. */
  dialog?: ObservedDialog;
  /** PNG screenshot of the full surface, for the LLM and for evidence. */
  screenshot?: Buffer;
  /** Wall-clock capture time (ISO 8601). */
  at: string;
}

/**
 * Semantic actions — the complete set of things any operator (LLM agent,
 * replay engine, or human) can ask a surface to do. Surfaces translate them
 * into driver mechanics (click vs Invoke(), fill vs SendKeys…).
 */
export type SemanticAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'activate'; ref: number }
  | { kind: 'setValue'; ref: number; value: string }
  | { kind: 'choose'; ref: number; option: string }
  | { kind: 'read'; ref: number }
  | { kind: 'answerDialog'; accept: boolean; promptText?: string };

/** What an action returns: read actions yield the extracted value. */
export interface ActResultValue {
  readValue?: string;
}

/** Risk classification for actions/steps — drives policy handling. */
export type RiskClass = 'read' | 'reversible' | 'irreversible';

/** Who currently holds control of the live session. */
export type ControlHolder = 'agent' | 'human';
