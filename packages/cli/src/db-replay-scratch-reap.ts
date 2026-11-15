// The working databases a scratch run creates on a shared Postgres — the schema dump's and the
// exercise pass's clones — stamped with the SERVER's clock when created, and a killed run's reaped
// by the next run once older than `SCRATCH_MAX_AGE_MS`: `reapBranches`' shape (`@ultimat3/db`'s
// `branch.ts`). Only a stamped database of this module's exact name shape is ever dropped.

import type { DbClient } from '@ultimat3/db';
import { identifier, literal, raw, sql } from '@ultimat3/db';

/** The comment a working database carries: this marker, then its creation as UTC ISO seconds. */
export const SCRATCH_MARKER = 'ultimate:scratch:';

/** A working database older than this is a killed run's: no pass holds one for six hours. */
export const SCRATCH_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Exactly a working database's name — `x_scratch_<pid>_<8 hex>`, `x_schema_dump_<pid>_<8 hex>`. */
const WORKING_NAME = '^x_(scratch|schema_dump)_[0-9]+_[0-9a-f]{8}$';

/** Exactly a stamp: anything else in the comment is somebody else's, and never read as an age. */
const STAMP = /^ultimate:scratch:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;

type Admin = Pick<DbClient, 'one' | 'query' | 'execute'>;

/** Stamp `database` with the server's now: the age a later run reads is the server's, too. */
export async function stampScratch(admin: Admin, database: string): Promise<void> {
  const row = await admin.one<{ at: string }>(
    sql`select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at`,
  );
  if (row === null) return;
  await admin.execute(
    sql`comment on database ${identifier(database)} is ${literal(`${SCRATCH_MARKER}${row.at}`)}`,
  );
}

/** Drop every stamped working database older than `maxAgeMs` by the server's clock; their names. */
export async function reapScratch(
  admin: Admin,
  maxAgeMs: number = SCRATCH_MAX_AGE_MS,
): Promise<readonly string[]> {
  const rows = await admin.query<{ name: string; comment: string | null; now_ms: string | number }>(
    sql`select d.datname as name, shobj_description(d.oid, 'pg_database') as comment,
      (extract(epoch from now()) * 1000)::bigint as now_ms
      from pg_database d where d.datname ~ ${WORKING_NAME}`,
  );
  const reaped: string[] = [];
  for (const row of rows) {
    const stamp = STAMP.exec(row.comment ?? '')?.[1];
    if (stamp === undefined) continue;
    const created = Date.parse(stamp);
    if (!Number.isFinite(created) || Number(row.now_ms) - created < maxAgeMs) continue;
    await admin.execute(raw(`drop database if exists "${row.name}" with (force)`));
    reaped.push(row.name);
  }
  return reaped;
}
