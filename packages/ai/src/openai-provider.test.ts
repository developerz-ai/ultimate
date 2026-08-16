/**
 * The provider end to end, over an injected `fetch` — never a live endpoint, because a test that
 * needs a key and a network is a test that gets skipped.
 *
 * Four properties matter more than the happy path, and each one is a bug this package already
 * refuses to ship elsewhere: a non-200 becomes a CODED error rather than a parse failure, a
 * `Secret` never reaches an error, a budget is reserved BEFORE the provider is touched and
 * reconciled from the provider's own counts after, and a refusal branches before the answer is
 * parsed.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx, t } from '@ultimat3/action';
import { secret } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { createGateway } from './gateway';
import { llm } from './llm';
import { modelSpec } from './models';
import { OPENAI_MODEL_IDS, registerOpenAiModels } from './openai-models';
import { openAiProvider } from './openai-provider';
import { definePrompt } from './prompt';
import { costOf, type GenerateRequest, STREAM_ONLY_MAX_TOKENS, type StreamChunk } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

const KEY = 'sk-live-do-not-log-me';
const MODEL = 'gpt-5.6-sol';

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** Records what left the process and replies with whatever the test wants back. */
function fakeFetch(calls: Call[], reply: (call: Call, index: number) => Response): typeof fetch {
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return reply(calls[calls.length - 1] as Call, calls.length - 1);
  };
  return impl as unknown as typeof fetch;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A real SSE body — the provider reads it through the same framing a socket would deliver. */
const sseResponse = (payloads: readonly unknown[]): Response =>
  new Response(
    payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const completion = (message: unknown, finish = 'stop', usage?: unknown): unknown => ({
  id: 'chatcmpl-1',
  model: MODEL,
  choices: [{ index: 0, message, finish_reason: finish }],
  ...(usage === undefined ? {} : { usage }),
});

const request = (extra: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: MODEL,
  messages: [{ role: 'user', content: 'ship it' }],
  maxTokens: 1_000,
  ...extra,
});

function provider(reply: (call: Call, index: number) => Response, calls: Call[] = []) {
  return {
    calls,
    provider: openAiProvider({
      apiKey: secret(KEY, 'OPENAI_API_KEY'),
      models: [...OPENAI_MODEL_IDS],
      fetch: fakeFetch(calls, reply),
    }),
  };
}

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = [];
  for await (const chunk of chunks) seen.push(chunk);
  return seen;
}

beforeEach(() => {
  // `resetModels()` in another suite clears the whole registry, this provider's specs included.
  registerOpenAiModels();
  resetAiRuntime();
});

describe('failures arrive coded', () => {
  test('a non-200 is X_AI_PROVIDER_UNAVAILABLE carrying its status, not a parse failure', async () => {
    const { provider: openai } = provider(() =>
      jsonResponse({ error: { message: 'model not found', type: 'invalid_request_error' } }, 404),
    );

    await expect(openai.generate(request())).rejects.toMatchObject({
      code: 'X_AI_PROVIDER_UNAVAILABLE',
      status: 404,
    });
  });

  test('a 200 carrying an error object never reads as an empty successful answer', async () => {
    const { provider: openai } = provider(() =>
      jsonResponse({ error: { message: 'upstream is down', type: 'server_error' } }),
    );
    await expect(openai.generate(request())).rejects.toMatchObject({ status: 500 });
  });

  test('the missing-key throw names the variable THIS provider reads', async () => {
    const openai = openAiProvider({
      apiKey: '',
      models: [MODEL],
      fetch: fakeFetch([], () => jsonResponse({})),
    });
    await expect(openai.generate(request())).rejects.toMatchObject({
      code: 'X_AI_KEY_MISSING',
      meta: { envVar: 'OPENAI_API_KEY' },
    });
  });

  test('an empty models list is refused at construction, not at the first call', () => {
    expect(() => openAiProvider({ apiKey: KEY, models: [] })).toThrow(/models/);
  });
});

