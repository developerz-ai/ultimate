/**
 * One question, one answer, whichever wire format is asked. `provider.ts`/`wire.ts` read the
 * Anthropic Messages API; `openai-provider.ts`/`openai-wire.ts` read the OpenAI chat-completions
 * format. A rule only one of them holds is a rule an app loses the day it points `configureAi` at
 * the other endpoint — so every case here asserts BOTH sides, and both of the Anthropic
 * TRANSPORTS, inside one `test()`, and neither side can move alone.
 *
 * The per-format suites already cover each half on its own; what could not be seen from inside
 * either is that they disagreed.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { secret } from '@ultimat3/core';
import { AiTransportError } from './errors';
import { OPENAI_MODEL_IDS, registerOpenAiModels } from './openai-models';
import { openAiProvider } from './openai-provider';
import { ChatCompletionStream, parseChatCompletion } from './openai-wire';
import { AnthropicProvider, parseMessage } from './provider';
import type { SseFrame } from './sse';
import { MessageStream } from './wire';

const KEY = 'sk-live-do-not-log-me';
const OPENAI_MODEL = 'gpt-5.6-sol';
const ANTHROPIC_MODEL = 'claude-opus-5';

const frame = (payload: unknown, event = 'message'): SseFrame => ({
  event,
  data: JSON.stringify(payload),
  id: undefined,
  retry: undefined,
});

/** What the call threw, or `undefined` — so a case asserts the value rather than a `try` shape. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

const transportError = (value: unknown): AiTransportError => {
  expect(value).toBeInstanceOf(AiTransportError);
  return value as AiTransportError;
};

/** Records what left the process and replies with whatever the case wants back. */
function fakeFetch(reply: () => Response): typeof fetch {
  const impl = async (): Promise<Response> => reply();
  return impl as unknown as typeof fetch;
}

beforeEach(() => {
  // `resetModels()` in another suite clears the whole registry, this format's specs included.
  registerOpenAiModels();
});

describe('an in-band error is never an empty successful answer', () => {
  test('a 200 whose body carries an error object is a coded transport failure on both formats', () => {
    const body = { type: 'error', error: { type: 'overloaded_error', message: 'saturated' } };
    // The non-streaming Anthropic read, the streamed one, and the OpenAI-format read. All three
    // parse a body a gateway can send after the headers are out; two of them already refused it.
    const anthropic = transportError(thrownBy(() => parseMessage(ANTHROPIC_MODEL, body)));
    const streamed = transportError(thrownBy(() => new MessageStream().push(frame(body, 'error'))));
    const openai = transportError(
      thrownBy(() =>
        parseChatCompletion(
          { error: { type: 'overloaded_error', message: 'saturated' } },
          'openai',
        ),
      ),
    );

    for (const error of [anthropic, streamed, openai]) {
      expect(error.code).toBe('X_AI_PROVIDER_UNAVAILABLE');
      expect(error.cause).toContain('saturated');
      // The status IS the gateway's retry rule: an in-band failure with none reads as a fault
      // nothing may retry, which is the opposite of what an overloaded provider is saying.
      expect(error.status).not.toBeUndefined();
    }
    // Each format spells "overloaded" in its own numbers, and that is the format's fact, not a
    // divergence: 529 is Anthropic's, 503 is what the OpenAI-format table maps.
    expect(anthropic.status).toBe(529);
    expect(streamed.status).toBe(529);
    expect(openai.status).toBe(503);
  });
});

describe('a refusal detail decides the stop reason', () => {
  test('a refusal is stopReason "refusal" on both formats, whatever the stop field says', () => {
    // `llm()` and `agent()` branch on `stopReason` alone — `stopDetails` has no reader that can
    // refuse — so a body that says "refusal" in the detail and something else in the reason must
    // not arrive as a complete answer that happens to be empty. `parseStopReason` answers
    // `end_turn` for a spelling this build has never seen, which is exactly that case.
    const anthropic = parseMessage(ANTHROPIC_MODEL, {
      content: [],
      stop_reason: 'model_refusal_2027',
      stop_details: { type: 'refusal', category: 'bio' },
      usage: { input_tokens: 9, output_tokens: 0 },
    });
    const stream = new MessageStream();
    stream.push(
      frame({
        type: 'message_delta',
        delta: {
          stop_reason: 'model_refusal_2027',
          stop_details: { type: 'refusal', category: 'bio' },
        },
      }),
    );
    const openai = parseChatCompletion(
      { choices: [{ message: { refusal: 'declined' }, finish_reason: 'stop' }] },
      'openai',
    );

    expect(anthropic.stopReason).toBe('refusal');
    expect(stream.state().stopReason).toBe('refusal');
    expect(openai.stopReason).toBe('refusal');
    // The category is carried on every path: it is the one thing that says whether another model
    // would answer, and `X_LLM_REFUSED`'s fix line is built out of it.
    expect(anthropic.stopDetails?.category).toBe('bio');
    expect(stream.state().stopDetails?.category).toBe('bio');
    expect(openai.stopDetails?.category).toBe('refusal');
  });
});

