// Single responsibility: wait, bounded, for a replication slot's previous walsender to let go of it
// before `START_REPLICATION` asks for it. A goodbye is not a release: the old backend frees the
// slot on its way out, after the socket said `Terminate`, so a dial right behind it was refused.

import type { PgConnection } from './pg-connection';
import { assertIdentifier } from './pg-identifier';

/**
 * How many times the slot is asked again, each ask holding the SERVER for `SLOT_POLL_SECONDS` —
 * ~5 s in all. Long enough for any backend that was told goodbye, or whose socket closed, to exit
 * (milliseconds); short enough that a slot held by a genuine second replicator still fails the boot
 * with postgres' own 55006 and its fix, instead of hanging it. A walsender that never heard its
 * client go (no FIN) outlives this by its keepalive, ~25 s; the replicator's restart loop covers it.
 * A count, not a clock: the polls are the server's time, so a frozen test clock cannot stall it.
 */
export const SLOT_RELEASE_POLLS = 100;
const SLOT_POLL_SECONDS = 0.05;

/**
 * Returns once the slot has no `active_pid` (or no longer exists), or after `SLOT_RELEASE_POLLS`
 * asks — then `START_REPLICATION` is left to refuse with 55006, which names the fix. `activePid` is
 * what preflight already read, so a slot nobody holds costs no statement at all. Each ask reads,
 * then sleeps on the server: no client timer, and nothing between the asks for a test to move.
 */
export async function awaitSlotReleased(
  connection: PgConnection,
  slot: string,
  activePid: string | null | undefined,
): Promise<boolean> {
  if (activePid === null || activePid === undefined) return true;
  assertIdentifier('slot', slot);
  for (let poll = 0; poll < SLOT_RELEASE_POLLS; poll += 1) {
    const [row] = await connection.query(
      `SELECT active_pid, pg_sleep(${SLOT_POLL_SECONDS}) FROM pg_replication_slots ` +
        `WHERE slot_name = '${slot}'`,
    );
    if (row === undefined || row[0] === null || row[0] === undefined) return true;
  }
  return false;
}
