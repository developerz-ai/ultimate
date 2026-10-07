// Test support: drop the probe databases a KILLED run of the same suite left behind. A per-run name
// (`probe-database.ts`) is never reused, so nothing else would ever drop it — the fixed name it
// replaced was dropped by the next run. Only a database whose run is provably over goes: its pid
// dead on this host AND no backend connected, so a concurrent run on any host is left alone.

import { stringField } from './error-render';
import type { PgExecutor } from './pg-executor';

/** `<prefix>_<pid>_<8 hex>` — exactly what `probeDatabaseName` returns. */
const PROBE_SHAPE = /^([a-z_][a-z0-9_]*)_(\d+)_[0-9a-f]{8}$/;

export interface ProbeDatabaseSweepOptions {
  /** Whether a pid is a live process on this host. Defaults to `probeDatabaseAlive`. */
  readonly isAlive?: ((pid: number) => boolean) | undefined;
}

/**
 * `kill(pid, 0)` delivers nothing and answers whether the process exists: `EPERM` is a process
 * someone else owns, which is alive. Another host's pid reads as dead here, which is why the sweep
 * also demands that nothing is connected.
 */
export function probeDatabaseAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (thrown) {
    return stringField(thrown, 'code') === 'EPERM';
  }
}

/**
 * Drop every database sharing `probeName`'s prefix whose run is over, never `probeName` itself.
 * Call it beside the `create database`; it answers the names it dropped. A name not shaped like
 * `probeDatabaseName`'s answer has no siblings to find, and nothing is sent.
 */
export async function sweepProbeDatabases(
  executor: PgExecutor,
  probeName: string,
  options: ProbeDatabaseSweepOptions = {},
): Promise<readonly string[]> {
  const prefix = PROBE_SHAPE.exec(probeName)?.[1];
  if (prefix === undefined) return [];
  const isAlive = options.isAlive ?? probeDatabaseAlive;
  const rows = await executor.query<{ datname: string; backends: number | string }>(
    `select d.datname, (select count(*) from pg_stat_activity a where a.datname = d.datname) as backends
       from pg_database d where d.datname like $1`,
    [`${prefix.replaceAll('_', '\\_')}\\_%`],
  );
  const swept: string[] = [];
  for (const row of rows) {
    const shape = PROBE_SHAPE.exec(row.datname);
    if (row.datname === probeName || shape?.[1] !== prefix) continue;
    if (Number(row.backends) > 0 || isAlive(Number(shape[2]))) continue;
    // The name matched `PROBE_SHAPE`, so it is `[a-z0-9_]` only — quoting it needs no escape.
    await executor.query(`drop database if exists "${row.datname}" with (force)`, []);
    swept.push(row.datname);
  }
  return swept;
}
