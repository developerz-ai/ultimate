// Single responsibility: the one deadline every goodbye of a replicator `stop()` is held to — the
// feed's, the lock's, and a start still in flight — on the injected `Scheduler`, so a test fires it.

import type { Scheduler } from './thundering-herd';

/**
 * How long each polite goodbye of a `stop()` may take — the feed's, then the lock's — before the
 * thing is abandoned instead. Both are conversations with a socket; a black-holed one never
 * answers, and a SIGTERM that waited on it never finished.
 */
export const STOP_DEADLINE_MS = 5_000;

export type DeadlineOutcome =
  | { readonly how: 'done' | 'late' }
  | { readonly how: 'failed'; readonly error: unknown };

/** `goodbye` raced against `STOP_DEADLINE_MS`. Never rejects; the timer is cancelled either way. */
export async function withinStopDeadline(
  schedule: Scheduler,
  goodbye: Promise<void>,
): Promise<DeadlineOutcome> {
  let cancel = (): void => undefined;
  const deadline = new Promise<{ readonly how: 'late' }>((resolve) => {
    cancel = schedule(() => resolve({ how: 'late' }), STOP_DEADLINE_MS);
  });
  const said = goodbye.then(
    () => ({ how: 'done' as const }),
    (error: unknown) => ({ how: 'failed' as const, error }),
  );
  const outcome = await Promise.race([said, deadline]);
  cancel();
  return outcome;
}
