// What an IDLE scheduler, worker and outbox relay cost, counted in statements. Measured on a
// production app: an idle scheduler with ~35 tasks ran ~70 queries a second — a lease UPSERT and a
// watermark read per task per one-second round — and an idle worker pod 9 to 13, a claim per
// queue every 250 ms and an outbox claim every 200 ms. Nothing here waits on a wall clock: the
// loops publish the delay they would arm, and the test adds those up for one idle minute.

import { afterEach, describe, expect, test } from 'bun:test';
import { createContext, frozenClock } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { resetJobDriver, setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { signalStaged } from './enqueue-signal';
import { createIdleBackoff, IDLE_POLL_CEILING_MS } from './idle-backoff';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import { createMemoryOutboxStore } from './outbox';
import { createOutboxRelay } from './outbox-relay';
import { createScheduler } from './scheduler';
import type { LeaderElection } from './scheduler-leader';
import type { SchedulerState } from './scheduler-state';
import { createMemorySchedulerState } from './scheduler-state';
import { resetTasks, task } from './task';
import { createWorker } from './worker';

const MINUTE = 60_000;
const TASKS = 35;

afterEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
});

/** Every call on `target` counted — the store's statements, whatever they are named. */
function counted<T extends object>(target: T, count: () => void): T {
  return new Proxy(target, {
    get(inner, key, receiver) {
      const value: unknown = Reflect.get(inner, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        count();
        return Reflect.apply(value, inner, args);
      };
    },
  });
}

/** Thirty-five tasks that fire at 03:00 UTC — nothing is due for the minute under test. */
function nightlyTasks(): ReturnType<typeof task>[] {
  const handle = itemJob({ run: () => Promise.resolve() });
  return Array.from({ length: TASKS }, (_, index) =>
    task({
      name: `idle-nightly-${index}`,
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[handle, { item: 'nightly' }]],
    }),
  );
}

