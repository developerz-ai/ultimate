// How a row ENDS, written once over a harness and run twice: on the memory driver
// (`driver-parity-lifecycle.test.ts`) and on the pg driver against a real Postgres
// (`driver-pg-lifecycle.job.test.ts`). A claim that buries a poison row, a cancel that refuses a
// finished one, a requeue that names its row — one assertion, two drivers.

import { expect, test } from 'bun:test';
import type { Ctx, UltimateError } from '@ultimat3/core';
import { ctxOf, frozenClock, isUltimateError } from '@ultimat3/core';
import { announceExhausted } from './claim-exhausted';
import type { ClaimedJob, JobDriver, JobRecord } from './driver';
import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';
import { memoryJobDriver } from './driver-memory';
import { cancelJob } from './inspect';
import type { OperatorHarness } from './operator-surface-fixture';
import { enqueueItem, itemJob, operatorOf, rowOf, TTL_MS } from './operator-surface-fixture';
import { memorySchedulerState } from './scheduler-state';
import type { JobSettled } from './settled';

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

/** An id of the right shape that nobody queued. */
export const NO_SUCH_JOB = '019ff1c5-0000-7000-8000-00000000dead';

/** The memory driver under an injected clock, seeded straight through the queue. */
export function memoryHarness(): OperatorHarness {
  const clock = frozenClock('2026-10-01T00:00:30.000Z');
  return {
    clock,
    driver: () => Promise.resolve(memoryJobDriver({ clock })),
    elapse: (_driver, ms) => {
      clock.advance(ms);
      return Promise.resolve();
    },
    async seed(driver, { name, state, count, queue = 'default' }) {
      for (let index = 0; index < count; index += 1) {
        const { id } = await driver.enqueue({
          name,
          queue,
          input: { item: `seed-${index}` },
          idempotencyKey: `seed:${name}:${index}`,
          maxAttempts: 1,
        });
        await driver.claim({
          queues: [queue],
          limit: 1,
          visibilityTimeoutMs: TTL_MS,
          workerId: 's',
        });
        if (state === 'done') await driver.ack(id, { workerId: 's', claim: 1 });
        else {
          await driver.nack(id, { workerId: 's', claim: 1, delayMs: 0, deadLetter: true });
        }
        clock.advance(1);
      }
    },
    schedulerState: () => Promise.resolve(memorySchedulerState()),
  };
}

export const refusalOf = async (attempt: Promise<unknown>): Promise<UltimateError> => {
  try {
    await attempt;
  } catch (error) {
    if (isUltimateError(error)) return error;
  }
  return expect.unreachable('expected a framework refusal');
};

/** One pass over `default` by a worker that will never settle what it takes. */
const claimAs = (
  driver: JobDriver,
  workerId: string,
  buried: JobRecord[] = [],
): Promise<readonly ClaimedJob[]> =>
  driver.claim({
    queues: ['default'],
    limit: 5,
    visibilityTimeoutMs: TTL_MS,
    workerId,
    onExhausted: (dead) => {
      buried.push(...dead);
    },
  });

