// `llm()` declares `stream`, so its OWN route answers `text/event-stream`: the answer's text as
// chunks, then `done` with the value. A JSON caller still gets the repairing non-streamed call, and
// a token reaches the reader while the provider is still holding the rest.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { FetchLike } from '@ultimat3/action';
import { rpc, toRoute } from '@ultimat3/action';
import { userActor } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { providerGateway } from './gateway';
import { llm } from './llm';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import type { GenerateResult, Provider, StreamChunk } from './provider';
import { costOf } from './provider';
import { installAiGateway, resetAiRuntime } from './runtime';
import { scriptedProvider } from './scripted-provider';

useFixtureModels();

let seq = 0;
function summarize(policy = allow('posts:summarize')) {
  seq += 1;
  return llm({
    input: t.object({ postId: t.string }),
    output: t.string,
    prompt: definePrompt<{ postId: string }>({
      id: `route-stream-${seq}`,
      version: '1.0.0',
      template: 'Summarise {{postId}}.',
    }),
    vars: ({ input }) => ({ postId: input.postId }),
    policy,
  }).named(`summarizeRoute${seq}`);
}

function fetchFor(target: ReturnType<typeof summarize>, signedIn = true): FetchLike {
  const server = httpServer({
    routes: [toRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => (signedIn ? userActor({ id: 'u1' }) : null) },
  });
  return (url, init) =>
    server.fetch(
      new Request(url, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), origin: 'http://dev.test' },
      }),
    );
}

const USAGE = { inputTokens: 5, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Streams two words with a gate between them, then `done`. Thinking first: it must not cross. */
function heldProvider(held: Promise<void>): Provider {
  return {
    name: 'held',
    models: [FIXTURE_MODEL],
    generate: () => Promise.reject(new Error('a reader of the chunks streams; generate is unused')),
    async *stream(request): AsyncIterable<StreamChunk> {
      yield { type: 'thinking', text: 'private reasoning' };
      yield { type: 'text', text: 'Hello ' };
      await held;
      yield { type: 'text', text: 'world' };
      const result: GenerateResult = {
        model: request.model ?? FIXTURE_MODEL,
        text: 'Hello world',
        toolCalls: [],
        stopReason: 'end_turn',
        stopDetails: undefined,
        usage: USAGE,
        cost: costOf(FIXTURE_MODEL, USAGE),
      };
      yield { type: 'done', result };
    },
  };
}

beforeEach(() => {
  resetAiRuntime();
});

describe('llm() over its own route', () => {
  test('the first token reaches the typed client before the provider has finished', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    installAiGateway(
      providerGateway({ defaultModel: FIXTURE_MODEL, providers: [heldProvider(held)] }),
    );
    const target = summarize();
    const method = target.client({ baseUrl: 'http://dev.test', fetch: fetchFor(target) });
    const stream = method.stream({ postId: 'p1' });
    // Read while the provider is still parked on `held`: a buffered route would never answer.
    expect(await stream.next()).toEqual({ done: false, value: { type: 'text', text: 'Hello ' } });
    release();
    expect(await stream.next()).toEqual({ done: false, value: { type: 'text', text: 'world' } });
    expect(await stream.next()).toEqual({ done: true, value: 'Hello world' });
  });

  test('a JSON caller gets the drained, non-streamed call — the respond tool, not the stream', async () => {
    const provider = scriptedProvider({ turns: [{ answer: { value: 'a summary' } }] });
    installAiGateway(providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] }));
    const target = summarize();
    const api = rpc<{ summarize: typeof target }>({
      baseUrl: 'http://dev.test',
      fetch: fetchFor(target),
    });
    const viaPin = target.client({ baseUrl: 'http://dev.test', fetch: fetchFor(target) });
    expect(await viaPin({ postId: 'p1' })).toBe('a summary');
    // The non-streamed request offers `respond`; a streamed one offers no tool at all.
    expect(provider.seen[0]?.tools?.length).toBe(1);
    expect(typeof api.summarize.stream).toBe('function');
  });

  test('a caller the policy refuses never reaches the provider, streamed or not', async () => {
    const provider = scriptedProvider({ turns: [] });
    installAiGateway(providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] }));
    const target = summarize(can('posts:summarize'));
    const method = target.client({
      baseUrl: 'http://dev.test',
      fetch: fetchFor(target, false),
    });
    const failure = await method
      .stream({ postId: 'p1' })
      .next()
      .then(
        () => expect.unreachable('a refused caller must not stream'),
        (error: unknown) => error,
      );
    expect((failure as { code?: unknown }).code).toBe('X_UNAUTHENTICATED');
    expect(provider.seen).toHaveLength(0);
  });
});
