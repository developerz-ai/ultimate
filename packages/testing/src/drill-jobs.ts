// What the jobs tables say after a drill: how many jobs the drill window created, how many are not
// terminal once the fleet had its chance to reclaim them, and how many idempotency keys completed
// twice. Read straight off `x_jobs` on a direct connection — never through the faulted proxy.

import { finiteCount } from '@ultimat3/core';

/** The one query surface this file needs; `Bun.SQL` satisfies it, a test hands in rows. */
export interface DrillSql {
  rows(text: string, params: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}

export interface DrillJobCounts {
  readonly ran: number;
  readonly stuck: number;
  readonly doubled: number;
}

/** Not terminal and due: claimable and unclaimed, or running past nothing reclaiming it. */
export const STUCK_SQL = `select count(*)::int as n from x_jobs
  where created_at >= $1 and state in ('ready', 'delayed', 'running') and run_at <= now()`;

export const RAN_SQL = 'select count(*)::int as n from x_jobs where created_at >= $1';

/** A key completed twice: the live-row dedupe only holds while the first is live. */
export const DOUBLED_SQL = `select count(*)::int as n from (
  select 1 from x_jobs where created_at >= $1 and state = 'done'
  group by name, coalesce(tenant_id, ''), idempotency_key having count(*) > 1) twice`;

const count = async (sql: DrillSql, text: string, since: Date): Promise<number> => {
  const [row] = await sql.rows(text, [since]);
  const value = row?.['n'];
  return typeof value === 'number' ? value : Number(value ?? 0);
};

export interface DrillJobsOptions {
  readonly sql: DrillSql;
  readonly since: Date;
  /** How long a killed worker's run may take to be reclaimed and finished. */
  readonly settleMs: number;
  readonly pollMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** Counted once nothing is stuck, or once `settleMs` has passed — whichever is first. */
export async function drillJobCounts(options: DrillJobsOptions): Promise<DrillJobCounts> {
  const settleMs = finiteCount('drillJobCounts', 'settleMs', options.settleMs);
  const pollMs = finiteCount('drillJobCounts', 'pollMs', options.pollMs ?? 250, 1);
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const until = now() + settleMs;
  let stuck = await count(options.sql, STUCK_SQL, options.since);
  while (stuck > 0 && now() < until) {
    await sleep(pollMs);
    stuck = await count(options.sql, STUCK_SQL, options.since);
  }
  return {
    ran: await count(options.sql, RAN_SQL, options.since),
    stuck,
    doubled: await count(options.sql, DOUBLED_SQL, options.since),
  };
}

/** `Bun.SQL` behind `DrillSql`: the drill's direct line to the scratch database. */
export function bunDrillSql(url: string): DrillSql & { close(): Promise<void> } {
  const client = new Bun.SQL(url);
  return {
    rows: async (text, params) =>
      (await client.unsafe(text, [...params])) as readonly Record<string, unknown>[],
    close: () => client.close(),
  };
}
