/**
 * The discovery agent's tool surface, kept narrow. The model can
 * observe, perform the same semantic actions the replay engine performs
 * (through the same ActionGate), declare extractions and observed business
 * outcomes, retract mistakes, and finish. Strict schemas: every tool input
 * validates exactly, which matters when tool inputs feed a recorder.
 *
 * Two safety-relevant design points:
 *  - `type` accepts either literal text OR a param NAME. Secret params are
 *    only ever referenced by name — the harness injects the value; the model
 *    never sees it (and password field values are never observed either).
 *  - `declare_outcome` requires a text marker that is currently visible; the
 *    harness verifies it against the live observation, so a detector can only
 *    encode text that was actually on screen.
 */

// Minimal JSON-schema type for tool definitions (strict tool use).
interface ToolDef {
  name: string;
  description: string;
  strict: true;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

const str = (description: string): Record<string, unknown> => ({ type: 'string', description });
const int = (description: string): Record<string, unknown> => ({ type: 'integer', description });
const bool = (description: string): Record<string, unknown> => ({ type: 'boolean', description });

export const DISCOVERY_TOOLS: ToolDef[] = [
  {
    name: 'observe',
    description:
      'Take a fresh look at the surface: element map (with refs), visible text, current location, any open dialog, and a screenshot. click, navigate, and answer_dialog return the resulting observation automatically; type, choose, and read return short confirmations and leave refs unchanged — call observe when you want a fresh look.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'navigate',
    description: 'Navigate the browser to a URL (must stay on the allowed origin).',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { url: str('Absolute URL to open.'), intent: str('One line: why this navigation.') },
      required: ['url', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description:
      'Activate (click) an element by its ref from the latest observation. Set irreversible=true when the click commits a permanent business change (posting a transaction, final confirm) — such actions are policy-gated.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        ref: int('Element ref from the latest observation.'),
        intent: str('One line: what this click accomplishes.'),
        irreversible: bool('True if this click commits a permanent, hard-to-undo business change.'),
      },
      required: ['ref', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description:
      "Set a text field's value. Provide EITHER text (literal) OR param (name of a provided parameter — the harness injects its value; always use param for credentials/sensitive parameters).",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        ref: int('Element ref of the textbox.'),
        intent: str('One line: what is being entered and why.'),
        text: str('Literal text to enter.'),
        param: str('Name of a provided parameter whose value the harness will inject.'),
      },
      required: ['ref', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'choose',
    description: 'Choose an option in a select/combobox by its visible option text.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        ref: int('Element ref of the combobox.'),
        option: str('Visible text of the option to choose.'),
        intent: str('One line: why this option.'),
      },
      required: ['ref', 'option', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description:
      "Extract an element's text/value as a named output of the capability (e.g. the balance cell into 'savingsBalance').",
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        ref: int('Element ref to read.'),
        output_name: str('Output name, lowerCamelCase.'),
        intent: str('One line: what this value is.'),
      },
      required: ['ref', 'output_name', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'answer_dialog',
    description: 'Answer the currently open native dialog (accept or dismiss). Decide deliberately based on its text.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { accept: bool('true = OK/accept, false = cancel/dismiss.'), intent: str('One line: why.') },
      required: ['accept', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'begin_probe',
    description:
      'Mark the start of an exceptional-state probe (e.g. searching a nonexistent record to learn the not-found behavior). Probe actions are recorded as evidence but EXCLUDED from the replayable step sequence. End the probe with declare_outcome.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        outcome_code: str('SCREAMING_SNAKE code of the outcome being probed, e.g. MEMBER_NOT_FOUND.'),
        intent: str('One line: what you are probing.'),
      },
      required: ['outcome_code', 'intent'],
      additionalProperties: false,
    },
  },
  {
    name: 'declare_outcome',
    description:
      'Declare an expected business outcome you are OBSERVING RIGHT NOW. The marker must be text literally visible on the current screen — the harness verifies it.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        code: str('SCREAMING_SNAKE outcome code, e.g. MEMBER_NOT_FOUND.'),
        description: str('One or two sentences a calling agent will read: what this outcome means.'),
        marker: str('Exact text currently visible that identifies this state.'),
      },
      required: ['code', 'description', 'marker'],
      additionalProperties: false,
    },
  },
  {
    name: 'revise',
    description:
      'Retract your last N recorded actions from the replayable sequence (they still happened in the browser — retract only when they were a wrong turn, then steer back).',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { drop_last: int('How many trailing recorded actions to retract.'), reason: str('Why.') },
      required: ['drop_last', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'declare_done',
    description:
      'Finish successfully. Provide the capability identity for the compiled artifact. Only call when the goal is fully accomplished.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        capability_id: str("Namespaced id, e.g. 'member.readSavingsBalance'."),
        title: str('Short human title.'),
        description: str('2-3 sentences for reviewers AND calling agents: what it does, what it needs, what it returns, notable outcomes.'),
      },
      required: ['capability_id', 'title', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'give_up',
    description: 'Stop because the goal cannot be safely accomplished. Explain precisely what blocked you.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { reason: str('What blocked you and what you tried.') },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];
