// The scheduler's lifecycle: ONE dispatch round at a time, a `stop()` that waits that round out
// before the advisory lock goes back, and exactly one shutdown hook while it runs. Two rounds
// over one `lastFiredAt` re-mark the watermark and report occurrences they never enqueued; a lock
// released mid-dispatch hands the next node an occurrence this one is still firing.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { drain, logger, resetLifecycle, shutdownHookCount } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { EnqueueRequest, EnqueueResult, JobDriver } from './driver';
import { resetJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { DriverUnavailableError } from './errors';
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

interface GatedDriver {
  readonly driver: JobDriver;
  enqueues(): number;
  /** Settles once a dispatch has entered `enqueue` — the round is provably mid-flight. */
  entered(): Promise<void>;
  release(): void;
}

/** The memory driver with `enqueue` held open, so a round can be caught in the middle of one. */
function gatedDriver(): GatedDriver {
  const base = createMemoryDriver();
  let enqueues = 0;
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let arrived = (): void => undefined;
  const first = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  return {
    driver: {
      ...base,
      async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
        enqueues += 1;
        arrived();
        await gate;
        return base.enqueue(request);
      },
    },
    enqueues: () => enqueues,
    entered: () => first,
    release: () => open(),
  };
}

interface CountingLeader {
  readonly leader: LeaderElection;
  acquires(): number;
  releases(): number;
}

/** `release` optionally held open (a lock that is slow to go back) or failing outright. */
function countingLeader(release?: () => Promise<void>): CountingLeader {
  let acquires = 0;
  let releases = 0;
  return {
    leader: {
      acquire: () => {
        acquires += 1;
        return Promise.resolve(true);
      },
      release: async () => {
        releases += 1;
        await (release?.() ?? Promise.resolve());
      },
    },
    acquires: () => acquires,
    releases: () => releases,
  };
}

/** A gate a test opens by hand, for a `release` that must not finish yet. */
function heldGate(): { held: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held, open: () => open() };
}

let nightly: TaskHandle;
let sendDigest: JobHandle<Record<string, never>>;

beforeEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
  resetJobsFacade();
  // Lifecycle registrations are process-global, so a leak here is another suite's problem too.
  resetLifecycle();
  sendDigest = job<Record<string, never>>({
    tenant: 'none',
    name: 'sendDigest',
    input: passthrough<Record<string, never>>(),
    idempotencyKey: () => 'digest',
    retry: { attempts: 3 },
    run: () => Promise.resolve(),
  });
  nightly = task({
    name: 'nightlyDigest',
    cron: '* * * * *',
    tz: 'UTC',
    enqueue: () => [[sendDigest, {}]],
  });
});

afterEach(() => {
  resetJobDriver();
  resetJobsFacade();
  resetLifecycle();
});

/** Armed and one occurrence due: the state every dispatch test starts from. */
async function armed(
  driver: JobDriver,
  clock: Clock & { advance(ms: number): void },
  leader?: LeaderElection,
): Promise<Scheduler> {
  const scheduler = createScheduler({
    driver,
    clock,
    cron: everySecond,
    tasks: [nightly],
    tickIntervalMs: 60_000,
    ...(leader === undefined ? {} : { leader }),
  });
  await scheduler.tick();
  clock.advance(2_000);
  return scheduler;
}

describe('the scheduler runs one dispatch round at a time', () => {
  test('a tick landing on a round in flight joins it instead of dispatching again', async () => {
    const gated = gatedDriver();
    const clock = fakeClock(T0);
    const scheduler = await armed(gated.driver, clock);

    const first = scheduler.tick();
    await gated.entered();
    // Before the guard both rounds read the same `lastFiredAt`, walked the same occurrence and
    // dispatched it — the occurrence key deduped the job, so only the doubled round showed it.
    const second = scheduler.tick();
    gated.release();
    const [a, b] = await Promise.all([first, second]);

    expect(gated.enqueues()).toBe(1);
    expect(a).toBe(b);
    expect(a.map((entry) => entry.occurrenceMs)).toEqual(b.map((entry) => entry.occurrenceMs));
    expect(a.length).toBe(1);
    await scheduler.stop();
  });

  test('the timer loop re-arms on the round it finished, never on a fixed period', async () => {
    const gated = gatedDriver();
    const clock = fakeClock(T0);
    const scheduler = createScheduler({
      driver: gated.driver,
      clock,
      cron: everySecond,
      tasks: [nightly],
      // Zero gap: a `setInterval` loop fires again and again through the held dispatch.
      tickIntervalMs: 0,
    });
    await scheduler.tick();
    clock.advance(2_000);

    scheduler.start();
    await gated.entered();
    await Bun.sleep(20);

    expect(gated.enqueues()).toBe(1);
    gated.release();
    await scheduler.stop();
  });
});

