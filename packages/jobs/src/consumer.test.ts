// `consumer()` as a declaration and as one run on the memory queue: what it refuses where it is
// written, what it registers, and that the self-enqueue trap `recipes.job.test.ts` pins is
// unreachable through it. The Postgres half — commit atomicity, restart, drain — is
// `consumer.job.test.ts`.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { type PgliteClient, pgliteClient, setDbClient } from '@ultimat3/db';
import { consumer } from './consumer';
import { consumerDeclarationOf, consumerRow, registeredConsumers } from './consumer-registry';
import type { ConsumerDefinition } from './consumer-types';
import { resetJobDriver, setJobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { getJob, isJobHandle, resetJobs } from './job';
import { type KeyedHarness, workerOn } from './keyed-concurrency-fixture';
import { resetJobsFacade } from './outbox';
import { getTask, resetTasks } from './task';

const clock = frozenClock('2026-11-06T00:00:00.000Z');
const harness: KeyedHarness = {
  clock,
  driver: () => Promise.resolve(memoryJobDriver({ clock })),
  elapse: (_driver, ms) => {
    clock.advance(ms);
    return Promise.resolve();
  },
};

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the declaration was accepted');
};

const codeOf = (error: unknown): string | undefined =>
  isUltimateError(error) ? error.code : undefined;

/** An in-memory stream: every item after the cursor, then the end. */
async function* after(log: readonly number[], cursor: number | null): AsyncGenerator<number> {
  for (const item of log) if (item > (cursor ?? 0)) yield item;
}

let minted = 0;
function definition(
  overrides: Partial<ConsumerDefinition<number, number>> = {},
): ConsumerDefinition<number, number> {
  minted += 1;
  const cursors = new Map<string, number>();
  return {
    name: `orders-${minted}`,
    tenant: 'none',
    keys: () => ['acct-1'],
    open: ({ cursor }) => after([1, 2, 3], cursor),
    handle: ({ items }) => items[items.length - 1] ?? 0,
    cursor: {
      load: (key) => cursors.get(key) ?? null,
      save: (key, next) => {
        cursors.set(key, next);
      },
    },
    ...overrides,
  };
}

let db: PgliteClient | undefined;

beforeEach(() => {
  db ??= pgliteClient();
  setDbClient(db);
  setJobDriver(memoryJobDriver({ clock }));
});

afterEach(() => {
  resetJobsFacade();
  resetJobDriver();
  resetJobs();
  resetTasks();
});

afterAll(async () => {
  setDbClient(undefined);
  await db?.close();
});

describe('the declaration', () => {
  test('is a registered job keyed per key, with a registered supervisor task', () => {
    const declared = definition({ rearm: '5m', batch: 10, lag: () => 0 });
    const handle = consumer(declared);

    expect(isJobHandle(handle)).toBe(true);
    expect(getJob(declared.name)).toBe(handle);
    expect(getJob(`${declared.name}.arm`)).toBeDefined();
    expect(getTask(`${declared.name}.supervisor`)).toBe(handle.supervisor);
    expect(handle.supervisor.cron).toBe('*/5 * * * *');
    expect(handle.supervisor.tz).toBe('UTC');
    expect(handle.idempotencyKeyFor({ key: 'acct-1' })).toBe(`consumer:${declared.name}:acct-1`);
    expect(handle.concurrencyKeyFor({ key: 'acct-1' })).toBeDefined();
    expect(handle.timeoutMs).toBeUndefined();
    expect(consumerDeclarationOf(handle)).toEqual({
      kind: 'consumer',
      name: declared.name,
      queue: 'default',
      supervisor: `${declared.name}.supervisor`,
      arm: `${declared.name}.arm`,
      rearm: '*/5 * * * *',
      batch: 10,
      lags: true,
    });
    expect(registeredConsumers().map((row) => row.name)).toEqual([declared.name]);
  });

  test('refuses a missing cursor seam, naming X_CONSUMER_INVALID', () => {
    const { cursor: _omitted, ...rest } = definition();
    const missing = { ...rest } as unknown as ConsumerDefinition<number, number>;
    expect(codeOf(thrown(() => consumer(missing)))).toBe('X_CONSUMER_INVALID');
    const half = definition({ cursor: { load: () => null } as never });
    expect(codeOf(thrown(() => consumer(half)))).toBe('X_CONSUMER_INVALID');
    // Refused before `job()` ran, so the name is still free for the corrected declaration.
    expect(getJob(half.name)).toBeUndefined();
  });

  test('refuses a timeout, and a rearm the cron cannot tick evenly', () => {
    const timed = { ...definition(), timeout: '5m' } as unknown as ConsumerDefinition<
      number,
      number
    >;
    expect(codeOf(thrown(() => consumer(timed)))).toBe('X_CONSUMER_INVALID');
    for (const rearm of ['30s', '7m', '2h']) {
      expect(codeOf(thrown(() => consumer(definition({ rearm }))))).toBe('X_CONSUMER_INVALID');
    }
    expect(consumer(definition({ rearm: '1h' })).supervisor.cron).toBe('0 * * * *');
  });
});

