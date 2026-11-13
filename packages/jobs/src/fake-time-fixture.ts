// Fake time for a jobs test: Bun's fake timers move every `setTimeout`/`setInterval` a worker, a
// scheduler or a relay arms, and `performance.now()` with them — so a test MOVES time in slices,
// letting each pass's promises settle between them, instead of waiting for the wall clock.
// `setImmediate` stays real: it is how a slice hands the event loop over.

import { afterEach, beforeEach, expect, jest } from 'bun:test';

export interface FakeTime {
  /** `ms` of fake time in `step` slices, a few event-loop turns after each. */
  advance(ms: number, step?: number): Promise<void>;
  /** Event-loop turns with no time passing: promises chained on a settled one run. */
  flush(turns?: number): Promise<void>;
  /**
   * Moves time in `step` slices until `condition` holds; fails once `budgetMs` of FAKE time is
   * spent, so a regression is a red assertion, never a hang and never a race with the runner.
   */
  until(
    condition: () => boolean | Promise<boolean>,
    budgetMs?: number,
    step?: number,
  ): Promise<void>;
  /** Moves time until `promise` settles and answers it; fails past `budgetMs` of fake time. */
  settles<T>(promise: Promise<T>, budgetMs?: number, step?: number): Promise<T>;
  /**
   * A wait of `ms` FAKE time — a job body, a hook that takes a while. Refused outside a test of
   * this file's: without the fake timers under it, it would be the wall-clock wait it replaces.
   */
  sleep(ms: number): Promise<void>;
}

const TURNS = 6;

const turn = (): Promise<void> => new Promise<void>((done) => setImmediate(done));

/** Installs fake timers before each test of the file and restores the real ones after. */
export function useFakeTime(): FakeTime {
  let installed = false;
  beforeEach(() => {
    jest.useFakeTimers();
    installed = true;
  });
  afterEach(() => {
    // Only what this fixture installed: a file that never reached `beforeEach` restores nothing.
    if (installed) jest.useRealTimers();
    installed = false;
  });
  /** Moving time with nothing faked under it would advance nothing and pass on the wall clock. */
  const fakeOnly = (what: string): void => {
    if (!installed) expect.unreachable(`fake-time ${what} outside a fake-timed test`);
  };
  const flush = async (turns = TURNS): Promise<void> => {
    for (let at = 0; at < turns; at += 1) await turn();
  };
  const advance = async (ms: number, step = 5): Promise<void> => {
    fakeOnly('advance');
    await flush();
    for (let gone = 0; gone < ms; gone += step) {
      jest.advanceTimersByTime(Math.min(step, ms - gone));
      await flush();
    }
  };
  const until = async (
    condition: () => boolean | Promise<boolean>,
    budgetMs = 4_000,
    step = 5,
  ): Promise<void> => {
    fakeOnly('until');
    await flush();
    for (let gone = 0; !(await condition()); gone += step) {
      if (gone > budgetMs) expect.unreachable(`the condition never held in ${budgetMs} ms`);
      jest.advanceTimersByTime(step);
      await flush();
    }
  };
  const settles = async <T>(promise: Promise<T>, budgetMs = 4_000, step = 5): Promise<T> => {
    let done = false;
    const watched = promise.finally(() => {
      done = true;
    });
    // Observed before the wait, so a rejection is the caller's to read, never an unhandled one.
    watched.catch(() => undefined);
    await until(() => done, budgetMs, step);
    return watched;
  };
  const sleep = (ms: number): Promise<void> => {
    fakeOnly('sleep');
    return new Promise<void>((done) => setTimeout(done, ms));
  };
  return { advance, flush, until, settles, sleep };
}
