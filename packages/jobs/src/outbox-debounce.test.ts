// Debounce (`onConflict: 'replace'`) and expiry (`expiresAt`) enqueued INSIDE a transaction: the
// staged row carries both, and the relay publishes such a row through the single-row enqueue —
// `enqueueMany` refuses either — while the plain rows around it keep batching, in staged order.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FrozenClock } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { EnqueueRequest, JobDriver, JobRecord } from './driver';
import type { MemoryJobDriver } from './driver-memory';
import { memoryJobDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import type { MemoryOutboxStore } from './outbox';
import { memoryOutboxStore, outboxJobsFacade, resetJobsFacade, setJobsFacade } from './outbox';
import { outboxRelay } from './outbox-relay';

interface Ping {
  readonly n: number;
  readonly v?: number;
}

const passthrough: StandardSchemaV1<unknown, Ping> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value) => ({ value: value as Ping }),
  },
};

let clock: FrozenClock;
let driver: MemoryJobDriver;
let store: MemoryOutboxStore;
let ping: JobHandle<Ping>;
let txs = 0;

beforeEach(() => {
  resetJobs();
  clock = frozenClock('2026-11-12T09:00:00.000Z');
  driver = memoryJobDriver({ clock });
  store = memoryOutboxStore({ clock });
  ping = job<Ping>({
    tenant: 'none',
    name: 'ping',
    queue: 'pings',
    input: passthrough,
    idempotencyKey: ({ n }) => `ping:${n}`,
    retry: { attempts: 1, jitter: 'none' },
    run: () => Promise.resolve(),
  });
});

afterEach(() => {
  resetJobsFacade();
});

/** Run `body` with a transaction open on the facade, then commit it the way the tx runner does. */
async function inTx(body: () => Promise<unknown>, over: JobDriver = driver): Promise<void> {
  txs += 1;
  const tx = { id: `tx-${txs}`, onRollback: () => undefined } as Tx;
  setJobsFacade(outboxJobsFacade({ store, driver: over, clock }, () => tx));
  await body();
  await store.commit(tx);
}

const claim = (onExhausted?: (rows: readonly JobRecord[]) => void) =>
  driver.claim({
    queues: ['pings'],
    limit: 10,
    visibilityTimeoutMs: 30_000,
    workerId: 'w',
    ...(onExhausted === undefined ? {} : { onExhausted }),
  });

describe('a staged enqueue carries onConflict and expiresAt', () => {
  test('the facade stages them instead of refusing them', async () => {
    const expiresAt = clock.now().getTime() + 60_000;
    await inTx(() => ping.enqueue({ n: 1 }, { onConflict: 'replace', expiresAt }));
    const [row] = await store.claim(10);
    expect(row).toMatchObject({ onConflict: 'replace', expiresAt });
  });

  test("a plain one carries neither, and 'dedupe' is the default, not a field", async () => {
    await inTx(() => ping.enqueue({ n: 1 }, { onConflict: 'dedupe' }));
    const [row] = await store.claim(10);
    expect(row === undefined ? [] : Object.keys(row)).not.toContain('onConflict');
    expect(row === undefined ? [] : Object.keys(row)).not.toContain('expiresAt');
  });

  test('an expiresAt that is no instant is refused at stage, in the caller', async () => {
    await expect(inTx(() => ping.enqueue({ n: 1 }, { expiresAt: Number.NaN }))).rejects.toThrow(
      'expiresAt',
    );
    expect(await store.pendingCount()).toBe(0);
  });
});

describe('the relay publishes a debounced or expiring row through the single enqueue', () => {
  test('two transactions debouncing one key leave one waiting job with the latest input', async () => {
    const later = clock.now().getTime() + 5_000;
    await inTx(() => ping.enqueue({ n: 1, v: 1 }, { runAt: later, onConflict: 'replace' }));
    await inTx(() => ping.enqueue({ n: 1, v: 2 }, { runAt: later, onConflict: 'replace' }));
    const relay = outboxRelay({ store, driver, clock, drainOnShutdown: false });
    expect(await relay.tick()).toBe(2);
    clock.advance(5_000);
    const taken = await claim();
    expect(taken.map((row) => row.input)).toEqual([{ n: 1, v: 2 }]);
  });

  test('a published row past its expiresAt is settled expired by the claim, never run', async () => {
    const expiresAt = clock.now().getTime() + 1_000;
    await inTx(() => ping.enqueue({ n: 1 }, { expiresAt }));
    await outboxRelay({ store, driver, clock, drainOnShutdown: false }).tick();
    clock.advance(2_000);
    const buried: (string | undefined)[] = [];
    expect(await claim((rows) => buried.push(...rows.map((row) => row.lastError)))).toEqual([]);
    expect(buried).toEqual(['expired']);
  });

  test('plain rows keep batching around it, and the batch publishes in staged order', async () => {
    const calls: string[] = [];
    const recording: JobDriver = {
      ...driver,
      enqueue: (request: EnqueueRequest) => {
        calls.push(`one:${request.idempotencyKey}`);
        return driver.enqueue(request);
      },
      enqueueMany: (requests: readonly EnqueueRequest[]) => {
        calls.push(`many:${requests.map((each) => each.idempotencyKey).join(',')}`);
        return driver.enqueueMany(requests);
      },
    };
    await inTx(async () => {
      await ping.enqueue({ n: 1 });
      await ping.enqueue({ n: 2 });
      await ping.enqueue({ n: 3 }, { onConflict: 'replace' });
      await ping.enqueue({ n: 4 });
      await ping.enqueue({ n: 5 }, { expiresAt: clock.now().getTime() + 60_000 });
    }, recording);
    const relay = outboxRelay({ store, driver: recording, clock, drainOnShutdown: false });
    expect(await relay.tick()).toBe(5);
    expect(calls).toEqual(['many:ping:1,ping:2', 'one:ping:3', 'many:ping:4', 'one:ping:5']);
    expect(await store.pendingCount()).toBe(0);
  });
});
