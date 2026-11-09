// One consumer run's edges, on the memory queue: a declared lag lands in the row's progress as
// `total - done`, a lag that is not a finite non-negative number fails the run, and a stream whose
// close rejects is logged and does not fail a run that committed.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, setLogSink } from '@ultimat3/core';
import { type PgliteClient, pgliteClient, setDbClient } from '@ultimat3/db';
import { installJobDriver, resetJobDriver } from './adapter';
import { consumer } from './consumer';
import type { ConsumerDefinition } from './consumer-types';
import { memoryJobDriver } from './driver-memory';
import { resetJobs } from './job';
import { type KeyedHarness, workerOn } from './keyed-concurrency-fixture';
import { resetJobsFacade } from './outbox';
import { resetTasks } from './task';

const clock = frozenClock('2026-11-06T00:00:00.000Z');
const harness: KeyedHarness = {
  clock,
  driver: () => Promise.resolve(memoryJobDriver({ clock })),
  elapse: (_driver, ms) => {
    clock.advance(ms);
    return Promise.resolve();
  },
};

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
    name: `loop-${minted}`,
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

/** Enqueue one key's run and tick it once; answers the run and its row afterwards. */
async function runOnce(declared: ConsumerDefinition<number, number>) {
  const handle = consumer(declared);
  const driver = memoryJobDriver({ clock });
  installJobDriver(driver);
  const queued = await handle.enqueue({ key: 'acct-1' });
  // The enqueue stamps `runAt` off the facade's own clock; the queue's is moved up to it, or the
  // row would stay delayed and the tick come back empty.
  const due = (await driver.introspect?.job(queued.id))?.runAt ?? 0;
  clock.advance(Math.max(0, due - clock.now().getTime()));
  const [run] = await workerOn(harness, driver, 'w-loop').tick();
  const row = await driver.introspect?.job(queued.id);
  return { run, row };
}

describe('consumerRun', () => {
  test('a declared lag is reported as total minus done, asked with the committed cursor', async () => {
    const asked: { key: string; cursor: number | null }[] = [];
    const { run, row } = await runOnce(
      definition({
        lag: ({ key, cursor }) => {
          asked.push({ key, cursor });
          return 5;
        },
      }),
    );
    expect(run?.outcome).toBe('completed');
    expect(run?.result).toEqual({ key: 'acct-1', batches: 1, items: 3 });
    expect(asked).toEqual([{ key: 'acct-1', cursor: 3 }]);
    expect(row?.progress).toMatchObject({ done: 3, total: 8 });
  });

  test('with no lag declared, total is done', async () => {
    const { row } = await runOnce(definition());
    expect(row?.progress).toMatchObject({ done: 3, total: 3 });
  });

  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    test(`a lag of ${String(bad)} fails the run, naming the consumer`, async () => {
      const declared = definition({ lag: () => bad });
      const { run } = await runOnce(declared);
      expect(run?.outcome).not.toBe('completed');
      expect(run?.error).toContain('X_INVARIANT');
      expect(run?.error).toContain(`consumer "${declared.name}" lag() returned ${String(bad)}`);
    });
  }

  test('a stream whose close rejects is logged, and the run that committed still completes', async () => {
    const lines: string[] = [];
    const previous = setLogSink((line) => {
      lines.push(line);
    });
    try {
      const declared = definition({
        open: () => {
          let given = false;
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => {
                if (given) return Promise.resolve({ done: true as const, value: undefined });
                given = true;
                return Promise.resolve({ done: false as const, value: 9 });
              },
              return: () => Promise.reject(new TypeError('the stream would not close')),
            }),
          };
        },
      });
      const { run } = await runOnce(declared);
      expect(run?.outcome).toBe('completed');
      expect(run?.result).toEqual({ key: 'acct-1', batches: 1, items: 1 });
      const warned = lines
        .map((line) => JSON.parse(line) as { msg?: string; consumer?: string })
        .filter((line) => line.msg === 'jobs.consumer.close-failed');
      expect(warned.map((line) => line.consumer)).toEqual([declared.name]);
    } finally {
      setLogSink(previous);
    }
  });
});
