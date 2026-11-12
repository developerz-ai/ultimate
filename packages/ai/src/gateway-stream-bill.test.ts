// A stream that does not reach `done` still costs what the provider billed: abandoned, cut or
// aborted after the first provider byte, the gateway records the running usage the wire reported
// (`stream-bill.ts`); one aborted after its request was sent records the prompt; only a stream
// never sent, or refused by the provider, releases its reservation.

import { describe, expect, test } from 'bun:test';
import { currentBudget } from './budget';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, FIXTURE_OPENAI_IDS, useFixtureModels } from './model-fixture';
import { openAiProvider } from './openai-provider';
import type { Provider } from './provider';
import { anthropicProvider } from './provider';
import { fakeFetch } from './provider-fixture';

useFixtureModels();

const sse = (events: readonly Record<string, unknown>[]): string =>
  events.map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const HEAD = [
  { type: 'message_start', message: { id: 'm', usage: { input_tokens: 1_000, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(400) } },
];
const TAIL = [
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'more' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 120 } },
  { type: 'message_stop' },
];

/** A body that delivers `head`, then fails the read as a cut socket or an abort would. */
function failingBody(head: string, failure: unknown): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
    },
    pull(controller) {
      controller.error(failure);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const anthropic = (reply: () => Response): Provider =>
  anthropicProvider({ models: [FIXTURE_MODEL], apiKey: 'k', fetch: fakeFetch([], reply) });

/** Run `consume` over one gateway stream in a scope; what the scope's ledger was debited. */
async function tokensAfter(
  provider: Provider,
  consume: (stream: AsyncIterable<unknown>) => Promise<void>,
  model: string = FIXTURE_MODEL,
): Promise<{ tokens: number; minor: number }> {
  const gateway = providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] });
  return gateway.scope({}, async () => {
    await consume(
      gateway.stream({ model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 4_000 }),
    ).catch(() => undefined);
    const report = await currentBudget()?.report();
    return { tokens: report?.requestTokens ?? -1, minor: report?.costExact.minor ?? -1 };
  });
}

const breakAfterFirst = async (stream: AsyncIterable<unknown>): Promise<void> => {
  for await (const _chunk of stream) break;
};
const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
  for await (const _chunk of stream) {
    // drained
  }
};

describe('an Anthropic stream that never reaches done', () => {
  test('abandoned after one delta: the input from message_start and the streamed output are recorded', async () => {
    const spent = await tokensAfter(
      anthropic(() => new Response(sse([...HEAD, ...TAIL]))),
      breakAfterFirst,
    );
    // 1,000 input + ~100 output estimated from the 400 characters streamed.
    expect(spent.tokens).toBe(1_100);
    expect(spent.minor).toBeGreaterThan(0);
  });

  test('cut mid-answer: the throw carries no bill, the running usage is recorded', async () => {
    const spent = await tokensAfter(
      anthropic(() => new Response(sse(HEAD))),
      drain,
    );
    expect(spent.tokens).toBe(1_100);
  });

  test('aborted mid-read after message_start: recorded', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const spent = await tokensAfter(
      anthropic(() => failingBody(sse(HEAD), abort)),
      drain,
    );
    expect(spent.tokens).toBe(1_100);
  });

  test('aborted before any provider byte, after the request was sent: the prompt is recorded', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const spent = await tokensAfter(
      anthropic(() => failingBody('', abort)),
      drain,
    );
    // `hi` is one token at the gateway's estimate; the provider read it, and bills it.
    expect(spent.tokens).toBe(1);
    expect(spent.minor).toBeGreaterThan(0);
  });

  test('a stream that reaches done records the provider counts, not the running estimate', async () => {
    const spent = await tokensAfter(
      anthropic(() => new Response(sse([...HEAD, ...TAIL]))),
      drain,
    );
    expect(spent.tokens).toBe(1_120);
  });
});

describe('an OpenAI-format stream that never reaches done', () => {
  const MODEL = FIXTURE_OPENAI_IDS[0];
  const delta = (content: string): string =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
  const openai = (reply: () => Response): Provider =>
    openAiProvider({ models: [MODEL], apiKey: 'k', fetch: fakeFetch([], reply) });

  test('abandoned after one delta: the prompt is estimated, the streamed output counted', async () => {
    const spent = await tokensAfter(
      openai(() => new Response(delta('y'.repeat(40)) + delta('z'))),
      breakAfterFirst,
      MODEL,
    );
    // No usage frame arrived: the prompt's estimate (`hi` is one token) plus 10 streamed tokens.
    expect(spent.tokens).toBe(11);
  });

  test('a stream with no content frame yet, its request sent, records the prompt', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const spent = await tokensAfter(
      openai(() => failingBody('', abort)),
      drain,
      MODEL,
    );
    expect(spent.tokens).toBe(1);
  });

  test('a stream refused by the provider before any frame is released', async () => {
    // A 4xx is no abort and bills nothing: the request was sent, but never generated against.
    const spent = await tokensAfter(
      openai(() => new Response('{"error":{"message":"bad key"}}', { status: 401 })),
      drain,
      MODEL,
    );
    expect(spent).toEqual({ tokens: 0, minor: 0 });
  });
});
