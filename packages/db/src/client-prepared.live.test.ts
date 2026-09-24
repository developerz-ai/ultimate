// Single responsibility: a statement the pool has already run keeps working after a migration
// changes the table under it. `Bun.SQL` prepares NAMED statements by default and caches them per
// connection, so a warm `select *` / `returning *` answered `0A000 cached plan must not change
// result type` on every running pod after `alter table … add column`, until each connection
// closed. PGlite uses unnamed statements, which is why `x dev` never showed it — only a real
// server can, so this file is live-only.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import { identifier, raw, sql } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'cp_warm_plans';
const table = identifier(TABLE);

describe.skipIf(!hasPostgres)('live · postgres · a warm statement across a migration', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    // ONE connection, so the statement warmed below is the one re-run: with a pool of several the
    // second send could land on a cold connection and pass for the wrong reason.
    client = createPostgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await client.execute(raw(`drop table if exists "${TABLE}"`));
    await client.execute(raw(`create table "${TABLE}" (id integer primary key, name text)`));
  });

  afterAll(async () => {
    await client.execute(raw(`drop table if exists "${TABLE}"`));
    await client.close();
  });

  test('select * still runs after a column is added', async () => {
    const read = sql`select * from ${table} where id = ${1}`;
    await client.execute(raw(`insert into "${TABLE}" (id, name) values (1, 'a')`));
    // Warm it more than once: a driver may only name a statement on its second use.
    for (let turn = 0; turn < 3; turn += 1) await client.query(read);
    await client.execute(raw(`alter table "${TABLE}" add column extra text`));
    const rows = await client.query<{ id: number; extra: string | null }>(read);
    expect(rows[0]?.extra).toBeNull();
  });

  test('insert … returning * still runs after a column is dropped', async () => {
    const write = (id: number) =>
      sql`insert into ${table} (id, name) values (${id}, 'b') returning *`;
    for (let turn = 0; turn < 3; turn += 1) await client.query(write(10 + turn));
    await client.execute(raw(`alter table "${TABLE}" drop column extra`));
    const rows = await client.query<Record<string, unknown>>(write(20));
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['id', 'name']);
  });
});

describe.skipIf(!hasPostgres)('live · postgres · parameters on unnamed statements', () => {
  // `prepare: false` sends statements unnamed, and `Bun.SQL` then serialises a bound value with no
  // described type to go by: a `Date` went as `Date.prototype.toString()` ("Thu Jan 01 2026 …
  // GMT+0000 (Coordinated Universal Time)", `22007`, or "time zone gmt-0500 not recognized" off
  // UTC). Measured against Postgres 17 — every entity write with a timestamp failed. Every other
  // value `sql` accepts (string, number, boolean, bigint, null, Uint8Array) was measured fine.
  let client: PostgresClient;

  beforeAll(() => {
    client = createPostgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
  });

  afterAll(async () => {
    await client.close();
  });

  test('a Date binds as the instant it is, whatever the process TZ', async () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const row = await client.one<{ v: Date }>(sql`select ${at}::timestamptz as v`);
    expect(row?.v.toISOString()).toBe(at.toISOString());
  });
});
