// Single responsibility: the Postgres server's own health as gauges — connections against
// `max_connections`, the longest open transaction, the autovacuum backlog and the WAL each logical
// slot retains — sampled on an interval by ONE role (the scheduler), because a scrape reads gauges
// synchronously and these are server facts every pod would otherwise read the same of.

import type { Gauge, PgExecutor } from '@ultimat3/core';
import { gauge, logger, renderThrowable } from '@ultimat3/core';
import { PG_SERVER_STATS_SQL, PG_SLOT_STATS_SQL } from './pg-stats-sql';

/** A scrape reads every ~15s; sampling faster costs the server reads nobody sees. */
export const PG_STATS_INTERVAL_MS = 15_000;

interface Gauges {
  readonly connections: Gauge;
  readonly maxConnections: Gauge;
  readonly longestTransaction: Gauge;
  readonly autovacuumBacklog: Gauge;
  readonly slotRetained: Gauge;
  readonly sampleOk: Gauge;
}

let declared: Gauges | undefined;

/** On the first sample, never at import: a process that samples nothing declares no series. */
function gauges(): Gauges {
  declared ??= {
    connections: gauge('db_server_connections', {
      unit: '{connection}',
      description: 'Client connections open on the Postgres server, every database counted',
    }),
    maxConnections: gauge('db_server_max_connections', {
      unit: '{connection}',
      description: "The Postgres server's max_connections",
    }),
    longestTransaction: gauge('db_longest_transaction_seconds', {
      unit: 's',
      description: "Age of this database's oldest open transaction this role can see — 0 when none",
    }),
    autovacuumBacklog: gauge('db_autovacuum_backlog_ratio', {
      unit: '1',
      description: "The worst table's dead tuples over the count that triggers its autovacuum",
    }),
    slotRetained: gauge('db_replication_slot_retained_bytes', {
      unit: 'By',
      description: "WAL the primary keeps for one of this database's logical replication slots",
    }),
    // A failed round leaves every value above at its last good number — a long transaction that
    // began after the sampler died would read as none. This is what says the numbers are stale.
    sampleOk: gauge('db_stats_sample_ok', {
      unit: '1',
      description:
        'Whether the last Postgres stats round landed: 1, or 0 when the values are stale',
    }),
  };
  return declared;
}

const finite = (row: Readonly<Record<string, unknown>> | undefined, key: string) => {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

/** A value the driver did not send as a finite number writes nothing: the last good one stands. */
const recordIf = (target: Gauge, value: number | undefined, attributes = {}): void => {
  if (value !== undefined) target.record(value, attributes);
};

export interface PgStatsSampler {
  /** One round. Never rejects: a database that cannot be measured is logged, once per streak. */
  sample(): Promise<void>;
}

export function pgStatsSampler(executor: PgExecutor): PgStatsSampler {
  // The slots the last round published: a dropped slot reads 0, never its last size forever.
  let published: ReadonlySet<string> = new Set();
  let failing = false;
  return {
    async sample(): Promise<void> {
      try {
        const [server] = await executor.query<Record<string, unknown>>(PG_SERVER_STATS_SQL, []);
        const slots = await executor.query<Record<string, unknown>>(PG_SLOT_STATS_SQL, []);
        const g = gauges();
        recordIf(g.connections, finite(server, 'connections'));
        recordIf(g.maxConnections, finite(server, 'max_connections'));
        recordIf(g.longestTransaction, finite(server, 'longest_transaction_seconds'));
        recordIf(g.autovacuumBacklog, finite(server, 'autovacuum_backlog_ratio'));
        const seen = new Set<string>();
        for (const row of slots) {
          if (typeof row['slot'] !== 'string') continue;
          seen.add(row['slot']);
          recordIf(g.slotRetained, finite(row, 'retained_bytes'), { slot: row['slot'] });
        }
        for (const slot of published) if (!seen.has(slot)) g.slotRetained.record(0, { slot });
        published = seen;
        g.sampleOk.record(1);
        failing = false;
      } catch (error) {
        gauges().sampleOk.record(0);
        if (failing) return;
        failing = true;
        logger.warn('db.stats.sample-failed', { error: renderThrowable(error) });
      }
    },
  };
}

/**
 * Samples now and every `intervalMs`, one round at a time; returns the stop. Unref'd. The stop is
 * async and awaits the round in flight: release it BEFORE the pool closes, or that round's query
 * meets a closing pool and logs `db.stats.sample-failed` on every shutdown.
 */
export function startPgStatsGauges(
  executor: PgExecutor,
  intervalMs: number = PG_STATS_INTERVAL_MS,
): () => Promise<void> {
  const sampler = pgStatsSampler(executor);
  let inFlight: Promise<void> | undefined;
  const tick = (): void => {
    if (inFlight !== undefined) return;
    inFlight = sampler.sample().finally(() => {
      inFlight = undefined;
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}
