// `enqueueMany`'s statements against a real Postgres — the embedded one, with this package's DDL
// applied: `SQL_ENQUEUE_MANY`, `SQL_ENQUEUE_MANY_RESOLVE`, `SQL_OUTBOX_STAGE_MANY` and the relay's
// `SQL_OUTBOX_MARK_PUBLISHED_MANY`. Statements are COUNTED through the executor, so "1,000 inputs
// is one statement" is a fact this suite reads, not a claim. Opt-in (`.job.`): Postgres boots.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { uuidV7 } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import { claimOf } from './driver';
import { driverEnqueueManyScenarios, introspectedHarness } from './driver-enqueue-many-fixture';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { passthrough } from './operator-surface-fixture';
import { outboxJobsFacade } from './outbox';
import { postgresOutboxStore } from './outbox-pg';
import { outboxRelay } from './outbox-relay';

interface Item {
  readonly id: string;
}

afterEach(() => resetJobs());
afterAll(async () => {
  await (await embeddedPg()).close();
});

const declared = (): JobHandle<Item> =>
  job<Item, void>({
    name: 'enqueue-many-pg',
    tenant: 'none',
    input: passthrough<Item>(),
    idempotencyKey: ({ id }) => id,
    retry: { attempts: 1, jitter: false },
    run: () => Promise.resolve(),
  });

const items = (count: number): Item[] =>
  Array.from({ length: count }, (_, index) => ({ id: `k${index}` }));

/** `executor` with every statement it sends written down. */
const counted = (executor: PgExecutor) => {
  const sent: string[] = [];
  const wrapped: PgExecutor = {
    query: (sql, params) => {
      sent.push(sql);
      return executor.query(sql, params);
    },
  };
  return { wrapped, sent };
};

const rows = async (executor: PgExecutor) =>
  executor.query<{ id: string; run_id: string; input: unknown; idempotency_key: string }>(
    'select id, run_id, input, idempotency_key from x_jobs order by id',
    [],
  );

describe('what enqueueMany answers, on the pg driver', () => {
  driverEnqueueManyScenarios(
    'pg',
    introspectedHarness(
      async () => {
        const pg = await embeddedPg();
        await pg.reset();
        return postgresJobDriver({ executor: pg.executor });
      },
      async () => {
        const [row] = await (await embeddedPg()).executor.query<{ now: number | string }>(
          'select (extract(epoch from now()) * 1000)::bigint as now',
          [],
        );
        return Number(row?.now ?? 0);
      },
    ),
  );
});

describe('pg: enqueueMany straight to the driver', () => {
  test('1,000 inputs are ONE statement, answered in input order', async () => {
    const pg = await embeddedPg();
    await pg.reset();
    const { wrapped, sent } = counted(pg.executor);
    const driver = postgresJobDriver({ executor: wrapped });
    const jobs = outboxJobsFacade(
      { driver, store: postgresOutboxStore({ executor: wrapped, txExecutor: () => wrapped }) },
      () => undefined,
    );
    const input = items(1_000);
    const results = await jobs.enqueueMany(declared(), input);
    expect(sent).toHaveLength(1);
    expect(results.every((result) => !result.deduped)).toBe(true);
    const byId = new Map((await rows(pg.executor)).map((row) => [row.id, row]));
    expect(results.map((result) => byId.get(result.id)?.input)).toEqual(input);
    expect(results.map((result) => byId.get(result.id)?.run_id)).toEqual(
      results.map((result) => result.runId),
    );
  });

  test('a key twice in the batch, and a key a live job holds, are answered deduped', async () => {
    const pg = await embeddedPg();
    await pg.reset();
    const driver = postgresJobDriver({ executor: pg.executor });
    const jobs = outboxJobsFacade(
      {
        driver,
        store: postgresOutboxStore({ executor: pg.executor, txExecutor: () => pg.executor }),
      },
      () => undefined,
    );
    const handle = declared();
    const live = await jobs.enqueue(handle, { id: 'held' });
    const [first, repeat, held] = await jobs.enqueueMany(handle, [
      { id: 'a' },
      { id: 'a' },
      { id: 'held' },
    ]);
    expect(first?.deduped).toBe(false);
    expect(repeat).toEqual({ id: first?.id ?? '', runId: first?.runId ?? '', deduped: true });
    expect(held).toEqual({ ...live, deduped: true });
    expect(await rows(pg.executor)).toHaveLength(2);
  });

  test("a request's own id and runId land, and the same id after its job finished adds no row", async () => {
    const pg = await embeddedPg();
    await pg.reset();
    const driver = postgresJobDriver({ executor: pg.executor });
    const request = {
      id: uuidV7(),
      runId: uuidV7(),
      name: 'enqueue-many-pg',
      queue: 'default',
      input: { id: 'own' },
      idempotencyKey: 'own',
      maxAttempts: 1,
    };
    const [made] = await driver.enqueueMany([request]);
    expect(made).toEqual({ id: request.id, runId: request.runId, deduped: false });
    const [claimed] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w',
    });
    if (claimed === undefined) return expect.unreachable('the job was not claimable');
    await driver.ack(claimed.id, claimOf(claimed));
    const [again] = await driver.enqueueMany([request]);
    expect(again).toEqual({ id: request.id, runId: request.runId, deduped: true });
    expect(await rows(pg.executor)).toHaveLength(1);
  });
});

