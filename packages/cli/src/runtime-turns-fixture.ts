// Test material: the `runtime-*` unit tests wait for a fact one event-loop turn at a time, never on
// the wall clock. A fake bus and an injected scheduler move when their promises settle, so a test
// awaits the predicate — and one that never holds is a red verdict naming it, not a green sleep.

import { expect } from 'bun:test';

/** One macrotask: every promise the subject chained settles, and every `setImmediate` before it. */
export const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Resolves once `done()` holds; fails the test after `turns` turns with `what` in the message. The
 * bound is a count, not a duration: a loaded runner takes longer per turn, never more turns.
 */
export async function untilTurn(done: () => boolean, what: string, turns = 1_000): Promise<void> {
  for (let left = turns; left > 0; left -= 1) {
    if (done()) return;
    await turn();
  }
  if (!done()) expect.unreachable(`never held within ${String(turns)} turns: ${what}`);
}

/** As `untilTurn`, for a fact only an `await` can read (an LRU `get`, a stored page). */
export async function untilTurnAsync(
  done: () => Promise<boolean>,
  what: string,
  turns = 1_000,
): Promise<void> {
  for (let left = turns; left > 0; left -= 1) {
    if (await done()) return;
    await turn();
  }
  if (!(await done())) expect.unreachable(`never held within ${String(turns)} turns: ${what}`);
}

/** `count` turns pass, for a NEGATIVE claim: whatever the subject would do by then, it has done. */
export async function turns(count: number): Promise<void> {
  for (let left = count; left > 0; left -= 1) await turn();
}

/**
 * A backoff wait that is one turn long, whatever `ms` it was asked for: the dial loop retries as
 * fast as the test turns the loop, and a retry is counted in turns rather than milliseconds.
 */
export const turnScheduler = (fn: () => void): (() => void) => {
  const handle = setImmediate(fn);
  return () => clearImmediate(handle);
};
