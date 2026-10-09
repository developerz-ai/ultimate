// What the idempotency key dedupes AGAINST, on the pg driver and a real Postgres: a LIVE row only
// (ready, delayed, running, suspended). A finished one — done, dead — frees its key, so the same
// work enqueued tomorrow runs. An app reading "dedupe" as "at most once ever" builds a duplicate
// guard the queue does not give it; this file is the answer it can cite. The memory driver's half
// is `idempotency-namespace.test.ts`. Opt-in (`.job.`): booting Postgres costs seconds.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { JobDriver } from './driver';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';

const request = {
  name: 'sendReceipt',
  queue: 'default',
  input: { invoiceId: 'inv-1' },
  idempotencyKey: 'receipt:inv-1',
  maxAttempts: 1,
} as const;

let driver: JobDriver;

beforeEach(async () => {
  const pg = await embeddedPg();
  await pg.reset();
  driver = postgresJobDriver({ executor: pg.executor });
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

const claimOne = async (): Promise<string> => {
  const [claimed] = await driver.claim({
    queues: ['default'],
    limit: 1,
    visibilityTimeoutMs: 60_000,
    workerId: 'w',
  });
  expect(claimed).toBeDefined();
  return claimed?.id ?? '';
};

describe('idempotency on the pg driver · what a key dedupes against', () => {
  test('a queued row and a running row both hold the key', async () => {
    const first = await driver.enqueue(request);
    const queued = await driver.enqueue(request);
    expect(queued).toMatchObject({ deduped: true, id: first.id });

    await claimOne();
    const running = await driver.enqueue(request);
    expect(running).toMatchObject({ deduped: true, id: first.id });
  });

  test('a completed row frees it: the same key enqueues a new job', async () => {
    const first = await driver.enqueue(request);
    const id = await claimOne();
    expect(await driver.ack(id, { workerId: 'w', claim: 1 })).toBe(true);

    const again = await driver.enqueue(request);
    expect(again.deduped).toBe(false);
    expect(again.id).not.toBe(first.id);
  });

  test('a dead-lettered row frees it too', async () => {
    const first = await driver.enqueue(request);
    const id = await claimOne();
    await driver.nack(id, { workerId: 'w', claim: 1, delayMs: 0, deadLetter: true });

    const again = await driver.enqueue(request);
    expect(again.deduped).toBe(false);
    expect(again.id).not.toBe(first.id);
  });
});
