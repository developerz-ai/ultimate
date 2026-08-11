// The first tests in the repo that touch a real, network Postgres. Everywhere else, `db()` is
// stood in for with `createRecordingClient()` or the embedded PGlite driver — nothing has ever
// proven that client.ts/introspect.ts/branch.ts hold up against an actual server. This file wires
// them onto `template-db.ts`'s clone path: acquire a real worker database, exercise the driver,
// introspect the schema it produced, then branch and drop it exactly the way `x db branch` would.
//
// Skips entirely when no admin URL is configured — the CI `postgres` service container sets
// `TEST_DATABASE_URL`; a laptop with nothing installed just skips this file, same as
// `acquireWorkerDatabase` falling back to PGlite for every other suite.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  checkDb,
  createBranch,
  createPostgresClient,
  dropBranch,
  ensureReadOnlyRole,
  introspect,
  listBranches,
  type PostgresClient,
  READONLY_ROLE,
  readOnlyQuery,
  sql,
} from '@ultimat3/db';
import { acquireWorkerDatabase, urlFor, type WorkerDatabase } from './template-db';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? Bun.env['DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

describe.skipIf(!hasPostgres)('live · postgres', () => {
  let worker: WorkerDatabase;
  let client: PostgresClient;
  // A branch clones FROM the worker database, and Postgres refuses `CREATE DATABASE ... TEMPLATE`
  // while any session holds the source open — so branching runs on a connection to a different
  // database entirely (the admin url's), never on `client`. Mirrors `x db branch` in production:
  // the app's own pool is never what issues the clone.
  let adminClient: PostgresClient;

  beforeAll(async () => {
    worker = await acquireWorkerDatabase({ adminUrl });
    if (worker.kind !== 'postgres') {
      throw new Error(`expected a live postgres worker database, got "${worker.kind}"`);
    }
    client = createPostgresClient({ url: worker.url });
    adminClient = createPostgresClient({ url: adminUrl });

    await client.execute(sql`
      create table widgets (
        id serial primary key,
        name text not null,
        created_at timestamptz not null default now()
      )
    `);
    await client.execute(sql`create unique index widgets_name_key on widgets (name)`);
    await client.execute(sql`
      create table widget_parts (
        id serial primary key,
        widget_id integer not null references widgets (id) on delete cascade,
        label text not null
      )
    `);
  });

  afterAll(async () => {
    await client.close();
    await adminClient.close();
    await worker.drop();
  });

  test('createPostgresClient runs real statements over a real socket', async () => {
    await client.execute(sql`insert into widgets (name) values (${'left-hinge'})`);
    const row = await client.one<{ name: string }>(
      sql`select name from widgets where name = ${'left-hinge'}`,
    );
    expect(row?.name).toBe('left-hinge');

    const rows = await client.query<{ name: string }>(sql`select name from widgets`);
    expect(rows).toHaveLength(1);

    const affected = await client.execute(
      sql`update widgets set name = ${'left-hinge-v2'} where name = ${'left-hinge'}`,
    );
    expect(affected).toBe(1);
  });

  test('reserve() pins one real connection, so BEGIN and the statement share a session', async () => {
    // A pooled `Bun.SQL` handle refuses a bare BEGIN outright (ERR_POSTGRES_UNSAFE_TRANSACTION),
    // and no fake client can reproduce that — this is the only place the pin is provable.
    const pinned = await client.reserve();
    try {
      await pinned.execute(sql`begin`);
      await pinned.execute(sql`create temp table pinned_probe (id int)`);
      await pinned.execute(sql`insert into pinned_probe values (1)`);
      // A temp table is per-session: reading it back proves both statements ran on one connection.
      const rows = await pinned.query<{ id: number }>(sql`select id from pinned_probe`);
      expect(rows).toEqual([{ id: 1 }]);
      await pinned.execute(sql`rollback`);
    } finally {
      pinned.release();
    }
  });

  test('db.query layers 1 and 2 hold: a SELECT-only role inside BEGIN READ ONLY', async () => {
    const role = await ensureReadOnlyRole(client);
    expect(role).toBe(READONLY_ROLE);

    const read = await readOnlyQuery<{ name: string }>('select name from widgets', {
      client,
      role,
      timeoutMs: 4_000,
    });
    expect(read.guards).toEqual(['txn:read-only', 'timeout:4000ms', `role:${READONLY_ROLE}`]);

    // The parse layer never ran here on purpose: Postgres itself has to be the one refusing.
    for (const statement of [
      `insert into widgets (name) values ('smuggled')`,
      `update widgets set name = 'smuggled'`,
      'create table smuggled (id int)',
    ]) {
      await expect(readOnlyQuery(statement, { client, role })).rejects.toBeUltimateError(
        'X_DB_UNAVAILABLE',
      );
    }

    // Nothing the transaction set may survive it, or one agent read would re-time every request
    // the pool serves afterwards.
    const after = await client.one<{ user: string; timeout: string }>(
      sql`select current_user as user, current_setting('statement_timeout') as timeout`,
    );
    expect(after?.user).not.toBe(READONLY_ROLE);
    expect(after?.timeout).not.toBe('4s');
    expect(read.rows.length).toBeGreaterThanOrEqual(0);
  });

  test('maxRows bounds what the SERVER sends, not what the caller keeps', async () => {
    const role = await ensureReadOnlyRole(client);
    await client.execute(sql`
      insert into widgets (name)
      select 'w' || g from generate_series(1, 500) g
    `);

    // A recording client cannot tell a cursor from a slice — only a real server can, because
    // only here does the unbounded form actually allocate all 500 rows in this process.
    const bounded = await readOnlyQuery<{ id: number }>('select * from widgets', {
      client,
      role,
      maxRows: 10,
    });
    expect(bounded.rows).toHaveLength(10);
    expect(bounded.guards).toContain('fetch:10 rows');

    const whole = await readOnlyQuery<{ id: number }>('select * from widgets', { client, role });
    expect(whole.rows.length).toBeGreaterThan(400);
    expect(whole.guards.some((guard) => guard.startsWith('fetch:'))).toBe(false);

    // `EXPLAIN` has no cursor form, so it must survive the option rather than fail on it.
    const explained = await readOnlyQuery('explain select 1', { client, role, maxRows: 10 });
    expect(explained.rows.length).toBeGreaterThan(0);

    // ROLLBACK closes the cursor; a leak would leave it visible to the next pooled statement.
    const open = await client.query<{ name: string }>(sql`select name from pg_cursors`);
    expect(open).toEqual([]);
  });

  test('a session advisory lock outlives layer 2 — the evidence for layer 3 refusing it', async () => {
    const role = await ensureReadOnlyRole(client);
    // `pg_advisory_lock` is PUBLIC-executable, legal inside `BEGIN READ ONLY`, and a SESSION lock
    // is not released by the `ROLLBACK` layer 2 always runs. So layers 1, 2 and 4 all let it
    // through and it survives the call on a pooled connection the app's own writers use — which
    // is why `readonly-sql.ts` refuses the `pg_advisory_*` family outright. Only a real server
    // can show that: a recording client has no lock table to look at.
    const pinned = await client.reserve();
    try {
      await readOnlyQuery('select pg_advisory_lock(918273)', { client: pinned, role });

      const held = await pinned.query<{ objid: number }>(
        sql`select objid from pg_locks where locktype = 'advisory' and objid = 918273`,
      );
      expect(held).toEqual([{ objid: 918273 }]);
    } finally {
      // Session-scoped, so the release has to run on the connection that took it.
      await pinned.execute(sql`select pg_advisory_unlock_all()`).catch(() => undefined);
      pinned.release();
    }
  });

  test('ALTER DEFAULT PRIVILEGES covers tables created after the grant DDL ran', async () => {
    const role = await ensureReadOnlyRole(client);
    // The claim layer 1 makes is about the FUTURE: without `FOR ROLE`, Postgres scopes the
    // default to the executing user's own objects, and a table created later stops being
    // selectable. Nothing but a real server can refuse this.
    await client.execute(sql`create table gadgets (id int)`);
    await client.execute(sql`insert into gadgets values (7)`);

    const read = await readOnlyQuery<{ id: number }>('select id from gadgets', { client, role });
    expect(read.rows).toEqual([{ id: 7 }]);
  });

  test('checkDb pings the live connection instead of a fake one', async () => {
    const report = await checkDb(client);
    expect(report.ok).toBe(true);
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('a genuinely unreachable server reports X_DB_UNAVAILABLE, not a hang', async () => {
    const unreachable = createPostgresClient({ url: 'postgres://nobody@127.0.0.1:1/nowhere' });
    try {
      await expect(unreachable.query(sql`select 1`)).rejects.toBeUltimateError('X_DB_UNAVAILABLE');
    } finally {
      await unreachable.close();
    }
  });

  test('introspect reads the live schema out of information_schema and pg_catalog', async () => {
    const schema = await introspect({ client });

    const widgets = schema.tables.find((table) => table.name === 'widgets');
    expect(widgets).toBeDefined();
    expect(widgets?.primaryKey).toEqual(['id']);
    expect([...(widgets?.columns.map((column) => column.name) ?? [])].sort()).toEqual([
      'created_at',
      'id',
      'name',
    ]);

    const nameColumn = widgets?.columns.find((column) => column.name === 'name');
    expect(nameColumn?.nullable).toBe(false);
    expect(nameColumn?.dataType).toBe('text');

    const uniqueIndex = widgets?.indexes.find((index) => index.name === 'widgets_name_key');
    expect(uniqueIndex?.unique).toBe(true);
    expect(uniqueIndex?.primary).toBe(false);
    expect(uniqueIndex?.columns).toEqual(['name']);

    const parts = schema.tables.find((table) => table.name === 'widget_parts');
    const fk = parts?.foreignKeys[0];
    expect(fk?.referencedTable).toBe('widgets');
    expect(fk?.columns).toEqual(['widget_id']);
    expect(fk?.referencedColumns).toEqual(['id']);
  });

  test('createBranch clones live data via CREATE DATABASE ... TEMPLATE', async () => {
    const branchName = `${worker.database}_branch`;
    let branched = false;
    try {
      // Release every connection `client` holds on the worker db — the source of the clone —
      // before asking Postgres to copy it. Otherwise this is `X_DB_UNAVAILABLE`: "source database
      // is being accessed by other users", straight from the server.
      await client.close();
      const branch = await createBranch(branchName, {
        client: adminClient,
        base: worker.database,
      });
      branched = true;
      expect(branch.name).toBe(branchName);

      const listed = await listBranches({ client: adminClient });
      expect(listed.some((entry) => entry.name === branchName)).toBe(true);

      const branchClient = createPostgresClient({ url: urlFor(worker.url, branchName) });
      try {
        // The branch is a copy-on-write clone made *after* the insert/update above, so the
        // renamed row must already be there — proving this is real data, not a fresh schema.
        const row = await branchClient.one<{ name: string }>(
          sql`select name from widgets where name = ${'left-hinge-v2'}`,
        );
        expect(row?.name).toBe('left-hinge-v2');

        // Writing into the branch must never touch the base database.
        await branchClient.execute(sql`insert into widgets (name) values (${'branch-only'})`);
      } finally {
        await branchClient.close();
      }

      // `client` reconnects lazily here — its pool was closed above, not destroyed.
      const stillOnlyOne = await client.query(
        sql`select 1 from widgets where name = ${'branch-only'}`,
      );
      expect(stillOnlyOne).toHaveLength(0);
    } finally {
      if (branched) {
        const dropped = await dropBranch(branchName, { client: adminClient, force: true });
        expect(dropped).toBe(true);
      }
    }

    const afterDrop = await listBranches({ client: adminClient });
    expect(afterDrop.some((entry) => entry.name === branchName)).toBe(false);
  });

  test('createBranch refuses an unsafe name before it ever reaches SQL', async () => {
    await expect(
      createBranch('not a valid name!', { client: adminClient, base: worker.database }),
    ).rejects.toBeUltimateError('X_SQL_UNSAFE');
  });

  test('createBranch refuses to recreate a branch that already exists', async () => {
    const branchName = `${worker.database}_dup`;
    await client.close();
    await createBranch(branchName, { client: adminClient, base: worker.database });
    try {
      await expect(
        createBranch(branchName, { client: adminClient, base: worker.database }),
      ).rejects.toBeUltimateError('X_BRANCH_EXISTS');
    } finally {
      await dropBranch(branchName, { client: adminClient, force: true });
    }
  });
});
