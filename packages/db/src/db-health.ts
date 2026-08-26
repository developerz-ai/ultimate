// Single responsibility: the database's readiness answer — one `select 1` timed and reported, never
// thrown. Split from `client.ts` because a probe's report is a different job from opening a pool,
// and every role's `/readyz` reads this one and nothing else of the client.

import { renderThrowable } from '@ultimat3/core';
import { baseClient, type DbClient } from './client';
import { sql } from './sql';

/** Named `Db*` because `@ultimat3/core` already exports a `HealthReport` for the lifecycle. */
export interface DbHealthReport {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string | undefined;
}

/** Backs `/readyz` for every role. Never throws — the probe wants a report, not an exception. */
export async function checkDb(client: DbClient = baseClient()): Promise<DbHealthReport> {
  const started = performance.now();
  try {
    await client.query(sql`select 1`);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      // `renderThrowable`, never `error.message`: the probe wants a report, and a render that
      // throws is an exception out of `/readyz` — the one caller that cannot catch it.
      error: renderThrowable(error),
    };
  }
}
