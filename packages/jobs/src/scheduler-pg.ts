// The scheduler's durable halves: the watermark it decides "missed" against, and leader election
// that survives a pooled connection. Both were `Map`s and a `() => true` in the shipped boot, and
// both failures are silent — a redeployed pod arms to tomorrow and never reports the 03:00 run the
// pod it replaced dropped, and two pods in a rolling update both dispatch every task.

import type { Clock } from '@ultimat3/core';
import { finiteOption, uuid } from '@ultimat3/core';
import { nowMs } from './clock';
import type { PgExecutor } from './driver-pg';
import {
  SQL_LEADER_ACQUIRE,
  SQL_LEADER_RELEASE,
  SQL_SCHEDULER_STATE_GET,
  SQL_SCHEDULER_STATE_MARK,
} from './driver-pg-sql';
import type { LeaderElection, SchedulerState } from './scheduler';

/**
 * `x_scheduler_state`, one row per task. The watermark is what makes "missed" a decidable
 * question at all: `catchUp`, `maxCatchUp` and `run-once` are all relative to it, so a scheduler
 * whose watermark dies with its process has none of them — it takes the arming branch on every
 * boot and drops every occurrence between the two processes with nothing logged.
 */
export function pgSchedulerState(executor: PgExecutor): SchedulerState {
  return {
    async lastFiredAt(taskName) {
      const rows = await executor.query<{ last_fired_at: number | string | null }>(
        SQL_SCHEDULER_STATE_GET,
        [taskName],
      );
      const value = rows[0]?.last_fired_at;
      return value === null || value === undefined ? undefined : Number(value);
    },
    async markFired(taskName, occurrenceMs) {
      await executor.query(SQL_SCHEDULER_STATE_MARK, [taskName, occurrenceMs]);
    },
  };
}

export interface PgLeaseLeaderOptions {
  readonly executor: PgExecutor;
  /** One key per elected role. Default `'scheduler'`. */
  readonly lockKey?: string;
  /** This node's identity. Defaults to a per-process uuid — never a hostname a pod reuses. */
  readonly holder?: string;
  /**
   * How long a grant survives without a renewal. Must be comfortably longer than the scheduler's
   * tick interval, or a slow round loses the lock to a standby mid-dispatch. Default 30s against
   * a 1s tick.
   */
  readonly ttlMs?: number;
  readonly clock?: Clock;
}

export const DEFAULT_LEADER_TTL_MS = 30_000;

/**
 * Leader election as an expiring row, which is what makes it correct on the executor this package
 * is actually handed: a POOL. `createPgLeader`'s `pg_try_advisory_lock` is session-scoped, and a
 * session on a pool ends the moment the connection goes back — so every node reads itself as
 * leader and a rolling update double-fires every task. `@ultimat3/realtime`'s `PgAdvisoryLock`
 * solves the same problem by owning its connection; this package holds no wire protocol, so it
 * solves it with a row instead.
 *
 * `acquire()` is also the RENEWAL, so the scheduler calling it every round both keeps the lease
 * alive and learns the round it stops being leader. A crashed node's lease is reclaimed by expiry
 * with nothing to clean up, which is the one property the advisory lock had and a plain
 * `insert ... on conflict do nothing` would not.
 */
export function createPgLeaseLeader(options: PgLeaseLeaderOptions): LeaderElection {
  const lockKey = options.lockKey ?? 'scheduler';
  const holder = options.holder ?? `scheduler-${uuid()}`;
  const ttlMs = finiteOption(
    'the pg scheduler lease',
    'ttlMs',
    options.ttlMs ?? DEFAULT_LEADER_TTL_MS,
  );
  return {
    async acquire() {
      const rows = await options.executor.query<{ holder: string }>(SQL_LEADER_ACQUIRE, [
        lockKey,
        holder,
        ttlMs,
      ]);
      return rows[0]?.holder === holder;
    },
    async release() {
      await options.executor.query(SQL_LEADER_RELEASE, [lockKey, holder]);
    },
  };
}

/** Exposed so a test — and `x jobs ls` — can say which node currently holds the lease. */
export async function currentLeader(
  executor: PgExecutor,
  lockKey = 'scheduler',
  clock?: Clock,
): Promise<string | undefined> {
  const rows = await executor.query<{ holder: string; expires_at: number | string }>(
    `select holder, (extract(epoch from expires_at) * 1000)::bigint as expires_at
       from x_scheduler_leader where lock_key = $1`,
    [lockKey],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return Number(row.expires_at) > nowMs(clock) ? row.holder : undefined;
}
