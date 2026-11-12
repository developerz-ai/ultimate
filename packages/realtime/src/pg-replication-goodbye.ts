// Single responsibility: the read a replication stream's `stop()` owes the walsender between its
// CopyDone and its Terminate — bounded, because a silent server must not hold a SIGTERM.

import type { PgConnection } from './pg-connection';
import type { Scheduler } from './thundering-herd';

/**
 * How long `stop()` reads the walsender's goodbye before closing anyway. A healthy server answers a
 * CopyDone in one round trip; one that does not is not worth a slower shutdown.
 */
export const COPY_DRAIN_MS = 1_000;

/**
 * The walsender answers a CopyDone with its own, a CommandComplete and a ReadyForQuery. Closed over
 * unread, the socket answered with a reset: one `Connection reset by peer` in the server log per
 * deploy. `pump` holds the one reader, so it is waited out first — it returns on its next message,
 * once the stream has let the connection go — and the rest is read here. Both share one
 * `COPY_DRAIN_MS` bound; past it the close goes ahead unread. `true` when `ReadyForQuery` was read.
 */
export async function drainGoodbye(
  connection: PgConnection,
  pump: Promise<void> | null,
  schedule: Scheduler,
): Promise<boolean> {
  let cancel = (): void => undefined;
  const deadline = new Promise<void>((resolve) => {
    cancel = schedule(resolve, COPY_DRAIN_MS);
  });
  try {
    const late = deadline.then(() => false);
    // Settled either way: a pump's own failure is `stop()`'s to report, not a reason to skip this.
    const settled = pump?.then(
      () => true,
      () => true,
    );
    const handed = settled === undefined || (await Promise.race([settled, late]));
    return handed && (await connection.awaitCopyEnd(deadline));
  } finally {
    cancel();
  }
}
