// A database restart fails every scheduler round until it is back. The round's timer keeps
// re-arming — that is the recovery — but the log says it once: the first failure, then the
// recovery with the count. 154 identical `jobs.scheduler.tick-failed` lines for one restart was
// the production shape (2026-11-14). Fake time fires the scheduler's own timer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installLogSink, resetLifecycle } from '@ultimat3/core';
import { resetJobDriver } from './adapter';
import { memoryJobDriver } from './driver-memory';
import { DriverUnavailableError } from './errors';
import { useFakeTime } from './fake-time-fixture';
import { resetJobsFacade } from './outbox';
import { jobScheduler } from './scheduler';
import type { LeaderElection } from './scheduler-leader';

const time = useFakeTime();

const events: string[] = [];
let releaseLogSink: () => void = () => undefined;

beforeEach(() => {
  events.length = 0;
  resetLifecycle();
  releaseLogSink = installLogSink((line) => {
    const parsed = JSON.parse(line) as { msg?: string; event?: string };
    events.push(parsed.msg ?? parsed.event ?? line);
  });
});

afterEach(() => {
  releaseLogSink();
  resetJobDriver();
  resetJobsFacade();
  resetLifecycle();
});

/** An election whose store is down until `up()`: every `acquire` rejects, as a pool timeout does. */
function restartingLeader(): { readonly leader: LeaderElection; up(): void } {
  let down = true;
  return {
    leader: {
      renewEveryMs: 0,
      acquire: () =>
        down
          ? Promise.reject(
              new DriverUnavailableError({ driver: 'postgres', cause: 'restarting', fix: 'wait' }),
            )
          : Promise.resolve(true),
      release: () => Promise.resolve(),
    },
    up: () => {
      down = false;
    },
  };
}

describe('a scheduler through a database restart', () => {
  test('logs the first failed round and the recovery, never a line per round', async () => {
    const restart = restartingLeader();
    const scheduler = jobScheduler({
      driver: memoryJobDriver(),
      tasks: [],
      tickIntervalMs: 10,
      leader: restart.leader,
    });
    scheduler.start();
    await time.advance(500, 10);
    restart.up();
    await time.advance(50, 10);
    await time.settles(scheduler.stop(), 100);

    const ticks = events.filter((event) => event.startsWith('jobs.scheduler.tick-'));
    expect(ticks).toEqual(['jobs.scheduler.tick-failed', 'jobs.scheduler.tick-recovered']);
  });
});
