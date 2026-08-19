/**
 * The transcript one agent turn leaves behind: the assistant message replaying what the model
 * emitted, and the user message answering it. One file because the Messages API's rule spans both
 * halves — every `tool_use` block replayed here must be answered by a `tool_result` in the very
 * next message — and a rule split across two call sites is a rule one of them will miss.
 */

import { RESPOND } from './llm';
import type { AiContentBlock, AiMessage, GenerateResult } from './provider';
import type { LlmToolCall, LlmToolResult } from './tools';

/**
 * The model's turn, replayed as the transcript the next request needs. `tool_use` blocks survive
 * as themselves here — unlike `llm()`'s repair turn, which flattens them to text precisely
 * because it has no `tool_result` to follow them with, and the API demands one.
 */
export function assistantTurn(result: GenerateResult): AiMessage {
  const blocks: AiContentBlock[] = [];
  if (result.text !== '') blocks.push({ type: 'text', text: result.text });
  for (const call of result.toolCalls) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
  }
  // A turn with neither text nor a tool call would be an empty content array, which is a 400.
  return blocks.length === 0
    ? { role: 'assistant', content: '(no answer)' }
    : { role: 'assistant', content: blocks };
}

/**
 * What the model is told when it answered in the same turn it asked for a tool. Parallel tool use
 * is normal, and the answer that comes with it was written before the tool result existed — so it
 * is superseded, not wrong, and saying which is what stops the next turn repeating it verbatim.
 */
const SUPERSEDED = `This answer arrived in the same turn as the tool calls above, so it was written before their results existed. Read the results in this message, then call the "${RESPOND}" tool again.`;

/**
 * The tool results of one turn, plus a `tool_result` for every `respond` call the loop did not
 * accept. The second half is not optional: `respond` is filtered out of the calls that get RUN,
 * but it is replayed as a `tool_use` like any other, and a `tool_use` the next message does not
 * answer is a 400 (`tool_use ids were found without tool_result blocks`) — the whole run lost to
 * an `X_AI_PROVIDER_UNAVAILABLE` because the model did the ordinary thing.
 *
 * Real results stay first: they are what the model asked for, and the rejection reads as the
 * instruction that follows them.
 */
export function toolResultTurn(
  results: readonly LlmToolResult[],
  chars: number,
  unaccepted: readonly LlmToolCall[],
): AiMessage {
  return {
    role: 'user',
    content: [
      ...results.map((result) => ({
        type: 'tool_result' as const,
        tool_use_id: result.toolUseId,
        content: truncate(result.content, chars),
        // A denial or a failure is an outcome the model should read and react to, flagged so it
        // does not read as data.
        ...(result.isError === true ? { is_error: true } : {}),
      })),
      ...rejections(unaccepted, SUPERSEDED),
    ],
  };
}

/**
 * The correction after an answer that failed its schema, in whichever shape the turn it corrects
 * demands: a `tool_result` when the answer came through `respond` (the dominant path, and a
 * `tool_use` the API insists on seeing answered), a plain user message when the model answered in
 * prose and there is no id to name. Framework text, so never truncated by `maxToolResultChars`.
 */
export function repairTurn(unaccepted: readonly LlmToolCall[], issues: string): AiMessage {
  const text = `That answer failed its schema: ${issues}. Call the "${RESPOND}" tool with a value that satisfies it. Answer only through the tool.`;
  return unaccepted.length === 0
    ? { role: 'user', content: text }
    : { role: 'user', content: rejections(unaccepted, text) };
}

/** A `tool_result` saying an answer was not taken, flagged so the model does not read it as data. */
function rejections(calls: readonly LlmToolCall[], text: string): readonly AiContentBlock[] {
  return calls.map((call) => ({
    type: 'tool_result' as const,
    tool_use_id: call.id,
    content: text,
    is_error: true,
  }));
}

/** Truncation says so. A silently shortened tool result is a model reasoning over half a table. */
function truncate(text: string, chars: number): string {
  if (text.length <= chars) return text;
  return `${text.slice(0, chars)}\n[truncated: ${text.length - chars} more characters]`;
}
