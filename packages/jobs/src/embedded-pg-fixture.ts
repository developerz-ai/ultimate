// A real Postgres for the `.job.` suites: the embedded one, with this package's own DDL applied
// the way the boot applies it. Shared by every suite that proves STATEMENTS rather than logic.
//
// TIME. Every statement here reads the DATABASE's `now()`, and this process's clock is frozen by
// the test preload, so there is nothing to advance and nothing to wait for. `age` moves every
// instant the queue holds, a scheduler watermark aside, into the past by the same amount instead.
// No row is deleted and no statement of the driver's is bypassed — a lease that lapses here
// lapses because `expires_at > now()` stopped being true, which is the production path.

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
  /** Empty every table the DDL installed. */
  reset(): Promise<void>;
  /** Every stored instant, `ms` earlier — but a scheduler watermark (`NOT_AGED`). */
  age(ms: number): Promise<void>;
  close(): Promise<void>;
}

const BACK = `($1::bigint * interval '1 millisecond')`;

/**
 * Tables `age` leaves alone, and why. A watermark is a CRON-ALIGNED occurrence the scheduler also
 * holds in memory while it leads: shifting the stored copy would invent a history no occurrence
 * ever had, and disagree with the leader's own. Every other table is aged, whatever it is.
 */
const NOT_AGED: ReadonlySet<string> = new Set(['x_scheduler_state']);

/**
 * Read off the catalog once the DDL is applied, never listed by hand: a hand list missed
 * `x_backfills` and `x_scheduler_leader` in `reset`, and `x_outbox`'s claim in `age`, so a table
 * the DDL grows is held to both promises with no edit here.
 */
async function catalogOf(
  query: <R>(text: string, values: readonly unknown[]) => Promise<readonly R[]>,
): Promise<{
  readonly tables: readonly string[];
  readonly age: readonly string[];
}> {
  const columns = await query<{ table_name: string; column_name: string; data_type: string }>(
    `select c.table_name, c.column_name, c.data_type
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = current_schema() and t.table_type = 'BASE TABLE'
      order by c.table_name, c.ordinal_position`,
    [],
  );
  const instants = new Map<string, string[]>();
  for (const column of columns) {
    const list = instants.get(column.table_name) ?? [];
    if (column.data_type === 'timestamp with time zone') list.push(column.column_name);
    instants.set(column.table_name, list);
  }
  const age = [...instants]
    .filter(([table, list]) => list.length > 0 && !NOT_AGED.has(table))
    .map(
      ([table, list]) =>
        `update ${table} set ${list.map((column) => `${column} = ${column} - ${BACK}`).join(', ')}`,
    );
  return { tables: [...instants.keys()], age };
}

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
    const catalog = await catalogOf(query);
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
        for (const table of catalog.tables) await query(`delete from ${table}`, []);
      },
      async age(ms) {
        for (const statement of catalog.age) await query(statement, [ms]);
      },
      async close() {
        booted = undefined;
        await client.close();
      },
    };
  })();
  return booted;
}
