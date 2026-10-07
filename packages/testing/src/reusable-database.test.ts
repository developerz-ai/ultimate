// One embedded database per worker, reset between files: the reset must put back exactly the
// data the template held, through an insert-only guard, with sequences and generated columns.

import { afterAll, describe, expect, test } from 'bun:test';
import { pgliteClient, raw, sql } from '@ultimat3/db';
import { restoreDatabase, reusableDatabase, snapshotDatabase } from './reusable-database';

const client = pgliteClient();
afterAll(() => client.close());

const setup = async (): Promise<void> => {
  for (const statement of [
    'create table if not exists refs (id int generated always as identity primary key, name text, upper_name text generated always as (upper(name)) stored)',
    'create table if not exists events (id serial primary key, body text)',
    `create or replace function refuse_change() returns trigger language plpgsql as $$ begin raise exception 'insert-only'; end $$`,
    'drop trigger if exists events_insert_only on events',
    'create trigger events_insert_only before update or delete on events for each row execute function refuse_change()',
    "insert into refs (name) values ('alpha'), ('beta')",
  ]) {
    await client.execute(raw(statement));
  }
};

describe('unit · reusable database', () => {
  test('a restore puts back the template rows and sequences, through an insert-only trigger', async () => {
    await setup();
    const snapshot = await snapshotDatabase(client);
    await client.execute(sql`insert into events (body) values (${'leaked'})`);
    await client.execute(sql`insert into refs (name) values (${'gamma'})`);
    // The guard refuses a test's own delete, which is the whole reason a reset turns triggers off.
    await expect(client.execute(raw('delete from events'))).rejects.toThrow();
    await restoreDatabase(client, snapshot);
    expect(await client.query(raw('select id, name, upper_name from refs order by id'))).toEqual([
      { id: 1, name: 'alpha', upper_name: 'ALPHA' },
      { id: 2, name: 'beta', upper_name: 'BETA' },
    ]);
    expect(await client.query(raw('select * from events'))).toEqual([]);
    // Sequences are back where the snapshot left them: the next insert reuses the ids.
    await client.execute(sql`insert into refs (name) values (${'gamma'})`);
    await client.execute(sql`insert into events (body) values (${'first'})`);
    expect(
      await client.one<{ id: number }>(raw("select id from refs where name = 'gamma'")),
    ).toEqual({
      id: 3,
    });
    expect(await client.one<{ id: number }>(raw('select id from events'))).toEqual({ id: 1 });
    // And the guard is back on after the reset.
    await expect(client.execute(raw('delete from events'))).rejects.toThrow();
  }, 60_000);

  test('acquire opens once, and every later acquire answers the same client, reset', async () => {
    let opens = 0;
    const acquire = reusableDatabase(async () => {
      opens += 1;
      return client;
    });
    const first = await acquire();
    await first.execute(sql`insert into events (body) values (${'from file one'})`);
    const second = await acquire();
    expect(second).toBe(first);
    expect(opens).toBe(1);
    const rows = await second.query<{ body: string }>(raw('select body from events'));
    expect(rows.map((row) => row.body)).not.toContain('from file one');
  }, 60_000);
});
