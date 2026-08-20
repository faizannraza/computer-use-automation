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
  /**
   * Nearby anchor text (row text, preceding label) to disambiguate repeated
   * controls. Truncated to a payload budget ON A CELL BOUNDARY — a value it
   * contains is present in full, never as a prefix, because a partial value
   * cannot be matched by the redactor and would be written out in the clear.
   */
  nearText?: string;
  /** For table cells: the column header this cell sits under, if detectable. */
  colHeader?: string;
  /**
   * For table cells: identity of the row this cell belongs to, stable within
   * one observation (table ordinal + row ordinal). Row TEXT cannot serve as
   * identity — a ledger's duplicate posting repeats it verbatim, and it is
   * truncated besides — so anything grouping cells into rows must key on this
   * and treat `nearText` only as a fallback for observations without it.
   */
  rowId?: string;
  /**
   * For table cells: the row's cells as discrete strings, each one WHOLE.
   * `nearText` joins them with ' | ' and truncates, so a cell whose own text
   * contains '|' (or a wide row) cannot be recovered from it by splitting.
   * The walker bounds this by dropping trailing cells, never by cutting one:
   * a half a value is unmatchable by the redactor's exact-string needles and
   * would ship in cleartext. So it may be a PREFIX of the row's cells, but
   * every string in it is exactly what that cell says.
   */
  cellTexts?: string[];
  /** For options/selects: the choices offered. */
  options?: string[];
  /** Underlying values of those choices — often the stable identifier when
   * the visible label carries volatile data. */
  optionValues?: string[];
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
  | { kind: 'choose'; ref: number; option: string; by?: 'label' | 'value' | undefined }
  | { kind: 'read'; ref: number }
  /**
   * Read a whole table (rows × named columns) rather than one cell — what
   * "list this member's shares, balances and statuses" actually needs.
   * Addressed by column names rather than a ref, because the table is a
   * region of the surface, not a single control; a desktop driver would
   * satisfy it from a native grid.
   */
  | { kind: 'readTable'; columns: string[]; frame?: { name?: string | undefined; urlPattern?: string | undefined } }
  | { kind: 'answerDialog'; accept: boolean; promptText?: string };

/** What an action returns: read actions yield the extracted value. */
export interface ActResultValue {
  readValue?: string;
}

/** Risk classification for actions/steps — drives policy handling. */
export type RiskClass = 'read' | 'reversible' | 'irreversible';

/** Who currently holds control of the live session. */
export type ControlHolder = 'agent' | 'human';
