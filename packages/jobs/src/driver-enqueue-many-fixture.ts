// What `JobDriver.enqueueMany` answers, written once and run on both drivers: memory
// (`driver-parity-enqueue-many.test.ts`) and Postgres (`enqueue-many.job.test.ts`). Every scenario
// holds the batch to what `enqueue` would have answered each request, in request order.

import { expect, test } from 'bun:test';
import { UltimateError, uuidV7 } from '@ultimat3/core';
import type { EnqueueRequest, JobDriver, JobRecord } from './driver';

const request = (key: string, extra: Partial<EnqueueRequest> = {}): EnqueueRequest => ({
  name: 'enqueue-many-parity',
  queue: 'default',
  input: { key },
  idempotencyKey: key,
  maxAttempts: 1,
  ...extra,
});

const many = async (driver: JobDriver, requests: readonly EnqueueRequest[]) =>
  driver.enqueueMany(requests);

export type StoredRow = Pick<JobRecord, 'input' | 'state' | 'runAt'>;

/** What a scenario needs of a store beyond the driver: Redis has no `introspect` to read with. */
export interface EnqueueManyHarness {
  /** An EMPTY store's driver. */
  fresh(): Promise<JobDriver>;
  /** The instant the STORE reads as now: a `runAt` past it is delayed. */
  now(): Promise<number>;
  /** One row by id — the three fields a scenario reads — or `undefined`. */
  row(driver: JobDriver, id: string): Promise<StoredRow | undefined>;
  /** How many rows the store holds. */
  count(driver: JobDriver): Promise<number>;
}

/** The harness every driver with `introspect` shares; Redis builds its own over its keys. */
export const introspectedHarness = (
  fresh: () => Promise<JobDriver>,
  now: () => Promise<number>,
): EnqueueManyHarness => ({
  fresh,
  now,
  row: async (driver, id) => driver.introspect?.job(id),
  count: async (driver) => (await driver.introspect?.list())?.length ?? Number.NaN,
});

export function driverEnqueueManyScenarios(label: string, harness: EnqueueManyHarness): void {
  const { fresh } = harness;
  test(`${label}: rows land in request order with their own input`, async () => {
    const driver = await fresh();
    const results = await many(driver, [request('a'), request('b'), request('c')]);
    const inputs = await Promise.all(
      results.map(async (result) => (await harness.row(driver, result.id))?.input),
    );
    expect(inputs).toEqual([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
    expect(results.map((result) => result.deduped)).toEqual([false, false, false]);
  });

  test(`${label}: a key twice in one batch is one job, the second deduped onto the first`, async () => {
    const driver = await fresh();
    const [first, second] = await many(driver, [request('a'), request('a')]);
    expect(second).toEqual({ id: first?.id ?? '', runId: first?.runId ?? '', deduped: true });
    expect(await harness.count(driver)).toBe(1);
  });

  test(`${label}: a key a live job holds answers that job; another tenant's does not`, async () => {
    const driver = await fresh();
    const live = await driver.enqueue(request('a'));
    const [held, other] = await many(driver, [request('a'), request('a', { tenantId: 'org-2' })]);
    expect(held).toEqual({ ...live, deduped: true });
    expect(other?.deduped).toBe(false);
  });

  // One answer on every driver, BEFORE any row: a batch that refused a duplicate would leave the
  // rows after the conflict behind on Postgres and not on a loop. Nothing lands, either side of it.
  test(`${label}: onConflict 'error' in a batch is refused up front, and nothing lands`, async () => {
    const driver = await fresh();
    const outcome = await many(driver, [
      request('a'),
      request('b', { onConflict: 'error' }),
      request('c'),
    ]).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(UltimateError);
    expect((outcome as UltimateError).code).toBe('X_INVARIANT');
    expect(await harness.count(driver)).toBe(0);
  });

  test(`${label}: a stated id and runId land; a future runAt is delayed`, async () => {
    const driver = await fresh();
    const id = uuidV7();
    const runId = uuidV7();
    const [made] = await many(driver, [
      request('a', { id, runId, runAt: (await harness.now()) + 60_000 }),
    ]);
    expect(made).toEqual({ id, runId, deduped: false });
    expect((await harness.row(driver, id))?.state).toBe('delayed');
    const [again] = await many(driver, [request('b', { id, runId })]);
    expect(again).toEqual({ id, runId, deduped: true });
  });

  // `runAt` is epoch ms, and a caller's `now + Math.random() * 1000` is a fraction: the single
  // enqueue takes it, so the batch must too, and store the same instant for it.
  test(`${label}: a fractional runAt lands as the single enqueue lands it`, async () => {
    const driver = await fresh();
    const runAt = (await harness.now()) + 60_000.5;
    const single = await driver.enqueue(request('one', { runAt }));
    const [batched] = await many(driver, [request('many', { runAt })]);
    const one = await harness.row(driver, single.id);
    const other = await harness.row(driver, batched?.id ?? '');
    expect(other?.state).toBe('delayed');
    expect(other?.runAt).toBe(one?.runAt ?? Number.NaN);
  });

  test(`${label}: an empty batch answers []`, async () => {
    const driver = await fresh();
    expect(await many(driver, [])).toEqual([]);
  });
}
