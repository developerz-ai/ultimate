// The relay's batch publish: one `enqueueMany` and one `markPublishedMany` per claimed batch when
// the store can mark a batch, and the row loop — in order, stopping at the failing row — when the
// batch fails or the store cannot. `outbox-relay.test.ts` holds the drain; this the publish.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { EnqueueRequest, JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import type { OutboxRecord, OutboxStore } from './outbox';
import { memoryOutboxStore } from './outbox';
import { outboxRelay } from './outbox-relay';

const record = (index: number): OutboxRecord => ({
  id: `0190a000-0000-7000-8000-00000000000${index}`,
  runId: `0190a000-0000-7000-9000-00000000000${index}`,
  job: 'notifySubscribers',
  queue: 'default',
  input: { index },
  idempotencyKey: `notify:${index}`,
  maxAttempts: 1,
  runAt: 0,
  stagedAt: 0,
});

const poison = (): UltimateError =>
  new UltimateError({ code: 'X_DRIVER_UNAVAILABLE', cause: 'pool timeout', fix: 'retry' });

interface Calls {
  readonly batches: number[];
  readonly singles: string[];
  readonly markedMany: number[];
  readonly marked: string[];
}

/** Three committed rows, and a driver and store whose every call is recorded. */
async function rig(options: { failBatch?: boolean; failRow?: string; batchMark?: boolean }) {
  const calls: Calls = { batches: [], singles: [], markedMany: [], marked: [] };
  const memory = memoryOutboxStore();
  const tx = { id: 'tx' } as unknown as Tx;
  for (const index of [1, 2, 3]) await memory.stage(tx, record(index));
  await memory.commit(tx);
  const base = memoryJobDriver();
  const { markPublishedMany: storeMany, ...plain } = memory;
  const driver: JobDriver = {
    ...base,
    enqueue: (request: EnqueueRequest) => {
      calls.singles.push(request.idempotencyKey);
      if (request.idempotencyKey === options.failRow) return Promise.reject(poison());
      return base.enqueue(request);
    },
    enqueueMany: (requests: readonly EnqueueRequest[]) => {
      calls.batches.push(requests.length);
      if (options.failBatch === true) return Promise.reject(poison());
      return base.enqueueMany(requests);
    },
  };
  const store: OutboxStore = {
    ...plain,
    markPublished: (id, at, claimant) => {
      calls.marked.push(id);
      return memory.markPublished(id, at, claimant);
    },
    ...(options.batchMark === false
      ? {}
      : {
          markPublishedMany: (ids: readonly string[], at: number, claimant?: string) => {
            calls.markedMany.push(ids.length);
            return (
              storeMany?.(ids, at, claimant) ?? expect.unreachable('memory has the batch mark')
            );
          },
        }),
  };
  return { relay: outboxRelay({ store, driver, drainOnShutdown: false }), calls, memory };
}

describe('the relay publishes a claimed batch in two calls', () => {
  test('one enqueueMany and one markPublishedMany for the batch, no row calls', async () => {
    const { relay, calls, memory } = await rig({});
    expect(await relay.tick()).toBe(3);
    expect(calls).toEqual({ batches: [3], singles: [], markedMany: [3], marked: [] });
    expect(await memory.pendingCount()).toBe(0);
  });

  test('a batch that throws falls back to the row loop, in order, to the failing row', async () => {
    const { relay, calls, memory } = await rig({ failBatch: true, failRow: 'notify:2' });
    expect(await relay.tick()).toBe(1);
    expect(calls.batches).toEqual([3]);
    expect(calls.singles).toEqual(['notify:1', 'notify:2']);
    expect(calls.marked).toEqual([record(1).id]);
    // The rows past the poison are released, not held for the lease: the next tick claims them.
    expect(await memory.pendingCount()).toBe(2);
    expect((await memory.claim(10)).map((row) => row.id)).toEqual([record(2).id, record(3).id]);
  });

  test('a store without markPublishedMany keeps the row loop', async () => {
    const { relay, calls } = await rig({ batchMark: false });
    expect(await relay.tick()).toBe(3);
    expect(calls.singles).toEqual(['notify:1', 'notify:2', 'notify:3']);
    expect(calls.batches).toEqual([]);
  });
});