describe('an idle scheduler', () => {
  /** A lease-backed election: every `acquire()` is a write, relied on for ten seconds. */
  const lease = (count: () => void): LeaderElection => ({
    acquire: () => {
      count();
      return Promise.resolve(true);
    },
    release: () => Promise.resolve(),
    renewEveryMs: 10_000,
  });

  test('35 tasks cost a lease renewal every ten seconds — not two statements a task a second', async () => {
    const clock = frozenClock('2026-10-01T12:00:00.000Z');
    let statements = 0;
    const count = (): void => {
      statements += 1;
    };
    const driver = createMemoryDriver({ clock });
    const operator = driver.introspect;
    if (operator === undefined) return expect.unreachable('the memory driver ships an operator');
    const counting: JobDriver = { ...driver, introspect: counted(operator, count) };
    const state: SchedulerState = counted(createMemorySchedulerState(), count);
    const scheduler = createScheduler({
      driver: counting,
      clock,
      state,
      leader: lease(count),
      tasks: nightlyTasks(),
    });
    // The first round arms every task: one read and one write each, once per leadership.
    await scheduler.tick();
    statements = 0;

    for (let second = 0; second < 60; second += 1) {
      clock.advance(1_000);
      expect(await scheduler.tick()).toEqual([]);
    }

    // Was 4,321: (2 x 35 + 1) lease writes and watermark reads, plus a pause read, every second.
    expect(statements).toBe(6);
    expect(statements / 60).toBeLessThan(1);
  });

  test('a restarted scheduler reads each watermark once, then resolves no cron and asks no store', async () => {
    const clock = frozenClock('2026-10-01T12:00:00.000Z');
    const tasks = nightlyTasks();
    const shared = createMemorySchedulerState();
    const driver = createMemoryDriver({ clock });
    // The pod this one replaces armed every task.
    await createScheduler({
      driver,
      clock,
      state: shared,
      leader: lease(() => undefined),
      tasks,
    }).tick();

    let reads = 0;
    let resolutions = 0;
    const state: SchedulerState = counted(shared, () => {
      reads += 1;
    });
    const nightly = (_cron: string, options: { from: Date }): Date => {
      resolutions += 1;
      const day = 86_400_000;
      const at3 = Math.floor(options.from.getTime() / day) * day + 3 * 3_600_000;
      return new Date(at3 > options.from.getTime() ? at3 : at3 + day);
    };
    const scheduler = createScheduler({
      driver,
      clock,
      state,
      cron: nightly,
      leader: lease(() => undefined),
      tasks,
    });
    await scheduler.tick();
    // One read a task, and no write: nothing needed arming.
    expect(reads).toBe(TASKS);
    reads = 0;
    resolutions = 0;

    for (let second = 0; second < 60; second += 1) {
      clock.advance(1_000);
      await scheduler.tick();
    }
    expect(reads).toBe(0);
    // The other half of the idle cost: 35 cron resolutions a second, to learn nothing is due.
    expect(resolutions).toBe(0);
  });

  test('an occurrence another node already fired is read again, never retried every round', async () => {
    const clock = frozenClock('2026-10-01T02:59:59.000Z');
    const base = createMemorySchedulerState();
    let fires = 0;
    let reads = 0;
    const state: SchedulerState = {
      lastFiredAt: (name) => {
        reads += 1;
        return base.lastFiredAt(name);
      },
      markFired: (name, at) => base.markFired(name, at),
      // Another dispatcher got there first: the watermark is on the occurrence, nothing queued.
      async fire(_driver, fire) {
        fires += 1;
        await base.markFired(fire.task, fire.occurrenceMs);
        return undefined;
      },
    };
    const scheduler = createScheduler({
      driver: createMemoryDriver({ clock }),
      clock,
      state,
      leader: lease(() => undefined),
      tasks: nightlyTasks().slice(0, 1),
    });
    await scheduler.tick();
    clock.advance(1_000);
    reads = 0;

    expect(await scheduler.tick()).toEqual([]);
    expect(fires).toBe(1);
    for (let second = 0; second < 5; second += 1) {
      clock.advance(1_000);
      expect(await scheduler.tick()).toEqual([]);
    }
    // Refused once, re-read once, and then the watermark is known to be on that occurrence.
    expect(fires).toBe(1);
    expect(reads).toBe(1);
  });

  test('still fires on time: a watermark held in memory is not a missed occurrence', async () => {
    const clock = frozenClock('2026-10-01T02:59:30.000Z');
    const driver = createMemoryDriver({ clock });
    const scheduler = createScheduler({
      driver,
      clock,
      leader: lease(() => undefined),
      tasks: nightlyTasks(),
    });
    await scheduler.tick();

    clock.advance(29_000);
    expect(await scheduler.tick()).toEqual([]);
    clock.advance(1_000);
    const dispatched = await scheduler.tick();
    expect(dispatched).toHaveLength(TASKS);
    expect(new Date(dispatched[0]?.occurrenceMs ?? 0).toISOString()).toBe(
      '2026-10-01T03:00:00.000Z',
    );
    // And once: the next round finds every watermark on that occurrence.
    clock.advance(1_000);
    expect(await scheduler.tick()).toEqual([]);
  });

  test('a task registered after the scheduler started is armed and fires at its own time', async () => {
    const clock = frozenClock('2026-10-01T02:00:00.000Z');
    const driver = createMemoryDriver({ clock });
    const scheduler = createScheduler({ driver, clock, leader: lease(() => undefined) });
    await scheduler.tick();
    clock.advance(30 * 60_000);

    // The task set changes while the scheduler has nothing due and nothing to ask a store.
    const handle = itemJob({ run: () => Promise.resolve() });
    task({
      name: 'idle-late-arrival',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [[handle, { item: 'late' }]],
    });
    await scheduler.tick();
    clock.advance(30 * 60_000);

    expect((await scheduler.tick()).map((occurrence) => occurrence.task)).toEqual([
      'idle-late-arrival',
    ]);
  });

  test('an election that states no window is asked before every dispatch, as before', async () => {
    const clock = frozenClock('2026-10-01T02:59:59.000Z');
    let asked = 0;
    const leader: LeaderElection = {
      acquire: () => {
        asked += 1;
        return Promise.resolve(true);
      },
      release: () => Promise.resolve(),
      renewEveryMs: 0,
    };
    const scheduler = createScheduler({
      driver: createMemoryDriver({ clock }),
      clock,
      leader,
      tasks: nightlyTasks().slice(0, 3),
    });
    await scheduler.tick();
    asked = 0;
    clock.advance(1_000);

    expect(await scheduler.tick()).toHaveLength(3);
    // Once for the round, once before each task it dispatched.
    expect(asked).toBe(4);
  });
});