describe('the credential', () => {
  /**
   * The one path by which a key reaches an error: a proxy that echoes the request headers into its
   * own 4xx body. `error-render`'s check cannot see it — the detail is a `string`, not an
   * `unknown` — and an error's cause reaches a log index, a span and an HTTP problem document.
   */
  test('never appears in a thrown error, even when the endpoint echoes it back', async () => {
    const { provider: openai } = provider(() =>
      jsonResponse({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401),
    );

    const error = await openai.generate(request()).catch((e: unknown) => e);
    const rendered = JSON.stringify({
      cause: (error as { cause?: unknown }).cause,
      fix: (error as { fix?: unknown }).fix,
      meta: (error as { meta?: unknown }).meta,
    });
    expect(rendered).not.toContain(KEY);
    expect(rendered).toContain('[redacted]');
    // And the fix names the right variable — a hardcoded ANTHROPIC_API_KEY sent an operator to
    // set something this provider never reads.
    expect(rendered).toContain('OPENAI_API_KEY');
  });

  test('rides in Authorization by default and in api-key when Azure is the endpoint', async () => {
    const bearer = provider(() => jsonResponse(completion({ content: 'ok' })));
    await bearer.provider.generate(request());
    expect(bearer.calls[0]?.headers['authorization']).toBe(`Bearer ${KEY}`);

    const calls: Call[] = [];
    const azure = openAiProvider({
      apiKey: secret(KEY),
      auth: 'api-key',
      baseUrl: 'https://acme.openai.azure.com/openai/deployments/prod?api-version=2026-05-01',
      models: [MODEL],
      headers: { 'x-tenant': 'acme' },
      fetch: fakeFetch(calls, () => jsonResponse(completion({ content: 'ok' }))),
    });
    await azure.generate(request());

    expect(calls[0]?.headers['api-key']).toBe(KEY);
    expect(calls[0]?.headers['authorization']).toBeUndefined();
    expect(calls[0]?.headers['x-tenant']).toBe('acme');
    // The query survives the path append. Swallowed, it is a 404 whose cause reads like a wrong
    // deployment name.
    expect(calls[0]?.url).toBe(
      'https://acme.openai.azure.com/openai/deployments/prod/chat/completions?api-version=2026-05-01',
    );
  });

  test('a local endpoint is one field: the base URL', async () => {
    const calls: Call[] = [];
    const ollama = openAiProvider({
      apiKey: 'ollama',
      baseUrl: 'http://localhost:11434/v1/',
      models: [MODEL],
      fetch: fakeFetch(calls, () => jsonResponse(completion({ content: 'ok' }))),
    });
    await ollama.generate(request());
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
  });
});

describe('pricing', () => {
  /**
   * The whole reason `ModelId` became open and `costOf` reads the registry: an OpenAI-format model
   * priced at Anthropic's list is a budget ledger that is confidently wrong in both directions.
   */
  test('a registered OpenAI model is priced by ITS spec, never the default model’s', async () => {
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
    const { provider: openai } = provider(() =>
      jsonResponse(completion({ content: 'ok' }, 'stop', usage)),
    );

    const result = await openai.generate(request());
    const counted = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(result.cost).toEqual(costOf(MODEL, counted));
    // $5 + $30 per MTok, in minor units — and pointedly not claude-opus-5's $5 + $25.
    expect(result.cost).toEqual({ minor: 3_500, currency: 'USD' });
    expect(result.cost).not.toEqual(costOf('claude-opus-5', counted));
  });

  test('an endpoint that reports no usage is estimated, never billed as free', async () => {
    const { provider: openai } = provider(() => jsonResponse(completion({ content: 'a b c d' })));
    const result = await openai.generate(request());
    // Zero would refund the whole reservation for a call that really happened.
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
});

describe('streaming', () => {
  test('reassembles a fragmented tool call and reconciles usage from the last chunk', async () => {
    const { provider: openai, calls } = provider(() =>
      sseResponse([
        { choices: [{ delta: { content: 'thinking' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'respond', arguments: '{"ok"' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':true}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 25 } },
        '[DONE]',
      ]),
    );

    const chunks = await collect(openai.stream(request()));
    const done = chunks.at(-1);

    expect(calls[0]?.body['stream_options']).toEqual({ include_usage: true });
    expect(chunks.filter((c) => c.type === 'tool-call')).toHaveLength(1);
    expect(done).toMatchObject({
      type: 'done',
      result: {
        toolCalls: [{ id: 'call_1', name: 'respond', input: { ok: true } }],
        usage: { inputTokens: 100, outputTokens: 25 },
      },
    });
  });

  test('a stream cut before its finish reason throws rather than returning a partial', async () => {
    const { provider: openai } = provider(() =>
      sseResponse([{ choices: [{ delta: { content: 'half an ans' } }] }]),
    );
    await expect(collect(openai.stream(request()))).rejects.toMatchObject({
      code: 'X_AI_PROVIDER_UNAVAILABLE',
    });
  });

  test('a completion too large for one socket takes the streaming transport by itself', async () => {
    const maxTokens = STREAM_ONLY_MAX_TOKENS + 1;
    expect(modelSpec(MODEL).maxOutput).toBeGreaterThan(maxTokens);
    const { provider: openai, calls } = provider(() =>
      sseResponse([
        { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } },
        '[DONE]',
      ]),
    );

    const result = await openai.generate(request({ maxTokens }));
    expect(calls[0]?.body['stream']).toBe(true);
    expect(result.text).toBe('ok');
  });
});

describe('the budget survives the new provider', () => {
  test('is reserved BEFORE the provider is touched — nothing is sent, nothing is spent', async () => {
    const calls: Call[] = [];
    const openai = openAiProvider({
      apiKey: KEY,
      models: [MODEL],
      fetch: fakeFetch(calls, () => jsonResponse(completion({ content: 'ok' }))),
    });
    const gateway = createGateway({ providers: [openai], budget: { request: 10 } });

    await expect(
      gateway.scope({ actorKey: 'user-1' }, () => gateway.generate(request())),
    ).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    expect(calls).toHaveLength(0);
  });

  test("is reconciled afterwards from the endpoint's own counts, not from the estimate", async () => {
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
    const openai = openAiProvider({
      apiKey: KEY,
      models: [MODEL],
      fetch: fakeFetch([], () => jsonResponse(completion({ content: 'ok' }, 'stop', usage))),
    });
    const gateway = createGateway({ providers: [openai] });

    const spent = await gateway.scope({ actorKey: 'user-1' }, async () => {
      await gateway.generate(request());
      return gateway.spent();
    });
    expect(spent).toEqual({ minor: 3_500, currency: 'USD' });
  });
});

describe('through llm()', () => {
  const Output = t.object({ summary: t.string });

  function summarizer() {
    return llm({
      input: t.object({ postId: t.string }),
      output: Output,
      prompt: definePrompt<{ postId: string }>({
        id: `openai-summarize-${Math.random().toString(36).slice(2)}`,
        version: '1.0.0',
        template: 'Summarise post {{postId}}.',
        model: MODEL,
      }),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
    }).named('summarizeWithOpenAi');
  }

  test('the respond tool round-trips: schema out as a function, answer back as its arguments', async () => {
    const calls: Call[] = [];
    const openai = openAiProvider({
      apiKey: KEY,
      models: [MODEL],
      fetch: fakeFetch(calls, () =>
        jsonResponse(
          completion(
            {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'respond', arguments: '{"summary":"a post about caching"}' },
                },
              ],
            },
            'tool_calls',
          ),
        ),
      ),
    });
    configureAi({ gateway: createGateway({ providers: [openai] }) });

    const answer = await summarizer()({ postId: 'p-1' }, { ctx: anonymousCtx() });

    expect(answer).toEqual({ summary: 'a post about caching' });
    const tools = calls[0]?.body['tools'] as readonly { function: { name: string } }[];
    expect(tools[0]?.function.name).toBe('respond');
    expect(calls[0]?.body['tool_choice']).toEqual({
      type: 'function',
      function: { name: 'respond' },
    });
  });

  /**
   * A refusal is a 200 with no answer in it. Parsed first it reports a schema disagreement — the
   * wrong cause, an inapplicable fix, and a repair turn that buys the same refusal again.
   */
  test('a refusal branches before the answer is parsed, and buys no repair turn', async () => {
    const calls: Call[] = [];
    const openai = openAiProvider({
      apiKey: KEY,
      models: [MODEL],
      fetch: fakeFetch(calls, () =>
        jsonResponse(completion({ content: null, refusal: 'I will not do that' })),
      ),
    });
    configureAi({ gateway: createGateway({ providers: [openai] }) });

    await expect(summarizer()({ postId: 'p-1' }, { ctx: anonymousCtx() })).rejects.toMatchObject({
      code: 'X_LLM_REFUSED',
    });
    expect(calls).toHaveLength(1);
  });
});
