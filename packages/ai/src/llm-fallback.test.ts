// `llm()`'s half of `fallbackModels` and `providerOptions`: the declaration carries both onto the
// request, a bad bag fails the declaration, and the run's bill counts the failed model.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AiLlmEvent } from '@ultimat3/core';
import { resetInstrumentation, subscribe } from '@ultimat3/core';
import { addMoney, exactCostOf } from './cost';
import { AiTransportError } from './errors';
import { providerGateway } from './gateway';
import type { LlmCall } from './llm-def';
import { ANSWER, ctxFor, declare, POST_ID, promptFor, stub, USAGE } from './llm-fixture';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import type { Provider } from './provider';
import { meteredRun } from './run-meter';
import { installAiGateway, resetAiRuntime } from './runtime';

useFixtureModels();
beforeEach(resetAiRuntime);
afterEach(resetInstrumentation);

const SECOND = 'claude-sonnet-5';

const overloaded: Provider = {
  name: 'primary-host',
  models: [FIXTURE_MODEL],
  generate: async () => {
    throw new AiTransportError({ provider: 'primary-host', status: 529, detail: 'overloaded' });
  },
  stream: () => {
    throw new AiTransportError({ provider: 'primary-host', status: 529, detail: 'overloaded' });
  },
};

describe('llm() fallbackModels', () => {
  test('the declared chain answers on the second model, and the run is billed for both attempts', async () => {
    const answering = stub(ANSWER);
    const secondOnly: Provider = { ...answering.provider, models: [SECOND] };
    installAiGateway(
      providerGateway({
        providers: [overloaded, secondOnly],
        retry: { attempts: 1, base: 0, max: 0, jitter: 'none' },
        breaker: 'off',
      }),
    );
    const events: AiLlmEvent[] = [];
    subscribe('ai.llm', (event) => events.push(event.payload));
    const calls: LlmCall[] = [];
    const summarize = declare(promptFor(), {
      model: FIXTURE_MODEL,
      fallbackModels: [SECOND],
      onCall: (call) => void calls.push(call),
    });

    const { value, billed } = await meteredRun(() =>
      summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') }),
    );
    expect(value).toEqual(ANSWER);
    expect(calls.map((call) => call.model)).toEqual([SECOND]);
    expect(billed).toMatchObject({ calls: 1, unsettled: 1 });
    // The token metric counts the fallback's answer: it is the call's usage, billed apart.
    expect(events.map((event) => [event.model, event.inputTokens])).toEqual([
      [SECOND, USAGE.inputTokens],
    ]);
  });
});

describe('a run that answered on two models', () => {
  test("is priced at each model's own rate — a fallback answer is never re-priced at the primary", async () => {
    // Call 1: the primary is overloaded, the fallback answers off-schema. Call 2 (the repair): the
    // primary is back and answers. One answer on each model.
    const primary = stub(ANSWER);
    let primaryCalls = 0;
    const flaky: Provider = {
      name: 'primary-host',
      models: [FIXTURE_MODEL],
      generate: (request) => {
        primaryCalls += 1;
        if (primaryCalls === 1) return overloaded.generate(request);
        return primary.provider.generate(request);
      },
      stream: (request) => primary.provider.stream(request),
    };
    const offSchema = stub({ wrong: 1 });
    installAiGateway(
      providerGateway({
        providers: [flaky, { ...offSchema.provider, models: [SECOND] }],
        retry: { attempts: 1, base: 0, max: 0, jitter: 'none' },
        breaker: 'off',
      }),
    );
    const calls: LlmCall[] = [];
    await declare(promptFor(), {
      model: FIXTURE_MODEL,
      fallbackModels: [SECOND],
      onCall: (call) => void calls.push(call),
    })({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });

    expect(calls.map((call) => call.model)).toEqual([SECOND, FIXTURE_MODEL]);
    const expected = addMoney(exactCostOf(SECOND, USAGE), exactCostOf(FIXTURE_MODEL, USAGE));
    expect(calls[1]?.run.costExact).toEqual(expected);
    expect(calls[1]?.run.usage.inputTokens).toBe(USAGE.inputTokens * 2);
  });
});

describe('llm() providerOptions', () => {
  test('the bag reaches the request as declared', async () => {
    const answering = stub(ANSWER);
    installAiGateway(providerGateway({ providers: [answering.provider] }));
    await declare(promptFor(), {
      model: FIXTURE_MODEL,
      providerOptions: { anthropic: { service_tier: 'standard_only' } },
    })({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });
    expect(answering.seen[0]?.providerOptions).toEqual({
      anthropic: { service_tier: 'standard_only' },
    });
  });

  test('a bad bag fails the declaration, before any gateway or request exists', () => {
    expect(() => declare(promptFor(), { providerOptions: { openai: { top_p: 7 } } })).toThrow(
      /X_AI_REQUEST_INVALID/,
    );
  });
});
