import { describe, expect, test } from 'bun:test';
import { MemoryBudgetStore } from './budget';
import { createGateway } from './gateway';
import { ANTHROPIC_MODEL_IDS } from './models';
import type { GenerateRequest, GenerateResult, Provider, StreamChunk } from './provider';
import { costOf, EchoProvider } from './provider';

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

describe('routing and retries', () => {
  test('a retryable failure falls through to a healthy provider', async () => {
    const flaky: Provider = {
      name: 'flaky',
      models: ANTHROPIC_MODEL_IDS,
      async generate(): Promise<GenerateResult> {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
      // biome-ignore lint/correctness/useYield: interface requires a generator shape
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('unused');
      },
    };
    const gateway = createGateway({
      providers: [flaky, echo],
      retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => undefined,
    });
    const result = await gateway.generate({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
    });
    expect(result.text).toBe('ping');
  });

  test('a 400 is not retried and surfaces as X_AI_PROVIDER_UNAVAILABLE', async () => {
    let attempts = 0;
    const broken: Provider = {
      name: 'broken',
      models: ANTHROPIC_MODEL_IDS,
      async generate(): Promise<GenerateResult> {
        attempts += 1;
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
      // biome-ignore lint/correctness/useYield: interface requires a generator shape
      async *stream(): AsyncIterable<StreamChunk> {
        throw new Error('unused');
      },
    };
    const gateway = createGateway({
      providers: [broken],
      retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => undefined,
    });
    await expect(
      gateway.generate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 8 }),
    ).rejects.toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });
    expect(attempts).toBe(1);
  });

  // A `Provider` is an APP's object — `createGateway({ providers })` takes whatever it is handed —
  // so the value it rejects with is one the framework did not build. Both reads in the retry loop
  // run on it: `isRetryable` indexes it, and the failure line renders it. A throw from either
  // replaces `X_AI_PROVIDER_UNAVAILABLE` with a bare TypeError raised inside the catch block.
  test('a provider that rejects with a value fighting to be read still ends in a coded error', async () => {
    const hostile: readonly unknown[] = [
      new Proxy(
        {},
        {
          get() {
            throw new Error('trapped get');
          },
          getPrototypeOf() {
            throw new Error('trapped getPrototypeOf');
          },
        },
      ),
      Object.create(null),
      Symbol('rejected'),
    ];
    for (const value of hostile) {
      const rude: Provider = {
        name: 'rude',
        models: ANTHROPIC_MODEL_IDS,
        generate: () => Promise.reject(value),
        // biome-ignore lint/correctness/useYield: interface requires a generator shape
        async *stream(): AsyncIterable<StreamChunk> {
          throw new Error('unused');
        },
      };
      const gateway = createGateway({
        providers: [rude],
        retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
        sleep: async () => undefined,
      });
      // `toThrow(Class)` passes in Bun 1.3.14 when a call merely RETURNS an error, so the code is
      // asserted off the caught value instead.
      let thrown: unknown;
      try {
        await gateway.generate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 8 });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string } | undefined)?.code).toBe('X_AI_PROVIDER_UNAVAILABLE');
      expect(typeof (thrown as { cause?: unknown } | undefined)?.cause).toBe('string');
    }
  });

  test('a cache hit skips the provider entirely', async () => {
    let calls = 0;
    const counting: Provider = {
      name: 'counting',
      models: ANTHROPIC_MODEL_IDS,
      async generate(request: GenerateRequest) {
        calls += 1;
        return echo.generate(request);
      },
      stream: (request) => echo.stream(request),
    };
    const store = new Map<string, string>();
    const gateway = createGateway({
      providers: [counting],
      cache: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    });
    const request = { messages: [{ role: 'user' as const, content: 'same' }], maxTokens: 16 };
    await gateway.generate(request);
    await gateway.generate(request);
    expect(calls).toBe(1);
  });

  test('a refusal is never cached — it is a decision, not an answer', async () => {
    let calls = 0;
    const refusing: Provider = {
      name: 'refusing',
      models: ANTHROPIC_MODEL_IDS,
      async generate(request: GenerateRequest) {
        calls += 1;
        return { ...(await echo.generate(request)), stopReason: 'refusal' as const };
      },
      stream: (request) => echo.stream(request),
    };
    const store = new Map<string, string>();
    const gateway = createGateway({
      providers: [refusing],
      cache: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    });
    const request = { messages: [{ role: 'user' as const, content: 'same' }], maxTokens: 16 };

    await gateway.generate(request);
    await gateway.generate(request);

    // Caching one would keep serving a classifier decision long after the prompt was fixed.
    expect(store.size).toBe(0);
    expect(calls).toBe(2);
  });
});
