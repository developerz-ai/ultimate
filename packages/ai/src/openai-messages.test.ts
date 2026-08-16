/**
 * The format mapping is the deliverable, so it is what is pinned hardest: `AiMessage` carries
 * Anthropic's block names, and every one of them lands somewhere else on this wire. A mapping that
 * is merely wrong here produces a 400 or, worse, a transcript the model silently misreads.
 */

import { describe, expect, test } from 'bun:test';
import {
  type OpenAiMessage,
  satisfiesStrictMode,
  toOpenAiMessages,
  toOpenAiTools,
  toolChoiceFor,
} from './openai-messages';
import type { AiMessage } from './provider';
import type { JsonSchema, LlmTool } from './tools';

const STRICT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
};

const respond: LlmTool = {
  name: 'respond',
  description: 'Return the result.',
  input_schema: STRICT_SCHEMA,
  strict: true,
};

describe('messages', () => {
  /**
   * The failure this mapping exists to prevent. Anthropic puts a tool result in a USER message;
   * OpenAI rejects that outright and wants one `role: 'tool'` message per `tool_call_id`. Passed
   * through unchanged, an agent's second turn is a 400 — and the first thing anyone would try.
   */
  test('a tool_result block becomes its own tool message, never a user one', () => {
    const messages: readonly AiMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"ok":true}' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'denied', is_error: true },
        ],
      },
    ];

    expect(toOpenAiMessages(undefined, messages)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      // There is no `is_error` on this wire. Dropping the flag hands the model a failure that
      // reads as data, so the marker is the format's only way to say so.
      { role: 'tool', tool_call_id: 'call_2', content: 'error: denied' },
    ]);
  });

  test('the system prompt is a leading message, not a top-level field', () => {
    const out = toOpenAiMessages('be terse', [{ role: 'user', content: 'hi' }]);
    expect(out[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  test('an assistant tool_use block becomes tool_calls with STRINGIFIED arguments', () => {
    const out = toOpenAiMessages(undefined, [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'looking it up' },
          { type: 'tool_use', id: 'call_1', name: 'lookupOrder', input: { id: 7 } },
        ],
      },
    ]);

    expect(out).toEqual([
      {
        role: 'assistant',
        content: 'looking it up',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookupOrder', arguments: '{"id":7}' },
          },
        ],
      },
    ]);
  });

  test('a tool-calls-only turn omits content rather than sending an empty string', () => {
    const [message] = toOpenAiMessages(undefined, [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'lookupOrder', input: {} }],
      },
    ]) as readonly OpenAiMessage[];
    expect(message).not.toHaveProperty('content');
  });

  test('tool results lead, and prose in the same turn follows them', () => {
    const out = toOpenAiMessages(undefined, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'now answer' },
          { type: 'tool_result', tool_use_id: 'call_1', content: 'ok' },
        ],
      },
    ]);
    expect(out.map((m) => m.role)).toEqual(['tool', 'user']);
  });

  test('a plain string message survives untouched', () => {
    expect(toOpenAiMessages(undefined, [{ role: 'user', content: 'hi' }])).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });
});

describe('tools', () => {
  test('an LlmTool becomes a function envelope, schema unchanged', () => {
    const [tool] = toOpenAiTools([respond]);
    expect(tool?.type).toBe('function');
    expect(tool?.function.name).toBe('respond');
    expect(tool?.function.parameters).toBe(STRICT_SCHEMA);
  });

  /**
   * `strict` is a promise the SERVER checks here, unlike Anthropic where it is a hint. Forwarding
   * `LlmTool.strict` — which every framework projection sets — turns a schema with one optional
   * field into `Invalid schema for function 'respond'`, a 400 on a request that is otherwise fine.
   */
  test('strict is claimed only when the schema can keep the promise', () => {
    const optional: LlmTool = {
      ...respond,
      input_schema: {
        type: 'object',
        properties: { summary: { type: 'string' }, note: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false,
      },
    };
    expect(toOpenAiTools([respond])[0]?.function.strict).toBe(true);
    expect(toOpenAiTools([optional])[0]?.function).not.toHaveProperty('strict');
  });

  test('strict mode is checked recursively, because the server checks it recursively', () => {
    expect(satisfiesStrictMode(STRICT_SCHEMA)).toBe(true);
    expect(
      satisfiesStrictMode({
        type: 'object',
        properties: {
          nested: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        },
        required: ['nested'],
        additionalProperties: false,
      }),
      // The nested object never closed itself with additionalProperties: false.
    ).toBe(false);
    expect(
      satisfiesStrictMode({
        type: 'array',
        items: { type: 'object', properties: {}, required: [], additionalProperties: false },
      }),
    ).toBe(true);
  });

  /**
   * One tool is nothing to choose between, and it is exactly the shape `llm()` builds. Left on
   * `auto`, the family answers in prose often enough to make structured output a repair turn on
   * every second call. A tool LOOP is the opposite case: forcing a name there decides the model's
   * next step for it.
   */
  test('exactly one tool is forced; a tool loop is never forced', () => {
    expect(toolChoiceFor([respond])).toEqual({
      type: 'function',
      function: { name: 'respond' },
    });
    expect(toolChoiceFor([respond, { ...respond, name: 'lookupOrder' }])).toBeUndefined();
    expect(toolChoiceFor([])).toBeUndefined();
  });
});
