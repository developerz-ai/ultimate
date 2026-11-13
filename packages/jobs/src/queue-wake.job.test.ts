// The cross-process wake on a real Postgres: the STATEMENTS that announce a row, and the loops
// they wake. "Another process" here is a second driver over the same database that raises no
// in-process signal — exactly what a web pod is to a worker pod. Opt-in (`.job.`): booting
// Postgres costs seconds. The embedded database's `now()` is frozen with the test clock, so one
// notification slot lasts until rows are aged out of it — which makes "one per slot" exact.
// Fake time (`fake-time-fixture.ts`, installed after the boot) moves every loop's timers, so a
// bound asserted is counted in the timers the loops armed, never in what a loaded runner did.

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { JobDriver } from './driver';
import { postgresJobDriver } from './driver-pg';
import {
  JOBS_WAKE_CHANNEL,
  OUTBOX_WAKE_CHANNEL,
  WAKE_DUE_WITHIN_MS,
  WAKE_SLOT_MS,
} from './driver-pg-wake-sql';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import { setWakeLive, wakeIsLive } from './enqueue-signal';
import { useFakeTime } from './fake-time-fixture';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { postgresOutboxStore } from './outbox-pg';
import { outboxRelay } from './outbox-relay';
import type { QueueWake } from './queue-wake';
import { startQueueWake } from './queue-wake';
import { postgresSchedulerState } from './scheduler-pg';
import { jobWorker } from './worker';
import type { Worker } from './worker-types';

/**
 * The embedded Postgres is booted, and the whole jobs DDL applied, inside the FIRST `beforeEach` —
 * so the suite's first test carries the boot on Bun's 5000ms default, which three of these booting
 * at once in the `job` step's parallel run passed with nothing wrong. The boot's own budget is the
 * honest ceiling, as `packages/entity/src/sealed-column.test.ts` sets it for the same reason — and
 * it must sit ABOVE the boot, never under it: bun cancels nothing, so a hook that times out
 * mid-boot completed later anyway and registered these taps a SECOND time, doubling every payload
 * the rest of the file read. `test-database.test.ts` budgets the same WASM compile plus initdb
 * generously; this box measures the boot alone at 32-42s (2026-10).
 */
const PGLITE_BOOT_MS = 120_000;
setDefaultTimeout(PGLITE_BOOT_MS);

const context = () => ctxOf({ role: 'worker', buildId: 'test' });
/** The floor every loop here polls at, and so the unit a "small bound" is counted in. */
const FLOOR_MS = 25;
/** Observation window with no wake: well below the no-wake arm's poll. */
const SOON_MS = 250;
/** Completion budget, in fake time, separate from the latency assertion. */
const BUDGET_MS = 2_000;
/**
 * The ceiling those loops idle at, and so the poll's own guarantee — `IDLE_POLL_CEILING_MS` in
 * `idle-backoff.ts`, which is what bounds a job committed by another process when no notification
 * ever crosses.
 */
const POLL_CEILING_MS = 2_000;
/**
 * The bound the two cross-process cases assert: ten floors, an eighth of the ceiling. It used to be
 * a LOADED number (1 s), because these loops ran on the wall clock and four PGlite instances on one
 * box measured the wake path at 206 ms. On fake time a slice passes only when this file moves it,
 * so the wake path measures 5-10 ms however loaded the runner, and the poll path exactly the
 * ceiling. Both loops idle at POLL_CEILING_MS first, so only a wake lands inside this bound.
 */
const WAKE_BOUND_MS = 10 * FLOOR_MS;

let pg: EmbeddedPg;
let heard: { channel: string; payload: string }[] = [];
let taps: { unlisten(): Promise<void> }[] = [];
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
  heard = [];
  // A plain listener beside the one under test: what any session on the channel reads.
  taps = [
    await pg.listener.listen(JOBS_WAKE_CHANNEL, (payload) => {
      heard.push({ channel: JOBS_WAKE_CHANNEL, payload });
    }),
    await pg.listener.listen(OUTBOX_WAKE_CHANNEL, (payload) => {
      heard.push({ channel: OUTBOX_WAKE_CHANNEL, payload });
    }),
  ];
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const tap of taps) await tap.unlisten();
  resetJobs();
  setWakeLive(false);
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

