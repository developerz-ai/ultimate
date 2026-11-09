// What one `llm()` call reports: an `ai.llm` event per call — answered, cached or failed — and a
// client span carrying OpenTelemetry's gen_ai names, never the legacy `llm.*` spellings.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx } from '@ultimat3/action';
import type { AiLlmEvent, ReadableSpan } from '@ultimat3/core';
import { resetInstrumentation, resetTelemetry, SEMCONV, subscribe } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import {
  ANSWER,
  ctxFor,
  declare,
  install,
  POST_ID,
  promptFor,
  stub,
  times,
  USAGE,
} from './llm-fixture';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { resetAiRuntime } from './runtime';

useFixtureModels();

let events: AiLlmEvent[] = [];
let spans: ReadableSpan[] = [];

beforeEach(() => {
  resetAiRuntime();
  resetTelemetry();
  events = [];
  spans = [];
  subscribe('ai.llm', (event) => events.push(event.payload));
  subscribe('span.end', (event) => spans.push(event.payload));
});

afterEach(resetInstrumentation);

describe('ai.llm', () => {
  test('an answered call reports its provider, model and token usage once', async () => {
    install(stub(ANSWER).provider);
    await declare(promptFor())({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });

    expect(events).toHaveLength(1);
    expect(events[0]?.provider).toBe('stub');
    expect(events[0]?.model).toBe(FIXTURE_MODEL);
    expect(events[0]?.inputTokens).toBe(USAGE.inputTokens);
    expect(events[0]?.outputTokens).toBe(USAGE.outputTokens);
    expect(events[0]?.cacheHit).toBe(false);
    expect(events[0]?.error).toBeUndefined();
  });

  test('a repair turn is still ONE call, its usage the sum of both attempts', async () => {
    install(stub({ wrong: 1 }, ANSWER).provider);
    await declare(promptFor())({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });

    expect(events).toHaveLength(1);
    expect(events[0]?.inputTokens).toBe(USAGE.inputTokens * 2);
  });

  test('a cache hit reports zero tokens and cacheHit', async () => {
    install(stub(ANSWER).provider);
    const summarize = declare(promptFor(), { cache: { semantic: { threshold: 0.5 } } });
    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });
    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });

    expect(events.map((event) => event.cacheHit)).toEqual([false, true]);
    expect(events[1]?.inputTokens).toBe(0);
  });

  test('a failed call is still a call, and carries its error', async () => {
    install(stub(...times(2, { wrong: 1 })).provider);
    await expect(
      declare(promptFor())({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') }),
    ).rejects.toBeDefined();

    expect(events).toHaveLength(1);
    expect(events[0]?.error).toBeDefined();
  });
});

describe('the ai.llm span', () => {
  test('is a client span with the gen_ai names and no legacy llm.* spelling', async () => {
    install(stub(ANSWER).provider);
    await declare(promptFor())({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });

    const span = spans.find((one) => one.name === 'ai.llm');
    expect(span?.kind).toBe('client');
    expect(span?.attributes[SEMCONV.genAiRequestModel]).toBe(FIXTURE_MODEL);
    expect(span?.attributes[SEMCONV.genAiProviderName]).toBe('stub');
    expect(span?.attributes[SEMCONV.genAiUsageInputTokens]).toBe(USAGE.inputTokens);
    expect(span?.attributes[SEMCONV.genAiUsageOutputTokens]).toBe(USAGE.outputTokens);
    const legacy = Object.keys(span?.attributes ?? {}).filter((key) => key.startsWith('llm.'));
    expect(legacy).toEqual([]);
  });
});

describe('ai.llm from agent()', () => {
  const declareAgent = (named: string) =>
    agent({
      input: t.object({ postId: t.uuid }),
      output: t.object({ answer: t.string }),
      prompt: promptFor(),
      model: FIXTURE_MODEL,
      vars: ({ input }) => ({ postId: input.postId }),
      tools: [],
      policy: allow(),
    }).named(named);

  test('every model turn is one ai.llm, with that turn alone', async () => {
    // A wrong answer, then the corrected one: two model calls, so two events.
    install(stub({ wrong: 1 }, { answer: 'done' }).provider);
    await declareAgent('instrumentedAgent')({ postId: POST_ID }, { ctx: anonymousCtx() });

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.provider).toBe('stub');
      expect(event.model).toBe(FIXTURE_MODEL);
      expect(event.inputTokens).toBe(USAGE.inputTokens);
      expect(event.outputTokens).toBe(USAGE.outputTokens);
      expect(event.cacheHit).toBe(false);
      expect(event.error).toBeUndefined();
    }
  });

  test('a model call that fails is still a call, and carries its error', async () => {
    install(stub().provider);
    await expect(
      declareAgent('instrumentedFailingAgent')({ postId: POST_ID }, { ctx: anonymousCtx() }),
    ).rejects.toBeDefined();

    expect(events).toHaveLength(1);
    expect(events[0]?.error).toBeDefined();
    expect(events[0]?.inputTokens).toBe(0);
  });
});
