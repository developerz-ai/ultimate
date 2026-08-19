/**
 * The response half, driven frame by frame with no socket — the only way to cover a stream that
 * arrives fragmented, and fragmentation is where this format is easiest to get subtly wrong: a
 * tool call's id, name and arguments are spread across chunks and keyed only by an index, and the
 * token counts arrive last, in a chunk that carries no answer at all.
 */

import { describe, expect, test } from 'bun:test';
import {
  ChatCompletionStream,
  parseChatCompletion,
  parseFinishReason,
  parseOpenAiUsage,
} from './openai-wire';
import type { StreamChunk } from './provider';
import type { SseFrame } from './sse';

const frame = (payload: unknown): SseFrame => ({
  event: 'message',
  data: JSON.stringify(payload),
});

const DONE: SseFrame = { event: 'message', data: '[DONE]' };

/** Feed a whole stream and collect what it emitted, in order. */
function drive(frames: readonly SseFrame[]): {
  chunks: readonly StreamChunk[];
  stream: ChatCompletionStream;
} {
  const stream = new ChatCompletionStream('openai');
  const chunks: StreamChunk[] = [];
  for (const f of frames) chunks.push(...stream.push(f));
  return { chunks, stream };
}

const TOOL_STREAM: readonly SseFrame[] = [
  frame({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'lookupOrder', arguments: '{"or' },
            },
          ],
        },
      },
    ],
  }),
  // Every later fragment carries the INDEX and nothing else — no id, no name. Merging by array
  // position instead would build one call per chunk and keep only the last slice of arguments.
  frame({
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'derId":' } }] } },
    ],
  }),
  frame({
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a-7"}' } }] } },
    ],
  }),
  frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  // Usage arrives after the answer is over, in a chunk with an empty choices array.
  frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 25 } }),
  DONE,
];

describe('a fragmented tool call', () => {
  test('reassembles into exactly one call, emitted whole and only at the finish', () => {
    const { chunks, stream } = drive(TOOL_STREAM);
    const calls = chunks.filter((chunk) => chunk.type === 'tool-call');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: 'tool-call',
      call: { id: 'call_1', name: 'lookupOrder', input: { orderId: 'a-7' } },
    });
    expect(stream.state().toolCalls).toHaveLength(1);
  });

  test('emits nothing at all while the arguments are still partial', () => {
    const stream = new ChatCompletionStream('openai');
    const before = TOOL_STREAM.slice(0, 3).flatMap((f) => [...stream.push(f)]);
    // Three frames in, `{"orderId":` is not JSON and is not an argument list either.
    expect(before).toEqual([]);
    expect(stream.isComplete()).toBe(false);
  });

  test('keeps two parallel calls apart by their index, however they interleave', () => {
    const { chunks } = drive([
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', function: { name: 'first', arguments: '{"a"' } },
                { index: 1, id: 'call_b', function: { name: 'second', arguments: '{"b"' } },
              ],
            },
          },
        ],
      }),
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: ':2}' } },
                { index: 0, function: { arguments: ':1}' } },
              ],
            },
          },
        ],
      }),
      frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      DONE,
    ]);

    expect(chunks.filter((chunk) => chunk.type === 'tool-call')).toEqual([
      { type: 'tool-call', call: { id: 'call_a', name: 'first', input: { a: 1 } } },
      { type: 'tool-call', call: { id: 'call_b', name: 'second', input: { b: 2 } } },
    ]);
  });

  test('arguments that are not JSON are a transport failure, not an empty input', () => {
    expect(() =>
      drive([
        frame({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'c', function: { name: 'x', arguments: '{"a":' } }],
              },
            },
          ],
        }),
        frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      ]),
    ).toThrow(/not JSON/);
  });
});

