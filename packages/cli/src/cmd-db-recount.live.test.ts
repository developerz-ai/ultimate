// `x db recount`'s sweep on a real Postgres (Bun.SQL): a writer whose trigger holds a parent row
// while the recount waits on it is counted, never overwritten by a count read before it committed;
// and the text-bound window key works for an integer and a uuid primary key alike.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { CounterDescriptionLike, PostgresClient } from '@ultimat3/db';
import { postgresClient, raw, sql, withTransaction } from '@ultimat3/db';
import { recountInBatches } from './cmd-db-recount';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const counter = (children: string): CounterDescriptionLike => ({
  column: 'n',
  key: 'id',
  table: children,
  references: 'parent_id',
  softDelete: null,
});

/** The trigger a `countedIn` compiles to, reduced to its effect: +1 on the parent per insert. */
const bumpSql = (parents: string, children: string): readonly string[] => [
  `create or replace function ${children}_bump() returns trigger language plpgsql as $f$ begin ` +
    `update ${parents} set n = n + 1 where id = new.parent_id; return null; end; $f$`,
  `create trigger ${children}_bump after insert on ${children} for each row execute function ${children}_bump()`,
];

/** Polls attempts, never a clock: each is one round trip to the server. */
const MAX_POLLS = 10_000;

describe.skipIf(!hasPostgres)('live · postgres · x db recount', () => {
  let client: PostgresClient;
  const drop = async () => {
    for (const table of ['rcl_kids', 'rcl_parents', 'rcu_kids', 'rcu_parents']) {
      await client.execute(raw(`drop table if exists ${table} cascade`));
    }
  };

  /**
   * Resolves once some backend is waiting on a row lock in a statement naming `table` — the
   * recount, queued behind the writer's trigger. Deterministic: the writer commits only after.
   */
  const blockedOnLock = async (table: string): Promise<void> => {
    for (let poll = 0; poll < MAX_POLLS; poll += 1) {
      const [row] = await client.query<{ waiting: number }>(
        sql`select count(*)::integer as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like ${`%${table}%`}`,
      );
      if ((row?.waiting ?? 0) > 0) return;
    }
    expect.unreachable(`no statement on ${table} waited on a lock within ${MAX_POLLS} polls`);
  };

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '', profile: { max: 4 } });
    await drop();
  });

  afterAll(async () => {
    await drop();
    await client.close();
  });

  test('a writer holding the parent row while the recount reaches it is counted', async () => {
    await client.execute(
      raw('create table rcl_parents (id integer primary key, n integer not null)'),
    );
    await client.execute(
      raw('create table rcl_kids (id serial primary key, parent_id integer not null)'),
    );
    for (const statement of bumpSql('rcl_parents', 'rcl_kids')) {
      await client.execute(raw(statement));
    }
    // Drifted: two children, stored 7.
    await client.execute(raw('insert into rcl_parents values (1, 7)'));
    await client.execute(raw('insert into rcl_kids (parent_id) values (1), (1)'));

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    // The writer: its trigger takes the parent row's lock, and it commits only once the recount
    // is seen waiting on it (`blockedOnLock`).
    const writer = withTransaction(
      async (tx) => {
        await tx.execute(sql`insert into rcl_kids (parent_id) values (${1})`);
        inserted();
        await held;
      },
      { client },
    );
    await ready;
    const sweep = recountInBatches(client, 'rcl_parents', counter('rcl_kids'), {
      write: true,
    });
    await blockedOnLock('rcl_parents');
    release();
    await writer;
    await sweep;
    const [row] = await client.query<{ n: number; actual: number }>(
      raw('select n, (select count(*)::integer from rcl_kids) as actual from rcl_parents'),
    );
    expect(row).toEqual({ n: 3, actual: 3 });
  });

  test('the window key binds as text for a uuid key, across several windows', async () => {
    await client.execute(raw('create table rcu_parents (id uuid primary key, n integer not null)'));
    await client.execute(raw('create table rcu_kids (id serial primary key, parent_id uuid)'));
    const ids = [1, 2, 3].map((n) => `00000000-0000-0000-0000-00000000000${n}`);
    for (const id of ids) {
      await client.execute(sql`insert into rcu_parents values (${id}::uuid, ${5})`);
    }
    await client.execute(sql`insert into rcu_kids (parent_id) values (${ids[1] ?? ''}::uuid)`);
    const report = await recountInBatches(client, 'rcu_parents', counter('rcu_kids'), {
      write: true,
      batch: 2,
    });
    expect(report.batches).toBe(2);
    expect(report.rows.map((row) => `${row.key}=${row.actual}`)).toEqual([
      `${ids[0]}=0`,
      `${ids[1]}=1`,
      `${ids[2]}=0`,
    ]);
    const stored = await client.query<{ n: number }>(raw('select n from rcu_parents order by id'));
    expect(stored.map((row) => row.n)).toEqual([0, 1, 0]);
  });

  test('the window key binds as text for an integer key, across several windows', async () => {
    const report = await recountInBatches(client, 'rcl_parents', counter('rcl_kids'), {
      write: false,
      batch: 1,
    });
    expect(report).toEqual({ batches: 1, drifted: 0, rows: [] });
  });
});
