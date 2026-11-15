// The two stats statements against a real Postgres — the only thing that can say they parse, that
// their casts land as numbers through `Bun.SQL`, and that a held transaction and a logical slot are
// what they read. Skips unless TEST_DATABASE_URL (and, for the slot, TEST_REPLICATION_URL) is set.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { collectMetrics } from '@ultimat3/core';
import { pgStatsSampler } from './pg-stats-gauges';
import { PG_SERVER_STATS_SQL, PG_SLOT_STATS_SQL } from './pg-stats-sql';

const url = Bun.env['TEST_DATABASE_URL'];
const replicationUrl = Bun.env['TEST_REPLICATION_URL'];

const executorOn = (sql: InstanceType<typeof Bun.SQL>): PgExecutor => ({
  query: async <R>(text: string, values: readonly unknown[]) =>
    (await sql.unsafe(text, [...values])) as readonly R[],
});

const value = (name: string, slot?: string): number | undefined =>
  collectMetrics()
    .metrics.find((metric) => metric.descriptor.name === name)
    ?.points.find((point) => slot === undefined || point.attributes['slot'] === slot)?.value;

describe.skipIf(url === undefined)('live · the Postgres stats statements', () => {
  test('the server row is four finite numbers, and a held transaction is seen', async () => {
    const sampler = new Bun.SQL(url ?? '', { max: 1 });
    const holder = new Bun.SQL(url ?? '', { max: 1 });
    try {
      const [row] = await sampler.unsafe(PG_SERVER_STATS_SQL);
      for (const key of [
        'connections',
        'max_connections',
        'longest_transaction_seconds',
        'autovacuum_backlog_ratio',
      ]) {
        expect({ [key]: typeof row[key] }).toEqual({ [key]: 'number' });
      }
      await holder.begin(async (tx) => {
        await tx`select 1`;
        await Bun.sleep(1_100);
        await pgStatsSampler(executorOn(sampler)).sample();
      });
      expect(value('db_longest_transaction_seconds')).toBeGreaterThanOrEqual(1);
      expect(value('db_server_connections')).toBeGreaterThanOrEqual(2);
      expect(value('db_server_max_connections')).toBeGreaterThan(0);
    } finally {
      await holder.end();
      await sampler.end();
    }
  });
});

describe.skipIf(replicationUrl === undefined)('live · a logical slot`s retained WAL', () => {
  test('a slot is reported by name, and reads 0 once dropped', async () => {
    const sql = new Bun.SQL(replicationUrl ?? '', { max: 1 });
    const slot = `x_stats_probe_${process.pid}`;
    try {
      await sql.unsafe(`select pg_create_logical_replication_slot('${slot}', 'pgoutput')`);
      const sampler = pgStatsSampler(executorOn(sql));
      await sampler.sample();
      const rows = await sql.unsafe(PG_SLOT_STATS_SQL);
      expect(rows.map((row: { slot: string }) => row.slot)).toContain(slot);
      expect(typeof value('db_replication_slot_retained_bytes', slot)).toBe('number');
      await sql.unsafe(`select pg_drop_replication_slot('${slot}')`);
      await sampler.sample();
      expect(value('db_replication_slot_retained_bytes', slot)).toBe(0);
    } finally {
      await sql
        .unsafe(`select pg_drop_replication_slot('${slot}') where exists
          (select 1 from pg_replication_slots where slot_name = '${slot}')`)
        .catch(() => undefined);
      await sql.end();
    }
  });
});
