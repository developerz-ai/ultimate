// Single responsibility: the REQUEST half of the OpenAI chat-completions format — `AiMessage`
// (which carries Anthropic's block names) onto OpenAI's messages, and `LlmTool` onto its functions.
//
// This mapping is the whole reason the provider exists: the two formats disagree about where a
// system prompt lives, how an assistant asks for a tool, and how a tool answers. Pure functions, so
// every disagreement is a unit test with no socket.

import type { AiContentBlock, AiMessage } from './provider';
import type { JsonSchema, LlmTool } from './tools';

export interface OpenAiToolCall {
  readonly id: string;
  readonly type: 'function';
  /** Arguments are a JSON STRING on this wire, not an object. The one field everybody gets wrong. */
  readonly function: { readonly name: string; readonly arguments: string };
}

export type OpenAiMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content?: string | undefined;
      readonly tool_calls?: readonly OpenAiToolCall[] | undefined;
    }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

export interface OpenAiFunctionTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** OpenAI calls it `parameters`; the JSON Schema inside is byte-identical to `input_schema`. */
    readonly parameters: JsonSchema;
    readonly strict?: boolean | undefined;
  };
}

/** `tool_choice`, when the framework is forcing one. Named function, the only forcing shape. */
export interface OpenAiToolChoice {
  readonly type: 'function';
  readonly function: { readonly name: string };
}

/**
 * The conversation, translated. Three structural differences, each of which silently corrupts a
 * transcript if it is missed:
 *
 *   - the system prompt is a MESSAGE here, not a top-level field, and it must lead;
 *   - an assistant's `tool_use` blocks become `tool_calls` ON the assistant message, with their
 *     arguments serialised to a string;
 *   - a `tool_result` block is not a user block at all — it is its own `role: 'tool'` message,
 *     one per result, keyed by `tool_call_id`.
 *
 * `system` rather than `developer`: the newer role is OpenAI's alone, and every other server
 * speaking this format — vLLM, Ollama, LiteLLM, Together — knows only `system`. OpenAI accepts it.
 */
export function toOpenAiMessages(
  system: string | undefined,
  messages: readonly AiMessage[],
): readonly OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system !== undefined && system !== '') out.push({ role: 'system', content: system });
  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === 'assistant') out.push(assistantMessage(message.content));
    else out.push(...toolTurn(message.content));
  }
  return out;
}

/** Text blocks concatenate; `tool_use` blocks move onto `tool_calls` with stringified arguments. */
function assistantMessage(blocks: readonly AiContentBlock[]): OpenAiMessage {
  let content = '';
  const toolCalls: OpenAiToolCall[] = [];
  for (const block of blocks) {
    if (block.type === 'text') content += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }
  // Content is OMITTED, not empty-stringed, when the turn was only tool calls: an assistant message
  // carrying both an empty string and `tool_calls` is rejected by some servers in the family.
  return {
    role: 'assistant',
    ...(content === '' ? {} : { content }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}

/**
 * A user turn that carries tool results. Every result becomes its own `role: 'tool'` message, in
 * order and before any prose, because OpenAI requires one tool message per `tool_call_id` the
 * previous assistant message asked for, and requires them to come first.
 */
function toolTurn(blocks: readonly AiContentBlock[]): readonly OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_result') {
      out.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        // There is no `is_error` on this wire, and dropping the flag would hand the model a failure
        // that reads as data. The marker is the format's only place to say so.
        content: block.is_error === true ? `error: ${block.content}` : block.content,
      });
    }
  }
  if (text !== '') out.push({ role: 'user', content: text });
  return out;
}

/**
 * Tool definitions, wrapped in the `{ type: 'function', function: … }` envelope.
 *
 * `strict` is claimed only when the projected schema actually satisfies OpenAI's strict rules.
 * `LlmTool.strict` is `true` on every projection the framework makes, but on THIS wire the flag is
 * a promise the server checks: a schema with an optional field — one key in `properties` and not in
 * `required` — is a 400 (`Invalid schema for function …`) rather than a looser check. So the flag
 * is derived from the schema, never forwarded, and a schema that cannot keep the promise is sent
 * without it and validated by the output schema on the way back, exactly as the Anthropic path is.
 */
export function toOpenAiTools(tools: readonly LlmTool[]): readonly OpenAiFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      ...(tool.strict === true && satisfiesStrictMode(tool.input_schema) ? { strict: true } : {}),
    },
  }));
}

/**
 * Whether a schema keeps OpenAI's strict-mode promise: every object closed with
 * `additionalProperties: false`, and every one of its keys listed in `required`. Recursive, because
 * the server checks it recursively.
 */
export function satisfiesStrictMode(schema: JsonSchema): boolean {
  if (schema.items !== undefined && !satisfiesStrictMode(schema.items)) return false;
  if (schema.type !== 'object' && schema.properties === undefined) return true;
  if (schema.additionalProperties !== false) return false;
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  for (const [key, child] of Object.entries(properties)) {
    if (!required.has(key)) return false;
    if (!satisfiesStrictMode(child)) return false;
  }
  return true;
}

/**
 * `tool_choice`, or nothing. Forced when the request offers EXACTLY ONE tool, which is precisely
 * the shape `llm()` builds: the `respond` projection of the output schema, with the instruction to
 * answer through it. One tool is nothing to choose between, and left to `auto` the family answers
 * in prose often enough that structured output becomes a repair turn on every second call.
 *
 * Never forced when a tool loop is running: `agent()` offers the app's tools alongside `respond`,
 * and forcing a name there would decide the loop's next step for the model.
 */
export function toolChoiceFor(tools: readonly LlmTool[]): OpenAiToolChoice | undefined {
  const only = tools.length === 1 ? tools[0] : undefined;
  if (only === undefined) return undefined;
  return { type: 'function', function: { name: only.name } };
}
