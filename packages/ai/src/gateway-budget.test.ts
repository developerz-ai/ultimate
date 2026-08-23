// The gateway's budget ledger: a refusal raised before the provider is called, cost accounted in
// integer minor units, and every reservation credited back on a path that never reached a
// provider. Routing, retries and error-code propagation are `gateway.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { BudgetStore } from './budget';
import { MemoryBudgetStore } from './budget';
import { createGateway } from './gateway';
import { ANTHROPIC_MODEL_IDS } from './models';
import type { Provider, StreamChunk } from './provider';
import { costOf, EchoProvider, totalTokens } from './provider';

const echo = new EchoProvider();

describe('budgets refuse rather than truncate', () => {
  test('a request past the per-request budget throws before the provider is called', async () => {
    let calls = 0;
    const counting: Provider = {
      name: 'counting',
      models: ANTHROPIC_MODEL_IDS,
      async generate(request) {
        calls += 1;
        return echo.generate(request);
      },
      stream: (request) => echo.stream(request),
    };

    const gateway = createGateway({ providers: [counting], budget: { request: 100 } });
    const failure = gateway.scope({}, () =>
      gateway.generate({
        messages: [{ role: 'user', content: 'x'.repeat(2_000) }],
        maxTokens: 64,
      }),
    );

    await expect(failure).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    // The point of refusing: nothing was spent, and nothing was silently shortened.
    expect(calls).toBe(0);
  });

  test('actor spend accumulates across calls until the actor budget refuses', async () => {
    const store = new MemoryBudgetStore();
    const gateway = createGateway({
      providers: [echo],
      budget: { actor: 400 },
      budgetStore: store,
    });

    await gateway.scope({ actorKey: 'actor:u1' }, async () => {
      await gateway.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 32 });
    });
    const afterFirst = store.spent('actor:u1');
    expect(afterFirst).toBeGreaterThan(0);

    const failure = gateway.scope({ actorKey: 'actor:u1' }, () =>
      gateway.generate({
        messages: [{ role: 'user', content: 'y'.repeat(4_000) }],
        maxTokens: 32,
      }),
    );
    await expect(failure).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    // Refused calls do not move the counter.
    expect(store.spent('actor:u1')).toBe(afterFirst);
  });

  test('a budget-free call still reports cost in integer minor units', async () => {
    const gateway = createGateway({ providers: [echo] });
    const result = await gateway.generate({
      messages: [{ role: 'user', content: 'hello world' }],
      maxTokens: 32,
    });
    expect(result.cost.currency).toBe('USD');
    expect(Number.isInteger(result.cost.minor)).toBe(true);
  });
});

describe('cost accounting', () => {
  test('cost is integer minor units and rounds up, never down to zero', () => {
    // 1 output token on opus-5 is 2500/1_000_000 of a cent — must round to 1, not 0.
    const tiny = costOf('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(tiny).toEqual({ minor: 1, currency: 'USD' });

    // 1M input + 1M output on opus-5 = $5 + $25 = 3000 cents.
    const full = costOf('claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(full.minor).toBe(3_000);

    // Cache reads are ~0.1x input: 1M cached reads on opus-5 is 50 cents, not 500.
    const cached = costOf('claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    });
    expect(cached.minor).toBe(50);
  });
});

// A reservation is DEBITED before the call, so every path out of `stream` that never reached a
// provider has to credit it back. `MemoryBudgetStore` is per process and never expires, so a
// reservation that leaks is not one refused call — it is every subsequent call in that process.
describe('a stream that never reaches a provider releases its reservation', () => {
  // `claude-opus-5` is registered (so `estimateSpend` prices it) and this provider does not list
  // it — an ordinary boot misconfiguration, not a contrived one.
  const haikuOnly: Provider = {
    name: 'haiku-only',
    models: ['claude-haiku-4-5'],
    generate: (request) => echo.generate(request),
    stream: (request) => echo.stream(request),
  };

  const drain = async (gateway: ReturnType<typeof createGateway>): Promise<void> => {
    for await (const _chunk of gateway.stream({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'x'.repeat(2_000) }],
      maxTokens: 512,
    })) {
      // the refusal lands on the first pull
    }
  };

  test('a model no configured provider serves leaves the org counter untouched', async () => {
    const store = new MemoryBudgetStore();
    const gateway = createGateway({
      providers: [haikuOnly],
      budget: { org: 20_000 },
      budgetStore: store,
    });

    for (let call = 1; call <= 5; call += 1) {
      const failure = gateway.scope({ orgKey: 'org:acme' }, () => drain(gateway));
      await expect(failure).rejects.toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });
      // Every iteration, not just the last: a leak that accrues would refuse itself at call 5
      // with `X_AI_BUDGET_EXCEEDED` and hide the real cause.
      expect(store.spent('org:acme')).toBe(0);
    }
  });

  test('the same misconfiguration does not poison a later call the gateway CAN serve', async () => {
    const store = new MemoryBudgetStore();
    const gateway = createGateway({
      providers: [haikuOnly],
      budget: { org: 20_000 },
      budgetStore: store,
    });

    await gateway.scope({ orgKey: 'org:acme' }, async () => {
      await expect(drain(gateway)).rejects.toMatchObject({
        code: 'X_AI_PROVIDER_UNAVAILABLE',
      });
    });

    const served = await gateway.scope({ orgKey: 'org:acme' }, () =>
      gateway.generate({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 32,
      }),
    );
    // Exactly what the served call used, with nothing carried over from the refused one. The
    // store is per process and never expires, so a leak here is charged to the org forever.
    expect(store.spent('org:acme')).toBe(totalTokens(served.usage));
  });

  test('a budget store that fails at `done` still gives the reservation back', async () => {
    // `settled = true` before `await ledger.record(...)` leaves the reservation both unreleased
    // and half-recorded: the `finally` sees a settled stream and credits nothing.
    const counters = new Map<string, number>();
    let failNextAdd = false;
    const store: BudgetStore = {
      spent: (key) => counters.get(key) ?? 0,
      add(key, tokens) {
        if (failNextAdd) {
          failNextAdd = false;
          // Handed TO the subject, never this test's own verdict.
          return Promise.reject(new Error('budget store unavailable'));
        }
        counters.set(key, (counters.get(key) ?? 0) + tokens);
        return undefined;
      },
      reset: () => counters.clear(),
    };

    const flaky: Provider = {
      name: 'flaky-store',
      models: ANTHROPIC_MODEL_IDS,
      generate: (request) => echo.generate(request),
      async *stream(request): AsyncIterable<StreamChunk> {
        for await (const chunk of echo.stream(request)) {
          // The store goes down between the last token and the reconciliation.
          if (chunk.type === 'done') failNextAdd = true;
          yield chunk;
        }
      },
    };

    const gateway = createGateway({
      providers: [flaky],
      budget: { org: 50_000 },
      budgetStore: store,
    });
    const failure = gateway.scope({ orgKey: 'org:acme' }, async () => {
      for await (const _chunk of gateway.stream({
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 64,
      })) {
        // drain to `done`
      }
    });

    await expect(failure).rejects.toThrow(/budget store unavailable/);
    expect(counters.get('org:acme') ?? 0).toBe(0);
  });
});
