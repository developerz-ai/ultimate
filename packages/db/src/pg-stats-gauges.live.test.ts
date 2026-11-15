// The two stats statements against a real Postgres — the only thing that can say they parse, that
// their casts land as numbers through `Bun.SQL`, and that a held transaction and a logical slot are
// what they read. Skips unless TEST_DATABASE_URL (and, for the slot, TEST_REPLICATION_URL) is set.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { collectMetrics } from '@ultimat3/core';
import { postgresStatsSampler } from './pg-stats-gauges';
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
        // `xact_start` is fixed here and the sample reads `now()` later: any positive age is seen.
        await tx`select 1`;
        await postgresStatsSampler(executorOn(sampler)).sample();
      });
      expect(value('db_longest_transaction_seconds')).toBeGreaterThan(0);
      expect(value('db_server_connections')).toBeGreaterThanOrEqual(2);
      expect(value('db_server_max_connections')).toBeGreaterThan(0);
    } finally {
      await holder.end();
      await sampler.end();
    }
  });

  test('a zero autovacuum trigger on an empty table answers, never a division by zero', async () => {
    // The server's settings are not ours to change, so the statement reads zeros in their place:
    // `autovacuum_vacuum_threshold = 0` over a table of no rows is a divisor of 0.
    const zeroed = PG_SERVER_STATS_SQL.replace(
      "current_setting('autovacuum_vacuum_threshold')",
      "'0'",
    ).replace("current_setting('autovacuum_vacuum_scale_factor')", "'0'");
    expect(zeroed).not.toBe(PG_SERVER_STATS_SQL);
    const sql = new Bun.SQL(url ?? '', { max: 1 });
    const table = `x_stats_probe_${process.pid}`;
    try {
      await sql.unsafe(`create table if not exists ${table} (id int)`);
      const [row] = await sql.unsafe(zeroed);
      expect(typeof row.autovacuum_backlog_ratio).toBe('number');
    } finally {
      await sql.unsafe(`drop table if exists ${table}`);
      await sql.end();
    }
  });
});

describe.skipIf(replicationUrl === undefined)('live · a logical slot`s retained WAL', () => {
  test('a slot is reported by name, and reads 0 once dropped', async () => {
    const sql = new Bun.SQL(replicationUrl ?? '', { max: 1 });
    const slot = `x_stats_probe_${process.pid}`;
    try {
      await sql.unsafe(`select pg_create_logical_replication_slot('${slot}', 'pgoutput')`);
      const sampler = postgresStatsSampler(executorOn(sql));
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
