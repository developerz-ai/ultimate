// The Anthropic provider's response half: SSE streaming, the stream-only ceiling, and message
// parsing. The request half is `provider.test.ts`.
import { describe, expect, test } from 'bun:test';
import { createGateway } from './gateway';
import {
  AnthropicProvider,
  costOf,
  parseMessage,
  requiresStreaming,
  STREAM_ONLY_MAX_TOKENS,
} from './provider';
import { type Call, collect, fakeFetch, STREAM_EVENTS, sseResponse } from './provider-fixture';

describe('streaming', () => {
  test('asks for an event stream and yields text as it arrives, then the assembled result', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(calls, () => sseResponse(STREAM_EVENTS)),
    });

    const chunks = await collect(
      remote.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 }),
    );

    expect(calls[0]?.body['stream']).toBe(true);
    expect(calls[0]?.headers['accept']).toBe('text/event-stream');
    expect(chunks.slice(0, 2)).toEqual([
      { type: 'text', text: 'ship ' },
      { type: 'text', text: 'it' },
    ]);

    const done = chunks.at(-1);
    const usage = {
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(done).toEqual({
      type: 'done',
      result: {
        model: 'claude-opus-5',
        text: 'ship it',
        toolCalls: [],
        stopReason: 'end_turn',
        // Required by `GenerateResult`: absent details on a non-refusal stop is the fact,
        // not a gap in the fixture.
        stopDetails: undefined,
        usage,
        cost: costOf('claude-opus-5', usage),
      },
    });
  });

  test('a stream cut before message_stop fails instead of returning the partial answer', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(calls, () => sseResponse(STREAM_EVENTS.slice(0, 4))),
    });

    await expect(
      collect(remote.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 })),
    ).rejects.toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });
  });

  test('a streamed budget is debited from the final chunk, not the estimate', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(calls, () => sseResponse(STREAM_EVENTS)),
    });
    const gateway = createGateway({ providers: [remote] });

    const spent = await gateway.scope({ actorKey: 'actor-1' }, async () => {
      await collect(gateway.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 }));
      return gateway.spent();
    });

    expect(spent).toEqual(
      costOf('claude-opus-5', {
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );
  });
});

describe('a completion too large for one response', () => {
  test('generate above the ceiling goes over the streaming transport and assembles the result', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(calls, () => sseResponse(STREAM_EVENTS)),
    });

    // A non-streaming request this large hits the HTTP timeout after paying for the whole
    // completion, and `llm()` has no streaming path — so the transport switches, not the API.
    const maxTokens = STREAM_ONLY_MAX_TOKENS + 1;
    expect(requiresStreaming({ messages: [], maxTokens })).toBe(true);

    const result = await remote.generate({
      messages: [{ role: 'user', content: 'write a long thing' }],
      maxTokens,
    });

    expect(calls[0]?.body['stream']).toBe(true);
    expect(calls[0]?.headers['accept']).toBe('text/event-stream');
    expect(result.text).toBe('ship it');
    expect(result.stopReason).toBe('end_turn');
  });

  test('the ceiling is read after the model clamp, so a request no model can exceed does not stream', () => {
    // 500k clamps to haiku's 64k, which is still over the ceiling; 8k is not.
    expect(requiresStreaming({ model: 'claude-haiku-4-5', messages: [], maxTokens: 500_000 })).toBe(
      true,
    );
    expect(requiresStreaming({ messages: [], maxTokens: 8_000 })).toBe(false);
  });
});

describe('response parsing', () => {
  test('a refusal is a successful response with a refusal stop reason', () => {
    const result = parseMessage('claude-opus-5', {
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' },
      usage: { input_tokens: 12, output_tokens: 0 },
    });
    // Callers must branch on stopReason before reading text — content may be empty.
    expect(result.stopReason).toBe('refusal');
    expect(result.text).toBe('');
    // The category is the one thing that says whether another model would answer.
    expect(result.stopDetails).toEqual({
      type: 'refusal',
      category: 'cyber',
      explanation: 'declined',
    });
  });

  test('stop details are absent on every other stop reason, and survive an unknown category', () => {
    const ok = parseMessage('claude-opus-5', {
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(ok.stopDetails).toBeUndefined();

    // The category set is open: a new one is information, not a parse failure.
    const novel = parseMessage('claude-opus-5', {
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'something-new-2027' },
      usage: {},
    });
    expect(novel.stopDetails?.category).toBe('something-new-2027');
    expect(novel.stopDetails?.explanation).toBeUndefined();
  });

  test('a streamed refusal carries its details too, not just the reason', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(calls, () =>
        sseResponse([
          { type: 'message_start', message: { usage: { input_tokens: 9 } } },
          {
            type: 'message_delta',
            delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio' } },
            usage: { output_tokens: 0 },
          },
          { type: 'message_stop' },
        ]),
      ),
    });

    const chunks = await collect(
      remote.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 }),
    );
    const done = chunks.at(-1);
    expect(done?.type).toBe('done');
    expect(done?.type === 'done' && done.result.stopDetails).toEqual({
      type: 'refusal',
      category: 'bio',
      explanation: undefined,
    });
  });

  test('text and tool_use blocks are separated, and usage drives cost', () => {
    const result = parseMessage('claude-opus-5', {
      content: [
        { type: 'text', text: 'calling a tool' },
        { type: 'tool_use', id: 'toolu_1', name: 'publishPost', input: { postId: 'p1' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    });
    expect(result.text).toBe('calling a tool');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'publishPost', input: { postId: 'p1' } },
    ]);
    expect(result.cost).toEqual({ minor: 500, currency: 'USD' });
  });
});
