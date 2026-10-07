// The ids an enqueue answers are the job's, on EVERY path. A staged enqueue used to answer
// `runId: ''` and the outbox row's id — neither of which names a job — so an action that had to
// say which run it started could not enqueue transactionally at all. Both ids are allocated at
// stage time and carried through the outbox, and the relay publishes under them.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { claimOf } from './driver';
import { memoryJobDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { createJobsFacade, enqueueInTx, memoryOutboxStore, resetJobsFacade } from './outbox';
import { createOutboxRelay } from './outbox-relay';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

interface SyncInput {
  readonly requestId: string;
}

let sync: JobHandle<SyncInput>;

beforeEach(() => {
  resetJobs();
  sync = job<SyncInput>({
    tenant: 'none',
    name: 'syncAccount',
    input: passthrough<SyncInput>(),
    idempotencyKey: ({ requestId }) => `sync:${requestId}`,
    retry: { attempts: 1 },
    run: () => Promise.resolve(),
  });
});

afterEach(() => {
  resetJobsFacade();
});

const fakeTx = (): Tx => ({ id: 'tx-1' }) as unknown as Tx;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN = '00000000-0000-4000-8000-0000000000b1';

describe('an enqueue names its run on every path', () => {
  test('inside a transaction the answer is the job the relay publishes', async () => {
    const driver = memoryJobDriver();
    const store = memoryOutboxStore();
    const tx = fakeTx();
    const jobs = createJobsFacade({ store, driver }, () => tx);

    const queued = await jobs.enqueue(sync, { requestId: 'r1' });

    expect(queued.runId).toMatch(UUID);
    expect(queued.id).toMatch(UUID);
    // Nothing is on the queue yet: the ids are allocated at STAGE time, the row at commit.
    expect(await driver.introspect?.job(queued.id)).toBeUndefined();

    await store.commit(tx);
    await createOutboxRelay({ store, driver }).tick();

    const row = await driver.introspect?.job(queued.id);
    expect(row?.runId).toBe(queued.runId);
    expect(row?.name).toBe('syncAccount');
  });

  test('a caller may name the run, staged or direct', async () => {
    const driver = memoryJobDriver();
    const store = memoryOutboxStore();
    const tx = fakeTx();
    let ambient: Tx | undefined = tx;
    const jobs = createJobsFacade({ store, driver }, () => ambient);

    const staged = await jobs.enqueue(sync, { requestId: 'r1' }, { runId: RUN });
    expect(staged.runId).toBe(RUN);
    await store.commit(tx);
    await createOutboxRelay({ store, driver }).tick();
    expect((await driver.introspect?.job(staged.id))?.runId).toBe(RUN);

    ambient = undefined;
    const other = '00000000-0000-4000-8000-0000000000b2';
    const direct = await jobs.enqueue(sync, { requestId: 'r2' }, { runId: other });
    expect(direct.runId).toBe(other);
    expect((await driver.introspect?.job(direct.id))?.runId).toBe(other);
  });

  test('a row published twice is one job, even after the first one finished', async () => {
    const driver = memoryJobDriver();
    const store = memoryOutboxStore();
    const tx = fakeTx();
    const jobs = createJobsFacade({ store, driver }, () => tx);
    const queued = await jobs.enqueue(sync, { requestId: 'r1' });
    const [record] = await store.commit(tx);
    if (record === undefined) return expect.unreachable('expected one staged record');

    const publish = () =>
      driver.enqueue({
        id: record.id,
        runId: record.runId,
        name: record.job,
        queue: record.queue,
        input: record.input,
        idempotencyKey: record.idempotencyKey,
        maxAttempts: record.maxAttempts,
      });
    // The relay died between its publish and its `markPublished` — and the job ran to the end
    // before the next relay picked the row up again.
    const first = await publish();
    const [claimed] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 1,
      workerId: 'w1',
    });
    if (claimed === undefined) return expect.unreachable('the published job was not claimable');
    await driver.ack(claimed.id, claimOf(claimed));
    const second = await publish();

    expect(first).toEqual({ id: queued.id, runId: queued.runId, deduped: false });
    // The id is the outbox row's own, so the repeat meets the job it already made — finished or
    // not — instead of inserting a second one the idempotency index no longer covers.
    expect(second).toEqual({ id: queued.id, runId: queued.runId, deduped: true });
    expect((await driver.introspect?.list())?.length).toBe(1);
  });
});

/**
 * `run_id` is a `uuid` column. The memory driver took any string and Postgres raised a raw
 * `22P02` from the insert, so the same call passed under `x dev` and failed in production — and on
 * the staged path it failed the caller's whole TRANSACTION, at the outbox insert.
 */
describe('a named run is a uuid on every path, refused before anything is written', () => {
  const codeOf = async (call: () => Promise<unknown>): Promise<string> => {
    try {
      await call();
    } catch (error) {
      return isUltimateError(error) ? error.code : `not coded: ${String(error)}`;
    }
    return 'did-not-throw';
  };
  const NOT_UUIDS: readonly unknown[] = [
    'order-42',
    '',
    '00000000-0000-4000-8000-0000000000B1',
    '{00000000-0000-4000-8000-0000000000b1}',
    '00000000000040008000000000000b1',
    42,
    null,
  ];

  test('direct: the driver is never asked', async () => {
    const driver = memoryJobDriver();
    const jobs = createJobsFacade({ store: memoryOutboxStore(), driver }, () => undefined);
    for (const runId of NOT_UUIDS) {
      const options = { runId } as { runId: string };
      expect(await codeOf(() => jobs.enqueue(sync, { requestId: 'r1' }, options))).toBe(
        'X_ID_INVALID',
      );
    }
    expect(await driver.introspect?.list()).toEqual([]);
  });

  test('staged: nothing reaches the outbox, through the facade or enqueueInTx', async () => {
    const driver = memoryJobDriver();
    const store = memoryOutboxStore();
    const tx = fakeTx();
    const jobs = createJobsFacade({ store, driver }, () => tx);
    for (const runId of NOT_UUIDS) {
      const options = { runId } as { runId: string };
      expect(await codeOf(() => jobs.enqueue(sync, { requestId: 'r1' }, options))).toBe(
        'X_ID_INVALID',
      );
      expect(
        await codeOf(() => enqueueInTx({ store, driver }, tx, sync, { requestId: 'r1' }, options)),
      ).toBe('X_ID_INVALID');
    }
    expect(await store.commit(tx)).toEqual([]);
  });

  test('the refusal names the option and never echoes the value', async () => {
    const jobs = createJobsFacade(
      { store: memoryOutboxStore(), driver: memoryJobDriver() },
      () => undefined,
    );
    const thrown = await jobs
      .enqueue(sync, { requestId: 'r1' }, { runId: 'sk_live_not_a_run' })
      .catch((error: unknown) => error);
    if (!isUltimateError(thrown)) return expect.unreachable('expected a coded refusal');
    expect(thrown.cause).toContain('runId');
    expect(thrown.cause).not.toContain('sk_live_not_a_run');
    expect(thrown.fix).toContain('uuid()');
  });
});
