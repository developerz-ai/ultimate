// The `respond` tool an `llm()` / `agent()` answers through, and the reader that gets the answer
// back out of a turn: the tool call's arguments, or the prose parsed as JSON. One file so the
// envelope a non-object `output` is wrapped in and its unwrapping cannot drift apart.

import type { StandardSchemaV1 } from '@ultimat3/schema';
import { toMcpInputSchema } from '@ultimat3/schema';
import type { GenerateResult } from './provider';
import type { LlmTool } from './tools';

/**
 * The tool the model answers through. One name, so the reader never has to guess — and shared
 * with `agent()`, which offers the app's tools alongside it and needs the same name to tell an
 * answer from a tool call.
 */
export const RESPOND = 'respond';

/** The one property a non-object `output` travels under. */
const ENVELOPE = 'value';

/** The tool for one `output`, and the reader that undoes whatever the tool did to it. */
export interface Respond {
  readonly tool: LlmTool;
  /** The answer in `result`, unwrapped — or `undefined` when there is none to validate. */
  read(result: GenerateResult): unknown;
}

/**
 * The output schema as the only tool the model may answer through — the spec's "structured
 * output drives tool use". `toMcpInputSchema` is the same projection an MCP client sees, so a
 * model and an agent are shown one shape, and a schema it cannot express throws HERE, at
 * declaration time.
 *
 * A tool's `input_schema` must be an OBJECT, so any other `output` (`t.string`, `t.number`, an
 * array) is wrapped in `{ value }` and unwrapped on the way back — never refused: `.stream()` is
 * documented for `output: t.string`, and the same declaration must work called plainly.
 */
export function respondFor(output: StandardSchemaV1): Respond {
  const schema = toMcpInputSchema(output);
  const wrapped = schema.type !== 'object';
  return {
    tool: {
      name: RESPOND,
      description: 'Return the result. Call this exactly once; do not answer in prose.',
      input_schema: wrapped
        ? {
            type: 'object',
            properties: { [ENVELOPE]: schema },
            required: [ENVELOPE],
            additionalProperties: false,
          }
        : schema,
      strict: true,
    },
    read(result) {
      const call = result.toolCalls.find((c) => c.name === RESPOND);
      if (call !== undefined) return wrapped ? call.input[ENVELOPE] : call.input;
      // A model that answers in prose is a schema failure, not a crash, so it flows into the
      // repair turn. For a wrapped output the prose itself may BE the answer (`t.string`), the
      // rule `.stream()` already applies.
      const parsed = parseJsonish(result.text);
      return parsed === undefined && wrapped && result.text !== '' ? result.text : parsed;
    },
  };
}

const FENCE = '```';

/**
 * The JSON in a prose answer: the first fenced block when there is a closed one, else the whole
 * text. Two `indexOf` scans, never a backtracking pattern: the regex this replaced re-scanned the
 * tail from every whitespace position after an unterminated fence — quadratic on model output.
 */
export function parseJsonish(text: string): unknown {
  const open = text.indexOf(FENCE);
  const close = open === -1 ? -1 : text.indexOf(FENCE, open + FENCE.length);
  let body = text;
  if (close !== -1) {
    body = text.slice(open + FENCE.length, close);
    if (body.startsWith('json')) body = body.slice('json'.length);
  }
  try {
    return JSON.parse(body.trim());
  } catch {
    return undefined;
  }
}
