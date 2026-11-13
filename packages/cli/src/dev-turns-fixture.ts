// Test material: the `x dev` unit tests wait for a fact one promise job at a time, never on the
// wall clock. A coalescer or a retire settles when its promises do, so a test awaits the predicate,
// and one that never holds is a red verdict naming it — not a green sleep that happened to be long.

import { expect } from 'bun:test';

/**
 * Resolves once `done()` holds; fails the test after `jobs` promise jobs with `what` in the
 * message. The bound is a count, not a duration: a loaded runner takes longer per job, never more.
 */
export async function untilSettled(done: () => boolean, what: string, jobs = 200): Promise<void> {
  for (let left = jobs; left > 0; left -= 1) {
    if (done()) return;
    await Promise.resolve();
  }
  if (!done()) expect.unreachable(`never held within ${String(jobs)} promise jobs: ${what}`);
}

/** Every promise job already chained runs, for a NEGATIVE claim: what would happen, has. */
export async function settled(jobs = 200): Promise<void> {
  for (let left = jobs; left > 0; left -= 1) await Promise.resolve();
}
