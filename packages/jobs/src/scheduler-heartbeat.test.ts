// The scheduler's dispatch loop stamps its heartbeat (`loop-heartbeat.ts`): a round that never
// returns — the event loop alive, the dispatch loop stuck — is stale within the bound, an idle
// scheduler ticking on its interval stays fresh, and a stopped one is not judged at all.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetLifecycle } from '@ultimat3/core';
import { memoryJobDriver } from './driver-memory';
import { useFakeTime } from './fake-time-fixture';
import { resetJobs } from './job';
import { LIVENESS_FLOOR_MS, staleLoops } from './loop-heartbeat';
import { jobScheduler } from './scheduler';
import type { LeaderElection } from './scheduler-leader';
import { resetTasks } from './task';

afterEach(() => {
  resetJobs();
  resetTasks();
  resetLifecycle();
});

const time = useFakeTime();

describe('unit · scheduler heartbeat', () => {
  test('a round that never returns turns the scheduler stale within its bound', async () => {
    let asks = 0;
    let release = (): void => undefined;
    // The election is the round's first await: the second round parks on it, as a lease
    // statement that never answers would.
    const leader: LeaderElection = {
      async acquire() {
        asks += 1;
        if (asks === 2) await new Promise<void>((done) => (release = done));
        return true;
      },
      release: () => Promise.resolve(),
      renewEveryMs: 0,
    };
    const scheduler = jobScheduler({
      driver: memoryJobDriver(),
      leader,
      tasks: [],
      tickIntervalMs: 25,
      drainOnShutdown: false,
    });
    scheduler.start();
    try {
      await time.until(() => asks === 2);
      await time.advance(LIVENESS_FLOOR_MS - 1_000, 1_000);
      expect(staleLoops()).toEqual([]);
      await time.advance(2_000, 1_000);
      expect(staleLoops().map((loop) => [loop.name, loop.reason])).toEqual([
        ['jobs.scheduler', 'held'],
      ]);
    } finally {
      release();
      await scheduler.stop();
    }
    expect(staleLoops()).toEqual([]);
  });

  test('an idle scheduler ticking on its interval stays fresh for minutes', async () => {
    const scheduler = jobScheduler({
      driver: memoryJobDriver(),
      tasks: [],
      tickIntervalMs: 1_000,
      drainOnShutdown: false,
    });
    scheduler.start();
    try {
      await time.advance(5 * 60_000, 500);
      expect(staleLoops()).toEqual([]);
    } finally {
      await scheduler.stop();
    }
    expect(staleLoops()).toEqual([]);
  });
});
