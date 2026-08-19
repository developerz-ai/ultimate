/**
 * `.stream()` is the SAME action over a different transport. The failures first: a stream that
 * bypassed the policy, or that hit the provider before the budget refused it, would be exactly
 * the loss that made a support-agent feature reach past `llm()` to the raw gateway.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx, t } from '@ultimat3/action';
import { createContext } from '@ultimat3/core';
import { allow, deny } from '@ultimat3/policy';
import { BudgetLedger, withBudget } from './budget';
import { createGateway } from './gateway';
import { llm } from './llm';
import type { LlmStreamChunk } from './llm-stream';
import { definePrompt, type Prompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, StreamChunk } from './provider';
import { costOf, EchoProvider } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

const Input = t.object({ postId: t.uuid });
const Prose = t.string;
const Structured = t.object({ summary: t.string });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

const USAGE = { inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Streams `words` one chunk at a time, then a `done` carrying their concatenation. */
function streamer(text: string): { provider: Provider; seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  const provider: Provider = {
    name: 'streamer',
    models: ['claude-opus-5'],
    generate: () => Promise.reject(new Error('the streaming path must not call generate')),
    async *stream(request): AsyncIterable<StreamChunk> {
      seen.push(request);
      yield { type: 'thinking', text: 'weighing it up' };
      for (const word of text.split(' ')) yield { type: 'text', text: `${word} ` };
      const result: GenerateResult = {
        model: request.model ?? 'claude-opus-5',
        text,
        toolCalls: [],
        stopReason: 'end_turn',
        stopDetails: undefined,
        usage: USAGE,
        cost: costOf('claude-opus-5', USAGE),
      };
      yield { type: 'done', result };
    },
  };
  return { provider, seen };
}

let seq = 0;
function promptFor(): Prompt<{ postId: string }> {
  seq += 1;
  return definePrompt<{ postId: string }>({
    id: `stream-${seq}`,
    version: '1.0.0',
    template: 'Summarise post {{postId}}.',
  });
}

async function collect<T>(stream: AsyncIterable<LlmStreamChunk<T>>): Promise<LlmStreamChunk<T>[]> {
  const chunks: LlmStreamChunk<T>[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

beforeEach(() => {
  resetAiRuntime();
  seq += 1;
});

describe('.stream() keeps everything llm() is for', () => {
  test('a denial happens before the provider is reached — the whole reason it is not a raw gateway call', async () => {
    const { provider, seen } = streamer('nope');
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const summarize = llm({
      input: Input,
      output: Prose,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: deny('not for you'),
    }).named('deniedStream');

    await expect(
      collect(summarize.stream({ postId: POST_ID }, { ctx: anonymousCtx() })),
    ).rejects.toMatchObject({ code: 'X_FORBIDDEN' });
    expect(seen.length).toBe(0);
  });

  test('the budget still refuses BEFORE a token is spent', async () => {
    const { provider, seen } = streamer('a long answer');
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const summarize = llm({
      input: Input,
      output: Prose,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
      budget: { tokensIn: 1 },
    }).named('budgetedStream');

    await withBudget(new BudgetLedger({ limits: {} }), async () => {
      await expect(
        collect(summarize.stream({ postId: POST_ID }, { ctx: anonymousCtx() })),
      ).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    });
    expect(seen.length).toBe(0);
  });

  test('yields increments, then one done carrying the validated value', async () => {
    const { provider, seen } = streamer('a post about caching');
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const summarize = llm({
      input: Input,
      output: Prose,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
    }).named('proseStream');

    const chunks = await collect(summarize.stream({ postId: POST_ID }, { ctx: anonymousCtx() }));
    expect(chunks.filter((c) => c.type === 'text').length).toBe(4);
    // Reasoning is its own kind and never folded into `text` — a consumer concatenating text
    // must not end up shipping the model's thinking to the user.
    expect(chunks.filter((c) => c.type === 'thinking').length).toBe(1);
    const last = chunks.at(-1);
    expect(last?.type).toBe('done');
    // The VALUE is the assembled answer the `done` frame carried, not the deltas concatenated:
    // a consumer that re-joins the increments is reconstructing what the provider already sent.
    expect(last?.type === 'done' ? last.value : undefined).toBe('a post about caching');
    // No `respond` tool: a tool call arrives whole, so forcing one leaves nothing to stream.
    expect(seen[0]?.tools).toBeUndefined();
  });

  test('an object output is satisfied by the JSON the stream assembled', async () => {
    const { provider } = streamer('{"summary": "caching"}');
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const summarize = llm({
      input: Input,
      output: Structured,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
    }).named('jsonStream');

    const chunks = await collect(summarize.stream({ postId: POST_ID }, { ctx: anonymousCtx() }));
    const last = chunks.at(-1);
    expect(last?.type === 'done' ? last.value : undefined).toEqual({ summary: 'caching' });
  });

  // The decision this file's header states: a stream cannot take a repair turn, so it says so
  // with its own code instead of reporting a repair that never happened.
  test('an answer that fails its schema is X_LLM_STREAM_INVALID, never a silent repair', async () => {
    const { provider } = streamer('just some prose');
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const summarize = llm({
      input: Input,
      output: Structured,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
    }).named('invalidStream');

    await expect(
      collect(summarize.stream({ postId: POST_ID }, { ctx: anonymousCtx() })),
    ).rejects.toMatchObject({ code: 'X_LLM_STREAM_INVALID' });
  });

  test('nothing is sent until the first pull', async () => {
    const { provider, seen } = streamer('unread');
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const summarize = llm({
      input: Input,
      output: Prose,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
    }).named('lazyStream');

    summarize.stream({ postId: POST_ID }, { ctx: anonymousCtx() });
    await Promise.resolve();
    expect(seen.length).toBe(0);
  });

  test("the caller's signal reaches the streamed request, inherited from the same base", async () => {
    // The stream is where a disconnect is most likely and most expensive: the consumer stops
    // pulling, and without a signal the socket stays open and the tokens keep being billed.
    const { provider, seen } = streamer('a summary');
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const summarize = llm({
      input: Input,
      output: Prose,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
    }).named('cancellableStream');
    const controller = new AbortController();

    await collect(
      summarize.stream({ postId: POST_ID }, { ctx: createContext({ signal: controller.signal }) }),
    );

    expect(seen[0]?.signal).toBe(controller.signal);
  });

  test('a renamed twin still streams — named() rebuilds the action, and would have dropped it', () => {
    configureAi({ gateway: createGateway({ providers: [new EchoProvider()] }) });
    const summarize = llm({
      input: Input,
      output: Prose,
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      policy: allow(),
    })
      .named('once')
      .named('twice');
    expect(typeof summarize.stream).toBe('function');
    expect(summarize.name).toBe('twice');
  });
});
