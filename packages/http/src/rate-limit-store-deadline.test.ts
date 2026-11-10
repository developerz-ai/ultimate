// The shared store's own deadline, on an injected scheduler: a database that never answers costs a
// decision `deadlineMs`, never the pool's statement bound, and degrades exactly as an unreachable one
// does. The real-socket proof is `packages/testing/src/rate-limit-store-blackhole.live.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import type { PgExecutor, Scheduler } from '@ultimat3/core';
import { installLogSink } from '@ultimat3/core';
import type { Bucket } from './rate-limit';
import { postgresRateLimitStore } from './rate-limit-postgres';
import { RATE_LIMIT_STORE_DEADLINE_MS } from './rate-limit-store-deadline';

const bucket: Bucket = { capacity: 1, refillPerSecond: 0.001 };
const NOW = 1_700_000_000_000;

/** Timers that fire only when the test says so, recording what each was armed for. */
function manualSchedule() {
  const armed: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const schedule: Scheduler = (fire, ms) => {
    const entry = { ms, fire, cancelled: false };
    armed.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return { armed, schedule };
}

const silent: PgExecutor = { query: () => new Promise(() => undefined) };

let releaseLogSink: (() => void) | undefined;
const collect = (): string[] => {
  const lines: string[] = [];
  releaseLogSink = installLogSink((line) => {
    lines.push(line);
  });
  return lines;
};
afterEach(() => {
  releaseLogSink?.();
  releaseLogSink = undefined;
});

/** Settled or still pending, after every queued microtask has run. */
async function state(promise: Promise<unknown>): Promise<'pending' | 'settled'> {
  const pending = Symbol('pending');
  const raced = await Promise.race([
    promise.then(() => 'settled' as const),
    Promise.resolve(pending),
  ]);
  return raced === pending ? 'pending' : 'settled';
}

describe('the postgres rate-limit store deadline', () => {
  test('an unanswered take waits the deadline, then degrades to a per-pod bucket that limits', async () => {
    const lines = collect();
    const { armed, schedule } = manualSchedule();
    const store = postgresRateLimitStore({ executor: silent, schedule });

    const first = store.take('k', bucket, 1, NOW);
    expect(await state(first)).toBe('pending');
    expect(armed.map((t) => t.ms)).toEqual([RATE_LIMIT_STORE_DEADLINE_MS]);
    armed[0]?.fire();
    expect((await first).allowed).toBe(true);
    expect(lines.join('\n')).toContain('http.rate_limit.degraded');
    expect(lines.join('\n')).toContain('X_RATE_LIMIT_STORE_TIMEOUT');

    const second = store.take('k', bucket, 1, NOW);
    armed[1]?.fire();
    expect((await second).allowed).toBe(false);
  });

  test('an unanswered peek degrades at the same deadline', async () => {
    collect();
    const { armed, schedule } = manualSchedule();
    const store = postgresRateLimitStore({ executor: silent, schedule, deadlineMs: 40 });
    const peeked = store.peek('k', bucket, NOW);
    expect(armed[0]?.ms).toBe(40);
    armed[0]?.fire();
    expect((await peeked).remaining).toBe(1);
  });

  test('an answer inside the deadline is the decision, and the timer is cancelled', async () => {
    const lines = collect();
    const { armed, schedule } = manualSchedule();
    const answering: PgExecutor = {
      query: <R>() => Promise.resolve([{ tokens: 0, spent: true }] as unknown as readonly R[]),
    };
    const store = postgresRateLimitStore({ executor: answering, schedule });
    expect((await store.take('k', bucket, 1, NOW)).allowed).toBe(true);
    expect(armed.map((t) => t.cancelled)).toEqual([true]);
    expect(lines.join('\n')).not.toContain('http.rate_limit.degraded');
  });

  test('a deadline that is not a timer is refused at construction', () => {
    for (const deadlineMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
      expect(() => postgresRateLimitStore({ executor: silent, deadlineMs })).toThrow(/deadlineMs/);
    }
  });
});
