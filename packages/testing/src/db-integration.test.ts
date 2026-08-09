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
  introspect,
  listBranches,
  type PostgresClient,
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