describe('the scheduler drains before the lock goes back', () => {
  test('stop() waits out the round it races, then releases the leader', async () => {
    const gated = gatedDriver();
    const clock = fakeClock(T0);
    const counting = countingLeader();
    const scheduler = await armed(gated.driver, clock, counting.leader);

    const dispatching = scheduler.tick();
    await gated.entered();
    const stopped = scheduler.stop('deploy');
    await Bun.sleep(1);

    // The lock is what stops a second node firing this occurrence. Handing it back here, with
    // the enqueue still open, is the double-fire leader election exists to prevent.
    expect(counting.releases()).toBe(0);

    gated.release();
    const [dispatched] = await Promise.all([dispatching, stopped]);

    expect(dispatched.length).toBe(1);
    expect(counting.releases()).toBe(1);
    expect(gated.enqueues()).toBe(1);
  });

  test('a round starting during or after the drain neither acquires nor dispatches', async () => {
    const clock = fakeClock(T0);
    const gate = heldGate();
    const counting = countingLeader(() => gate.held);
    const gated = gatedDriver();
    const scheduler = await armed(gated.driver, clock, counting.leader);

    const stopped = scheduler.stop('deploy');
    await Bun.sleep(1);

    // Parked inside `release()`: the lock is on its way back, so a round that dispatched here
    // would be enqueueing for an occurrence the next leader is already free to take.
    expect(await scheduler.tick()).toEqual([]);
    gate.open();
    await stopped;

    expect(await scheduler.tick()).toEqual([]);
    expect(gated.enqueues()).toBe(0);
    expect(counting.acquires()).toBe(1);
  });

  test('a stop landing mid-round stops the tasks that round has not reached', async () => {
    const clock = fakeClock(T0);
    const gated = gatedDriver();
    const counting = countingLeader();
    const weekly = task({
      name: 'weeklyDigest',
      cron: '* * * * *',
      tz: 'UTC',
      enqueue: () => [[sendDigest, {}]],
    });
    const scheduler = createScheduler({
      driver: gated.driver,
      clock,
      cron: everySecond,
      tasks: [nightly, weekly],
      tickIntervalMs: 60_000,
      leader: counting.leader,
    });
    await scheduler.tick();
    clock.advance(2_000);

    const dispatching = scheduler.tick();
    await gated.entered();
    const stopped = scheduler.stop('deploy');
    gated.release();
    const [dispatched] = await Promise.all([dispatching, stopped]);

    // "Stop dispatching" means this round too. The first task's occurrence runs to the end —
    // that is what `stop()` waited for — and the second is simply not fired, its `lastFiredAt`
    // untouched, so the next leader owes it.
    expect(dispatched.map((entry) => entry.task)).toEqual(['nightlyDigest']);
    expect(gated.enqueues()).toBe(1);
    expect(counting.releases()).toBe(1);
  });

  test('a release that throws still stops the scheduler and hands the hook back', async () => {
    const clock = fakeClock(T0);
    const counting = countingLeader(() => Promise.reject(new Error('lock lost')));
    const gated = gatedDriver();
    const scheduler = await armed(gated.driver, clock, counting.leader);
    scheduler.start();

    // The failure is the caller's to see — the registration is not part of the diagnosis.
    await expect(scheduler.stop()).rejects.toThrow('lock lost');
    expect(shutdownHookCount()).toBe(0);
    // And a lock this process could not hand back is never treated as still held.
    expect(await scheduler.tick()).toEqual([]);
    expect(gated.enqueues()).toBe(0);
  });
});

