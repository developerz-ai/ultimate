// The scheduler samples the Postgres server's own health — on a real server only: the embedded
// database is one process's private copy, and its "connections" and "slots" describe no fleet.
// The sampler itself (its interval, its round in flight) is `@ultimat3/db`'s, tested there.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { startRolePgStats } from './role-pg-stats';

const executor: PgExecutor = { query: async <R>() => [] as R[] };

/** A sampler starter that records what it was handed and returns a stop the test can identify. */
function recordingStarter() {
  const started: PgExecutor[] = [];
  const stop = async (): Promise<void> => {};
  return {
    started,
    stop,
    start: (handed: PgExecutor): (() => Promise<void>) => {
      started.push(handed);
      return stop;
    },
  };
}

describe('unit · the scheduler pg stats sampler', () => {
  test('a scheduler on an external database starts it on the executor it was handed', () => {
    const starter = recordingStarter();
    const stop = startRolePgStats(['scheduler'], 'external', executor, starter.start);
    expect(starter.started).toEqual([executor]);
    // The sampler's own stop, never a wrapper: it awaits the round in flight, and a wrapper that
    // dropped that promise let the role's unwind close the pool under a sampling query.
    expect(stop).toBe(starter.stop);
  });

  test('on the embedded database it starts nothing', () => {
    const starter = recordingStarter();
    expect(startRolePgStats(['scheduler'], 'embedded', executor, starter.start)).toBeNull();
    expect(starter.started).toEqual([]);
  });

  test('a process with no scheduler role starts nothing', () => {
    const starter = recordingStarter();
    expect(startRolePgStats(['web', 'worker'], 'external', executor, starter.start)).toBeNull();
    expect(starter.started).toEqual([]);
  });
});
