// A real Postgres for the `.job.` suites: the embedded one, with this package's own DDL applied
// the way the boot applies it. Shared by every suite that proves STATEMENTS rather than logic.
//
// TIME. Every statement here reads the DATABASE's `now()`, and this process's clock is frozen by
// the test preload, so there is nothing to advance and nothing to wait for. `age` moves every
// instant the queue holds into the past by the same amount instead. No row is deleted and no
// statement of the driver's is bypassed — a lease that lapses here lapses because
// `expires_at > now()` stopped being true, which is the production path.

import type { PgliteClient } from '@ultimat3/db';
import { createPgliteClient } from '@ultimat3/db';
import type { PgExecutor } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import type { PgListener } from './queue-wake';

export interface EmbeddedPg {
  readonly executor: PgExecutor;
  /** The session a `LISTEN` is held on — what `startQueueWake` takes. */
  readonly listener: PgListener;
  /**
   * One transaction, `work` handed the executor bound to it — what a request's `ctx.tx` is to the
   * outbox. Rolled back instead of committed when `end` says so, or when `work` throws.
   */
  transaction(
    work: (executor: PgExecutor) => Promise<void>,
    end?: 'commit' | 'rollback',
  ): Promise<void>;
  /** Empty every table the queue owns. */
  reset(): Promise<void>;
  /** Every stored instant, `ms` earlier. */
  age(ms: number): Promise<void>;
  close(): Promise<void>;
}

const TABLES = [
  'x_jobs',
  'x_job_steps',
  'x_job_leases',
  'x_job_pauses',
  'x_job_workers',
  'x_job_counters',
  'x_scheduler_state',
  'x_outbox',
  'x_job_events',
];

const BACK = `($1::bigint * interval '1 millisecond')`;

const AGE = [
  `update x_jobs set run_at = run_at - ${BACK}, visible_at = visible_at - ${BACK},
          created_at = created_at - ${BACK}, updated_at = updated_at - ${BACK}`,
  `update x_job_leases set expires_at = expires_at - ${BACK}`,
  `update x_job_workers set expires_at = expires_at - ${BACK},
          heartbeat_at = heartbeat_at - ${BACK}`,
  `update x_job_counters set bucket_start = bucket_start - ${BACK}`,
  `update x_job_events set published_at = published_at - ${BACK},
          expires_at = expires_at - ${BACK}`,
];

let booted: Promise<EmbeddedPg> | undefined;

/** One embedded Postgres per test process — booting it costs seconds. */
export function embeddedPg(): Promise<EmbeddedPg> {
  booted ??= (async () => {
    const client: PgliteClient = createPgliteClient();
    const query = <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
      client.query<R>({ text, values });
    // Statement by statement: the embedded Postgres speaks the extended protocol.
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await query(statement, []);
    }
    return {
      executor: { query },
      listener: client,
      async transaction(work, end = 'commit') {
        using pinned = await client.reserve();
        const bound: PgExecutor = {
          query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
            pinned.query<R>({ text, values }),
        };
        await bound.query('begin', []);
        try {
          await work(bound);
        } catch (error) {
          await bound.query('rollback', []);
          throw error;
        }
        await bound.query(end, []);
      },
      async reset() {
        for (const table of TABLES) await query(`delete from ${table}`, []);
      },
      async age(ms) {
        for (const statement of AGE) await query(statement, [ms]);
      },
      async close() {
        booted = undefined;
        await client.close();
      },
    };
  })();
  return booted;
}
