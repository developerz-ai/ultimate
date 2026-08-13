// Single responsibility: the PGlite binding against the real embedded database — the WASM module
// resolved, booted and answering SQL. The fakes in `pglite.test.ts` pin the adapter; nothing there
// can tell "the driver is wired up" from a claim about a module specifier nobody ever resolved.
// One boot, shared by every case here, because the boot is the entire cost.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { baseClient, setDbClient } from './client';
import { createPgliteClient } from './pglite';
import { readOnlyQuery } from './readonly-query';
import { sql } from './sql';
import { withTransaction } from './transaction';

describe('the real embedded database', () => {
  // A WASM compile plus an initdb — ~1.5s on a CI runner, against bun's 5s default. Stated so a
  // slow machine reads as slow rather than as a broken driver; it is a hang detector, not a budget.
  const PGLITE_BOOT_MS = 30_000;

  /**
   * One session for all four cases, not one each. The boot is the entire cost — four measured
   * ~2.4s apiece — and `createPgliteClient` is lazy, so the WASM compile still happens inside the
   * first case that runs a statement rather than at import. Sharing costs these cases nothing they
   * were asserting: PGlite is a pool of exactly one either way, which is the very thing the
   * reservation rules below exist for, so a shared client is the shape production runs.
   */
  const client = createPgliteClient();

  // Each case owns `posts` outright, so none of them inherits the previous one's table or rows.
  beforeEach(async () => {
    await client.execute(sql`drop table if exists posts`);
  }, PGLITE_BOOT_MS);

  afterAll(async () => {
    await client.close();
  });

  test(
    'boots from the default loader and runs Postgres, with no server and no Docker',
    async () => {
      await client.execute(sql`create table posts (id int primary key, title text)`);
      expect(await client.execute(sql`insert into posts values (${1}, ${'hello'})`)).toBe(1);
      expect(await client.execute(sql`insert into posts values (${2}, ${'world'})`)).toBe(1);
      expect(
        await client.one<{ title: string }>(sql`select title from posts where id = ${2}`),
      ).toEqual({ title: 'world' });
      expect(await client.query(sql`select id from posts order by id`)).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
      expect(await client.execute(sql`delete from posts`)).toBe(2);
    },
    PGLITE_BOOT_MS,
  );

  // Embedded Postgres is one session. Before this client was reservable both units of work ran
  // their BEGIN on the same connection, so B's COMMIT committed A's rows and A's ROLLBACK found
  // no transaction left to undo — `x dev` losing a rollback under any two concurrent requests.
  test(
    'two concurrent transactions do not share one — a rollback still rolls back',
    async () => {
      setDbClient(client);
      try {
        await client.execute(sql`create table posts (id int primary key, title text)`);

        const rolledBack = withTransaction(async (tx) => {
          await tx.execute(sql`insert into posts values (${1}, ${'abandoned'})`);
          await Bun.sleep(20);
          throw new Error('this unit of work fails');
        });
        const committed = withTransaction(async (tx) => {
          await Bun.sleep(5);
          await tx.execute(sql`insert into posts values (${2}, ${'kept'})`);
        });

        await expect(rolledBack).rejects.toThrow('this unit of work fails');
        await committed;
        expect(await client.query(sql`select id, title from posts order by id`)).toEqual([
          { id: 2, title: 'kept' },
        ]);
      } finally {
        setDbClient(undefined);
      }
    },
    PGLITE_BOOT_MS,
  );

  // `handle.enqueue(input, { outbox: false })` inside `withTransaction` goes to the queue driver's
  // own executor, which holds the plain client — and the plain client must not wait for the turn
  // the surrounding transaction is holding, or the request hangs with no error to explain it.
  test(
    'a plain statement issued inside a transaction joins it instead of deadlocking',
    async () => {
      setDbClient(client);
      try {
        await client.execute(sql`create table posts (id int primary key)`);
        const seen = await withTransaction(async (tx) => {
          await tx.execute(sql`insert into posts values (${1})`);
          await baseClient().execute(sql`insert into posts values (${2})`);
          return (await baseClient().query(sql`select id from posts`)).length;
        });
        expect(seen).toBe(2);
        expect(await client.query(sql`select id from posts order by id`)).toEqual([
          { id: 1 },
          { id: 2 },
        ]);
      } finally {
        setDbClient(undefined);
      }
    },
    PGLITE_BOOT_MS,
  );

  // `db.query`'s BEGIN READ ONLY used to land on the shared connection, so an app write that
  // happened to overlap an agent's read was executed inside a read-only transaction and refused.
  test(
    'an agent read-only query does not make a concurrent write fail',
    async () => {
      setDbClient(client);
      try {
        await client.execute(sql`create table posts (id int primary key)`);
        const read = readOnlyQuery<{ n: number }>('select count(*)::int as n from posts');
        const written = client.execute(sql`insert into posts values (${1})`);

        expect((await read).guards).toContain('txn:read-only');
        expect(await written).toBe(1);
        expect(await client.query(sql`select id from posts`)).toEqual([{ id: 1 }]);
      } finally {
        setDbClient(undefined);
      }
    },
    PGLITE_BOOT_MS,
  );
});