describe('a round that fails says what to do about it', () => {
  test('an UltimateError keeps its code, cause and fix in jobs.scheduler.tick-failed', async () => {
    const spy = spyOn(logger, 'error');
    const clock = fakeClock(T0);
    const unavailable = new DriverUnavailableError({
      driver: 'pg',
      cause: 'connection refused',
      fix: 'x doctor --json',
    });
    const failing: JobDriver = {
      ...createMemoryDriver(),
      enqueue: () => Promise.reject(unavailable),
    };
    const scheduler = createScheduler({
      driver: failing,
      clock,
      cron: everySecond,
      tasks: [nightly],
      tickIntervalMs: 1,
    });
    await scheduler.tick();
    clock.advance(2_000);

    scheduler.start();
    for (let waited = 0; waited < 2_000; waited += 2) {
      if (spy.mock.calls.some((call) => call[0] === 'jobs.scheduler.tick-failed')) break;
      await Bun.sleep(2);
    }
    await scheduler.stop();
    const failed = spy.mock.calls.find((call) => call[0] === 'jobs.scheduler.tick-failed');
    spy.mockRestore();

    // `message` alone strands the operator: the code is what they search on and the fix is what
    // they run, and neither survives `error instanceof Error ? error.message : String(error)`.
    expect(failed?.[1]).toMatchObject({
      code: 'X_DRIVER_UNAVAILABLE',
      cause: 'jobs driver "pg" is unavailable: connection refused',
      fix: 'x doctor --json',
    });
  });

  test('a plain Error still logs its message and nothing it does not have', async () => {
    const spy = spyOn(logger, 'error');
    const clock = fakeClock(T0);
    const failing: JobDriver = {
      ...createMemoryDriver(),
      enqueue: () => Promise.reject(new Error('socket hang up')),
    };
    const scheduler = createScheduler({
      driver: failing,
      clock,
      cron: everySecond,
      tasks: [nightly],
      tickIntervalMs: 1,
    });
    await scheduler.tick();
    clock.advance(2_000);

    scheduler.start();
    for (let waited = 0; waited < 2_000; waited += 2) {
      if (spy.mock.calls.some((call) => call[0] === 'jobs.scheduler.tick-failed')) break;
      await Bun.sleep(2);
    }
    await scheduler.stop();
    const failed = spy.mock.calls.find((call) => call[0] === 'jobs.scheduler.tick-failed');
    spy.mockRestore();

    // `renderThrowable`'s form: the throwable's own name beside its message, and nothing an
    // `UltimateError` would have carried. `String(error)` is what a null-prototype throwable
    // raises on, from a catch block with nothing left to answer with.
    expect(failed?.[1]).toEqual({ error: 'Error: socket hang up' });
  });
});

describe('the scheduler holds one shutdown hook, and only while it runs', () => {
  test('start registers one, stop hands it back, a restart still holds one', async () => {
    const scheduler = createScheduler({
      driver: createMemoryDriver(),
      tasks: [nightly],
      tickIntervalMs: 60_000,
    });

    scheduler.start();
    expect(shutdownHookCount()).toBe(1);
    await scheduler.stop();
    expect(shutdownHookCount()).toBe(0);

    scheduler.start();
    expect(shutdownHookCount()).toBe(1);
    await scheduler.stop();
    expect(shutdownHookCount()).toBe(0);
  });

  test('drainOnShutdown: false registers nothing to leak', async () => {
    const scheduler = createScheduler({
      driver: createMemoryDriver(),
      tasks: [nightly],
      tickIntervalMs: 60_000,
      drainOnShutdown: false,
    });

    scheduler.start();
    expect(shutdownHookCount()).toBe(0);
    await scheduler.stop();
    expect(shutdownHookCount()).toBe(0);
  });

  test('the hook drains the scheduler on SIGTERM, then is gone', async () => {
    const clock = fakeClock(T0);
    const gated = gatedDriver();
    const counting = countingLeader();
    const scheduler = await armed(gated.driver, clock, counting.leader);
    scheduler.start();

    await drain('SIGTERM');

    expect(counting.releases()).toBe(1);
    expect(shutdownHookCount()).toBe(0);
    // Stopped means stopped: the timer is gone and a manual tick dispatches nothing.
    expect(await scheduler.tick()).toEqual([]);
    expect(gated.enqueues()).toBe(0);
  });

  test('a SIGTERM landing on a manual stop joins it rather than releasing twice', async () => {
    const clock = fakeClock(T0);
    const gate = heldGate();
    const counting = countingLeader(() => gate.held);
    const scheduler = await armed(createMemoryDriver({ clock }), clock, counting.leader);
    scheduler.start();

    const manual = scheduler.stop('deploy');
    // The hook is still registered — this scheduler has not finished draining, and core is
    // entitled to wait for it. What it must not do is release the same lock twice.
    const signalled = drain('SIGTERM');
    gate.open();
    await Promise.all([manual, signalled]);

    expect(counting.releases()).toBe(1);
    expect(shutdownHookCount()).toBe(0);
  });

  test('a start during a drain neither re-arms the loop nor stacks a hook', async () => {
    const clock = fakeClock(T0);
    const gate = heldGate();
    const counting = countingLeader(() => gate.held);
    const gated = gatedDriver();
    const scheduler = await armed(gated.driver, clock, counting.leader);
    scheduler.start();

    const stopped = scheduler.stop('deploy');
    scheduler.start();
    expect(shutdownHookCount()).toBe(1);

    gate.open();
    await stopped;

    expect(shutdownHookCount()).toBe(0);
    expect(await scheduler.tick()).toEqual([]);
    expect(gated.enqueues()).toBe(0);
  });
});
