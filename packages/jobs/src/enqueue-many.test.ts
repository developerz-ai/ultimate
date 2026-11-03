// `handle.enqueueMany` on the memory pair: the answer in input order, the dedup a key earns inside
// the batch and against a live row, the refusals decided before any write, the chunking, and the
// loops a store or driver without the batch member falls back to. `.job.test.ts` is Postgres.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, runToCompletion, runWithContext, UltimateError } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { EnqueueRequest, JobDriver } from './driver';
import { resetJobDriver, setJobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { ENQUEUE_CHUNK, MAX_ENQUEUE_BATCH } from './job-enqueue-many';
import { passthrough } from './operator-surface-fixture';
import type { OutboxRecord, OutboxStore } from './outbox';
import { memoryOutboxStore, outboxJobsFacade, resetJobsFacade } from './outbox';

interface Item {
  readonly id: string;
}

afterEach(() => {
  resetJobs();
  resetJobDriver();
  resetJobsFacade();
});

const declared = (): JobHandle<Item> =>
  job<Item, void>({
    name: 'enqueue-many',
    tenant: 'none',
    input: passthrough<Item>(),
    idempotencyKey: ({ id }) => id,
    retry: { attempts: 1, jitter: false },
    run: () => Promise.resolve(),
  });

const items = (count: number, prefix = 'i'): Item[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));

const TX: Tx = { query: () => Promise.resolve([]) } as unknown as Tx;

/** A driver whose batch calls are recorded, so a test can count statements' worth of calls. */
const counting = () => {
  const driver = memoryJobDriver();
  const batches: number[] = [];
  const singles: string[] = [];
  const wrapped: JobDriver = {
    ...driver,
    enqueue: (request: EnqueueRequest) => {
      singles.push(request.idempotencyKey);
      return driver.enqueue(request);
    },
    enqueueMany: (requests) => {
      batches.push(requests.length);
      return driver.enqueueMany(requests);
    },
  };
  return { driver, wrapped, batches, singles };
};

const inputsOf = async (driver: JobDriver, ids: readonly string[]) =>
  Promise.all(ids.map(async (id) => (await driver.introspect?.job(id))?.input));

const timedOut = (): UltimateError =>
  new UltimateError({ code: 'X_TIMEOUT', cause: 'past the deadline', fix: 'raise it' });

const abortedWith = (reason: unknown): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

