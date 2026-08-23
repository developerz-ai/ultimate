// The scheduler's place in the process drain — the worker's rule, restated for the role that holds
// a lock instead of a pool. One `accept` hook that waited out the dispatch round spent the whole
// budget in the phase whose job is to be over immediately, and a round parked on a slow queue left
// the teardown running forever: the hooks never came back and the lease was never decided about.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import {
  configureLifecycle,
  drain,
  onShutdown,
  resetLifecycle,
  shutdownHookCount,
} from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { EnqueueRequest, EnqueueResult, JobDriver } from './driver';
import { resetJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import type { CronResolver, LeaderElection, Scheduler } from './scheduler';
import { createScheduler } from './scheduler';
import type { TaskHandle } from './task';
import { resetTasks, task } from './task';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  } as Clock & { advance(ms: number): void };
}

/** One occurrence a second, so `advance(2_000)` leaves exactly one of them due. */
const everySecond: CronResolver = (_cron, options) => new Date(options.from.getTime() + 1_000);

const T0 = Date.UTC(2026, 6, 26, 0, 0, 0);

interface Rig {
  readonly scheduler: Scheduler;
  releases(): number;
  /** The dispatch round, parked inside `enqueue` — a queue that is not answering. */
  entered(): Promise<void>;
  release(): void;
}

/**
 * A scheduler armed with one due occurrence, dispatching into a queue that never answers. Nothing
 * in this process can cancel that enqueue, which is why the wait around it has to be bounded.
 */
async function rig(): Promise<Rig> {
  const clock = fakeClock(T0);
  const base = createMemoryDriver({ clock });
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let arrived = (): void => undefined;
  const first = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const driver: JobDriver = {
    ...base,
    async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
      arrived();
      await gate;
      return base.enqueue(request);
    },
  };
  let releases = 0;
  const leader: LeaderElection = {
    acquire: () => Promise.resolve(true),
    release: () => {
      releases += 1;
      return Promise.resolve();
    },
  };
  const sendDigest: JobHandle<Record<string, never>> = job<Record<string, never>>({
    tenant: 'none',
    name: 'sendDigest',
    input: passthrough<Record<string, never>>(),
    idempotencyKey: () => 'digest',
    retry: { attempts: 3 },
    run: () => Promise.resolve(),
  });
  const nightly: TaskHandle = task({
    name: 'nightlyDigest',
    cron: '* * * * *',
    tz: 'UTC',
    enqueue: () => [[sendDigest, {}]],
  });
  const scheduler = createScheduler({
    driver,
    clock,
    leader,
    cron: everySecond,
    tasks: [nightly],
    tickIntervalMs: 60_000,
  });
  await scheduler.tick();
  clock.advance(2_000);
  scheduler.start();
  void scheduler.tick();
  await first;
  return { scheduler, releases: () => releases, entered: () => first, release: () => open() };
}

beforeEach(() => {
  resetLifecycle();
  resetJobs();
  resetTasks();
  resetJobDriver();
  resetJobsFacade();
});

afterEach(() => {
  resetLifecycle();
  resetJobs();
  resetTasks();
  resetJobDriver();
  resetJobsFacade();
});

describe('the scheduler drains in two phases, and its wait is bounded', () => {
  test('an accept hook behind it still gets its turn when a round outruns the budget', async () => {
    configureLifecycle({ deadlineMs: 150 });
    const app = await rig();

    let accepted = 0;
    onShutdown(
      'probe:accept',
      async () => {
        await Bun.sleep(5);
        accepted += 1;
      },
      { phase: 'accept' },
    );

    await drain('SIGTERM');
    // Read the instant the drain returns: an abandoned hook is still running, so a probe asserted
    // after a sleep would pass either way. What this asks is whether the phase FINISHED inside the
    // drain — which is the difference between a pod that stopped taking work and one that did not.
    expect(accepted).toBe(1);

    app.release();
  });

  test('an abandoned round leaves the lease to EXPIRE rather than handing it over', async () => {
    configureLifecycle({ deadlineMs: 150 });
    const app = await rig();

    await drain('SIGTERM');
    await Bun.sleep(30);

    // The teardown reached its end — hooks handed back — rather than parking forever on a round
    // this process cannot cancel.
    expect(shutdownHookCount()).toBe(0);
    // And it did NOT release: a lock handed back under a live dispatch promotes a standby onto an
    // occurrence this node is still enqueueing for, which is the double-fire leader election
    // exists to prevent. A lease row expires on its own; that is what expiry is for.
    expect(app.releases()).toBe(0);

    app.release();
  });

  test('stop() after an abandoned drain answers rather than joining it forever', async () => {
    configureLifecycle({ deadlineMs: 150 });
    const app = await rig();

    await drain('SIGTERM');
    await Bun.sleep(30);

    const answered = await Promise.race([
      app.scheduler.stop('rollback').then(() => 'stopped'),
      Bun.sleep(250).then(() => 'wedged'),
    ]);
    expect(answered).toBe('stopped');

    app.release();
  });
});