/** Installed after the boot above: PGlite starts on real timers, every loop runs on fake ones. */
const time = useFakeTime();

/**
 * Notifications are delivered in this process, behind the statement that sent them: a few turns of
 * the event loop are their turn. The database is in-process, so no wall-clock wait is theirs.
 */
const delivered = async (): Promise<typeof heard> => {
  await time.flush();
  return heard;
};

const payloads = async (channel: string): Promise<string[]> =>
  (await delivered()).filter((entry) => entry.channel === channel).map((entry) => entry.payload);

/** Moves fake time in `step` slices until `condition` holds; red past `budgetMs` of it. */
const until = (
  condition: () => boolean | Promise<boolean>,
  budgetMs = 5_000,
  step = 5,
): Promise<void> => time.until(condition, budgetMs, step);

const enqueue = (
  driver: JobDriver,
  name: string,
  item: string,
  extra: { queue?: string; runAt?: number } = {},
) =>
  driver.enqueue({
    name,
    queue: extra.queue ?? 'default',
    input: { item },
    idempotencyKey: `wake:${item}`,
    maxAttempts: 1,
    ...(extra.runAt === undefined ? {} : { runAt: extra.runAt }),
  });

/** A worker on its own driver, started, and idled until its wait is past `ms`. */
async function idleWorker(ms: number, idlePollMaxMs = 60_000): Promise<Worker> {
  const worker = jobWorker({
    driver: postgresJobDriver({ executor: pg.executor }),
    pollIntervalMs: FLOOR_MS,
    idlePollMaxMs,
    heartbeatIntervalMs: 3_600_000,
    context,
    drainOnShutdown: false,
  });
  worker.start();
  cleanups.push(() => worker.stop());
  // The ramp to the 2 s ceiling is 5.2 s of timer arithmetic (25 doubling to 2000), in fake time
  // moved a floor at a time. `until` returns the moment the condition holds; the budget bounds
  // pathology, not the wait.
  await until(async () => (await worker.stats()).pollDelayMs >= ms, 15_000, FLOOR_MS);
  return worker;
}

async function liveWake(): Promise<QueueWake> {
  const wake = startQueueWake({ listener: pg.listener, executor: pg.executor });
  cleanups.push(() => wake.stop());
  await until(() => wakeIsLive());
  heard = [];
  return wake;
}