describe('an idle worker', () => {
  test('converges to one claim every two seconds, however many queues it serves', async () => {
    const clock = frozenClock('2026-10-01T12:00:00.000Z');
    const driver = createMemoryDriver({ clock });
    let claims = 0;
    const counting: JobDriver = {
      ...driver,
      claim: (options) => {
        claims += 1;
        return driver.claim(options);
      },
    };
    const worker = createWorker({
      driver: counting,
      // Three queues, one of them named by no registered job.
      queues: ['default', 'mail', 'configured-and-unused'],
      clock,
      context: () => createContext({ role: 'worker', buildId: 'test' }),
      drainOnShutdown: false,
    });

    const delays: number[] = [];
    for (let elapsed = 0; elapsed < MINUTE; ) {
      await worker.tick();
      const { pollDelayMs } = await worker.stats();
      delays.push(pollDelayMs);
      elapsed += pollDelayMs;
    }

    expect(delays.slice(0, 5)).toEqual([250, 500, 1_000, 2_000, 2_000]);
    expect(Math.max(...delays)).toBe(IDLE_POLL_CEILING_MS);
    // Was 720: a claim per queue every 250 ms. The first pass still asks each queue once; every
    // pass after it is ONE statement over all three.
    expect(claims).toBe(3 + (delays.length - 1));
    expect(claims / 60).toBeLessThan(1);
  });

  test('work found resets the wait, and the pass after it claims per queue again', async () => {
    const clock = frozenClock('2026-10-01T12:00:00.000Z');
    const driver = createMemoryDriver({ clock });
    const asked: number[] = [];
    const counting: JobDriver = {
      ...driver,
      claim: (options) => {
        asked.push(options.queues.length);
        return driver.claim(options);
      },
    };
    const handle = itemJob({ run: () => Promise.resolve() });
    const worker = createWorker({
      driver: counting,
      queues: ['default', 'mail'],
      concurrency: { default: 4, mail: 1 },
      clock,
      context: () => createContext({ role: 'worker', buildId: 'test' }),
      drainOnShutdown: false,
    });
    await worker.tick();
    await worker.tick();
    expect((await worker.stats()).pollDelayMs).toBe(500);

    for (let index = 0; index < 3; index += 1) {
      await driver.enqueue({
        name: handle.name,
        queue: 'default',
        input: { item: `i${index}` },
        idempotencyKey: `idle:${index}`,
        maxAttempts: 1,
      });
    }
    // The idle pass asks both queues at once, for the FEWEST slots either has free — so it can
    // never over-fill `mail`, and it finds one of the three.
    expect(await worker.tick()).toHaveLength(1);
    expect((await worker.stats()).pollDelayMs).toBe(250);
    expect(await worker.tick()).toHaveLength(2);
    expect(asked).toEqual([1, 1, 2, 2, 1, 1]);
  });

  test('a job enqueued in this process starts at once, not at the end of the backed-off wait', async () => {
    const driver = createMemoryDriver();
    setJobDriver(driver);
    let ran = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      ran = resolve;
    });
    const handle = itemJob({
      run: () => {
        ran();
        return Promise.resolve();
      },
    });
    const worker = createWorker({
      driver,
      pollIntervalMs: 100,
      // Far past the test: without the wake, the job below waits this long.
      idlePollMaxMs: 60_000,
      context: () => createContext({ role: 'worker', buildId: 'test' }),
      drainOnShutdown: false,
    });
    worker.start();
    try {
      // Let it idle until the wait in hand is far longer than the assertion's budget.
      while ((await worker.stats()).pollDelayMs < 400) await Bun.sleep(10);
      const before = performance.now();
      await handle.enqueue({ item: 'local' });
      await started;
      // Well inside ONE poll interval: the pass runs now, not `pollIntervalMs` from now.
      expect(performance.now() - before).toBeLessThan(60);
    } finally {
      await worker.stop();
    }
  });
});

describe('an idle outbox relay', () => {
  const relayOver = (onClaim: () => void) => {
    const store = createMemoryOutboxStore();
    return createOutboxRelay({
      driver: createMemoryDriver(),
      store: {
        ...store,
        claim: (limit) => {
          onClaim();
          return store.claim(limit);
        },
      },
      drainOnShutdown: false,
    });
  };

  test('converges to one claim every two seconds', async () => {
    let claims = 0;
    const relay = relayOver(() => {
      claims += 1;
    });

    const delays: number[] = [];
    for (let elapsed = 0; elapsed < MINUTE; ) {
      await relay.tick();
      delays.push(relay.pollDelayMs());
      elapsed += relay.pollDelayMs();
    }

    expect(delays.slice(0, 6)).toEqual([200, 400, 800, 1_600, 2_000, 2_000]);
    // Was 300: a claim every 200 ms.
    expect(claims).toBe(delays.length);
    expect(claims / 60).toBeLessThan(1);
  });

  test('a row staged in this process brings a started relay back to its floor', async () => {
    let claims = 0;
    const relay = relayOver(() => {
      claims += 1;
    });
    await relay.tick();
    await relay.tick();
    await relay.tick();
    expect(relay.pollDelayMs()).toBe(800);

    relay.start();
    try {
      signalStaged();
      expect(relay.pollDelayMs()).toBe(200);
    } finally {
      await relay.stop();
    }
    expect(claims).toBeGreaterThanOrEqual(3);
  });
});

describe('the backoff both loops share', () => {
  test('the first empty pass waits the floor, then doubles to the ceiling and stays', () => {
    const backoff = createIdleBackoff({ subject: 'test', floorMs: 250 });
    expect(backoff.idle()).toBe(false);
    expect([1, 2, 3, 4, 5, 6].map(() => backoff.next(false))).toEqual([
      250, 500, 1_000, 2_000, 2_000, 2_000,
    ]);
    expect(backoff.idle()).toBe(true);
    expect(backoff.next(true)).toBe(250);
    expect(backoff.idle()).toBe(false);
  });

  test('a floor of zero still backs off, and a ceiling under the floor is the floor', () => {
    const immediate = createIdleBackoff({ subject: 'test', floorMs: 0, ceilingMs: 100 });
    expect([1, 2, 3, 4].map(() => immediate.next(false))).toEqual([0, 50, 100, 100]);
    const tight = createIdleBackoff({ subject: 'test', floorMs: 500, ceilingMs: 100 });
    expect([1, 2].map(() => tight.next(false))).toEqual([500, 500]);
    expect(() => createIdleBackoff({ subject: 'test', floorMs: Number.NaN })).toThrow(
      /X_INVARIANT/,
    );
  });
});
