// The scheduler's sampler of the Postgres server's own health (`@ultimat3/db`'s pg stats gauges):
// one role samples, because these are server facts every pod would read the same of. A real
// server only — the embedded database is one process's private copy and describes no fleet.

import type { PgExecutor, Role } from '@ultimat3/core';
import { startPgStatsGauges } from '@ultimat3/db';
import type { ServiceMode } from './runtime-bindings';

/** The stop, for the role's unwind list; `null` when nothing was started. */
export function startRolePgStats(
  roles: readonly Role[],
  mode: ServiceMode,
  executor: PgExecutor,
  intervalMs?: number,
): (() => Promise<void>) | null {
  if (!roles.includes('scheduler') || mode !== 'external') return null;
  const stop = startPgStatsGauges(executor, intervalMs);
  return async () => {
    stop();
  };
}