describe('a tool call carries an object or nothing', () => {
  test('arguments that are not an object become {} on every read path', () => {
    // `LlmToolCall.input` is `Record<string, unknown>` and `runLlmToolCall` indexes it, so a
    // string or an array arriving under that type is a lie the type system cannot catch later.
    const anthropic = parseMessage(ANTHROPIC_MODEL, {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'publishPost', input: 'not-an-object' }],
      stop_reason: 'tool_use',
      usage: {},
    });
    const stream = new MessageStream();
    stream.push(
      frame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'publishPost' },
      }),
    );
    stream.push(
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"not-an-object"' },
      }),
    );
    stream.push(frame({ type: 'content_block_stop', index: 0 }));
    const completion = new ChatCompletionStream('openai');
    completion.push(
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'publishPost', arguments: '"not-an-object"' },
                },
              ],
            },
          },
        ],
      }),
    );
    completion.push(frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));

    expect(anthropic.toolCalls[0]?.input).toEqual({});
    expect(stream.state().toolCalls[0]?.input).toEqual({});
    expect(completion.state().toolCalls[0]?.input).toEqual({});
  });
});

describe('the credential never reaches an error', () => {
  test('a 4xx body echoing the key is scrubbed on both providers', async () => {
    // A proxy that echoes the request headers into its own 400 body is the one path by which a
    // key reaches an error — and an error reaches a log index, a span and a problem document.
    const echoed = (header: string): Response =>
      new Response(JSON.stringify({ error: { message: `rejected header ${header}` } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });

    const anthropic = new AnthropicProvider({
      apiKey: KEY,
      fetch: fakeFetch(() => echoed(`x-api-key: ${KEY}`)),
    });
    const openai = openAiProvider({
      apiKey: secret(KEY, 'OPENAI_API_KEY'),
      models: [...OPENAI_MODEL_IDS],
      fetch: fakeFetch(() => echoed(`authorization: Bearer ${KEY}`)),
    });

    const failures = await Promise.all(
      [
        anthropic.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 }),
        openai.generate({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 16,
        }),
      ].map((promise) =>
        promise.then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    );

    for (const failure of failures) {
      const error = transportError(failure);
      expect(error.status).toBe(400);
      expect(error.cause).not.toContain(KEY);
      expect(error.message).not.toContain(KEY);
      expect(error.cause).toContain('[redacted]');
    }
  });
});

describe("the caller's abort signal reaches the socket", () => {
  test('both formats forward `signal` into fetch, on the streaming and non-streaming paths', async () => {
    // Cancellation that stops at the top of the next turn still pays for the call already in
    // flight — which on a long completion is the expensive one. `agent()` puts `ctx.signal` on
    // every request; a provider that drops it makes that guarantee a comment.
    const seen: (AbortSignal | undefined)[] = [];
    const recording = (): typeof fetch => {
      const impl = async (_url: string, init?: RequestInit): Promise<Response> => {
        seen.push(init?.signal ?? undefined);
        return new Response(JSON.stringify({ error: { message: 'stop here' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      };
      return impl as unknown as typeof fetch;
    };

    const signal = new AbortController().signal;
    const anthropic = new AnthropicProvider({ apiKey: KEY, fetch: recording() });
    const openai = openAiProvider({
      apiKey: secret(KEY, 'OPENAI_API_KEY'),
      models: [...OPENAI_MODEL_IDS],
      fetch: recording(),
    });
    const drain = async (chunks: AsyncIterable<unknown>): Promise<void> => {
      for await (const _chunk of chunks) {
        // The 503 lands on the first pull; nothing is expected to arrive.
      }
    };

    const calls: readonly (() => Promise<unknown>)[] = [
      () =>
        anthropic.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 16, signal }),
      () =>
        drain(
          anthropic.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 16, signal }),
        ),
      () =>
        openai.generate({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 16,
          signal,
        }),
      () =>
        drain(
          openai.stream({
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: 'hi' }],
            maxTokens: 16,
            signal,
          }),
        ),
    ];
    for (const call of calls) await call().catch(() => undefined);

    expect(seen).toHaveLength(4);
    expect(seen.every((each) => each === signal)).toBe(true);
  });

  test('a request with no signal attaches none, rather than an explicit undefined', async () => {
    let init: RequestInit | undefined;
    const impl = async (_url: string, given?: RequestInit): Promise<Response> => {
      init = given;
      return new Response('{}', { status: 503 });
    };
    const anthropic = new AnthropicProvider({
      apiKey: KEY,
      fetch: impl as unknown as typeof fetch,
    });
    await anthropic
      .generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 })
      .catch(() => undefined);
    expect(init !== undefined && 'signal' in init).toBe(false);
  });
});