describe('enqueueMany, straight to the driver', () => {
  test('answers in input order, every row its own job', async () => {
    const { driver, wrapped, batches } = counting();
    const jobs = outboxJobsFacade({ driver: wrapped, store: memoryOutboxStore() }, () => undefined);
    const input = items(5);
    const results = await jobs.enqueueMany(declared(), input);
    expect(results.map((result) => result.deduped)).toEqual([false, false, false, false, false]);
    expect(new Set(results.map((result) => result.id)).size).toBe(5);
    expect(
      await inputsOf(
        driver,
        results.map((result) => result.id),
      ),
    ).toEqual(input);
    expect(batches).toEqual([5]);
  });

  test('a key twice in one batch is one job, the second answered deduped with its id', async () => {
    const { wrapped } = counting();
    const jobs = outboxJobsFacade({ driver: wrapped, store: memoryOutboxStore() }, () => undefined);
    const [first, second] = await jobs.enqueueMany(declared(), [{ id: 'a' }, { id: 'a' }]);
    expect(first?.deduped).toBe(false);
    expect(second).toEqual({ id: first?.id ?? '', runId: first?.runId ?? '', deduped: true });
  });

  test('a key a live job holds is that job', async () => {
    const { wrapped } = counting();
    const jobs = outboxJobsFacade({ driver: wrapped, store: memoryOutboxStore() }, () => undefined);
    const handle = declared();
    const live = await jobs.enqueue(handle, { id: 'a' });
    const [held, fresh] = await jobs.enqueueMany(handle, [{ id: 'a' }, { id: 'b' }]);
    expect(held).toEqual({ ...live, deduped: true });
    expect(fresh?.deduped).toBe(false);
  });

  test('an empty list answers [] and calls nothing', async () => {
    const { wrapped, batches, singles } = counting();
    const jobs = outboxJobsFacade({ driver: wrapped, store: memoryOutboxStore() }, () => undefined);
    expect(await jobs.enqueueMany(declared(), [])).toEqual([]);
    expect([batches, singles]).toEqual([[], []]);
  });

  test('one call per chunk of ENQUEUE_CHUNK, answered whole and in order', async () => {
    const { wrapped, batches } = counting();
    const jobs = outboxJobsFacade({ driver: wrapped, store: memoryOutboxStore() }, () => undefined);
    const results = await jobs.enqueueMany(declared(), items(ENQUEUE_CHUNK * 2 + 5));
    expect(batches).toEqual([ENQUEUE_CHUNK, ENQUEUE_CHUNK, 5]);
    expect(results).toHaveLength(ENQUEUE_CHUNK * 2 + 5);
  });

  test('past MAX_ENQUEUE_BATCH: refused by code, nothing enqueued', async () => {
    const { wrapped, batches } = counting();
    const jobs = outboxJobsFacade({ driver: wrapped, store: memoryOutboxStore() }, () => undefined);
    const outcome = await jobs
      .enqueueMany(declared(), items(MAX_ENQUEUE_BATCH + 1))
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(UltimateError);
    expect((outcome as UltimateError).code).toBe('X_JOB_ENQUEUE_BATCH_TOO_LARGE');
    expect(batches).toEqual([]);
  });

  test('an empty key anywhere refuses the call before the first row', async () => {
    const { wrapped, batches } = counting();
    const jobs = outboxJobsFacade({ driver: wrapped, store: memoryOutboxStore() }, () => undefined);
    const outcome = await jobs
      .enqueueMany(declared(), [{ id: 'a' }, { id: 'b' }, { id: '' }])
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(UltimateError);
    expect(batches).toEqual([]);
  });

  test("mode 'required' refuses it outside a transaction", async () => {
    const { wrapped } = counting();
    const jobs = outboxJobsFacade(
      { driver: wrapped, store: memoryOutboxStore(), mode: 'required' },
      () => undefined,
    );
    const outcome = await jobs.enqueueMany(declared(), items(2)).catch((error: unknown) => error);
    expect((outcome as UltimateError).code).toBe('X_OUTBOX_NO_TX');
  });

  test('the handle reaches it through the ambient facade', async () => {
    const driver = memoryJobDriver();
    setJobDriver(driver);
    const results = await declared().enqueueMany(items(2));
    expect(
      await inputsOf(
        driver,
        results.map((result) => result.id),
      ),
    ).toEqual(items(2));
  });
});

describe('enqueueMany, staged in the transaction', () => {
  test('stages every row in one call, ids answered, committed in order', async () => {
    const store = memoryOutboxStore();
    const calls: number[] = [];
    const stageMany: NonNullable<OutboxStore['stageMany']> = (tx, records) => {
      calls.push(records.length);
      return store.stageMany?.(tx, records) ?? expect.unreachable('memory has stageMany');
    };
    const jobs = outboxJobsFacade(
      { driver: memoryJobDriver(), store: { ...store, stageMany } },
      () => TX,
    );
    const results = await jobs.enqueueMany(declared(), items(3));
    const committed = await store.commit(TX);
    expect(calls).toEqual([3]);
    expect(committed.map((record) => record.input)).toEqual(items(3));
    expect(results).toEqual(
      committed.map((record) => ({ id: record.id, runId: record.runId, deduped: false })),
    );
  });

  test('a rollback stages nothing', async () => {
    const store = memoryOutboxStore();
    const jobs = outboxJobsFacade({ driver: memoryJobDriver(), store }, () => TX);
    await jobs.enqueueMany(declared(), items(3));
    await store.rollback(TX);
    expect(await store.commit(TX)).toEqual([]);
    expect(await store.pendingCount()).toBe(0);
  });

  test('a store with no stageMany still stages all of them, in order', async () => {
    const store = memoryOutboxStore();
    const seen: OutboxRecord[] = [];
    const { stageMany: _batch, ...rest } = store;
    const loopOnly: OutboxStore = {
      ...rest,
      stage: (tx, record) => {
        seen.push(record);
        return store.stage(tx, record);
      },
    };
    const jobs = outboxJobsFacade({ driver: memoryJobDriver(), store: loopOnly }, () => TX);
    await jobs.enqueueMany(declared(), items(3));
    expect(seen.map((record) => record.input)).toEqual(items(3));
  });

  test('outbox: false goes straight to the driver even inside one', async () => {
    const { wrapped, batches } = counting();
    const jobs = outboxJobsFacade({ driver: wrapped, store: memoryOutboxStore() }, () => TX);
    await jobs.enqueueMany(declared(), items(2), { outbox: false });
    expect(batches).toEqual([2]);
  });
});

