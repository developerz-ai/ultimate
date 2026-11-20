// A drill's scratch database: created on the admin URL, dropped when the fleet stops. The drop
// waits out a logical slot a role's walsender still holds — postgres refuses `DROP DATABASE` on a
// database with an ACTIVE slot before `WITH (FORCE)` terminates anyone — then terminates the holder.

import { renderCauseValue, renderThrowable } from '@ultimat3/core';
import { DrillTeardownFailedError } from './drill-errors';
import { dropSql, urlFor } from './template-db';

/** The admin connection the drop runs on; injected so the unit tests need no server. */
export interface ScratchAdminSql {
  query(
    statement: string,
    params?: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
  close(): Promise<void>;
}

/**
 * How many times the slots are asked again per wait, each ask holding the SERVER 50 ms — ~5 s, as
 * realtime's `SLOT_RELEASE_POLLS`: a walsender whose socket closed exits in milliseconds. A count,
 * not a clock: nothing waits on this process's timers, and a slot nobody holds costs one ask.
 */
export const SCRATCH_SLOT_POLLS = 100;

const NAME = /^x_drill_[0-9a-f]{16}$/;

/** The slots on the database still held, with who holds them; the sleep runs only per held row. */
const HELD_SQL =
  'select slot_name, active_pid, pg_sleep(0.05) from pg_replication_slots ' +
  'where database = $1 and active_pid is not null';

const TERMINATE_SQL =
  'select pg_terminate_backend(active_pid) from pg_replication_slots ' +
  'where database = $1 and active_pid is not null';

interface Holder {
  readonly slot: string;
  readonly pid: number;
}

const holdersOf = (rows: readonly Record<string, unknown>[]): readonly Holder[] =>
  rows.map((row) => ({
    slot: typeof row['slot_name'] === 'string' ? row['slot_name'] : '<unnamed>',
    pid: Number(row['active_pid']),
  }));

/** Polls until no slot on the database is active, or the bound: then the last holders seen. */
async function awaitInactive(sql: ScratchAdminSql, name: string): Promise<readonly Holder[]> {
  let holders: readonly Holder[] = [];
  for (let poll = 0; poll < SCRATCH_SLOT_POLLS; poll += 1) {
    holders = holdersOf(await sql.query(HELD_SQL, [name]));
    if (holders.length === 0) return holders;
  }
  return holders;
}

const refused = (adminUrl: string, database: string, why: string): DrillTeardownFailedError =>
  new DrillTeardownFailedError({ database, adminUrl, why });

/**
 * Drop `name`: wait (bounded) for its slots to go inactive, terminate a holder that outlived the
 * wait and wait again, then `DROP DATABASE … WITH (FORCE)`, which removes the inactive slot too.
 */
export async function dropScratchDatabase(
  sql: ScratchAdminSql,
  name: string,
  adminUrl: string,
): Promise<void> {
  if (!NAME.test(name)) {
    throw refused(adminUrl, name, `${renderCauseValue(name)} is not a drill scratch database`);
  }
  // Every statement in one `try`: the admin session can drop during the wait, and Bun.SQL then
  // rejects a poll or the terminate with a raw error the drill would otherwise print uncoded.
  let holders: readonly Holder[];
  try {
    holders = await awaitInactive(sql, name);
    if (holders.length > 0) {
      await sql.query(TERMINATE_SQL, [name]);
      holders = await awaitInactive(sql, name);
    }
    if (holders.length === 0) await sql.query(dropSql(name));
  } catch (error) {
    throw refused(adminUrl, name, renderThrowable(error));
  }
  if (holders.length > 0) {
    const named = holders.map((holder) => `slot ${holder.slot} (pid ${String(holder.pid)})`);
    throw refused(
      adminUrl,
      name,
      `still used by an active logical replication slot after its holder was terminated: ${named.join(', ')}`,
    );
  }
}

const bunAdmin = (url: string): ScratchAdminSql => {
  // Bun.SQL is the blessed Postgres client: no driver package.
  const sql = new Bun.SQL(url);
  return {
    query: async (statement, params = []) => [...(await sql.unsafe(statement, [...params]))],
    close: () => sql.close(),
  };
};

/** Create the scratch database on the admin URL; answers its name, its URL and its drop. */
export async function scratchDatabase(adminUrl: string, connect = bunAdmin) {
  const name = `x_drill_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = connect(adminUrl);
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.close();
  }
  return {
    name,
    url: urlFor(adminUrl, name),
    async drop(): Promise<void> {
      const again = connect(adminUrl);
      try {
        await dropScratchDatabase(again, name, adminUrl);
      } finally {
        await again.close();
      }
    },
  };
}
