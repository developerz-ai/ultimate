// `catchUp: 'run-once'` across a crash. The catch-up fired through `SchedulerState.fire` and the
// missed occurrences were dropped by a SECOND call, `markFired(at)`: a scheduler that died between
// the two left the watermark on the occurrence it ran, and the next leader fired another
// "one catch-up" — one per restart until the backlog was gone.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { resetJobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import type { CronResolver } from './scheduler';
import { createScheduler } from './scheduler';
import type { ScheduledFire, SchedulerState } from './scheduler-state';
import { memorySchedulerState } from './scheduler-state';
import type { TaskHandle } from './task';
import { resetTasks, task } from './task';

const HOUR_MS = 3_600_000;
// 2026-07-26T00:00:00Z.
const T0 = Date.UTC(2026, 6, 26, 0, 0, 0);

const hourly: CronResolver = (_cron, options) =>
  new Date(Math.floor(options.from.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);

function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    monotonic: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

const passthrough: StandardSchemaV1<unknown, Record<string, never>> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as Record<string, never> }),
  },
};

let digest: JobHandle<Record<string, never>>;
let once: TaskHandle;

beforeEach(() => {
  resetJobs();
  resetTasks();
  digest = job<Record<string, never>>({
    tenant: 'none',
    name: 'digest',
    input: passthrough,
    idempotencyKey: () => 'digest',
    retry: { attempts: 1 },
    run: () => Promise.resolve(),
  });
  once = task({
    name: 'hourlyOnce',
    cron: '0 * * * *',
    tz: 'UTC',
    catchUp: 'run-once',
    enqueue: () => [[digest, {}]],
  });
});

afterEach(() => {
  resetJobDriver();
});

/** The store, every call recorded, and a `markFired` AFTER the fire able to die with the process. */
function watched(inner: SchedulerState) {
  const fires: ScheduledFire[] = [];
  const marks: number[] = [];
  const control = { crashOnMark: false };
  const state: SchedulerState = {
    lastFiredAt: (name) => inner.lastFiredAt(name),
    markFired(name, occurrenceMs) {
      if (control.crashOnMark) return Promise.reject(new Error('the process died here'));
      marks.push(occurrenceMs);
      return inner.markFired(name, occurrenceMs);
    },
    fire(driver, fire) {
      fires.push(fire);
      // The store's own fire — the one write that is allowed to land before the process dies.
      return inner.fire(driver, fire);
    },
  };
  return { state, fires, marks, control };
}

describe('run-once is one write', () => {
  test('the catch-up and the dropped occurrences move in ONE fire, with no mark behind it', async () => {
    const clock = fakeClock(T0);
    const driver = memoryJobDriver({ clock });
    const { state, fires, marks } = watched(memorySchedulerState());
    const scheduler = createScheduler({ driver, clock, cron: hourly, state, tasks: [once] });

    await scheduler.tick(); // Arms: the one legitimate `markFired`.
    expect(marks).toHaveLength(1);
    clock.advance(5 * HOUR_MS + 1_000);
    const at = clock.now().getTime();

    expect(await scheduler.tick()).toHaveLength(1);

    expect(fires).toHaveLength(1);
    // The EARLIEST missed occurrence is what runs; `at` is where the watermark lands.
    expect(fires[0]?.occurrenceMs).toBe(T0 + HOUR_MS);
    expect(fires[0]?.watermarkMs).toBe(at);
    expect(marks).toHaveLength(1);
    expect(await state.lastFiredAt('hourlyOnce')).toBe(at);
  });

  test('a scheduler that dies right after the fire leaves nothing for its successor to re-fire', async () => {
    const clock = fakeClock(T0);
    const driver = memoryJobDriver({ clock });
    const durable = memorySchedulerState();
    const first = watched(durable);
    const dying = createScheduler({
      driver,
      clock,
      cron: hourly,
      state: first.state,
      tasks: [once],
    });
    await dying.tick();
    clock.advance(5 * HOUR_MS + 1_000);
    // Everything AFTER the fire is lost with the process.
    first.control.crashOnMark = true;
    await dying.tick();
    expect(((await driver.introspect?.list()) ?? []).length).toBe(1);

    // The job ran and finished, so the occurrence key no longer dedupes a second catch-up.
    const [claimed] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 1_000,
      workerId: 'w1',
    });
    if (claimed === undefined) return expect.unreachable('the catch-up was not claimable');
    await driver.ack(claimed.id, { workerId: 'w1', claim: claimed.claim });

    const successor = createScheduler({
      driver,
      clock,
      cron: hourly,
      state: durable,
      tasks: [once],
    });
    clock.advance(1_000);
    expect(await successor.tick()).toEqual([]);
    expect(((await driver.introspect?.list()) ?? []).length).toBe(1);
  });

  test('a fire with no watermark of its own lands on its occurrence, as every other policy does', async () => {
    const driver = memoryJobDriver();
    const state = memorySchedulerState();
    await state.fire(driver, { task: 't', occurrenceMs: 5_000, jobs: [] });
    expect(await state.lastFiredAt('t')).toBe(5_000);
    await state.fire(driver, { task: 't', occurrenceMs: 6_000, watermarkMs: 9_000, jobs: [] });
    expect(await state.lastFiredAt('t')).toBe(9_000);
    // The fence is the OCCURRENCE: 8_000 is behind the watermark, so it was dropped, not missed.
    expect(await state.fire(driver, { task: 't', occurrenceMs: 8_000, jobs: [] })).toBeUndefined();
  });
});