export function driverLifecycleScenarios(label: string, harness: OperatorHarness): void {
  test(`${label}: a job whose worker dies on every attempt is dead-lettered by the claim after maxAttempts`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const settled: JobSettled<unknown>[] = [];
    const handle = itemJob({
      run: () => Promise.resolve(),
      retry: { attempts: 3, jitter: false },
      onSettled: (ending) => {
        settled.push(ending);
        return Promise.resolve();
      },
    });
    const id = await enqueueItem(driver, handle);
    const buried: JobRecord[] = [];

    // Three claims, three workers that die holding it: each lease lapses and the next pass takes
    // the row again — the visibility timeout doing what it is for.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const [claimed] = await claimAs(driver, `doomed-${attempt}`, buried);
      expect(claimed?.id).toBe(id);
      expect(claimed?.attempt).toBe(attempt);
      await harness.elapse(driver, TTL_MS + 1);
    }
    expect(buried).toEqual([]);

    // The fourth pass: the row has had every attempt it was given. It is not handed out.
    expect(await claimAs(driver, 'survivor', buried)).toEqual([]);
    expect(buried.map((row) => row.id)).toEqual([id]);
    expect(buried[0]).toMatchObject({ state: 'dead', attempt: 3, name: handle.name });
    const row = await rowOf(driver, id);
    expect(row).toMatchObject({
      state: 'dead',
      attempt: 3,
      lastError: LEASE_LAPSED_FINAL_ATTEMPT,
    });
    expect(row.claimedBy).toBeUndefined();
    expect(row.visibleAt).toBeUndefined();
    expect((await operator.deadLetters()).map((dead) => dead.id)).toEqual([id]);
    expect((await driver.stats())[0]).toMatchObject({ queue: 'default', dead: 1, running: 0 });
    const totals = (await operator.counterTotals(0)).find((entry) => entry.job === handle.name);
    expect(totals).toMatchObject({ dead: 1, done: 0, retried: 0 });

    // Buried ONCE: later passes find nothing to bury and nothing to announce.
    expect(await claimAs(driver, 'survivor', buried)).toEqual([]);
    expect(buried).toHaveLength(1);
    // The body that never died, only stalled, cannot settle the row it lost.
    expect(await driver.ack(id, { workerId: 'doomed-3', claim: 3 })).toBe(false);
    expect((await rowOf(driver, id)).state).toBe('dead');

    // The claim round's half: the ending is announced from the rows the pass handed back.
    expect(await announceExhausted({ exhausted: buried, workerId: 'survivor', context })).toEqual({
      deadLettered: 1,
      dropped: 0,
    });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      outcome: 'dead-lettered',
      jobId: id,
      attempt: 3,
      error: LEASE_LAPSED_FINAL_ATTEMPT,
      code: undefined,
    });
  });

  test(`${label}: one pass buries the exhausted row and still claims the fresh one beside it`, async () => {
    const driver = await harness.driver();
    const handle = itemJob({ run: () => Promise.resolve() });
    const poison = await enqueueItem(driver, handle);
    // A lease that lapsed with attempts LEFT is the ordinary re-delivery, never a burial.
    const retried = await enqueueItem(
      driver,
      itemJob({ run: () => Promise.resolve(), retry: { attempts: 2 } }),
    );
    expect(await claimAs(driver, 'doomed')).toHaveLength(2);
    await harness.elapse(driver, TTL_MS + 1);
    const fresh = await enqueueItem(driver, handle);

    const buried: JobRecord[] = [];
    const claimed = await claimAs(driver, 'survivor', buried);
    expect(claimed.map((row) => row.id).sort()).toEqual([fresh, retried].sort());
    expect(claimed.find((row) => row.id === retried)?.attempt).toBe(2);
    expect(buried.map((row) => row.id)).toEqual([poison]);
  });

  test(`${label}: cancel stops a live job and refuses every finished one, dead letters included`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const ids = {
      dead: await enqueueItem(driver, handle),
      failed: await enqueueItem(driver, handle),
      done: await enqueueItem(driver, handle),
      cancelled: await enqueueItem(driver, handle),
    };
    const claimed = await claimAs(driver, 'w');
    const by = (id: string) => ({
      workerId: 'w',
      claim: claimed.find((row) => row.id === id)?.claim ?? 0,
    });
    await driver.nack(ids.dead, {
      ...by(ids.dead),
      delayMs: 0,
      error: 'card declined',
      deadLetter: true,
    });
    await driver.nack(ids.failed, { ...by(ids.failed), delayMs: 0, error: 'key busy', fail: true });
    await driver.ack(ids.done, by(ids.done));
    expect((await operator.cancel?.(ids.cancelled, 'stopped on purpose'))?.state).toBe('cancelled');

    const before = await operator.deadLetters();
    expect(before.map((row) => row.id)).toEqual([ids.dead]);
    for (const [state, id] of Object.entries(ids)) {
      const row = await rowOf(driver, id);
      expect(await operator.cancel?.(id, 'oops wrong id')).toBeUndefined();
      const refusal = await refusalOf(cancelJob(driver, id, 'oops wrong id'));
      expect(refusal.code).toBe('X_JOB_NOT_CANCELLABLE');
      expect(String(refusal.cause)).toContain(`"${state}"`);
      // Not a column moved: the record of how the job ended is the operator's evidence.
      expect(await rowOf(driver, id)).toEqual(row);
    }
    expect(await operator.deadLetters()).toEqual(before);

    // The four LIVE states still stop.
    const ready = await enqueueItem(driver, handle);
    const delayed = await enqueueItem(driver, handle, {
      runAt: (await rowOf(driver, ready)).runAt + 3_600_000,
    });
    const running = await enqueueItem(driver, handle);
    const suspended = await enqueueItem(driver, handle);
    const held = await claimAs(driver, 'w2');
    const parked = held.find((row) => row.id === suspended);
    await driver.nack(suspended, {
      workerId: 'w2',
      claim: parked?.claim ?? 0,
      delayMs: 3_600_000,
      countsAsAttempt: false,
      park: true,
    });
    await driver.nack(ready, {
      workerId: 'w2',
      claim: held.find((row) => row.id === ready)?.claim ?? 0,
      delayMs: 0,
      countsAsAttempt: false,
    });
    expect((await rowOf(driver, running)).state).toBe('running');
    expect((await rowOf(driver, suspended)).state).toBe('suspended');
    expect((await rowOf(driver, delayed)).state).toBe('delayed');
    for (const id of [ready, delayed, running, suspended]) {
      expect((await operator.cancel?.(id))?.state).toBe('cancelled');
    }
    expect(await operator.cancel?.(NO_SUCH_JOB)).toBeUndefined();
  });

  test(`${label}: requeue of an id nobody queued is X_JOB_NOT_FOUND, with or without a step`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    for (const attempt of [
      operator.requeue(NO_SUCH_JOB),
      operator.requeue(NO_SUCH_JOB, { fromStep: 'charge' }),
    ]) {
      const refusal = await refusalOf(attempt);
      expect(refusal.code).toBe('X_JOB_NOT_FOUND');
      expect(String(refusal.cause)).toContain(NO_SUCH_JOB);
      expect(String(refusal.cause)).toContain(driver.name);
      expect(refusal.fix).toBe('x jobs list --json');
    }
  });

  test(`${label}: requeue from a step drops that step and the later ones with the row's own move`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const id = await enqueueItem(driver, handle);
    const { runId } = await rowOf(driver, id);
    const put = (name: string, startedAt: number): Promise<void> =>
      driver.steps.put({
        runId,
        name,
        status: 'completed',
        startedAt,
        completedAt: startedAt + 1,
        attempts: 1,
      });
    await put('load', 1_000);
    await put('charge', 2_000);
    await put('receipt', 3_000);

    // A LIVE row is refused, and a refused requeue deletes nothing.
    expect((await refusalOf(operator.requeue(id, { fromStep: 'charge' }))).code).toBe(
      'X_JOB_NOT_REQUEUEABLE',
    );
    expect((await driver.steps.list(runId)).map((step) => step.name)).toEqual([
      'load',
      'charge',
      'receipt',
    ]);

    const [claimed] = await claimAs(driver, 'w');
    await driver.nack(id, {
      workerId: 'w',
      claim: claimed?.claim ?? 0,
      delayMs: 0,
      deadLetter: true,
    });
    const requeued = await operator.requeue(id, { fromStep: 'charge' });
    expect(requeued).toMatchObject({ id, state: 'ready', attempt: 0 });
    expect((await driver.steps.list(runId)).map((step) => step.name)).toEqual(['load']);
  });
}