describe('one run on the memory queue', () => {
  test('the supervisor arms each key; a run commits its batches and the next arm is a restart', async () => {
    const saved: number[] = [];
    const declared = definition({ keys: () => ['acct-1', 'acct-2'] });
    const handle = consumer({
      ...declared,
      cursor: {
        load: declared.cursor.load,
        save: (key, next) => {
          saved.push(next);
          return declared.cursor.save(key, next);
        },
      },
    });
    const driver = memoryJobDriver({ clock });
    setJobDriver(driver);
    const worker = workerOn(harness, driver, 'w-arm');

    const fired = await handle.supervisor.enqueue();
    expect(fired.map((entry) => entry.job)).toEqual([`${declared.name}.arm`]);
    expect((await worker.tick()).map((run) => run.result)).toEqual([{ keys: 2, started: 2 }]);
    const runs = [...(await worker.tick()), ...(await worker.tick())];
    expect(runs.map((run) => run.result)).toEqual([
      { key: 'acct-1', batches: 1, items: 3 },
      { key: 'acct-2', batches: 1, items: 3 },
    ]);
    expect(saved).toEqual([3, 3]);

    // Settled, so the next tick restarts each key — from its saved cursor, with nothing new.
    await handle.supervisor.enqueue();
    await worker.tick();
    const again = [...(await worker.tick()), ...(await worker.tick())];
    expect(again.map((run) => run.result)).toEqual([
      { key: 'acct-1', batches: 0, items: 0 },
      { key: 'acct-2', batches: 0, items: 0 },
    ]);
  });
});

describe('the self-enqueue trap', () => {
  test("a consumer's own body enqueuing itself is refused with X_CONSUMER_SELF_ENQUEUE", async () => {
    let refusal: unknown;
    const declared = definition();
    const handle = consumer({
      ...declared,
      handle: async ({ items, key }) => {
        try {
          await handle.enqueue({ key });
        } catch (error) {
          refusal = error;
          throw error;
        }
        return items[items.length - 1] ?? 0;
      },
    });
    const driver = memoryJobDriver({ clock });
    setJobDriver(driver);
    await handle.enqueue({ key: 'acct-1' });
    const outcomes = (await workerOn(harness, driver, 'w-self').tick()).map((run) => run.outcome);

    expect(codeOf(refusal)).toBe('X_CONSUMER_SELF_ENQUEUE');
    expect(outcomes).not.toEqual(['completed']);
    // From outside a run the same handle enqueues as any job does.
    expect(codeOf(await handle.enqueue({ key: 'acct-2' }).catch((error) => error))).toBeUndefined();
  });
});

describe('the consumer row', () => {
  test('reports the key, the last batch and the lag only when one is declared', () => {
    const lagging = consumer(definition({ lag: () => 4 }));
    const silent = consumer(definition());
    const progress = { done: 3, total: 7, at: Date.UTC(2026, 10, 6), note: 'consumer' };

    expect(consumerRow({ name: lagging.name, input: { key: 'acct-1' }, progress })).toEqual({
      key: 'acct-1',
      lastBatchAt: '2026-11-06T00:00:00.000Z',
      lag: 4,
    });
    expect(consumerRow({ name: silent.name, input: { key: 'a' }, progress })?.lag).toBeNull();
    expect(consumerRow({ name: silent.name, input: { key: 'a' }, progress: null })).toEqual({
      key: 'a',
      lastBatchAt: null,
      lag: null,
    });
    expect(consumerRow({ name: 'not-a-consumer', input: {}, progress })).toBeNull();
  });
});
