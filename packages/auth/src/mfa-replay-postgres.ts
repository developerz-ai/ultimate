// The shared replay guard: one Postgres table, so a TOTP code spent on one replica is spent on all
// of them. A claim is one `insert … on conflict do nothing`, because a read and a write are two
// round trips and two replicas fit between them; the primary key is what decides the race.
import type { PgExecutor } from '@ultimat3/core';
import { TOTP_DRIFT_STEPS, type TotpReplayGuard, totpStep } from './mfa';

/** `$1` subject, `$2` step, `$3` the caller's clock. A row back is the first use; none, a replay. */
export const SQL_TOTP_CLAIM = `
insert into x_totp_steps (subject, step, used_at)
values ($1, $2::bigint, $3::timestamptz)
on conflict (subject, step) do nothing
returning 1 as claimed
`;

/** `$1` the lowest step still kept, computed from the CALLER's clock and never `now()`. */
export const SQL_TOTP_PURGE = `
with dropped as (
  delete from x_totp_steps where step < $1::bigint returning 1
)
select count(*) as removed from dropped
`;

/**
 * A minute past the drift window. `verifyTotp` reads its replica's own clock, so a replica running
 * behind the sweep's still offers a step the sweep's clock has written off; a row kept a little
 * longer costs nothing and a row taken early reopens a spent code.
 */
const SWEEP_SLACK_STEPS = 2;

export interface PostgresTotpReplayGuardOptions {
  readonly executor: PgExecutor;
}

export interface PostgresTotpReplayGuard extends TotpReplayGuard {
  /**
   * Drop every step no replica can offer again, and answer how many rows went. The table takes one
   * row per second factor and does not bound itself; `@ultimat3/cli`'s hourly sweep calls this.
   */
  purgeExpired(nowMs: number): Promise<number>;
}

export function postgresTotpReplayGuard(
  options: PostgresTotpReplayGuardOptions,
): PostgresTotpReplayGuard {
  const exec = options.executor;
  return {
    // A rejection from the executor passes through on purpose: `completeMfa` reads it as no verdict.
    async claim(subject, step, at): Promise<boolean> {
      const rows = await exec.query(SQL_TOTP_CLAIM, [subject, step, at.toISOString()]);
      return rows.length > 0;
    },

    async purgeExpired(nowMs): Promise<number> {
      const floor = totpStep(new Date(nowMs)) - TOTP_DRIFT_STEPS - SWEEP_SLACK_STEPS;
      const rows = await exec.query<{ readonly removed: number | string }>(SQL_TOTP_PURGE, [floor]);
      return Number(rows[0]?.removed ?? 0);
    },
  };
}
