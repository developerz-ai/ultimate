/**
 * What leaves the process. Every assertion here is a 400 somebody would otherwise learn about from
 * a production log: the deprecated token field, a sampling knob a reasoning model rejects, and the
 * one `stream_options` field without which the budget reconciles a real call against nothing.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { registerModel } from './models';
import { chatCompletionBody } from './openai-body';
import { registerOpenAiModels } from './openai-models';
import type { GenerateRequest } from './provider';
import type { LlmTool } from './tools';

const MODEL = 'gpt-5.6-sol';
/** A model an app registered for its own endpoint: no reasoning controls at all. */
const PLAIN = 'acme-70b';

const request = (extra: Partial<GenerateRequest> = {}): GenerateRequest => ({
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 1_000,
  ...extra,
});

const respond: LlmTool = {
  name: 'respond',
  description: 'Return the result.',
  input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  strict: true,
};

beforeEach(() => {
  // `resetModels()` in another suite clears the whole registry, this provider's specs included.
  registerOpenAiModels();
  registerModel({
    id: PLAIN,
    contextWindow: 128_000,
    maxOutput: 8_192,
    inputPerMillion: { minor: 20, currency: 'USD' },
    outputPerMillion: { minor: 40, currency: 'USD' },
    cacheMinimumTokens: 0,
    reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
  });
});

describe('the request body', () => {
  /**
   * The failure first: `max_tokens` is deprecated on this wire and REJECTED outright by every
   * current reasoning model (`Unsupported parameter: 'max_tokens' … use 'max_completion_tokens'`).
   * A provider that sends the old name is a 400 on every single call to the vendor it is named for.
   */
  test('sends max_completion_tokens and never max_tokens', () => {
    const body = chatCompletionBody({ request: request(), model: MODEL, stream: false });
    expect(body['max_completion_tokens']).toBe(1_000);
    expect(body['max_tokens']).toBeUndefined();
  });

  test("clamps the ceiling to the model's own maxOutput", () => {
    const body = chatCompletionBody({
      request: request({ maxTokens: 1_000_000 }),
      model: MODEL,
      stream: false,
    });
    expect(body['max_completion_tokens']).toBe(128_000);
  });

  test('never sends a sampling knob, and never response_format', () => {
    const body = chatCompletionBody({ request: request(), model: MODEL, stream: false });
    expect(body['temperature']).toBeUndefined();
    expect(body['top_p']).toBeUndefined();
    expect(body['presence_penalty']).toBeUndefined();
    // Structured output goes through the `respond` tool, which is the framework's one path.
    expect(body['response_format']).toBeUndefined();
  });

  /**
   * Without `include_usage` the final chunk carries no `usage`, the budget reconciles against
   * nothing, and a reservation for a call that really happened is refunded in full.
   */
  test('a streamed request asks for usage explicitly', () => {
    const body = chatCompletionBody({ request: request(), model: MODEL, stream: true });
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });
  });

  test('a non-streamed request says nothing about streaming', () => {
    const body = chatCompletionBody({ request: request(), model: MODEL, stream: false });
    expect(body['stream']).toBeUndefined();
    expect(body['stream_options']).toBeUndefined();
  });

  test('tools travel with a forced choice when there is exactly one of them', () => {
    const body = chatCompletionBody({
      request: request({ tools: [respond], stopSequences: ['STOP'] }),
      model: MODEL,
      stream: false,
    });
    expect(body['tools']).toHaveLength(1);
    expect(body['tool_choice']).toEqual({ type: 'function', function: { name: 'respond' } });
    expect(body['stop']).toEqual(['STOP']);
  });
});

describe('reasoning', () => {
  test('an effort the caller asked for is sent, and one nobody asked for is omitted', () => {
    expect(
      chatCompletionBody({ request: request({ effort: 'xhigh' }), model: MODEL, stream: false })[
        'reasoning_effort'
      ],
    ).toBe('xhigh');
    expect(
      chatCompletionBody({ request: request(), model: MODEL, stream: false })['reasoning_effort'],
    ).toBeUndefined();
  });

  test("thinking: 'disabled' is this format's `none`", () => {
    const body = chatCompletionBody({
      request: request({ thinking: 'disabled' }),
      model: MODEL,
      stream: false,
    });
    expect(body['reasoning_effort']).toBe('none');
  });

  test('adaptive is the server default here, so nothing is sent for it', () => {
    // Only reachable on a model registered as adaptive-capable; the built-ins are not, and asking
    // for adaptive on one of those is refused below rather than dropped.
    const body = chatCompletionBody({ request: request(), model: MODEL, stream: false });
    expect(body['thinking']).toBeUndefined();
    expect(body['reasoning_effort']).toBeUndefined();
  });

  test('asking for both thinking and effort is refused, because they are one wire field', () => {
    expect(() =>
      chatCompletionBody({
        request: request({ effort: 'high', thinking: 'disabled' }),
        model: MODEL,
        stream: false,
      }),
    ).toThrow(/reasoning_effort/);
  });

  test('a model with no effort control refuses the control locally, not with a 400', () => {
    expect(() =>
      chatCompletionBody({ request: request({ effort: 'high' }), model: PLAIN, stream: false }),
    ).toThrow(/effort control/);
    expect(() =>
      chatCompletionBody({
        request: request({ thinking: 'adaptive' }),
        model: PLAIN,
        stream: false,
      }),
    ).toThrow(/adaptive/);
    // Nothing to switch off, so nothing is sent — the model stays callable.
    expect(
      chatCompletionBody({
        request: request({ thinking: 'disabled' }),
        model: PLAIN,
        stream: false,
      })['reasoning_effort'],
    ).toBeUndefined();
  });
});
