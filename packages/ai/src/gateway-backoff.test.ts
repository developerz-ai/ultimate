// The gateway's wait between attempts and its retryability table — the two halves of `attempt`'s
// schedule. Its own file because `gateway.test.ts` owns routing, fallthrough and the response
// cache, and because until the roll was injectable none of this could be asserted at all.

import { describe, expect, test } from 'bun:test';
import { AiTransportError } from './errors';
import { backoffMs, createGateway, isRetryable, type RetryPolicy } from './gateway';
import { ANTHROPIC_MODEL_IDS } from './models';
import type { GenerateResult, Provider, StreamChunk } from './provider';

const POLICY: RetryPolicy = { attempts: 5, baseDelayMs: 500, maxDelayMs: 8_000 };

/** A provider that always fails with `status`, counting attempts and recording every wait. */
function failingGateway(status: number, waits: number[], random: () => number) {
  let attempts = 0;
  const failing: Provider = {
    name: 'failing',
    models: ANTHROPIC_MODEL_IDS,
    generate(): Promise<GenerateResult> {
      attempts += 1;
      return Promise.reject(new AiTransportError({ provider: 'failing', status, detail: 'no' }));
    },
    // biome-ignore lint/correctness/useYield: the failure happens before the first chunk
    async *stream(): AsyncIterable<StreamChunk> {
      throw new AiTransportError({ provider: 'failing', status, detail: 'no' });
    },
  };
  const gateway = createGateway({
    providers: [failing],
    retry: { attempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 },
    random,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { gateway, attempts: () => attempts };
}

describe('backoffMs', () => {
  test('the roll is injected, so the schedule is an exact list and not a range', () => {
    const half = (): number => 0.5;
    // full jitter over a doubling ceiling, clamped BEFORE the roll: 500, 1000, 2000, 4000, 8000,
    // then 8000 forever. Half of each is the whole schedule.
    expect([1, 2, 3, 4, 5, 6].map((attempt) => backoffMs(POLICY, attempt, half))).toEqual([
      250, 500, 1_000, 2_000, 4_000, 4_000,
    ]);
  });

  test('the roll is the whole delay at 1 and nothing at 0 — full jitter, not equal', () => {
    expect(backoffMs(POLICY, 3, () => 1)).toBe(2_000);
    expect(backoffMs(POLICY, 3, () => 0)).toBe(0);
  });

  test('a delay is ROUNDED, where this gateway floored it', () => {
    // 500 * 0.3333 = 166.65. `Math.floor` answered 166 for four years of this package; core's
    // `backoffDelay` rounds, and jobs and realtime already did. The delta is <=1ms and it is
    // pinned here so the adoption is recorded rather than discovered by a diff.
    expect(backoffMs(POLICY, 1, () => 0.3333)).toBe(167);
  });

  test('a policy carrying a NaN is REFUSED, not silently turned into 0', () => {
    // `Number(process.env.AI_RETRY_BASE_MS)` on an unset var is NaN, and `setTimeout(NaN)` fires on
    // the next tick — a "backoff" that is a tight spin across every attempt.
    //
    // This asserted `0` while core clamped, which was the safe answer to the wrong question: a
    // schedule of zeroes still spins, it just spins deliberately. Core's `backoffDelay` now refuses
    // a non-finite bound before clamping, and the gateway inherits the refusal along with the curve
    // — the whole point of having one engine.
    const broken: RetryPolicy = { attempts: 3, baseDelayMs: Number.NaN, maxDelayMs: 8_000 };
    expect(() => backoffMs(broken, 1, () => 0.5)).toThrow('X_INVARIANT');
  });

  test('a negative base never produces a negative wait', () => {
    const broken: RetryPolicy = { attempts: 3, baseDelayMs: -500, maxDelayMs: 8_000 };
    expect(backoffMs(broken, 1, () => 0.5)).toBe(0);
  });
});

describe('isRetryable', () => {
  // 408 and 425 are transient by definition — the server gave up waiting for a body it never fully
  // read, and a handshake that had not completed. Neither is a statement about the request. They
  // were not retried before core's one table replaced this gateway's `429 || >= 500`.
  test.each([408, 409, 425, 429, 500, 502, 503, 504, 529])('%d is retried', (status) => {
    expect(isRetryable({ status })).toBe(true);
  });

  test.each([400, 401, 403, 404, 413, 422])('%d is not', (status) => {
    expect(isRetryable({ status })).toBe(false);
  });

  // Core's table is HTTP status only, so this branch stays in ai: a socket that timed out or was
  // reset has no status to classify.
  test.each(['ETIMEDOUT', 'ECONNRESET'])('a transport %s is retried on its code', (code) => {
    expect(isRetryable({ code })).toBe(true);
  });

  test('an unreadable value fails closed rather than throwing inside the catch block', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new AiTransportError({ provider: 'rude', detail: 'trapped' });
        },
      },
    );
    expect(isRetryable(hostile)).toBe(false);
  });
});

describe('the gateway waits the schedule it computed', () => {
  test('the injected roll reaches the sleep, so the waits are an exact list', async () => {
    const waits: number[] = [];
    const { gateway } = failingGateway(503, waits, () => 1);

    await expect(
      gateway.generate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 8 }),
    ).rejects.toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });

    // Two waits for three attempts, and none after the last: attempt 3 fails and the loop is over.
    expect(waits).toEqual([500, 1_000]);
  });

  test('a 408 is retried where it used to reach the caller on attempt one', async () => {
    const waits: number[] = [];
    const { gateway, attempts } = failingGateway(408, waits, () => 0);

    await expect(
      gateway.generate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 8 }),
    ).rejects.toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });

    expect(attempts()).toBe(3);
  });

  test('a 400 still stops on attempt one and waits not at all', async () => {
    const waits: number[] = [];
    const { gateway, attempts } = failingGateway(400, waits, () => 1);

    await expect(
      gateway.generate({ messages: [{ role: 'user', content: 'x' }], maxTokens: 8 }),
    ).rejects.toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });

    expect(attempts()).toBe(1);
    expect(waits).toEqual([]);
  });
});
