// The relay's place in the process drain — the worker's rule and the scheduler's, restated for the
// loop that turns a committed `x_outbox` row into a queued job. It registered NO hook, so on
// SIGTERM it went on claiming through every phase: rows leased on a pod that would never run them,
// and a pass killed between `driver.enqueue` and `markPublished` published twice on the next boot.
// Fake time (`fake-time-fixture.ts`) moves the relay's poll and the drain's deadline together.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureLifecycle,
  drain,
  onShutdown,
  resetLifecycle,
  shutdownHookCount,
  systemClock,
} from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { EnqueueRequest, EnqueueResult, JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { useFakeTime } from './fake-time-fixture';
import type { MemoryOutboxStore, OutboxRecord } from './outbox';
import { memoryOutboxStore } from './outbox';
import type { OutboxRelay } from './outbox-relay';
import { outboxRelay } from './outbox-relay';

const time = useFakeTime();

/** The tx identity is the store's map key and nothing here reads a connection off it. */
const fakeTx = (id: string): Tx => ({ id }) as unknown as Tx;

const record = (id: string): OutboxRecord => ({
  id,
  runId: `run-${id}`,
  job: 'notifySubscribers',
  queue: 'default',
  input: {},
  idempotencyKey: `notify:${id}`,
  maxAttempts: 1,
  runAt: 0,
  stagedAt: 0,
});

interface Rig {
  readonly relay: OutboxRelay;
  readonly store: MemoryOutboxStore;
  /** Rows this driver accepted, in order. */
  published(): readonly string[];
  /** Commit one more row, so a relay that is still polling would publish it. */
  stage(id: string): Promise<void>;
  /** The pass parked inside `driver.enqueue`, and the release for it. */
  entered(): Promise<void>;
  release(): void;
}

/**
 * A relay polling every millisecond against a driver that parks its FIRST publish. Everything the
 * drain has to decide about is then observable: the pass in flight, the rows behind it, and
 * whether a later commit is picked up after the drain said the process was closing.
 */
async function rig(options: { park: boolean }): Promise<Rig> {
  const store = memoryOutboxStore();
  const base = memoryJobDriver();
  const accepted: string[] = [];
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let arrived = (): void => undefined;
  const first = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let parked = options.park;
  const enqueue = async (request: EnqueueRequest): Promise<EnqueueResult> => {
    arrived();
    if (parked) {
      parked = false;
      await gate;
    }
    accepted.push(request.idempotencyKey);
    return base.enqueue(request);
  };
  // The relay publishes a batch through `enqueueMany`; it parks on the same first row the row
  // loop would, so the pass in flight is the same pass either way.
  const driver: JobDriver = {
    ...base,
    enqueue,
    async enqueueMany(requests) {
      const results: EnqueueResult[] = [];
      for (const request of requests) results.push(await enqueue(request));
      return results;
    },
  };

  const tx = fakeTx('tx-first');
  await store.stage(tx, record('row-1'));
  await store.commit(tx);

  const relay = outboxRelay({ store, driver, intervalMs: 1 });
  relay.start();
  await time.settles(first, 50);
  let staged = 1;
  return {
    relay,
    store,
    published: () => accepted,
    async stage(id: string): Promise<void> {
      staged += 1;
      const next = fakeTx(`tx-${staged}`);
      await store.stage(next, record(id));
      await store.commit(next);
    },
    entered: () => first,
    release: () => open(),
  };
}

beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  resetLifecycle();
});

