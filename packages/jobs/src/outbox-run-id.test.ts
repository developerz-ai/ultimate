// The ids an enqueue answers are the job's, on EVERY path. A staged enqueue used to answer
// `runId: ''` and the outbox row's id — neither of which names a job — so an action that had to
// say which run it started could not enqueue transactionally at all. Both ids are allocated at
// stage time and carried through the outbox, and the relay publishes under them.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Tx } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { claimOf } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { createJobsFacade, createMemoryOutboxStore, resetJobsFacade } from './outbox';
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
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
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
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
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
    const driver = createMemoryDriver();
    const store = createMemoryOutboxStore();
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
