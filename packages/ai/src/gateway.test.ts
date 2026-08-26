// Which provider serves a gateway call and what reaches the caller when one cannot: fallthrough,
// the retry rules, the response cache, and the code a failure surfaces under. The budget ledger
// is `gateway-budget.test.ts`.

import { describe, expect, test } from 'bun:test';
import { asyncRefusal, NOT_A_BOUND, refusal } from './bounds-fixture';
import { AiKeyMissingError, AiRequestInvalidError, AiTransportError } from './errors';
import { createGateway } from './gateway';
import { ANTHROPIC_MODEL_IDS } from './models';
import type { GenerateRequest, GenerateResult, Provider, StreamChunk } from './provider';
import { EchoProvider } from './provider';

const echo = new EchoProvider();

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

  test('a stream is not retried and does not fall over — the comment says so, this proves it', async () => {
    // A retryable failure on `generate` reaches the healthy provider above. On `stream` it must
    // not: there is no point at which the connection is open and no chunk has been delivered, so
    // a "handshake only" retry cannot be told from replaying tokens the consumer already read.
    let attempts = 0;
    let fellOver = false;
    const flaky: Provider = {
      name: 'flaky',
      models: ANTHROPIC_MODEL_IDS,
      generate: () => Promise.reject(new Error('unused')),
      // biome-ignore lint/correctness/useYield: the failure happens before the first chunk
      async *stream(): AsyncIterable<StreamChunk> {
        attempts += 1;
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    };
    const healthy: Provider = {
      name: 'healthy',
      models: ANTHROPIC_MODEL_IDS,
      generate: (request) => echo.generate(request),
      async *stream(request): AsyncIterable<StreamChunk> {
        fellOver = true;
        yield* echo.stream(request);
      },
    };
    const gateway = createGateway({
      providers: [flaky, healthy],
      retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => undefined,
    });

    const drain = async (): Promise<void> => {
      for await (const _chunk of gateway.stream({
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 16,
      })) {
        // the failure lands on the first pull
      }
    };
    await expect(drain()).rejects.toThrow(/rate limited/);
    expect(attempts).toBe(1);
    expect(fellOver).toBe(false);
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

// `attempt` collects every provider's failure into one `X_AI_PROVIDER_UNAVAILABLE`. That is right
// for a TRANSPORT failure — it says "provider 1 timed out, provider 2 429'd" — and wrong for a
// refusal the framework itself raised before the socket opened: the same rejection is waiting on
// every provider and every attempt, which is the stated reason a 400 is not retried.
describe('a local refusal reaches the caller with its own code', () => {
  const localRefusal = (): Provider => ({
    name: 'keyless',
    models: ANTHROPIC_MODEL_IDS,
    generate: () =>
      Promise.reject(new AiKeyMissingError({ provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' })),
    // biome-ignore lint/correctness/useYield: the refusal happens before the first chunk
    async *stream(): AsyncIterable<StreamChunk> {
      throw new AiKeyMissingError({ provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' });
    },
  });

  test('generate answers X_AI_KEY_MISSING, the same code stream answers', async () => {
    const gateway = createGateway({
      providers: [localRefusal()],
      retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => undefined,
    });

    let fromGenerate: unknown;
    try {
      await gateway.generate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 8 });
    } catch (error) {
      fromGenerate = error;
    }
    let fromStream: unknown;
    try {
      for await (const _chunk of gateway.stream({
        messages: [{ role: 'user', content: 'x' }],
        maxTokens: 8,
      })) {
        // never reached
      }
    } catch (error) {
      fromStream = error;
    }

    expect((fromGenerate as { code?: string } | undefined)?.code).toBe('X_AI_KEY_MISSING');
    expect((fromGenerate as { code?: string } | undefined)?.code).toBe(
      (fromStream as { code?: string } | undefined)?.code,
    );
    // The runnable fix is what a swallowed refusal discards, and it is the point of the code.
    expect((fromGenerate as { fix?: string } | undefined)?.fix).toContain('ANTHROPIC_API_KEY');
  });

  test('a local refusal is not retried — the same rejection waits on every attempt', async () => {
    let attempts = 0;
    const counting: Provider = {
      name: 'keyless',
      models: ANTHROPIC_MODEL_IDS,
      generate: () => {
        attempts += 1;
        return Promise.reject(
          new AiRequestInvalidError({
            detail: 'model "claude-haiku-4-5" does not accept effort',
            fix: "drop effort from definePrompt, or set model: 'claude-opus-5'",
          }),
        );
      },
      // biome-ignore lint/correctness/useYield: unused by this test
      async *stream(): AsyncIterable<StreamChunk> {
        throw new AiKeyMissingError({ provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' });
      },
    };
    const gateway = createGateway({
      providers: [counting],
      retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => undefined,
    });

    let thrown: unknown;
    try {
      await gateway.generate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 8 });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string } | undefined)?.code).toBe('X_AI_REQUEST_INVALID');
    expect(attempts).toBe(1);
  });

  test('a transport failure still collects across providers as X_AI_PROVIDER_UNAVAILABLE', async () => {
    // The other half of the rule: `AiTransportError` IS `X_AI_PROVIDER_UNAVAILABLE`, so a 503 on
    // provider one must still fall through to provider two rather than reaching the caller.
    let served = false;
    const down: Provider = {
      name: 'down',
      models: ANTHROPIC_MODEL_IDS,
      generate: () =>
        Promise.reject(
          new AiTransportError({ provider: 'down', status: 503, detail: 'overloaded' }),
        ),
      // biome-ignore lint/correctness/useYield: unused by this test
      async *stream(): AsyncIterable<StreamChunk> {
        throw new AiTransportError({ provider: 'down', status: 503, detail: 'overloaded' });
      },
    };
    const healthy: Provider = {
      name: 'healthy',
      models: ANTHROPIC_MODEL_IDS,
      generate: (request) => {
        served = true;
        return echo.generate(request);
      },
      stream: (request) => echo.stream(request),
    };
    const gateway = createGateway({
      providers: [down, healthy],
      retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => undefined,
    });

    const result = await gateway.generate({
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 8,
    });
    expect(served).toBe(true);
    expect(result.provider).toBe('healthy');
  });
});

/**
 * The gateway's own two bounds, and neither had anything checking it.
 *
 * `retry.attempts` is the retry loop's only exit condition: `attempt <= NaN` is false on the first
 * comparison, so `attempt()` calls NO provider and raises `X_AI_PROVIDER_UNAVAILABLE` carrying an
 * EMPTY attempt list — measured, `no provider could serve model "claude-opus-5" ()` about a
 * provider that was never asked. `maxTokens` is screened here because this is the one seam every
 * model call in an app passes through, and because of where it goes next: it IS the pre-flight
 * estimate, and a `NaN` estimate passes every ceiling and then writes itself onto the ledger and
 * the per-process `BudgetStore`, turning the budget off for the life of the process.
 */
describe('the gateway screens its own bounds', () => {
  const counting = (): { provider: Provider; calls: () => number } => {
    let calls = 0;
    const provider: Provider = {
      name: 'counting',
      models: ANTHROPIC_MODEL_IDS,
      generate(request): Promise<GenerateResult> {
        calls += 1;
        return echo.generate(request);
      },
      stream: (request) => echo.stream(request),
    };
    return { provider, calls: () => calls };
  };

  test('retry.attempts is refused when the gateway is built, not on the first failure', () => {
    for (const attempts of [...NOT_A_BOUND, 0]) {
      const error = refusal(() =>
        createGateway({
          providers: [echo],
          retry: { attempts, baseDelayMs: 0, maxDelayMs: 0 },
        }),
      );
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('retry.attempts');
      expect(error.fix).toContain('createGateway');
    }
  });

  test('a completion ceiling that is not a count never reaches a provider', async () => {
    const { provider, calls } = counting();
    const gateway = createGateway({ providers: [provider] });
    for (const maxTokens of [...NOT_A_BOUND, 0]) {
      const error = await asyncRefusal(() =>
        gateway.generate({ messages: [{ role: 'user', content: 'ping' }], maxTokens }),
      );
      expect(error.cause).toContain('maxTokens');
    }
    // The streamed half is the same request shape and the same screen.
    const stream = gateway.stream({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: Number.NaN,
    });
    const drain = await asyncRefusal(async () => {
      for await (const chunk of stream) void chunk;
    });
    expect(drain.cause).toContain('maxTokens');
    expect(calls()).toBe(0);
  });

  test('an honest gateway still answers — the non-vacuity half', async () => {
    const { provider, calls } = counting();
    const gateway = createGateway({
      providers: [provider],
      retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
    const result = await gateway.generate({
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
    });
    expect(result.text).toBe('ping');
    expect(calls()).toBe(1);
  });
});
