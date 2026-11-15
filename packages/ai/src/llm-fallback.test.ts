// `llm()`'s half of `fallbackModels` and `providerOptions`: the declaration carries both onto the
// request, a bad bag fails the declaration, and the run's bill counts the failed model.

import { beforeEach, describe, expect, test } from 'bun:test';
import { AiTransportError } from './errors';
import { providerGateway } from './gateway';
import type { LlmCall } from './llm-def';
import { ANSWER, ctxFor, declare, POST_ID, promptFor, stub } from './llm-fixture';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import type { Provider } from './provider';
import { meteredRun } from './run-meter';
import { installAiGateway, resetAiRuntime } from './runtime';

useFixtureModels();
beforeEach(resetAiRuntime);

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
