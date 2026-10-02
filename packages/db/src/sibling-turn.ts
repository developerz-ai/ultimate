// Single responsibility: a nested scope's wait for its turn among its siblings, under a deadline.
// Sibling scopes run one after the other (savepoints are a stack), so a body that awaits a sibling
// queued BEHIND it is a cycle nothing can break from inside — and an unbounded wait made it a
// silent, permanent hang. Same shape as `pool-reserve.ts`: a late turn is given back, never dropped.

import type { DbError } from './errors';
import type { Turn, TurnQueue } from './pglite-turns';

/**
 * The default wait, in milliseconds. Above the serving roles' `statement_timeout` (10–15 s,
 * `pool-profile.ts`), so a sibling that is merely inside one slow statement finishes or fails
 * first; `{ siblingWaitMs }` moves it and `0` removes it.
 */
export const SIBLING_SCOPE_WAIT_MS = 30_000;

/**
 * `queue.take()` under a deadline. The place in the queue is claimed the moment `take()` is called
 * and cannot be withdrawn, so a wait that gives up must still hand the turn straight on when it
 * arrives — otherwise every later sibling waits behind a scope that no longer exists.
 */
export async function siblingTurn(
  queue: TurnQueue,
  waitMs: number,
  refusal: () => DbError,
): Promise<Turn> {
  const pending = queue.take();
  if (waitMs === 0) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          // Built at expiry, so it names the scope holding the turn NOW.
          reject(refusal());
        }, waitMs);
        // The deadline must not be what keeps a finished process alive.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void pending.then((late) => {
      if (expired) late.release();
    });
  }
}
