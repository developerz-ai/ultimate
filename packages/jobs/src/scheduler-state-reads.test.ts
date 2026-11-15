// How often a scheduler asks its store for watermarks: once a cold round for every task it does not
// know, never again for a task whose `enqueue` threw before anything was fired, and per task only
// for a store that states no bulk read. The memory store mirrors `postgresSchedulerState`'s read.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { memoryJobDriver } from './driver-memory';
import { resetJobs } from './job';
import { itemJob } from './operator-surface-fixture';
import type { CronResolver } from './scheduler';
import { jobScheduler } from './scheduler';
import type { LeaderElection } from './scheduler-leader';
import { soleLeader } from './scheduler-leader';
import type { SchedulerState } from './scheduler-state';
import { memorySchedulerState, readWatermarks } from './scheduler-state';
import type { TaskHandle } from './task';
import { resetTasks, task } from './task';

const MINUTE = 60_000;

afterEach(() => {
  resetJobs();
  resetTasks();
});

const everyMinute: CronResolver = (_cron, options) =>
  new Date(Math.floor(options.from.getTime() / MINUTE) * MINUTE + MINUTE);

/** Every read the store answers, by method. */
function reading(base: SchedulerState): { state: SchedulerState; reads: Record<string, number> } {
  const reads: Record<string, number> = { lastFiredAt: 0, watermarks: 0 };
  return {
    reads,
    state: {
      lastFiredAt(name) {
        reads['lastFiredAt'] = (reads['lastFiredAt'] ?? 0) + 1;
        return base.lastFiredAt(name);
      },
      watermarks(names) {
        reads['watermarks'] = (reads['watermarks'] ?? 0) + 1;
        return readWatermarks(base, names);
      },
      markFired: (name, at) => base.markFired(name, at),
      fire: (driver, fire) => base.fire(driver, fire),
    },
  };
}

function tasksOf(count: number, enqueue?: () => never): TaskHandle[] {
  const beat = itemJob({ run: () => Promise.resolve() });
  return Array.from({ length: count }, (_, index) =>
    task({
      name: `reads-task-${index}`,
      cron: '* * * * *',
      tz: 'UTC',
      enqueue: enqueue ?? (() => [[beat, { item: `beat-${index}` }]]),
    }),
  );
}

describe('scheduler watermark reads', () => {
  test('a newly elected leader reads every watermark in ONE read, not one a task', async () => {
    const clock = frozenClock('2026-11-14T12:00:30.000Z');
    const shared = memorySchedulerState();
    const tasks = tasksOf(10);
    await jobScheduler({ driver: memoryJobDriver({ clock }), clock, state: shared, tasks }).tick();
    let leading = false;
    const leader: LeaderElection = {
      acquire: () => Promise.resolve(leading),
      release: () => Promise.resolve(),
      renewEveryMs: 0,
    };
    const { state, reads } = reading(shared);
    const node = jobScheduler({ driver: memoryJobDriver({ clock }), clock, state, leader, tasks });

    expect(await node.tick()).toEqual([]);
    expect(reads).toEqual({ lastFiredAt: 0, watermarks: 0 });
    leading = true;
    expect(await node.tick()).toEqual([]);
    expect(reads).toEqual({ lastFiredAt: 0, watermarks: 1 });
  });

  test('a task whose enqueue throws every round is never read again', async () => {
    const clock = frozenClock('2026-11-14T12:00:30.000Z');
    const { state, reads } = reading(memorySchedulerState());
    const node = jobScheduler({
      driver: memoryJobDriver({ clock }),
      clock,
      state,
      cron: everyMinute,
      leader: soleLeader(),
      // A broken task body: the parse throws inside `enqueue`, before anything is fired.
      tasks: tasksOf(1, () => JSON.parse('{') as never),
    });
    await node.tick();
    reads['watermarks'] = 0;

    for (let round = 0; round < 5; round += 1) {
      clock.advance(MINUTE);
      expect(await node.tick()).toEqual([]);
    }

    // The throw came before the fire, so the watermark it remembered is still the store's: it was
    // read once a round, for a task due every round, until a deploy.
    expect(reads).toEqual({ lastFiredAt: 0, watermarks: 0 });
  });

  test('a failed read costs the cold tasks one round, and the next round reads them again', async () => {
    const clock = frozenClock('2026-11-14T12:00:30.000Z');
    const base = memorySchedulerState();
    let refuse = true;
    const state: SchedulerState = {
      ...base,
      watermarks: (names) =>
        refuse
          ? Promise.reject(new TypeError('the connection is gone'))
          : readWatermarks(base, names),
    };
    const node = jobScheduler({
      driver: memoryJobDriver({ clock }),
      clock,
      state,
      cron: everyMinute,
      leader: soleLeader(),
      tasks: tasksOf(3),
    });

    expect(await node.tick()).toEqual([]);
    expect(await base.lastFiredAt('reads-task-0')).toBeUndefined();
    refuse = false;
    expect(await node.tick()).toEqual([]);
    clock.advance(MINUTE);
    expect(await node.tick()).toHaveLength(3);
  });

  test('a store that states no bulk read is asked per task', async () => {
    const base = memorySchedulerState();
    await base.markFired('a', 5);
    const names: string[] = [];
    const legacy: SchedulerState = {
      lastFiredAt(name) {
        names.push(name);
        return base.lastFiredAt(name);
      },
      markFired: (name, at) => base.markFired(name, at),
      fire: (driver, fire) => base.fire(driver, fire),
    };

    expect([...(await readWatermarks(legacy, ['a', 'b']))]).toEqual([['a', 5]]);
    expect(names).toEqual(['a', 'b']);
    expect([...(await readWatermarks(legacy, []))]).toEqual([]);
    expect(names).toEqual(['a', 'b']);
  });

  test('memory: a task never armed is absent, as the pg read leaves it', async () => {
    const state = memorySchedulerState();
    await state.markFired('armed', 7);
    await state.markFired('armed', 3);

    expect([...((await state.watermarks?.(['armed', 'never'])) ?? [])]).toEqual([['armed', 7]]);
  });
});
