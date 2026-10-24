// `SQL_STATS` against a real planner, over the table a production queue reaches: two weeks of
// `done` rows (the default retention) and a handful the read actually counts. Every worker issues
// it every 15 s, so it must be a range over `x_jobs_depth_idx` — a scan of the whole queue grows
// with what the queue has FINISHED (prod, 2026-10-24: 29 ms mean over 48k rows, 22 counted).
// Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { SQL_JOBS_TABLE, SQL_STATS } from './driver-pg-sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_stats_live');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

describe.skipIf(!hasPostgres)('live · postgres · the queue depth read', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let executor: PgExecutor;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 1 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
    executor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        client.query<R>({ text, values }),
    };
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  // `explain` only plans; the counts are asked separately, so the answer is pinned as well as the
  // path to it — an index that served the read but dropped a bucket would pass a plan check alone.
  test('it reads x_jobs_depth_idx, never the finished rows, and still counts every bucket', async () => {
    await executor.query(
      `insert into x_jobs (id, name, input, idempotency_key, run_id, state, run_at, updated_at)
       select gen_random_uuid(), 'mail.send', '{}'::jsonb, 'k' || g, gen_random_uuid(),
              case when g % 2000 = 0 then 'dead' when g % 2000 = 1 then 'cancelled' else 'done' end,
              now() - (g % 14) * interval '1 day', now() - (g % 14) * interval '1 day'
         from generate_series(1, 50000) g`,
      [],
    );
    await executor.query(
      `insert into x_jobs (id, name, queue, input, idempotency_key, run_id, state, run_at)
       values (gen_random_uuid(), 'a', 'mail', '{}', 'a', gen_random_uuid(), 'ready', now() - interval '1 minute'),
              (gen_random_uuid(), 'b', 'mail', '{}', 'b', gen_random_uuid(), 'delayed', now() + interval '1 hour'),
              (gen_random_uuid(), 'c', 'mail', '{}', 'c', gen_random_uuid(), 'running', now()),
              (gen_random_uuid(), 'd', 'mail', '{}', 'd', gen_random_uuid(), 'suspended', now() + interval '1 day'),
              (gen_random_uuid(), 'e', 'mail', '{}', 'e', gen_random_uuid(), 'failed', now())`,
      [],
    );
    await executor.query('analyze x_jobs', []);

    const rows = await executor.query<Record<string, unknown>>(`explain ${SQL_STATS}`, []);
    const plan = rows.map((row) => Object.values(row).join('')).join('\n');
    expect(plan).toMatch(/Index (Only )?Scan using x_jobs_depth_idx on x_jobs/);
    expect(plan).not.toContain('Seq Scan on x_jobs');

    const BUCKETS = ['ready', 'delayed', 'running', 'suspended', 'failed', 'dead'] as const;
    const stats = await executor.query<Record<string, unknown>>(SQL_STATS, []);
    expect(
      stats.map((row) => [row['queue'], ...BUCKETS.map((bucket) => Number(row[bucket]))]),
    ).toEqual([
      ['default', 0, 0, 0, 0, 0, 25],
      ['mail', 1, 1, 1, 1, 1, 0],
    ]);
  }, 60_000);
});
