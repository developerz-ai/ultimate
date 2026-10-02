// The second half of the operator-surface scenarios — what a SETTLE writes and what expires:
// counters, the claimer fence, the atomic fire, the worker registry, progress and a paused task.
// Split off `operator-surface-fixture.ts` at the file-size ceiling; same harness, same rule: one
// assertion, two drivers.

import { expect, test } from 'bun:test';
import type { JobState } from './driver';
import { COUNTER_BUCKET_MS } from './introspection';
import type { OperatorHarness } from './operator-surface-fixture';
import {
  enqueueItem,
  itemJob,
  operatorOf,
  rowOf,
  TTL_MS,
  workerOn,
} from './operator-surface-fixture';

export function operatorSettleScenarios(label: string, harness: OperatorHarness): void {
  test(`${label}: counters equal the settled rows, by outcome, in the settle's own bucket`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) ids.push(await enqueueItem(driver, handle));
    const since = (await rowOf(driver, ids[0] ?? '')).createdAt - COUNTER_BUCKET_MS;
    const claimed = await driver.claim({
      queues: ['default'],
      limit: 10,
      visibilityTimeoutMs: TTL_MS,
      workerId: 'worker-a',
    });
    expect(claimed).toHaveLength(7);
    const by = { workerId: 'worker-a', claim: 1 };
    const [a, b, c, retried, dead, refused, shed] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    // Every way a claimed row is settled, once — and what each adds to the job's bucket.
    await driver.ack(a, { ...by, durationMs: 5 });
    await driver.ack(b, { ...by, durationMs: 5 });
    await driver.ack(c, { ...by, durationMs: 5 });
    await driver.nack(retried, { ...by, delayMs: 60_000, error: 'boom', durationMs: 7 });
    await driver.nack(dead, { ...by, delayMs: 0, error: 'boom', deadLetter: true, durationMs: 11 });
    await driver.nack(refused, { ...by, delayMs: 0, fail: true, countsAsAttempt: false });
    // A shed is handed back uncounted: it is not history.
    await driver.nack(shed, { ...by, delayMs: 0, countsAsAttempt: false });

    const totals = (await operator.counterTotals(since)).find((row) => row.job === handle.name);
    expect(totals).toEqual({
      job: handle.name,
      done: 3,
      retried: 1,
      failed: 1,
      dead: 1,
      durationMs: 33,
    });
    // The counts ARE the rows: every terminal state holds as many rows as its counter says.
    const rows = await operator.list({ name: handle.name });
    const perState = new Map<JobState, number>();
    for (const row of rows) perState.set(row.state, (perState.get(row.state) ?? 0) + 1);
    const inState = (wanted: JobState): number => perState.get(wanted) ?? 0;
    expect([inState('done'), inState('failed'), inState('dead')]).toEqual([3, 1, 1]);
    expect(inState('ready')).toBe(2);
    const stats = (await driver.stats()).find((queue) => queue.queue === 'default');
    expect(stats).toMatchObject({ failed: 1, dead: 1 });

    const buckets = await operator.counters({ job: handle.name, sinceMs: since });
    expect(buckets.every((bucket) => bucket.bucketMs === COUNTER_BUCKET_MS)).toBe(true);
    expect(buckets.every((bucket) => bucket.bucketStart % COUNTER_BUCKET_MS === 0)).toBe(true);
    expect(buckets.reduce((sum, bucket) => sum + bucket.done, 0)).toBe(3);
    // Another job's buckets are another job's.
    expect(await operator.counters({ job: 'no-such-job', sinceMs: since })).toEqual([]);
  });

  test(`${label}: a settle from a worker that no longer owns the row lands on nothing`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const id = await enqueueItem(driver, handle);
    const claim = (workerId: string) =>
      driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: TTL_MS, workerId });
    await claim('worker-a');
    // A's lease lapses and B claims the same row. A is still unwinding.
    await harness.elapse(driver, TTL_MS + 1_000);
    expect((await claim('worker-b')).map((row) => row.id)).toEqual([id]);

    // A's nack would hand B's running job to a third worker; A's ack would mark B's run done.
    expect(
      await driver.nack(id, { workerId: 'worker-a', claim: 1, delayMs: 0, error: 'lease lost' }),
    ).toBe(false);
    expect(await driver.ack(id, { workerId: 'worker-a', claim: 1 })).toBe(false);
    const row = await rowOf(driver, id);
    expect(row.state).toBe('running');
    expect(row.claimedBy).toBe('worker-b');
    expect(row.lastError).toBeUndefined();
    // And a stale settle counts nothing.
    expect(await operator.counterTotals(0)).toEqual([]);

    expect(await driver.ack(id, { workerId: 'worker-b', claim: 2 })).toBe(true);
    expect((await rowOf(driver, id)).state).toBe('done');
  });

  // The fence was the WORKER's id, and a worker that takes back its own lapsed job has the same
  // one: the body still unwinding from the first claim settled, renewed and reported on the
  // second. Each claim carries its own ordinal, and every fenced statement reads it.
  test(`${label}: a worker's own EARLIER claim cannot settle, renew or report on the one that replaced it`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const id = await enqueueItem(driver, handle);
    const claim = async () => {
      const [claimed] = await driver.claim({
        queues: ['default'],
        limit: 1,
        visibilityTimeoutMs: TTL_MS,
        workerId: 'worker-a',
      });
      if (claimed === undefined) return expect.unreachable('the row was claimable');
      return claimed;
    };
    const first = await claim();
    // The lease lapses with the body still running, and the SAME worker claims the row again.
    await harness.elapse(driver, TTL_MS + 1_000);
    const second = await claim();
    const stale = { workerId: 'worker-a', claim: first.claim };
    const current = { workerId: 'worker-a', claim: second.claim };

    // The old body learns it lost the row — a renewal that landed would keep it running for ever.
    expect(await driver.heartbeat(id, { visibilityTimeoutMs: TTL_MS, ...stale })).toBe(false);
    await operator.recordProgress(id, stale, { done: 9, total: 9, at: 1 });
    expect((await rowOf(driver, id)).progress).toBeUndefined();
    expect(await driver.nack(id, { ...stale, delayMs: 0, error: 'the old body failed' })).toBe(
      false,
    );
    expect(await driver.ack(id, stale)).toBe(false);
    const row = await rowOf(driver, id);
    expect(row.state).toBe('running');
    expect(row.lastError).toBeUndefined();
    expect(await operator.counterTotals(0)).toEqual([]);
    expect(second.claim).toBeGreaterThan(first.claim);

    // The claim that holds the row does all four.
    expect(await driver.heartbeat(id, { visibilityTimeoutMs: TTL_MS, ...current })).toBe(true);
    await operator.recordProgress(id, current, { done: 1, total: 2, at: 1 });
    expect((await rowOf(driver, id)).progress?.done).toBe(1);
    expect(await driver.ack(id, current)).toBe(true);
    expect((await rowOf(driver, id)).state).toBe('done');
  });

  test(`${label}: an ack that is not counted settles the row and writes no history`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const moved = await enqueueItem(driver, handle);
    const ran = await enqueueItem(driver, handle);
    await driver.claim({
      queues: ['default'],
      limit: 2,
      visibilityTimeoutMs: TTL_MS,
      workerId: 'x-jobs-drain',
    });
    const by = { workerId: 'x-jobs-drain', claim: 1 };
    // What `x jobs drain` sends for a row it moved to another driver.
    expect(await driver.ack(moved, { ...by, counted: false })).toBe(true);
    expect((await rowOf(driver, moved)).state).toBe('done');
    expect(await operator.counterTotals(0)).toEqual([]);
    // The default is counted.
    expect(await driver.ack(ran, by)).toBe(true);
    expect((await operator.counterTotals(0)).map((row) => row.done)).toEqual([1]);
  });

  test(`${label}: an occurrence fires once — the watermark and its jobs move together`, async () => {
    const driver = await harness.driver();
    const state = await harness.schedulerState(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const occurrenceMs = (await rowOf(driver, await enqueueItem(driver, handle))).createdAt;
    const fire = {
      task: `task-of-${handle.name}`,
      occurrenceMs,
      jobs: [
        {
          name: handle.name,
          queue: 'default',
          input: { item: 'nightly' },
          idempotencyKey: `nightly:${occurrenceMs}`,
          maxAttempts: 1,
          runAt: occurrenceMs,
        },
      ],
    };

    const first = await state.fire(driver, fire);
    expect(first?.map((result) => result.deduped)).toEqual([false]);
    expect(await state.lastFiredAt(fire.task)).toBe(occurrenceMs);
    // The job RUNS and finishes — which frees its idempotency key. This is the double-fire: a
    // second fire of the same occurrence used to insert the job again, because the key only
    // dedupes against a LIVE row.
    const worker = workerOn(harness, driver, 'worker-a');
    await worker.tick();

    expect(await state.fire(driver, fire)).toBeUndefined();
    const fired = (await operatorOf(driver).list({ name: handle.name })).filter(
      (row) => row.idempotencyKey === `nightly:${occurrenceMs}`,
    );
    expect(fired.map((row) => row.state)).toEqual(['done']);
    // A LATER occurrence still fires.
    const next = await state.fire(driver, {
      ...fire,
      occurrenceMs: occurrenceMs + 60_000,
      jobs: fire.jobs.map((request) => ({ ...request, idempotencyKey: 'nightly:next' })),
    });
    expect(next?.length).toBe(1);
  });

  test(`${label}: a task's last fire is the occurrence that QUEUED its jobs, never an arming`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const state = await harness.schedulerState(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const occurrenceMs = (await rowOf(driver, await enqueueItem(driver, handle))).createdAt;
    const job = (key: string) => ({
      name: handle.name,
      queue: 'default',
      input: { item: key },
      idempotencyKey: key,
      maxAttempts: 1,
      runAt: occurrenceMs,
    });
    expect(await operator.taskFires()).toEqual([]);

    // Arming a task first seen moves the watermark and queues nothing: not a fire.
    await state.markFired('task-b', occurrenceMs);
    expect(await operator.taskFires()).toEqual([]);

    await state.fire(driver, {
      task: 'task-b',
      occurrenceMs: occurrenceMs + 60_000,
      jobs: [job('b:1')],
    });
    await state.fire(driver, { task: 'task-a', occurrenceMs, jobs: [job('a:1')] });
    const [a, b] = await operator.taskFires();
    // Ordered by task name, whatever order they fired in.
    expect([a?.task, b?.task]).toEqual(['task-a', 'task-b']);
    expect(a?.occurrenceMs).toBe(occurrenceMs);
    expect(b?.occurrenceMs).toBe(occurrenceMs + 60_000);
    // WHEN it was dispatched, on the store's clock — not the instant it was scheduled for.
    expect(b?.firedAt).toBe(a?.firedAt ?? Number.NaN);
    expect(Number.isFinite(a?.firedAt)).toBe(true);

    await harness.elapse(driver, 5_000);
    // Refused: the watermark is already on this occurrence. The record does not move.
    expect(
      await state.fire(driver, { task: 'task-a', occurrenceMs, jobs: [job('a:2')] }),
    ).toBeUndefined();
    // Skipping missed occurrences moves the watermark only.
    await state.markFired('task-a', occurrenceMs + 120_000);
    expect((await operator.taskFires())[0]?.occurrenceMs).toBe(occurrenceMs);

    await state.fire(driver, {
      task: 'task-a',
      occurrenceMs: occurrenceMs + 180_000,
      jobs: [job('a:3')],
    });
    const [later] = await operator.taskFires();
    expect(later?.occurrenceMs).toBe(occurrenceMs + 180_000);
    expect(await operator.taskFires()).toHaveLength(2);
  });

  test(`${label}: a worker is in the registry while it heartbeats, and leaves by expiry`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const announce = (id: string, inFlight: readonly string[] = []) =>
      operator.announceWorker(
        {
          id,
          host: `host-${id}`,
          startedAt: 1_000,
          queues: ['default', 'mail'],
          concurrency: 8,
          inFlight,
        },
        TTL_MS,
      );
    await announce('worker-killed', ['job-1']);
    await announce('worker-alive');
    expect((await operator.workers()).map((worker) => worker.id).sort()).toEqual([
      'worker-alive',
      'worker-killed',
    ]);
    const killed = (await operator.workers()).find((worker) => worker.id === 'worker-killed');
    expect(killed).toMatchObject({
      host: 'host-worker-killed',
      queues: ['default', 'mail'],
      concurrency: 8,
      inFlight: ['job-1'],
      startedAt: 1_000,
    });

    // One heartbeats on; the other was SIGKILLed and announces nothing. No cleanup call.
    await harness.elapse(driver, TTL_MS - 1_000);
    await announce('worker-alive', ['job-2']);
    await harness.elapse(driver, 2_000);

    const live = await operator.workers();
    expect(live.map((worker) => worker.id)).toEqual(['worker-alive']);
    expect(live[0]?.inFlight).toEqual(['job-2']);
    // A clean stop hands the row back at once.
    await operator.forgetWorker('worker-alive');
    expect(await operator.workers()).toEqual([]);
  });

  test(`${label}: progress lands on the row, fenced on the claimer`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    const handle = itemJob({ run: () => Promise.resolve() });
    const id = await enqueueItem(driver, handle);
    await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: TTL_MS,
      workerId: 'worker-a',
    });

    const holder = { workerId: 'worker-a', claim: 1 };
    await operator.recordProgress(id, holder, { done: 3, total: 10, note: 'rows', at: 5_000 });
    expect((await rowOf(driver, id)).progress).toEqual({
      done: 3,
      total: 10,
      note: 'rows',
      at: 5_000,
    });
    // A worker that does not hold the row writes nothing.
    await operator.recordProgress(
      id,
      { workerId: 'worker-b', claim: 1 },
      { done: 9, total: 10, at: 6_000 },
    );
    expect((await rowOf(driver, id)).progress?.done).toBe(3);
  });

  test(`${label}: a paused task is listed, and resumed by name`, async () => {
    const driver = await harness.driver();
    const operator = operatorOf(driver);
    await operator.pauseTask('nightlyDigest');
    await operator.pauseTask('weeklyReport');
    expect((await operator.pausedTasks()).map((entry) => entry.name)).toEqual([
      'nightlyDigest',
      'weeklyReport',
    ]);
    // Queues and tasks are two namespaces: a task's pause holds no queue.
    expect(await operator.pausedQueues()).toEqual([]);
    await operator.resumeTask('nightlyDigest');
    expect((await operator.pausedTasks()).map((entry) => entry.name)).toEqual(['weeklyReport']);
  });
}
