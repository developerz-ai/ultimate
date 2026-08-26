// Every numeric knob `createWorker` and `createOutboxRelay` accept, refused when it is not a
// finite number. `Number(process.env.X)` on an unset variable is `NaN`, `??` guards only nullish
// and `Math.max`/`Math.floor` PROPAGATE `NaN`, so the value reaches a lease deadline, a claim
// limit and a timer interval intact — and every comparison against it reads false.

import { afterEach, describe, expect, test } from 'bun:test';
import { type Ctx, createContext, UltimateError } from '@ultimat3/core';
import { createMemoryDriver } from './driver-memory';
import { resetJobs } from './job';
import { createMemoryOutboxStore, createOutboxRelay } from './outbox';
import { createWorker } from './worker';

const context = (): Ctx => createContext({ role: 'worker', buildId: 'test' });

/** Every shape `Number(...)` / `parseInt` / JSON hands a config reader that no `??` can catch. */
const NOT_A_BOUND: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

const fixOf = (thrown: unknown): string =>
  thrown instanceof UltimateError ? `${thrown.code} ${thrown.cause} ${thrown.fix}` : '';

afterEach(() => {
  resetJobs();
});

describe('a worker built on a number that is not a number', () => {
  test('a non-finite visibilityTimeoutMs is refused, not turned into a lease that never expires', () => {
    // MEASURED against `createMemoryDriver`: `visibleAt = at + NaN` is `NaN`, the reclaim scan asks
    // `(record.visibleAt ?? 0) <= at` and `NaN <= at` is FALSE, so a job whose worker died is never
    // claimable again. At-least-once becomes never, with no error, no log, and a row `x jobs ls`
    // still prints as `running`. The Postgres driver takes the same number into `visible_at`.
    for (const visibilityTimeoutMs of NOT_A_BOUND) {
      const build = (): unknown =>
        createWorker({
          driver: createMemoryDriver(),
          context,
          drainOnShutdown: false,
          visibilityTimeoutMs,
        });
      expect(build).toThrow(UltimateError);
      let thrown: unknown;
      try {
        build();
      } catch (error: unknown) {
        thrown = error;
      }
      expect(fixOf(thrown)).toContain('visibilityTimeoutMs');
      expect(fixOf(thrown)).toContain('X_INVARIANT');
    }
  });

  test('a non-finite pollIntervalMs is refused, not handed to setTimeout as zero', () => {
    // `setTimeout(fn, NaN)` coerces the delay to 0, so the claim loop stops being a poll and
    // becomes a spin — one round trip to Postgres per event-loop turn, from every worker replica.
    for (const pollIntervalMs of NOT_A_BOUND) {
      expect(() =>
        createWorker({
          driver: createMemoryDriver(),
          context,
          drainOnShutdown: false,
          pollIntervalMs,
        }),
      ).toThrow(UltimateError);
    }
  });

  test('a non-finite heartbeatIntervalMs is refused', () => {
    for (const heartbeatIntervalMs of NOT_A_BOUND) {
      expect(() =>
        createWorker({
          driver: createMemoryDriver(),
          context,
          drainOnShutdown: false,
          heartbeatIntervalMs,
        }),
      ).toThrow(UltimateError);
    }
  });

  test('a non-finite concurrency is refused, in both the flat and the per-queue form', () => {
    // MEASURED: `Math.max(0, NaN - inFlight)` is `NaN`, `free === 0` is false so the round proceeds,
    // and `[...].slice(0, NaN)` is `[]`. The worker ticks forever, claims nothing, reports healthy —
    // the `hive({ concurrency: NaN })` outcome, one package over.
    for (const value of NOT_A_BOUND) {
      expect(() =>
        createWorker({
          driver: createMemoryDriver(),
          context,
          drainOnShutdown: false,
          concurrency: value,
        }),
      ).toThrow(UltimateError);
      expect(() =>
        createWorker({
          driver: createMemoryDriver(),
          context,
          drainOnShutdown: false,
          queues: ['imports'],
          concurrency: { imports: value },
        }),
      ).toThrow(UltimateError);
    }
  });

  test('the ordinary worker is unchanged — the guard refuses numbers, not workers', async () => {
    // Non-vacuity: a rule that threw on everything would pass every assertion above.
    const worker = createWorker({
      driver: createMemoryDriver(),
      context,
      drainOnShutdown: false,
      visibilityTimeoutMs: 30_000,
      pollIntervalMs: 250,
      concurrency: { default: 2 },
    });
    expect(await worker.tick()).toEqual([]);
    await worker.stop();
  });
});

describe('an outbox relay built on a number that is not a number', () => {
  test('a non-finite intervalMs is refused, not handed to setInterval as zero', () => {
    // `setInterval(fn, NaN)` is `setInterval(fn, 0)`: the relay stops polling and starts spinning.
    for (const intervalMs of NOT_A_BOUND) {
      expect(() =>
        createOutboxRelay({
          store: createMemoryOutboxStore(),
          driver: createMemoryDriver(),
          intervalMs,
        }),
      ).toThrow(UltimateError);
    }
  });

  test('a non-finite batchSize is refused, not turned into a pass that claims nothing', () => {
    for (const batchSize of NOT_A_BOUND) {
      expect(() =>
        createOutboxRelay({
          store: createMemoryOutboxStore(),
          driver: createMemoryDriver(),
          batchSize,
        }),
      ).toThrow(UltimateError);
    }
  });

  test('an ordinary relay is unchanged', async () => {
    const relay = createOutboxRelay({
      store: createMemoryOutboxStore(),
      driver: createMemoryDriver(),
      batchSize: 10,
      intervalMs: 50,
    });
    expect(await relay.pending()).toBe(0);
    await relay.stop();
  });
});
