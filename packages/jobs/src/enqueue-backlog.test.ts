// The facade's enqueue options past "insert or dedupe": `maxPending` refuses a producer once the
// queue is drowning (`X_JOB_BACKLOG_FULL`, a 429), and `onConflict: 'replace'` / `expiresAt` reach
// the driver on the direct path and are staged with the row on the transactional one.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import type { JobDefinition, JobHandle } from './job';
import { job, resetJobs } from './job';
import { memoryOutboxStore, outboxJobsFacade, resetJobsFacade, setJobsFacade } from './outbox';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

interface Ping {
  readonly n: number;
}

const declare = (extra: Partial<JobDefinition<Ping>> = {}): JobHandle<Ping> =>
  job<Ping>({
    tenant: 'none',
    name: 'ping',
    queue: 'pings',
    input: passthrough<Ping>(),
    idempotencyKey: ({ n }) => `ping:${n}`,
    retry: { attempts: 1, jitter: 'none' },
    run: () => Promise.resolve(),
    ...extra,
  });

let driver: JobDriver;
let tx: Tx | undefined;

beforeEach(() => {
  resetJobs();
  driver = memoryJobDriver();
  tx = undefined;
  setJobsFacade(outboxJobsFacade({ store: memoryOutboxStore(), driver }, () => tx));
});

afterEach(() => {
  resetJobsFacade();
});

const codeOf = async (attempt: Promise<unknown>): Promise<string | undefined> =>
  attempt.then(
    () => undefined,
    (error: unknown) => (isUltimateError(error) ? error.code : 'not-coded'),
  );

describe('job({ maxPending })', () => {
  test('an enqueue past the waiting rows of its queue is X_JOB_BACKLOG_FULL', async () => {
    const ping = declare({ maxPending: 2 });
    await ping.enqueue({ n: 1 });
    await ping.enqueue({ n: 2 });
    expect(await codeOf(ping.enqueue({ n: 3 }))).toBe('X_JOB_BACKLOG_FULL');
    // Claimed rows no longer wait: room again.
    await driver.claim({ queues: ['pings'], limit: 1, visibilityTimeoutMs: 30_000, workerId: 'w' });
    expect((await ping.enqueue({ n: 3 })).deduped).toBe(false);
  });

  test('a batch that would cross it is refused whole, before a row is written', async () => {
    const ping = declare({ maxPending: 2 });
    await ping.enqueue({ n: 1 });
    expect(await codeOf(ping.enqueueMany([{ n: 2 }, { n: 3 }]))).toBe('X_JOB_BACKLOG_FULL');
    expect(await driver.backlog?.('pings', 10)).toBe(1);
  });

  test('the staged path is refused at stage time too, inside the caller transaction', async () => {
    const ping = declare({ maxPending: 1 });
    await ping.enqueue({ n: 1 });
    tx = { id: 'tx-1' } as unknown as Tx;
    expect(await codeOf(ping.enqueue({ n: 2 }))).toBe('X_JOB_BACKLOG_FULL');
  });

  test('an enqueue that adds no row is not refused at the ceiling: a dedupe, a replace', async () => {
    const ping = declare({ maxPending: 2 });
    await ping.enqueue({ n: 1 }, { runAt: Date.UTC(9999, 0, 1) });
    await ping.enqueue({ n: 2 });
    // Full, and both keys are held by waiting rows: neither call adds one.
    expect((await ping.enqueue({ n: 1 }, { onConflict: 'replace', runAt: 1 })).deduped).toBe(true);
    expect((await ping.enqueue({ n: 2 })).deduped).toBe(true);
    expect(await driver.backlog?.('pings', 10)).toBe(2);
    // A new key still would, and is refused.
    expect(await codeOf(ping.enqueue({ n: 3 }))).toBe('X_JOB_BACKLOG_FULL');
  });

  test("a transaction's own staged rows count toward it, and a key staged twice once", async () => {
    const ping = declare({ maxPending: 2 });
    tx = { id: 'tx-staged' } as unknown as Tx;
    await ping.enqueue({ n: 1 });
    await ping.enqueue({ n: 1 }, { onConflict: 'replace' });
    await ping.enqueue({ n: 2 });
    // Nothing is committed, so the driver counts none of the three — the ledger counts two rows.
    expect(await driver.backlog?.('pings', 10)).toBe(0);
    expect(await codeOf(ping.enqueue({ n: 3 }))).toBe('X_JOB_BACKLOG_FULL');
    expect(await codeOf(ping.enqueueMany([{ n: 3 }]))).toBe('X_JOB_BACKLOG_FULL');
    // Another transaction has staged nothing.
    tx = { id: 'tx-other' } as unknown as Tx;
    expect(await codeOf(ping.enqueue({ n: 3 }))).toBeUndefined();
  });

  test('a maxPending that is no count is refused where it is declared', () => {
    expect(() => declare({ maxPending: 0 })).toThrow();
    resetJobs();
    expect(() => declare({ maxPending: Number.NaN })).toThrow();
  });

  test('without it, nothing is counted', async () => {
    let counted = 0;
    driver = {
      ...memoryJobDriver(),
      backlog: () => {
        counted += 1;
        return Promise.resolve(0);
      },
    };
    setJobsFacade(outboxJobsFacade({ store: memoryOutboxStore(), driver }, () => undefined));
    await declare().enqueue({ n: 1 });
    expect(counted).toBe(0);
  });
});

describe("enqueue({ onConflict: 'replace', expiresAt })", () => {
  test('the direct path hands both to the driver: the waiting row takes the newer input', async () => {
    const ping = declare();
    const key = { n: 1 };
    const first = await ping.enqueue(key, { runAt: Date.UTC(9999, 0, 1) });
    const again = await ping.enqueue(key, { runAt: 1, onConflict: 'replace', expiresAt: 2 });
    expect(again).toMatchObject({ id: first.id, deduped: true });
    const row = await driver.introspect?.job(first.id);
    expect(row?.state).toBe('ready');
  });

  test('the staged path stages both for the relay (outbox-debounce.test.ts), refusing neither', async () => {
    const ping = declare();
    tx = { id: 'tx-1' } as unknown as Tx;
    expect(await codeOf(ping.enqueue({ n: 1 }, { onConflict: 'replace' }))).toBeUndefined();
    expect(await codeOf(ping.enqueue({ n: 2 }, { expiresAt: 1 }))).toBeUndefined();
  });
});