describe('usage', () => {
  test('is reconciled from the final chunk, which carries no answer', () => {
    const { stream } = drive(TOOL_STREAM);
    expect(stream.state().usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  /**
   * `prompt_tokens` INCLUDES the cached prefix on this wire, where Anthropic's `input_tokens`
   * excludes it. Reported as-is, the cached half is billed twice — once at the full input rate and
   * again at the cache rate — and the ledger over-reports every cached call.
   */
  test('subtracts the cached prefix out of the input count', () => {
    expect(
      parseOpenAiUsage({
        prompt_tokens: 1_000,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 800 },
      }),
    ).toEqual({
      inputTokens: 200,
      outputTokens: 10,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
  });

  test('is undefined — never zero — when the endpoint reported none', () => {
    // Zero would read as a free call and refund the whole reservation. The provider substitutes an
    // estimate; it can only do that if this half says "nothing arrived" rather than "nothing spent".
    expect(parseOpenAiUsage(undefined)).toBeUndefined();
    expect(parseOpenAiUsage({})).toBeUndefined();
    const { stream } = drive([
      frame({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }),
      DONE,
    ]);
    expect(stream.state().usage).toBeUndefined();
  });
});

describe('a finish reason is looked up, never indexed', () => {
  // `FINISH_REASONS['constructor']` on an object literal answers the `Object` FUNCTION, which was
  // returned as a `StopReason` and treated by the stream reader as a finish — so `isComplete()`
  // answered true for a stream that never finished.
  test('an inherited property name is not a finish reason', () => {
    expect(parseFinishReason('constructor')).toBeUndefined();
    expect(parseFinishReason('toString')).toBeUndefined();
    expect(parseFinishReason('__proto__')).toBeUndefined();
    expect(parseFinishReason('stop')).toBe('end_turn');
  });

  test('a frame finishing with __proto__ does not report the stream complete', () => {
    const { stream } = drive([
      frame({ choices: [{ delta: { content: 'half an ans' }, finish_reason: '__proto__' }] }),
    ]);
    expect(stream.isComplete()).toBe(false);
    // And the stop reason is untouched: nothing was learned about why the model stopped.
    expect(stream.state().stopReason).toBe('end_turn');
  });

  test('an in-band error type off the prototype chain gets 500, never a function', () => {
    let thrown: unknown;
    try {
      drive([frame({ error: { type: 'constructor', message: 'nope' } })]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE', status: 500 });
    expect(typeof (thrown as { status: unknown }).status).toBe('number');
  });

  test('a negative token count is floored, never credited to the ledger', () => {
    // A negative count becomes a negative cost, and a negative debit is a CREDIT to the budget.
    expect(parseOpenAiUsage({ prompt_tokens: -10, completion_tokens: -4 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // A negative CACHED count is the same fault by a different route: it is subtracted out of the
    // input count, so an unclamped one inflates the tokens billed at the full input rate.
    expect(
      parseOpenAiUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: -50 } }),
    ).toMatchObject({ inputTokens: 100, cacheReadTokens: 0 });
  });
});

describe('the stream ends', () => {
  test('a cut connection is incomplete, so the provider can refuse a truncated answer', () => {
    const { stream } = drive([frame({ choices: [{ delta: { content: 'half an ans' } }] })]);
    expect(stream.isComplete()).toBe(false);
    expect(stream.state().text).toBe('half an ans');
  });

  test('a finish reason with no [DONE] still counts — plenty of servers just close', () => {
    const { stream } = drive([frame({ choices: [{ delta: {}, finish_reason: 'length' }] })]);
    expect(stream.isComplete()).toBe(true);
    expect(stream.state().stopReason).toBe('max_tokens');
  });

  test('an in-band error frame becomes a coded transport failure with a status', () => {
    expect(() =>
      drive([frame({ error: { type: 'rate_limit_exceeded', message: 'slow down' } })]),
    ).toThrow(/slow down/);
    try {
      drive([frame({ error: { type: 'rate_limit_exceeded', message: 'slow down' } })]);
    } catch (error) {
      expect(error).toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE', status: 429 });
    }
  });

  test('an unreadable frame fails loudly rather than reading as an empty answer', () => {
    expect(() => drive([{ event: 'message', data: 'not json' }])).toThrow(/unreadable/);
  });

  test('[DONE] while a tool call is still open is NOT complete', () => {
    // `onFinish` is the only drain of `pending`, so a `[DONE]` with no finish reason behind it
    // dropped the whole call and left a successful, empty `end_turn` — a tool the model asked for
    // that no layer below can tell was ever requested.
    const { chunks, stream } = drive([
      TOOL_STREAM[0] as SseFrame,
      TOOL_STREAM[1] as SseFrame,
      TOOL_STREAM[2] as SseFrame,
      DONE,
    ]);
    expect(chunks.filter((chunk) => chunk.type === 'tool-call')).toHaveLength(0);
    expect(stream.isComplete()).toBe(false);
    expect(stream.state().toolCalls).toEqual([]);
  });

  test('[DONE] after the finish reason closed the call is complete', () => {
    // The ordinary shape, and the one the exception above must not break: the call was emitted at
    // the finish reason, so nothing is pending by the time the sentinel lands.
    const { stream } = drive(TOOL_STREAM);
    expect(stream.isComplete()).toBe(true);
  });

  test('[DONE] alone still ends a text-only answer', () => {
    // The other half that must not break: a server in the family that sends `[DONE]` and never a
    // finish reason has still delivered a whole answer when no tool call is open.
    const { stream } = drive([frame({ choices: [{ delta: { content: 'hello' } }] }), DONE]);
    expect(stream.isComplete()).toBe(true);
  });
});

describe('refusals and reasoning', () => {
  test('a streamed refusal is a refusal, whatever the finish reason claims', () => {
    const { stream } = drive([
      frame({ choices: [{ delta: { refusal: 'I cannot ' } }] }),
      frame({ choices: [{ delta: { refusal: 'help with that' }, finish_reason: 'stop' }] }),
      DONE,
    ]);
    const state = stream.state();
    expect(state.stopReason).toBe('refusal');
    expect(state.stopDetails).toEqual({
      type: 'refusal',
      category: 'refusal',
      explanation: 'I cannot help with that',
    });
  });

  test('reasoning deltas are yielded as thinking and never joined onto the answer', () => {
    const { chunks, stream } = drive([
      frame({ choices: [{ delta: { reasoning_content: 'the user wants' } }] }),
      frame({ choices: [{ delta: { content: 'yes' }, finish_reason: 'stop' }] }),
      DONE,
    ]);
    expect(chunks).toEqual([
      { type: 'thinking', text: 'the user wants' },
      { type: 'text', text: 'yes' },
    ]);
    expect(stream.state().text).toBe('yes');
  });
});

describe('a non-streamed completion', () => {
  test('reads the answer, the tool call and the stop reason', () => {
    const answer = parseChatCompletion(
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'respond', arguments: '{"summary":"ok"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
      'openai',
    );
    expect(answer.stopReason).toBe('tool_use');
    expect(answer.toolCalls[0]?.input).toEqual({ summary: 'ok' });
    expect(answer.usage?.inputTokens).toBe(10);
  });

  test('a refusal field is read before anything trusts the content', () => {
    const answer = parseChatCompletion(
      { choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }] },
      'openai',
    );
    expect(answer.stopReason).toBe('refusal');
    expect(answer.stopDetails?.explanation).toBe('no');
    expect(answer.text).toBe('');
  });

  test('a content filter is a refusal, and the category says which kind', () => {
    const answer = parseChatCompletion(
      { choices: [{ message: { content: 'part' }, finish_reason: 'content_filter' }] },
      'openai',
    );
    expect(answer.stopReason).toBe('refusal');
    expect(answer.stopDetails?.category).toBe('content_filter');
  });

  test('a body with no choices is a transport failure, not an empty answer', () => {
    expect(() => parseChatCompletion({ choices: [] }, 'openai')).toThrow(/no choices/);
    expect(() => parseChatCompletion('nope', 'openai')).toThrow(/not a JSON object/);
  });
});
