// Every list the pg driver orders by an instant, over rows inside ONE millisecond. Each statement
// projects the instant as epoch ms under the column's own name, and a bare `order by` binds to that
// output column: every row of the millisecond ties, and they come back in whatever order the scan
// met them. Each set below is inserted against its true order, so a tie is visible.
// Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { SQL_JOBS_TABLE } from './driver-pg-ddl';
import { SQL_WORKERS } from './driver-pg-operator-sql';
import { SQL_BACKFILL_LIST, SQL_EVENT_LIST, SQL_STEP_LIST } from './driver-pg-sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_sort_column_live');
const RUN = '00000000-0000-4000-8000-0000000000aa';

/** The one millisecond, plus `micros`. */
const at = (micros: number): string =>
  `'2026-11-14 10:00:00.123'::timestamptz + ${String(micros)} * interval '1 microsecond'`;

/** Inserted latest first, and named against their order: an alias sort ties them, then reads `a, b, c`. */
const ROWS = [
  { name: 'a', micros: 900 },
  { name: 'b', micros: 500 },
  { name: 'c', micros: 100 },
] as const;
const OLDEST_FIRST = ['c', 'b', 'a'];

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

describe.skipIf(!hasPostgres)('live · postgres · lists order by the instant, not its ms', () => {
  let admin: PostgresClient;
  let client: PostgresClient;

  const names = async (
    sql: string,
    values: readonly unknown[],
    key: string,
  ): Promise<readonly unknown[]> =>
    (await client.query<Record<string, unknown>>({ text: sql, values: [...values] })).map(
      (row) => row[key],
    );

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
    for (const { name, micros } of ROWS) {
      await client.execute(
        raw(`insert into x_job_steps (run_id, name, status, started_at)
             values ('${RUN}', '${name}', 'completed', ${at(micros)})`),
      );
      await client.execute(
        raw(`insert into x_job_events (id, name, payload, correlation_key, published_at, expires_at)
             values (gen_random_uuid(), 'paid', '{}', '${name}', ${at(micros)},
                     now() + interval '1 day')`),
      );
      await client.execute(
        raw(`insert into x_job_workers (id, host, queues, concurrency, in_flight, started_at,
                                        expires_at)
             values ('${name}', 'h', '[]', 1, '[]', ${at(micros)}, now() + interval '1 hour')`),
      );
    }
    // Newest first, so inserted oldest first.
    for (const { name, micros } of [...ROWS].reverse()) {
      await client.execute(
        raw(`insert into x_backfills (run_id, name, checksum, app_version, started_at)
             values (gen_random_uuid(), '${name}', 'c', 'v1', ${at(micros)})`),
      );
    }
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  test('a run lists its steps in the order they started', async () => {
    expect(await names(SQL_STEP_LIST, [RUN], 'name')).toEqual(OLDEST_FIRST);
  });

  test('events list in publication order', async () => {
    expect(await names(SQL_EVENT_LIST, ['paid', 10], 'correlation_key')).toEqual(OLDEST_FIRST);
  });

  test('workers list in the order they started', async () => {
    expect(await names(SQL_WORKERS, [], 'id')).toEqual(OLDEST_FIRST);
  });

  // Two rows sharing one MICROSECOND: the instant cannot order them, so the `id` tiebreak must —
  // inserted in the reverse of that order, so a scan-order answer fails.
  test('events and workers at one instant list by id', async () => {
    const tie = at(950);
    await client.execute(
      raw(`insert into x_job_workers (id, host, queues, concurrency, in_flight, started_at,
                                       expires_at)
           values ('tie-z', 'h', '[]', 1, '[]', ${tie}, now() + interval '1 hour'),
                  ('tie-y', 'h', '[]', 1, '[]', ${tie}, now() + interval '1 hour')`),
    );
    await client.execute(
      raw(`insert into x_job_events (id, name, payload, correlation_key, published_at, expires_at)
           values ('00000000-0000-4000-8000-0000000000f2', 'paid', '{}', 'tie-2', ${tie},
                   now() + interval '1 hour'),
                  ('00000000-0000-4000-8000-0000000000f1', 'paid', '{}', 'tie-1', ${tie},
                   now() + interval '1 hour')`),
    );
    try {
      expect(await names(SQL_WORKERS, [], 'id')).toEqual([...OLDEST_FIRST, 'tie-y', 'tie-z']);
      expect(await names(SQL_EVENT_LIST, ['paid', 10], 'correlation_key')).toEqual([
        ...OLDEST_FIRST,
        'tie-1',
        'tie-2',
      ]);
    } finally {
      await client.execute(raw(`delete from x_job_workers where id like 'tie-%'`));
      await client.execute(raw(`delete from x_job_events where correlation_key like 'tie-%'`));
    }
  });

  test('backfills list newest first', async () => {
    expect(await names(SQL_BACKFILL_LIST, [null, null, null, 10], 'name')).toEqual(
      [...OLDEST_FIRST].reverse(),
    );
  });
});