describe('what a statement announces', () => {
  test('an enqueue notifies its QUEUE NAME and nothing else, once per slot', async () => {
    const driver = postgresJobDriver({ executor: pg.executor });
    const handle = itemJob({ run: () => Promise.resolve() });
    await enqueue(driver, handle.name, 'a', { queue: 'mail' });
    await enqueue(driver, handle.name, 'b', { queue: 'mail' });
    await enqueue(driver, handle.name, 'c', { queue: 'mail' });
    await enqueue(driver, handle.name, 'd');
    // No id, no input, no tenant: the queue name, and one per queue however many rows.
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual(['mail', 'default']);

    // The slot has passed: the next row speaks again.
    await pg.age(WAKE_SLOT_MS);
    await enqueue(driver, handle.name, 'e', { queue: 'mail' });
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual(['mail', 'default', 'mail']);
  });

  test('a row due after the longest rest, or never inserted, announces nothing', async () => {
    const driver = postgresJobDriver({ executor: pg.executor });
    const handle = itemJob({ run: () => Promise.resolve() });
    // Due after the longest rest: the rest ends first, and its own pass reads the due time.
    await enqueue(driver, handle.name, 'later', { runAt: Date.now() + WAKE_DUE_WITHIN_MS + 1_000 });
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual([]);

    await pg.age(WAKE_SLOT_MS);
    // Due inside a rest: a resting worker must re-read its horizon.
    await enqueue(driver, handle.name, 'skewed', { runAt: Date.now() + WAKE_DUE_WITHIN_MS / 2 });
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual(['default']);

    await pg.age(WAKE_SLOT_MS);
    // The live key is taken: `do nothing` fired, no row, no wake.
    expect((await enqueue(driver, handle.name, 'skewed')).deduped).toBe(true);
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual(['default']);
  });

  test('an outbox stage notifies on COMMIT, never on rollback, and not behind a row already waiting', async () => {
    const tx = { id: 'tx' } as unknown as Tx;
    let bound = pg.executor;
    const store = postgresOutboxStore({ executor: pg.executor, txExecutor: () => bound });
    const row = (id: string) => ({
      id,
      runId: id,
      job: 'notify',
      queue: 'default',
      input: { item: id },
      idempotencyKey: `stage:${id}`,
      maxAttempts: 1,
      runAt: Date.now(),
      stagedAt: Date.now(),
    });

    await pg.transaction(async (executor) => {
      bound = executor;
      await store.stage(tx, row('00000000-0000-7000-8000-000000000001'));
    }, 'rollback');
    expect(await payloads(OUTBOX_WAKE_CHANNEL)).toEqual([]);

    await pg.transaction(async (executor) => {
      bound = executor;
      await store.stage(tx, row('00000000-0000-7000-8000-000000000002'));
      // Two rows of one transaction: the second sees the first waiting.
      await store.stage(tx, row('00000000-0000-7000-8000-000000000003'));
      // Not before the commit.
      expect(await payloads(OUTBOX_WAKE_CHANNEL)).toEqual([]);
    });
    // The payload names nothing: a relay serves every queue.
    expect(await payloads(OUTBOX_WAKE_CHANNEL)).toEqual(['']);

    // Rows are waiting unclaimed, so a relay is already on its way: no second notification.
    await pg.transaction(async (executor) => {
      bound = executor;
      await store.stage(tx, row('00000000-0000-7000-8000-000000000004'));
    });
    expect(await payloads(OUTBOX_WAKE_CHANNEL)).toEqual(['']);

    // Claimed by a relay — which may be dead. Its rows are not a wake: the next stage speaks.
    expect(await store.claim(10)).toHaveLength(3);
    await pg.transaction(async (executor) => {
      bound = executor;
      await store.stage(tx, row('00000000-0000-7000-8000-000000000005'));
    });
    expect(await payloads(OUTBOX_WAKE_CHANNEL)).toEqual(['', '']);
  });

  test('a scheduler fire announces each queue it filled once, and a refused fire announces nothing', async () => {
    const driver = postgresJobDriver({ executor: pg.executor });
    const state = postgresSchedulerState(pg.executor);
    const jobs = ['a', 'b', 'c'].map((item, index) => ({
      name: 'nightly',
      queue: index === 2 ? 'mail' : 'reports',
      input: { item },
      idempotencyKey: `fire:${item}`,
      maxAttempts: 1,
    }));
    expect(
      await state.fire(driver, { task: 'nightly', occurrenceMs: Date.now(), jobs }),
    ).toHaveLength(3);
    expect((await payloads(JOBS_WAKE_CHANNEL)).sort()).toEqual(['mail', 'reports']);

    // The watermark is already on this occurrence: nothing queued, nothing said.
    expect(
      await state.fire(driver, { task: 'nightly', occurrenceMs: Date.now(), jobs }),
    ).toBeUndefined();
    expect(await payloads(JOBS_WAKE_CHANNEL)).toHaveLength(2);
  });

  test('an operator repair is announced: requeue, promote, resume', async () => {
    const driver = postgresJobDriver({ executor: pg.executor });
    const operator = driver.introspect;
    if (operator === undefined)
      return expect.unreachable('the pg driver ships an operator surface');
    const handle = itemJob({ run: () => Promise.resolve() });
    const waiting = await enqueue(driver, handle.name, 'waiting', {
      queue: 'mail',
      runAt: Date.now() + WAKE_DUE_WITHIN_MS + 1_000,
    });
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual([]);

    await operator.promote(waiting.id);
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual(['mail']);

    await operator.cancel?.(waiting.id);
    await operator.requeue(waiting.id);
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual(['mail', 'mail']);

    await operator.cancel?.(waiting.id);
    expect(await operator.requeueMany({ state: 'cancelled' })).toEqual({
      affected: 1,
      remaining: 0,
    });
    // Every queue the bulk call may have touched: it named none.
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual(['mail', 'mail', '']);

    await operator.pauseQueue('mail');
    await operator.resumeQueue('mail');
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual(['mail', 'mail', '', 'mail']);
  });
});

