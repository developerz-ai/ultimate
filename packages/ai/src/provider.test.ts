import { describe, expect, test } from 'bun:test';
import { createGateway, isRetryable } from './gateway';
import { AnthropicProvider, costOf, MODELS, parseMessage, type StreamChunk } from './provider';

const provider = new AnthropicProvider();

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** Records what left the process and replies with whatever the test wants back. */
function fakeFetch(calls: Call[], reply: (call: Call, index: number) => Response): typeof fetch {
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(call);
    return reply(call, calls.length - 1);
  };
  return impl as unknown as typeof fetch;
}

/** A real SSE body — the provider reads it through the same framing a socket would deliver. */
function sseResponse(events: readonly Record<string, unknown>[]): Response {
  const text = events
    .map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const STREAM_EVENTS: readonly Record<string, unknown>[] = [
  {
    type: 'message_start',
    message: { id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 100 } },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ship ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'it' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } },
  { type: 'message_stop' },
];

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = [];
  for await (const chunk of chunks) seen.push(chunk);
  return seen;
}

describe('Anthropic request body', () => {
  test('never sends sampling parameters or a thinking budget', () => {
    const body = provider.body({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1_000,
    });
    // All three are rejected with a 400 on every current model. Encoded, not documented.
    expect(body['temperature']).toBeUndefined();
    expect(body['top_p']).toBeUndefined();
    expect(body['top_k']).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
  });

  test('effort lives inside output_config and thinking defaults to adaptive', () => {
    const body = provider.body({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1_000,
      effort: 'xhigh',
    });
    expect(body['output_config']).toEqual({ effort: 'xhigh' });
    expect(body['effort']).toBeUndefined();
    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  test('disabling thinking above high effort is refused locally, not by a 400', () => {
    expect(() =>
      provider.body({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1_000,
        effort: 'max',
        thinking: 'disabled',
      }),
    ).toThrow();
    const ok = provider.body({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1_000,
      effort: 'high',
      thinking: 'disabled',
    });
    expect(ok['thinking']).toEqual({ type: 'disabled' });
  });

  test('max_tokens is clamped to the model ceiling', () => {
    const body = provider.body({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 500_000,
    });
    expect(body['max_tokens']).toBe(MODELS['claude-haiku-4-5'].maxOutput);
  });

  test('a remote call without a key throws X_AI_KEY_MISSING naming the env var', async () => {
    // An explicit empty key, so the result does not depend on the developer's own environment.
    const keyless = new AnthropicProvider({ apiKey: '' });
    await expect(
      keyless.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 }),
    ).rejects.toMatchObject({ code: 'X_AI_KEY_MISSING' });
    await expect(
      collect(keyless.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 })),
    ).rejects.toMatchObject({ code: 'X_AI_KEY_MISSING' });
  });
});

describe('transport', () => {
  test('generate posts a non-streaming body to the Messages endpoint and parses the reply', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'sk-ant-test',
      fetch: fakeFetch(calls, () =>
        Response.json({
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
      ),
    });

    const result = await remote.generate({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
    });

    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe('sk-ant-test');
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]?.headers['accept']).toBe('application/json');
    expect(calls[0]?.body['stream']).toBe(false);
    expect(result.text).toBe('hi');
    expect(result.usage.inputTokens).toBe(4);
  });

  test('a non-2xx carries its status, so the gateway can tell momentary from permanent', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(calls, () =>
        Response.json(
          { error: { type: 'rate_limit_error', message: 'slow down' } },
          { status: 429 },
        ),
      ),
    });

    const failure = await remote
      .generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE', status: 429 });
    // The provider's own words, not a generic "request failed".
    expect(String(failure)).toContain('slow down');
    expect(isRetryable(failure)).toBe(true);
  });

  test('a 400 is never retried — the same body earns the same rejection', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(calls, () => new Response('max_tokens too large', { status: 400 })),
    });

    const failure = await remote
      .generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 })
      .catch((error: unknown) => error);

    expect(isRetryable(failure)).toBe(false);
    expect((failure as { fix: string }).fix).toContain('fix the request');
  });

  test('the gateway retries a 429 and succeeds on the attempt that lands', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(calls, (_call, index) =>
        index < 2
          ? new Response('{}', { status: 429 })
          : Response.json({
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
      ),
    });
    const gateway = createGateway({ providers: [remote], sleep: async () => undefined });

    const result = await gateway.generate({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
    });

    expect(result.text).toBe('ok');
    expect(calls).toHaveLength(3);
  });
});

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

describe('response parsing', () => {
  test('a refusal is a successful response with a refusal stop reason', () => {
    const result = parseMessage('claude-opus-5', {
      content: [],
      stop_reason: 'refusal',
      usage: { input_tokens: 12, output_tokens: 0 },
    });
    // Callers must branch on stopReason before reading text — content may be empty.
    expect(result.stopReason).toBe('refusal');
    expect(result.text).toBe('');
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
