import { describe, expect, test } from 'bun:test';
import { isRetryable } from './gateway';
import type { StreamChunk } from './provider';
import type { SseFrame } from './sse';
import { MessageStream, parsePartialUsage, parseStopReason, parseUsage } from './wire';

/** One SSE frame, as the API sends it: the event name is mirrored by the payload's `type`. */
function frame(payload: Record<string, unknown>): SseFrame {
  return { event: String(payload['type']), data: JSON.stringify(payload) };
}

function drive(
  message: MessageStream,
  payloads: readonly Record<string, unknown>[],
): StreamChunk[] {
  return payloads.flatMap((payload) => [...message.push(frame(payload))]);
}

const START = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    model: 'claude-opus-5',
    usage: { input_tokens: 100, cache_read_input_tokens: 40 },
  },
};

describe('usage and stop reason', () => {
  test('parseUsage zero-fills every counter the payload omits', () => {
    expect(parseUsage({ input_tokens: 7 })).toEqual({
      inputTokens: 7,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(parseUsage(undefined).inputTokens).toBe(0);
  });

  test('parsePartialUsage reports only what arrived', () => {
    expect(parsePartialUsage({ output_tokens: 3, unrelated: 9 })).toEqual({ outputTokens: 3 });
    expect(parsePartialUsage({ input_tokens: 'lots' })).toEqual({});
  });

  test('an unknown stop reason falls back to end_turn rather than widening the union', () => {
    expect(parseStopReason('refusal')).toBe('refusal');
    expect(parseStopReason('something_new')).toBe('end_turn');
  });

  test('a negative or non-finite token count is floored, never credited to the ledger', () => {
    // `MemoryBudgetStore.add` reads a negative debit as a CREDIT on purpose (that is how an
    // unspent reservation is released), so a provider — or a proxy in front of one — reporting
    // `-1` here would TOP UP the ceiling it was supposed to consume.
    expect(parsePartialUsage({ input_tokens: -5, output_tokens: -1 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(parsePartialUsage({ input_tokens: Number.NaN })).toEqual({});
    expect(parseUsage({ input_tokens: -100 }).inputTokens).toBe(0);
  });
});

describe('MessageStream', () => {
  test('yields text as it lands and assembles the final result', () => {
    const message = new MessageStream();
    const chunks = drive(message, [
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } },
      { type: 'message_stop' },
    ]);

    expect(chunks).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
    ]);
    expect(message.isComplete()).toBe(true);
    expect(message.state()).toEqual({
      text: 'Hello world',
      toolCalls: [],
      stopReason: 'end_turn',
      // Required by `StreamState`, and asserted rather than omitted: an `end_turn` that carried
      // refusal details would be a parse bug this assertion is the only thing positioned to see.
      stopDetails: undefined,
      // The closing usage must not erase the cache counters the opening one carried.
      usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 40, cacheWriteTokens: 0 },
    });
  });

  test('thinking is streamed but never joins the answer text', () => {
    const message = new MessageStream();
    const chunks = drive(message, [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    expect(chunks).toEqual([{ type: 'thinking', text: 'hmm' }]);
    expect(message.state().text).toBe('');
  });

  test('a tool call is emitted whole, once its argument fragments close', () => {
    const message = new MessageStream();
    const chunks = drive(message, [
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'publishPost' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"postId":' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"p1"}' },
      },
      { type: 'content_block_stop', index: 1 },
    ]);

    const call = { id: 'toolu_1', name: 'publishPost', input: { postId: 'p1' } };
    // Nothing is emitted mid-fragment: half of `{"postId":` is not arguments, it is a substring.
    expect(chunks).toEqual([{ type: 'tool-call', call }]);
    expect(message.state().toolCalls).toEqual([call]);
  });

  test('a tool with no arguments streams no fragments, which is {} and not a fault', () => {
    const message = new MessageStream();
    const chunks = drive(message, [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_2', name: 'ping' },
      },
      { type: 'content_block_stop', index: 0 },
    ]);
    expect(chunks).toEqual([
      { type: 'tool-call', call: { id: 'toolu_2', name: 'ping', input: {} } },
    ]);
  });

  test('ping and future event types yield nothing instead of failing', () => {
    const message = new MessageStream();
    expect(drive(message, [{ type: 'ping' }, { type: 'message_thing_from_2027' }])).toEqual([]);
    expect(message.isComplete()).toBe(false);
  });

  test('an in-band error becomes a retryable transport failure', () => {
    const message = new MessageStream();
    let thrown: unknown;
    try {
      message.push(frame({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE', status: 529 });
    // The gateway must treat "overloaded mid-stream" exactly like a 529 on the handshake.
    expect(isRetryable(thrown)).toBe(true);
  });

  test('an invalid_request_error is not retryable', () => {
    const message = new MessageStream();
    let thrown: unknown;
    try {
      message.push(
        frame({ type: 'error', error: { type: 'invalid_request_error', message: 'no' } }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(isRetryable(thrown)).toBe(false);
  });

  test('a frame whose data is not an object is a transport failure, never a silent skip', () => {
    const message = new MessageStream();
    expect(() => message.push({ event: 'message_delta', data: '{"delta":' })).toThrow(
      /unreadable "message_delta" frame/,
    );
  });

  test('an in-band error type off the prototype chain maps to no status, never a function', () => {
    // `ERROR_STATUS['constructor']` on an object literal answers the `Object` FUNCTION, where
    // `AiTransportError.status` is declared `number | undefined` — `isRetryable` then answers
    // false for what may be a 429, and the function's source lands in the operator-facing cause.
    const message = new MessageStream();
    let thrown: unknown;
    try {
      message.push(frame({ type: 'error', error: { type: 'constructor', message: 'nope' } }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });
    expect(typeof (thrown as { status: unknown }).status).not.toBe('function');
    expect((thrown as { status: unknown }).status).toBeUndefined();
    expect(String((thrown as { cause: unknown }).cause)).not.toContain('function');
  });

  test('tool arguments that never parse are a transport failure', () => {
    const message = new MessageStream();
    message.push(
      frame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't', name: 'broken' },
      }),
    );
    message.push(
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"a":' },
      }),
    );
    expect(() => message.push(frame({ type: 'content_block_stop', index: 0 }))).toThrow(
      /streamed arguments that are not JSON/,
    );
  });
});
