// A page of `x jobs list` against a real planner, over rows that share one MILLISECOND. The keyset
// compares the column's microseconds, so the page must be ordered by the column too: ordered by the
// epoch-ms OUTPUT column of the same name, a row a page cut off sorted behind the cursor and no
// page ever answered it — and no index serves that order, so every page sorted the whole queue.
// Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { SQL_JOBS_TABLE } from './driver-pg-ddl';
import { SQL_JOB_LIST, SQL_JOB_LIST_BEFORE } from './driver-pg-jobs-sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_list_order_live');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

/** Three rows in one millisecond, ids against their microseconds: `c` oldest, `a` newest. */
const MATES = [
  { id: '00000000-0000-4000-8000-00000000000c', micros: 100 },
  { id: '00000000-0000-4000-8000-00000000000b', micros: 500 },
  { id: '00000000-0000-4000-8000-00000000000a', micros: 900 },
] as const;
const NEWEST_FIRST = MATES.map((row) => row.id).reverse();

interface PageRow {
  readonly id: string;
  readonly created_at: number | string;
}

describe.skipIf(!hasPostgres)('live · postgres · a page of jobs across one millisecond', () => {
  let admin: PostgresClient;
  let client: PostgresClient;

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
    for (const row of MATES) {
      await client.query({
        text: `insert into x_jobs (id, name, input, idempotency_key, run_id, created_at)
               values ($1::uuid, 'probe', '{}', $1::text, $1::uuid,
                       '2026-11-14 10:00:00.123'::timestamptz + $2::int * interval '1 microsecond')`,
        values: [row.id, row.micros],
      });
    }
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  /** One page of one row: `LIST_MATCH` unset, `$8`/`$9` the cursor. */
  const page = async (sql: string, cursor?: PageRow): Promise<PageRow | undefined> =>
    (await rowsOf(sql, 1, cursor))[0];

  /** One page of `limit` rows, in the order the statement answers them. */
  const rowsOf = (sql: string, limit: number, cursor?: PageRow): Promise<readonly PageRow[]> =>
    client.query<PageRow>({
      text: sql,
      values: [
        null,
        null,
        null,
        limit,
        null,
        null,
        null,
        cursor === undefined ? null : Number(cursor.created_at),
        cursor?.id ?? null,
        null,
      ],
    });

  test('walking forward a row a page answers every row once, newest first', async () => {
    const seen: string[] = [];
    let cursor = await page(SQL_JOB_LIST);
    while (cursor !== undefined && seen.length <= MATES.length) {
      seen.push(cursor.id);
      cursor = await page(SQL_JOB_LIST, cursor);
    }
    expect(seen).toEqual(NEWEST_FIRST);
  });

  test('walking back from the oldest answers every newer row once, nearest first', async () => {
    const oldest = (
      await client.query<PageRow>({
        text: `select id, (extract(epoch from created_at) * 1000)::bigint as created_at
               from x_jobs where id = $1::uuid`,
        values: [MATES[0].id],
      })
    )[0];
    const seen: string[] = [];
    let cursor = oldest === undefined ? undefined : await page(SQL_JOB_LIST_BEFORE, oldest);
    while (cursor !== undefined && seen.length <= MATES.length) {
      seen.push(cursor.id);
      cursor = await page(SQL_JOB_LIST_BEFORE, cursor);
    }
    expect(seen).toEqual(MATES.slice(1).map((row) => row.id));
  });

  // The back-walk seeks nearest-first and then turns the page around: with one row a page the
  // outer sort never sorts anything, so a page of two is what holds it.
  test('a page walked back from the oldest still reads newest first', async () => {
    const oldest = (
      await client.query<PageRow>({
        text: `select id, (extract(epoch from created_at) * 1000)::bigint as created_at
               from x_jobs where id = $1::uuid`,
        values: [MATES[0].id],
      })
    )[0];
    if (oldest === undefined) expect.unreachable('the oldest probe row is missing');
    const rows = await rowsOf(SQL_JOB_LIST_BEFORE, 2, oldest);
    expect(rows.map((row) => row.id)).toEqual(NEWEST_FIRST.slice(0, 2));
  });
});