describe('the relay takes part in the drain instead of running through it', () => {
  test('start() registers one accept hook and one close hook, and stop() hands both back', async () => {
    const app = await rig({ park: false });
    // Two, for the two phases — the shape `worker.ts` and `scheduler.ts` both hold. Zero was the
    // defect: the relay was stopped only by `RunningRoles.stop()`, which a signal can skip.
    expect(shutdownHookCount()).toBe(2);

    await time.settles(app.relay.stop(), 100);
    // Handed back in the teardown's `finally`, so start -> stop -> start holds one pair rather
    // than one per start, each retaining a stopped relay's store and driver.
    expect(shutdownHookCount()).toBe(0);
  });

  test('drainOnShutdown: false registers none, for a caller that drives its own teardown', async () => {
    const relay = outboxRelay({
      store: memoryOutboxStore(),
      driver: memoryJobDriver(),
      drainOnShutdown: false,
    });
    relay.start();
    expect(shutdownHookCount()).toBe(0);
    // Driven here, because this relay registered nothing to drive it: `unref()` keeps the timer off
    // the process exit and does not stop it, so a relay left running polls its store through every
    // test that follows this one.
    await time.settles(relay.stop(), 100);
  });

  test('start() during a drain is refused, so no second pair of hooks is stacked', async () => {
    const app = await rig({ park: true });
    // Mid-drain: the `accept` hook has cleared the timer and the `close` hook is waiting the
    // parked pass out. A relay re-armed here would poll a store the drain is about to leave, and
    // its second registration would overwrite the unregisters of the first.
    const draining = drain('SIGTERM');
    await time.advance(5);
    app.relay.start();
    expect(shutdownHookCount()).toBe(2);

    app.release();
    await time.settles(draining, 100);
    expect(shutdownHookCount()).toBe(0);
  });

  test('nothing is claimed or published once the drain has resolved', async () => {
    const app = await rig({ park: false });
    await time.settles(drain('SIGTERM'), 100);
    const atDrain = app.published().length;

    // A row committed after the drain is a row this pod has no business leasing: its lease would
    // sit on a row nothing here will ever publish, for the whole visibility window.
    await app.stage('row-after');
    // Thirty polls' worth of fake time: a relay still armed would have claimed it on the first.
    await time.advance(30);

    expect(app.published().length).toBe(atDrain);
    expect(await app.store.pendingCount()).toBe(1);
  });

  test('the pass in flight finishes inside the close phase, marked published', async () => {
    const app = await rig({ park: true });

    const draining = drain('SIGTERM');
    // The drain must still be OPEN while the publish is parked: the close phase is where this
    // wait belongs, and a drain that resolved here returned between `driver.enqueue` and
    // `markPublished` — the row is published, unmarked, and published again on the next boot.
    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await time.advance(60);
    expect(drained).toBe(false);

    app.release();
    await time.settles(draining, 100);
    // Published AND retired: a teardown that returned between the two closed the database under
    // the row it was about to mark, which republishes it on the next boot.
    expect(app.published()).toEqual(['notify:row-1']);
    expect(await app.store.pendingCount()).toBe(0);
  });

  test('an accept hook behind the relay still gets its turn while a pass is parked', async () => {
    configureLifecycle({ deadlineMs: 150 });
    const app = await rig({ park: true });

    let accepted = 0;
    onShutdown(
      'probe:accept',
      async () => {
        await time.sleep(5);
        accepted += 1;
      },
      { phase: 'accept' },
    );

    await time.settles(drain('SIGTERM'), 300);
    // Read the instant the drain returns. The relay's own wait belongs to `close`; parked in
    // `accept` it would spend the whole budget before this hook — the HTTP server's "stop
    // listening" is an `accept` hook too — ever ran.
    expect(accepted).toBe(1);

    app.release();
  });
  // Audit 04-jobs step 4. `stop()` memoises its teardown, and the teardown kept the deadline it
  // was STARTED with — so a SIGTERM landing on a manual stop joined a wait with no bound, behind a
  // publish that never returns. Core abandoned the hook; the relay never reached 'stopped'.
  test('a shutdown deadline landing on a manual stop() bounds the wait already in flight', async () => {
    const app = await rig({ park: true });

    const manual = app.relay.stop();
    let stopped = false;
    void manual.then(() => {
      stopped = true;
    });
    await time.advance(20);
    // Manual: it waits as long as its pass takes.
    expect(stopped).toBe(false);

    const bounded = app.relay.stop(systemClock.monotonic() + 40);
    // Answered at the 40 ms bound, never at the release that does not come.
    await time.settles(Promise.all([manual, bounded]), 100);
    // Abandoned, not finished: the row was never marked, and the next boot republishes it.
    expect(await app.store.pendingCount()).toBe(1);
    // And a relay that was abandoned still answers a later stop at once.
    await time.settles(app.relay.stop(), 5);

    app.release();
  });

  test('the EARLIEST deadline wins: a later, looser one cannot extend the wait', async () => {
    const app = await rig({ park: true });
    const started = performance.now();
    const first = app.relay.stop(systemClock.monotonic() + 40);
    const second = app.relay.stop(systemClock.monotonic() + 5_000);
    await time.settles(Promise.all([first, second]), 100);
    expect(performance.now() - started).toBeLessThan(100);
    app.release();
  });
});
