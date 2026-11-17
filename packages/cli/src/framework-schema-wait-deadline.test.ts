// `ULTIMATE_SCHEMA_WAIT_MS` bounds the READS as well as the backoff between them: a catalog read
// on a blackholed database hangs until the pool gives up (~125 s on a worker), and until round 5
// only a drain could end one — `deadlineMs: 50`, even `0`, sat on it for the pool's whole bound.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock, resetLifecycle, UltimateError } from '@ultimat3/core';
import type { SchemaCheck } from './framework-schema-wait';
import { SCHEMA_READ_FLOOR_MS, waitForSchema } from './framework-schema-wait';

afterEach(() => resetLifecycle());

const hung = (): Promise<never> => new Promise<never>(() => undefined);

const behind: SchemaCheck<string> = {
  ready: false,
  refuse: (waitedMs) =>
    new UltimateError({
      code: 'X_FRAMEWORK_SCHEMA_UNAPPLIED',
      cause: 'behind, in a test',
      fix: 'x db migrate',
      meta: { waitedMs: waitedMs ?? 0 },
    }),
};

/** The wait's outcome, or `'still waiting'` once `ms` of real time pass with neither. */
async function outcomeWithin(work: Promise<unknown>, ms: number): Promise<UltimateError | string> {
  return Promise.race([
    work.then(
      () => 'served',
      (error: unknown) => (error instanceof UltimateError ? error : 'an uncoded rejection'),
    ),
    // The subject's read bound is a real timer: a database hangs in real time.
    // real-clock: the watchdog over a real-time bound
    Bun.sleep(ms).then(() => 'still waiting'),
  ]);
}

describe('unit · a schema read that never answers', () => {
  test('a hung FIRST read is refused X_DB_UNAVAILABLE once the read floor passes', async () => {
    const started = performance.now();
    const outcome = await outcomeWithin(waitForSchema(hung, { deadlineMs: 50 }), 4_000);
    const elapsedMs = performance.now() - started;
    expect(outcome instanceof UltimateError && outcome.code).toBe('X_DB_UNAVAILABLE');
    expect(outcome instanceof UltimateError && outcome.cause).toContain('ULTIMATE_SCHEMA_WAIT_MS');
    expect(elapsedMs).toBeLessThan(SCHEMA_READ_FLOOR_MS + 1_000);
  });

  test('a hung LATER read is refused with the last verdict, as the deadline would', async () => {
    let reads = 0;
    const check = (): Promise<SchemaCheck<string>> => {
      reads += 1;
      return reads === 1 ? Promise.resolve(behind) : hung();
    };
    // Frozen: the backoff spends no real time, so the second read starts inside the deadline.
    const waiting = waitForSchema(check, {
      deadlineMs: 2_000,
      clock: frozenClock(),
      random: () => 0.5,
    });
    const outcome = await outcomeWithin(waiting, 4_000);
    expect(outcome instanceof UltimateError && outcome.code).toBe('X_FRAMEWORK_SCHEMA_UNAPPLIED');
    expect(reads).toBe(2);
  });

  test('a deadline of 0 still lets a slow but live read answer, inside the floor', async () => {
    const slow = async (): Promise<SchemaCheck<string>> => {
      // real-clock: the database's own latency, another process's time.
      await Bun.sleep(30);
      return { ready: true, value: 'served' };
    };
    expect(await waitForSchema(slow, { deadlineMs: 0 })).toBe('served');
  });
});
