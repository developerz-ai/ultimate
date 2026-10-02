// The cross-process wake on a real Postgres: the STATEMENTS that announce a row, and the loops
// they wake. "Another process" here is a second driver over the same database that raises no
// in-process signal — exactly what a web pod is to a worker pod. Opt-in (`.job.`): booting
// Postgres costs seconds. The embedded database's `now()` is frozen with the test clock, so one
// notification slot lasts until rows are aged out of it — which makes "one per slot" exact.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createContext } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { JobDriver } from './driver';
import { createPgDriver } from './driver-pg';
import {
  JOBS_WAKE_CHANNEL,
  OUTBOX_WAKE_CHANNEL,
  WAKE_DUE_WITHIN_MS,
  WAKE_SLOT_MS,
} from './driver-pg-wake-sql';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import { setWakeLive, wakeIsLive } from './enqueue-signal';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { createPgOutboxStore } from './outbox-pg';
import { createOutboxRelay } from './outbox-relay';
import type { QueueWake } from './queue-wake';
import { startQueueWake } from './queue-wake';
import { pgSchedulerState } from './scheduler-pg';
import { createWorker } from './worker';
import type { Worker } from './worker-types';

const context = () => createContext({ role: 'worker', buildId: 'test' });
/** The floor every loop here polls at, and so the unit a "small bound" is counted in. */
const FLOOR_MS = 25;
/** Well under one backed-off wait, well over a round trip on a loaded machine. */
const SOON_MS = 150;

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

/** Notifications are delivered on a microtask after the statement: give them their turn. */
const delivered = async (): Promise<typeof heard> => {
  await Bun.sleep(2);
  return heard;
};

const payloads = async (channel: string): Promise<string[]> =>
  (await delivered()).filter((entry) => entry.channel === channel).map((entry) => entry.payload);

async function until(condition: () => boolean | Promise<boolean>, budgetMs = 5_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!(await condition())) {
    if (performance.now() > deadline) expect.unreachable('the condition never became true');
    await Bun.sleep(2);
  }
}

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
  const worker = createWorker({
    driver: createPgDriver({ executor: pg.executor }),
    pollIntervalMs: FLOOR_MS,
    idlePollMaxMs,
    heartbeatIntervalMs: 3_600_000,
    context,
    drainOnShutdown: false,
  });
  worker.start();
  cleanups.push(() => worker.stop());
  await until(async () => (await worker.stats()).pollDelayMs >= ms);
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
    const driver = createPgDriver({ executor: pg.executor });
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

  test('a row that is not about to be claimable, or was never inserted, announces nothing', async () => {
    const driver = createPgDriver({ executor: pg.executor });
    const handle = itemJob({ run: () => Promise.resolve() });
    // Delayed well past what a woken worker would wait out.
    await enqueue(driver, handle.name, 'later', { runAt: Date.now() + 60_000 });
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual([]);

    await pg.age(WAKE_SLOT_MS);
    // Due a moment from now — an enqueuer whose clock runs ahead of the database's.
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
    const store = createPgOutboxStore({ executor: pg.executor, txExecutor: () => bound });
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
    const driver = createPgDriver({ executor: pg.executor });
    const state = pgSchedulerState(pg.executor);
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
    const driver = createPgDriver({ executor: pg.executor });
    const operator = driver.introspect;
    if (operator === undefined)
      return expect.unreachable('the pg driver ships an operator surface');
    const handle = itemJob({ run: () => Promise.resolve() });
    const waiting = await enqueue(driver, handle.name, 'waiting', {
      queue: 'mail',
      runAt: Date.now() + 60_000,
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
    await idleWorker(400);

    const other = createPgDriver({ executor: pg.executor });
    const before = performance.now();
    await enqueue(other, handle.name, 'cross-process');
    await until(() => started.length === 1, 2_000);
    // The wait in hand was 400 ms or more.
    expect((started[0] ?? 0) - before).toBeLessThan(SOON_MS);
  });

  test('with NO wake the same job waits for the poll — and the poll ceiling still bounds it', async () => {
    const started: number[] = [];
    const handle = itemJob({
      run() {
        started.push(performance.now());
        return Promise.resolve();
      },
    });
    // No `startQueueWake`: a transaction-pooling proxy, or a session that died.
    const ceiling = 400;
    await idleWorker(ceiling, ceiling);

    const other = createPgDriver({ executor: pg.executor });
    const before = performance.now();
    await enqueue(other, handle.name, 'polled');
    // Nothing told the worker: where the wake starts the job, this one is still waiting.
    await Bun.sleep(SOON_MS);
    expect(started).toEqual([]);
    await until(() => started.length === 1, 3_000);
    // The guarantee: never past the ceiling (plus a pass).
    expect((started[0] ?? 0) - before).toBeLessThan(ceiling + SOON_MS);
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
    await idleWorker(400);
    const driver = createPgDriver({ executor: pg.executor });
    const relayStore = createPgOutboxStore({
      executor: pg.executor,
      txExecutor: () => pg.executor,
    });
    const relay = createOutboxRelay({
      store: relayStore,
      driver,
      intervalMs: FLOOR_MS,
      idlePollMaxMs: 60_000,
      drainOnShutdown: false,
    });
    relay.start();
    cleanups.push(() => relay.stop());
    await until(() => relay.pollDelayMs() >= 400);

    // The web pod: its own store, its own transaction, no signal raised in this process.
    let bound = pg.executor;
    const webStore = createPgOutboxStore({ executor: pg.executor, txExecutor: () => bound });
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
    await until(() => started.length === 1, 2_000);
    expect((started[0] ?? 0) - before).toBeLessThan(SOON_MS);
  });

  test('a stopped wake leaves the loops under the no-wake ceiling', async () => {
    const wake = await liveWake();
    expect(wake.live()).toBe(true);
    await wake.stop();
    expect(wakeIsLive()).toBe(false);
    const driver = createPgDriver({ executor: pg.executor });
    const handle = itemJob({ run: () => Promise.resolve() });
    await enqueue(driver, handle.name, 'after-stop');
    // The statement still announces — the session that would have heard it is gone.
    expect(await payloads(JOBS_WAKE_CHANNEL)).toEqual(['default']);
  });
});
