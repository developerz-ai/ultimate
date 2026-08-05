// The `clock` fixture: the only legal way for time to pass inside a test.
//
// `clock.advance('3d')` is synchronous — a job test asserts on what is due on the very next
// line — so the duration parser is resolved while the fixture is built, not when it is used.

import { advanceClock, frozenNow, setFrozenClock } from './determinism';

/** `'3d'` | `'30s'` | `1500`. Same vocabulary as a job's `timeout` and a step's `sleep`. */
export type TestDuration = string | number;

export interface TestClock {
  /** The frozen instant. Never the wall clock. */
  now(): Date;
  advance(duration: TestDuration): Date;
  set(instant: string | number): Date;
}

export async function createTestClock(): Promise<TestClock> {
  const { toMs } = await import('@ultimat3/time');
  return {
    now: frozenNow,
    advance: (duration) => advanceClock(toMs(duration)),
    set: (instant) => {
      setFrozenClock(instant);
      return frozenNow();
    },
  };
}