describe('the loops it wakes', () => {
  test('a job another process enqueued starts within a small bound, though the worker idles at its ceiling', async () => {
    await liveWake();
    const started: number[] = [];
    const handle = itemJob({
      run() {
        started.push(performance.now());
        return Promise.resolve();
      },
    });
    // Idling at the ceiling the poll alone guarantees — the wake is what has to beat it.
    await idleWorker(POLL_CEILING_MS, POLL_CEILING_MS);

    const other = postgresJobDriver({ executor: pg.executor });
    const before = performance.now();
    await enqueue(other, handle.name, 'cross-process');
    await until(() => started.length === 1, BUDGET_MS);
    // The wait in hand was the whole ceiling — only a wake lands inside WAKE_BOUND_MS.
    expect((started[0] ?? 0) - before).toBeLessThan(WAKE_BOUND_MS);
  });

  test('with NO wake the same job waits for the poll — and the poll ceiling still bounds it', async () => {
    const started: number[] = [];
    const handle = itemJob({
      run() {
        started.push(performance.now());
        return Promise.resolve();
      },
    });
    // No `startQueueWake`: a transaction-pooling proxy, or a session that died. The worker idles
    // at POLL_CEILING_MS, the ceiling the poll alone guarantees, and only that poll can start it.
    const ceiling = POLL_CEILING_MS;
    await idleWorker(ceiling, ceiling);

    const other = postgresJobDriver({ executor: pg.executor });
    const before = performance.now();
    await enqueue(other, handle.name, 'polled');
    // Nothing told the worker: where the wake starts the job, this one is still waiting.
    await time.advance(SOON_MS);
    expect(started).toEqual([]);
    // A budget past the bound below, so a late start fails on the bound — the promise —
    // rather than on this wait.
    await until(() => started.length === 1, ceiling + WAKE_BOUND_MS + 2_000);
    // The guarantee: never past the ceiling, plus one pass.
    expect((started[0] ?? 0) - before).toBeLessThan(ceiling + WAKE_BOUND_MS);
    expect(wakeIsLive()).toBe(false);
  });

  test('through the outbox: a row another process committed is published and started within the bound', async () => {
    await liveWake();
    const started: number[] = [];
    const handle = itemJob({
      run() {
        started.push(performance.now());
        return Promise.resolve();
      },
    });
    await idleWorker(POLL_CEILING_MS, POLL_CEILING_MS);
    const driver = postgresJobDriver({ executor: pg.executor });
    const relayStore = postgresOutboxStore({
      executor: pg.executor,
      txExecutor: () => pg.executor,
    });
    const relay = outboxRelay({
      store: relayStore,
      driver,
      intervalMs: FLOOR_MS,
      idlePollMaxMs: POLL_CEILING_MS,
      drainOnShutdown: false,
    });
    relay.start();
    cleanups.push(() => relay.stop());
    await until(() => relay.pollDelayMs() >= POLL_CEILING_MS);

    // The web pod: its own store, its own transaction, no signal raised in this process.
    let bound = pg.executor;
    const webStore = postgresOutboxStore({ executor: pg.executor, txExecutor: () => bound });
    const before = performance.now();
    await pg.transaction(async (executor) => {
      bound = executor;
      await webStore.stage({ id: 'web' } as unknown as Tx, {
        id: '00000000-0000-7000-8000-0000000000aa',
        runId: '00000000-0000-7000-8000-0000000000ab',
        job: handle.name,
        queue: 'default',
        input: { item: 'through-the-outbox' },
        idempotencyKey: 'wake:outbox',
        maxAttempts: 1,
        runAt: Date.now(),
        stagedAt: Date.now(),
      });
    });
    await until(() => started.length === 1, BUDGET_MS);
    // Only a wake lands inside WAKE_BOUND_MS: the relay's poll sits at POLL_CEILING_MS.
    expect((started[0] ?? 0) - before).toBeLessThan(WAKE_BOUND_MS);
  });

  test('a stopped wake leaves the loops under the no-wake ceiling', async () => {
    const wake = await liveWake();
    expect(wake.live()).toBe(true);
    await wake.stop();
    expect(wakeIsLive()).toBe(false);
    const driver = postgresJobDriver({ executor: pg.executor });
    const handle = itemJob({ run: () => Promise.resolve() });
    await enqueue(driver, handle.name, 'after-stop');
    // The statement still announces — the session that would have heard it is gone.
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual(['default']);
  });
});
