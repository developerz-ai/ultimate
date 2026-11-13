// Test material: wait for a fact one event-loop turn at a time. A fake bus, a fake socket and an
// injected scheduler move when their promises settle, never on the wall clock — so a test awaits
// the predicate, and one that never holds is a red verdict naming it, not a green timeout.

import { expect } from 'bun:test';

/** One macrotask: every promise the subject chained settles before it returns. */
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

/** `turns` turns pass, for a NEGATIVE claim: whatever the subject would do by then, it has done. */
export async function turns(count: number): Promise<void> {
  for (let left = count; left > 0; left -= 1) await turn();
}

/**
 * Every promise already chained settles, and no timer runs: what a test under Bun's fake timers
 * awaits, where a macrotask turn is the faked clock's to give.
 */
export async function microtasks(count = 50): Promise<void> {
  for (let left = count; left > 0; left -= 1) await Promise.resolve();
}
