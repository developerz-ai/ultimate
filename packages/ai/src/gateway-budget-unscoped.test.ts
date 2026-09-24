// Single responsibility: a gateway's declared `budget` holds with no `scope()` open. It was
// enforced only inside `gateway.scope()`, which nothing in the framework calls, and `llm()` /
// `agent()` started from an empty ledger — so `createGateway({ budget: { request: 100 } })` capped
// nothing any app ran.

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx } from '@ultimat3/action';
import { createGateway } from './gateway';
import { ANSWER, declare, POST_ID, promptFor, stub } from './llm-fixture';
import { ANTHROPIC_MODEL_IDS } from './models';
import type { Provider } from './provider';
import { EchoProvider } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

const echo = new EchoProvider();

const counting = (): { provider: Provider; calls: () => number } => {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      name: 'counting',
      models: ANTHROPIC_MODEL_IDS,
      async generate(request) {
        calls += 1;
        return echo.generate(request);
      },
      stream: (request) => echo.stream(request),
    },
  };
};

beforeEach(() => {
  resetAiRuntime();
});

describe('a declared budget with no scope open', () => {
  test('gateway.generate refuses past the per-request ceiling', async () => {
    const { provider, calls } = counting();
    const gateway = createGateway({ providers: [provider], budget: { request: 100 } });
    const failure = gateway.generate({
      messages: [{ role: 'user', content: 'x'.repeat(2_000) }],
      maxTokens: 64,
    });
    await expect(failure).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    expect(calls()).toBe(0);
  });

  test('gateway.stream refuses too', async () => {
    const { provider, calls } = counting();
    const gateway = createGateway({ providers: [provider], budget: { request: 100 } });
    const drain = async () => {
      for await (const _ of gateway.stream({
        messages: [{ role: 'user', content: 'x'.repeat(2_000) }],
        maxTokens: 64,
      })) {
        // consumed
      }
    };
    await expect(drain()).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    expect(calls()).toBe(0);
  });

  test('an llm() action runs under the gateway ceiling', async () => {
    const { provider, seen } = stub(ANSWER);
    configureAi({ gateway: createGateway({ providers: [provider], budget: { request: 1 } }) });
    const summarize = declare(promptFor());
    await expect(summarize({ postId: POST_ID }, { ctx: anonymousCtx() })).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
    });
    expect(seen.length).toBe(0);
  });

  test('a call inside the ceiling still runs', async () => {
    const gateway = createGateway({ providers: [echo], budget: { request: 10_000 } });
    const result = await gateway.generate({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 32,
    });
    expect(result.text.length).toBeGreaterThanOrEqual(0);
  });
});
