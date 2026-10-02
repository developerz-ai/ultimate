// What a driver ANSWERS, where the two used to answer differently: the stack a nack leaves, the
// order `stats()` lists queues in, a cursor that is not one, and what a bulk requeue says is left.
// Written once over a harness and run on memory (`driver-parity-lifecycle.test.ts`) and on a real
// Postgres (`driver-pg-lifecycle.job.test.ts`).

import { expect, test } from 'bun:test';
import type { JobDriver } from './driver';
import { NO_SUCH_JOB, refusalOf } from './driver-lifecycle-fixture';
import { MAX_BULK_ROWS, MAX_JOB_PAGE } from './introspection';
import type { OperatorHarness } from './operator-surface-fixture';
import { enqueueItem, itemJob, operatorOf, rowOf, TTL_MS } from './operator-surface-fixture';

const claimOne = (driver: JobDriver) =>
  driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: TTL_MS, workerId: 'w' });

export function driverAnswerScenarios(label: string, harness: OperatorHarness): void {
  test(`${label}: a failure recorded with no stack does not keep the previous failure's stack`, async () => {
    const driver = await harness.driver();
    const handle = itemJob({ run: () => Promise.resolve(), retry: { attempts: 5 } });
    const id = await enqueueItem(driver, handle);

    await claimOne(driver);
    await driver.nack(id, {
      workerId: 'w',
      claim: 1,
      delayMs: 0,
      error: 'first',
      stack: 'at a.ts:1',
    });
    expect(await rowOf(driver, id)).toMatchObject({
      lastError: 'first',
      lastErrorStack: 'at a.ts:1',
    });

    // A hand-back with NO error — a shed — says nothing about the last failure and keeps both.
    await claimOne(driver);
    await driver.nack(id, { workerId: 'w', claim: 2, delayMs: 0, countsAsAttempt: false });
    expect(await rowOf(driver, id)).toMatchObject({
      lastError: 'first',
      lastErrorStack: 'at a.ts:1',
    });

    // A NEW failure that carried no stack: the old stack is some other error's diagnosis.
    await claimOne(driver);
    await driver.nack(id, { workerId: 'w', claim: 3, delayMs: 0, error: 'second' });
    const row = await rowOf(driver, id);
    expect(row.lastError).toBe('second');
    expect(row.lastErrorStack).toBeUndefined();
    expect('lastErrorStack' in row).toBe(false);
  });

  test(`${label}: stats lists queues by code unit, whatever the locale or the collation`, async () => {
    const driver = await harness.driver();
    const handle = itemJob({ run: () => Promise.resolve() });
    for (const queue of ['mail', 'Zeta', '_internal', 'default', 'émile']) {
      await enqueueItem(driver, handle, { queue });
    }
    expect((await driver.stats()).map((row) => row.queue)).toEqual([
      'Zeta',
      '_internal',
      'default',
      'mail',
      'émile',
    ]);
  });

  test(`${label}: a cursor whose id is not a uuid is X_JOB_PAGE_INVALID, after or before`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    await enqueueItem(driver, itemJob({ run: () => Promise.resolve() }));
    for (const cursor of ['123:not-a-uuid', '123:019ff1c5', `123:${NO_SUCH_JOB}x`, '123:']) {
      for (const filter of [{ after: cursor }, { before: cursor }]) {
        const refusal = await refusalOf(operator.list(filter));
        expect(refusal.code).toBe('X_JOB_PAGE_INVALID');
        // What the caller typed is not echoed: a cursor is input from the far side of a URL.
        // And it names the cursor that was actually handed over, never always `after`.
        const named = 'after' in filter ? 'an after cursor' : 'a before cursor';
        expect(String(refusal.cause)).toContain(`${named} that no page produced`);
        expect(refusal.fix).not.toContain('#');
        expect(String(refusal.cause)).not.toContain(cursor);
      }
    }
    // A well-formed cursor naming no row is a page, never a refusal.
    expect(await operator.list({ after: `123:${NO_SUCH_JOB}` })).toEqual([]);
    expect(await operator.list({ after: `123:${NO_SUCH_JOB.toUpperCase()}` })).toEqual([]);
  });

  test(`${label}: requeueMany spends its bound on rows it can move, and remaining is what a second call would`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const held = itemJob({ run: () => Promise.resolve() });
    const free = itemJob({ run: () => Promise.resolve() });
    await harness.seed(driver, {
      name: held.name,
      state: 'dead',
      count: MAX_BULK_ROWS,
      queue: 'bulk',
    });
    await harness.elapse(driver, 1_000);
    // The one row a requeue CAN move is the newest, so a bound spent oldest-first never reaches it.
    await harness.seed(driver, { name: free.name, state: 'dead', count: 1, queue: 'bulk' });
    // A live job takes every one of the thousand keys.
    let after: string | undefined;
    for (let page = 0; page < MAX_BULK_ROWS / MAX_JOB_PAGE; page += 1) {
      const rows = await operator.list({
        name: held.name,
        limit: MAX_JOB_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      for (const row of rows) {
        await driver.enqueue({
          name: row.name,
          queue: 'holders',
          input: {},
          idempotencyKey: row.idempotencyKey,
          maxAttempts: 1,
        });
      }
      const last = rows[rows.length - 1];
      after = last === undefined ? undefined : `${last.createdAt}:${last.id}`;
    }
    expect((await driver.stats()).find((row) => row.queue === 'holders')?.ready).toBe(
      MAX_BULK_ROWS,
    );

    // The thousand held rows are not this verb's to move — now or on any later call while their
    // keys are held — so they are neither affected nor "remaining": a caller looping until zero ends.
    expect(await operator.requeueMany({ state: 'dead', queue: 'bulk' })).toEqual({
      affected: 1,
      remaining: 0,
    });
    expect(await operator.requeueMany({ state: 'dead', queue: 'bulk' })).toEqual({
      affected: 0,
      remaining: 0,
    });
    expect((await driver.stats()).find((row) => row.queue === 'bulk')).toMatchObject({
      dead: MAX_BULK_ROWS,
      ready: 1,
    });
  });

  test(`${label}: two dead rows of one key are one requeue, and the sibling is not left as remaining`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const ids: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      const { id } = await driver.enqueue({
        name: handle.name,
        queue: 'default',
        input: {},
        idempotencyKey: 'same-key',
        maxAttempts: 1,
      });
      ids.push(id);
      const [claimed] = await claimOne(driver);
      await driver.nack(id, {
        workerId: 'w',
        claim: claimed?.claim ?? 0,
        delayMs: 0,
        deadLetter: true,
      });
      await harness.elapse(driver, 10);
    }
    expect(await operator.requeueMany({ state: 'dead', name: handle.name })).toEqual({
      affected: 1,
      remaining: 0,
    });
    // The OLDER of the two, as `distinct on … order by created_at` picks it.
    expect((await rowOf(driver, ids[0] ?? '')).state).toBe('ready');
    expect((await rowOf(driver, ids[1] ?? '')).state).toBe('dead');
  });

  test(`${label}: a step written under a claim that was taken over is refused, and the holder's lands`, async () => {
    const driver = await harness.driver();
    const handle = itemJob({ run: () => Promise.resolve(), retry: { attempts: 3 } });
    const id = await enqueueItem(driver, handle);
    const [stalled] = await claimOne(driver);
    if (stalled === undefined) return expect.unreachable('the job was not claimable');
    // The first worker stalls past its lease; the queue hands the row to another.
    await harness.elapse(driver, TTL_MS + 1);
    const [holder] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: TTL_MS,
      workerId: 'w2',
    });
    if (holder === undefined) return expect.unreachable('the lapsed job was not re-claimable');
    const step = (output: string) => ({
      runId: stalled.runId,
      name: 'charge',
      status: 'completed' as const,
      output,
      startedAt: 1_790_000_000_000,
      completedAt: 1_790_000_000_001,
      attempts: 1,
    });
    const fence = (claimed: typeof stalled) => ({
      job: handle.name,
      jobId: id,
      workerId: claimed.claimedBy,
      claim: claimed.claim,
    });

    // The stalled body wakes and writes its result onto a run it no longer owns.
    const refused = await refusalOf(driver.steps.put(step('stale'), fence(stalled)));
    expect(refused.code).toBe('X_JOB_LEASE_LOST');
    expect(await driver.steps.list(stalled.runId)).toEqual([]);

    await driver.steps.put(step('held'), fence(holder));
    expect((await driver.steps.get(stalled.runId, 'charge'))?.output).toBe('held');
    // And it cannot be overwritten from behind either.
    await refusalOf(driver.steps.put(step('stale'), fence(stalled)));
    expect((await driver.steps.get(stalled.runId, 'charge'))?.output).toBe('held');

    // A settled row holds no claim at all: the body that outlives its own ack writes nothing.
    await driver.ack(id, { workerId: 'w2', claim: holder.claim });
    expect((await refusalOf(driver.steps.put(step('late'), fence(holder)))).code).toBe(
      'X_JOB_LEASE_LOST',
    );
  });
}
