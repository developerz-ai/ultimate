// The `clock` fixture: the only legal way for time to pass inside a test.
//
// `clock.advance('3d')` is synchronous — a job test asserts on what is due on the very next
// line — so the duration parser is resolved while the fixture is built, not when it is used.

import {
  advanceClock,
  captureDeterminism,
  frozenNow,
  restoreCapturedDeterminism,
  setFrozenClock,
} from './determinism';

/** `'3d'` | `'30s'` | `1500`. Same vocabulary as a job's `timeout` and a step's `sleep`. */
export type TestDuration = string | number;

export interface TestClock {
  /** The frozen instant. Never the wall clock. */
  now(): Date;
  advance(duration: TestDuration): Date;
  set(instant: string | number): Date;
  /** Puts the instant this fixture was built at back. `fixtureTest` calls it; see below. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * The frozen instant is module-global and `advance`/`set` move it, so this fixture installs
 * process state exactly the way the mail and job fixtures do — and until it disposed, a test that
 * advanced three days handed the advanced clock to every later test FILE in the run (`bun test` is
 * one process), where the failure lands on an innocent suite.
 *
 * `captureDeterminism`/`restoreCapturedDeterminism` rather than `restoreDeterminism()`: the preload
 * installed determinism once for the whole process, and uninstalling it here would hand the REAL
 * `Date` and the REAL `Math.random` to everything after. Restore only what was found.
 */
export async function createTestClock(): Promise<TestClock> {
  const { toMs } = await import('@ultimat3/time');
  const captured = captureDeterminism();
  return {
    now: frozenNow,
    // The two names are the CALLER's: an author who wrote `clock.advance('3s')` never typed
    // `toMs`, and `pass a finite duration to toMs` sends them looking for a knob their code does
    // not contain. `@ultimat3/time`'s `toMs` takes them optionally for exactly this.
    advance: (duration) => advanceClock(toMs(duration, 'clock.advance', 'duration')),
    set: (instant) => {
      setFrozenClock(instant);
      return frozenNow();
    },
    [Symbol.asyncDispose]: async () => {
      restoreCapturedDeterminism(captured);
    },
  };
}