describe('enqueueMany past the abort', () => {
  test('direct: refused with the reason, nothing enqueued', async () => {
    const { wrapped, batches } = counting();
    const jobs = outboxJobsFacade({ driver: wrapped, store: memoryOutboxStore() }, () => undefined);
    const reason = timedOut();
    const outcome = await runWithContext(ctxOf({ signal: abortedWith(reason) }), () =>
      jobs.enqueueMany(declared(), items(2)).catch((error: unknown) => error),
    );
    expect(outcome).toBe(reason);
    expect(batches).toEqual([]);
  });

  test('staged: refused with the reason, nothing staged', async () => {
    const store = memoryOutboxStore();
    const jobs = outboxJobsFacade({ driver: memoryJobDriver(), store }, () => TX);
    const reason = timedOut();
    const outcome = await runWithContext(ctxOf({ signal: abortedWith(reason) }), () =>
      jobs.enqueueMany(declared(), items(2)).catch((error: unknown) => error),
    );
    expect(outcome).toBe(reason);
    expect(await store.commit(TX)).toEqual([]);
  });

  test('direct: an abort between chunks stops the chunks after it', async () => {
    const driver = memoryJobDriver();
    const controller = new AbortController();
    const reason = timedOut();
    const batches: number[] = [];
    const aborting: JobDriver = {
      ...driver,
      enqueueMany: async (requests) => {
        batches.push(requests.length);
        const results = await driver.enqueueMany(requests);
        controller.abort(reason);
        return results;
      },
    };
    const jobs = outboxJobsFacade(
      { driver: aborting, store: memoryOutboxStore() },
      () => undefined,
    );
    const outcome = await runWithContext(ctxOf({ signal: controller.signal }), () =>
      jobs.enqueueMany(declared(), items(ENQUEUE_CHUNK + 1)).catch((error: unknown) => error),
    );
    expect(outcome).toBe(reason);
    expect(batches).toEqual([ENQUEUE_CHUNK]);
  });

  test('runToCompletion lands it', async () => {
    const { wrapped, batches } = counting();
    const jobs = outboxJobsFacade({ driver: wrapped, store: memoryOutboxStore() }, () => undefined);
    await runWithContext(ctxOf({ signal: abortedWith(timedOut()) }), () =>
      runToCompletion(() => jobs.enqueueMany(declared(), items(2))),
    );
    expect(batches).toEqual([2]);
  });

  test('a client hang-up, uncoded, keeps enqueuing', async () => {
    const { wrapped, batches } = counting();
    const jobs = outboxJobsFacade({ driver: wrapped, store: memoryOutboxStore() }, () => undefined);
    const hangUp = new DOMException('The operation was aborted.', 'AbortError');
    await runWithContext(ctxOf({ signal: abortedWith(hangUp) }), () =>
      jobs.enqueueMany(declared(), items(2)),
    );
    expect(batches).toEqual([2]);
  });
});