describe('pg: enqueueMany staged in the transaction', () => {
  test('1,000 inputs stage in ONE statement on the caller connection; a rollback stages none', async () => {
    const pg = await embeddedPg();
    await pg.reset();
    const driver = postgresJobDriver({ executor: pg.executor });
    let bound: PgExecutor | undefined;
    const sent: string[] = [];
    const store = postgresOutboxStore({
      executor: pg.executor,
      txExecutor: () => {
        const executor = bound ?? expect.unreachable('staged outside the transaction');
        return (
          counted(executor).wrapped && {
            query: (sql, params) => {
              sent.push(sql);
              return executor.query(sql, params);
            },
          }
        );
      },
    });
    const tx = { id: 'tx' } as unknown as Tx;
    const jobs = outboxJobsFacade({ driver, store }, () => tx);
    const handle = declared();

    await pg.transaction(async (executor) => {
      bound = executor;
      await jobs.enqueueMany(handle, items(1_000));
    }, 'rollback');
    expect(sent).toHaveLength(1);
    expect(await store.pendingCount()).toBe(0);

    await pg.transaction(async (executor) => {
      bound = executor;
      await jobs.enqueueMany(handle, items(3));
    });
    expect(await store.pendingCount()).toBe(3);
  });

  test('a fractional runAt stages and publishes, as a single staged enqueue does', async () => {
    const pg = await embeddedPg();
    await pg.reset();
    const driver = postgresJobDriver({ executor: pg.executor });
    let bound: PgExecutor | undefined;
    const store = postgresOutboxStore({
      executor: pg.executor,
      txExecutor: () => bound ?? expect.unreachable('staged outside the transaction'),
    });
    const tx = { id: 'tx' } as unknown as Tx;
    const jobs = outboxJobsFacade({ driver, store }, () => tx);
    const handle = declared();
    const runAt = Date.now() + 1_234.5;
    await pg.transaction(async (executor) => {
      bound = executor;
      await jobs.enqueue(handle, { id: 'single' }, { runAt });
      await jobs.enqueueMany(handle, [{ id: 'batched' }], { runAt });
    });
    const staged = await store.claim(10);
    expect(staged.map((row) => row.runAt)).toEqual([staged[0]?.runAt ?? 0, staged[0]?.runAt ?? 0]);
    expect(await outboxRelay({ store, driver, drainOnShutdown: false }).tick()).toBe(0);
  });

  test('a batch the relay published and never marked is published again with no second row', async () => {
    const pg = await embeddedPg();
    await pg.reset();
    const driver = postgresJobDriver({ executor: pg.executor });
    let bound: PgExecutor | undefined;
    const store = postgresOutboxStore({
      executor: pg.executor,
      txExecutor: () => bound ?? expect.unreachable('staged outside the transaction'),
      claimLeaseMs: 1_000,
    });
    const tx = { id: 'tx' } as unknown as Tx;
    const jobs = outboxJobsFacade({ driver, store }, () => tx);
    await pg.transaction(async (executor) => {
      bound = executor;
      await jobs.enqueueMany(declared(), items(3));
    });

    // The crash between the publish and the mark: the jobs exist, the outbox rows are unmarked.
    const crashed = { ...store, markPublishedMany: () => Promise.resolve() };
    expect(await outboxRelay({ store: crashed, driver, drainOnShutdown: false }).tick()).toBe(3);
    // Every job runs to the end, out of the live states the idempotency index covers.
    const claimed = await driver.claim({
      queues: ['default'],
      limit: 10,
      visibilityTimeoutMs: 30_000,
      workerId: 'w',
    });
    for (const row of claimed) await driver.ack(row.id, claimOf(row));
    expect(claimed).toHaveLength(3);

    // The dead relay's lease lapses, and the next relay publishes the same batch.
    await pg.age(2_000);
    expect(await outboxRelay({ store, driver, drainOnShutdown: false }).tick()).toBe(3);
    expect(await rows(pg.executor)).toHaveLength(3);
    expect(await store.pendingCount()).toBe(0);
  });

  test('a relay tick publishes the batch: one enqueueMany, one markPublishedMany', async () => {
    const pg = await embeddedPg();
    await pg.reset();
    const { wrapped, sent } = counted(pg.executor);
    const driver = postgresJobDriver({ executor: wrapped });
    let bound: PgExecutor | undefined;
    const store = postgresOutboxStore({
      executor: wrapped,
      txExecutor: () => bound ?? expect.unreachable('staged outside the transaction'),
    });
    const tx = { id: 'tx' } as unknown as Tx;
    const jobs = outboxJobsFacade({ driver, store }, () => tx);
    await pg.transaction(async (executor) => {
      bound = executor;
      await jobs.enqueueMany(declared(), items(50));
    });
    sent.length = 0;
    expect(await outboxRelay({ store, driver, drainOnShutdown: false }).tick()).toBe(50);
    // The claim, the batch insert, the batch mark.
    expect(sent).toHaveLength(3);
    expect(await store.pendingCount()).toBe(0);
    expect(await rows(pg.executor)).toHaveLength(50);
  });
});
