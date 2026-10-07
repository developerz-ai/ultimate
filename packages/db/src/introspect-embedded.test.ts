// Single responsibility: `introspectSchema()`'s three catalog queries against the real embedded
// database. `introspect.test.ts` pins the row -> description fold with a recording client, and
// nothing there can tell a correct catalog query from one Postgres answers differently — a
// composite foreign key is the case that proves it, because the wrong join returns a cross
// product of source and target columns that a stubbed row set would never produce.

import { afterAll, describe, expect, test } from 'bun:test';
import { findTable, introspectSchema } from './introspect';
import { pgliteClient } from './pglite';
import { sql } from './sql';

describe('introspectSchema · the real embedded database', () => {
  // A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
  const PGLITE_BOOT_MS = 30_000;
  const client = pgliteClient();

  afterAll(async () => {
    await client.close();
  });

  test(
    'a composite foreign key comes back as one ordered pair of column lists, not a cross product',
    async () => {
      await client.execute(sql`drop table if exists introspect_memberships`);
      await client.execute(sql`drop table if exists introspect_users`);
      await client.execute(sql`
        create table introspect_users (
          tenant_id uuid not null,
          id uuid not null,
          primary key (tenant_id, id)
        )
      `);
      // Source order (org_id, user_id) deliberately does NOT match target order, and neither list
      // is alphabetical: a query that sorts by attnum instead of key position swaps the pairing.
      await client.execute(sql`
        create table introspect_memberships (
          id uuid primary key,
          user_id uuid not null,
          org_id uuid not null,
          constraint introspect_memberships_org_user_fkey
            foreign key (org_id, user_id) references introspect_users (tenant_id, id) on delete cascade
        )
      `);

      const schema = await introspectSchema({ client });
      const memberships = findTable(schema, 'introspect_memberships');

      expect(memberships?.foreignKeys).toEqual([
        {
          name: 'introspect_memberships_org_user_fkey',
          columns: ['org_id', 'user_id'],
          referencedTable: 'introspect_users',
          referencedColumns: ['tenant_id', 'id'],
          onDelete: 'c',
        },
      ]);

      await client.execute(sql`drop table introspect_memberships`);
      await client.execute(sql`drop table introspect_users`);
    },
    PGLITE_BOOT_MS,
  );

  // Issue #340: `pg_stat_statements` in `public` made every deploy fail terminally. A recording
  // client can pin the predicate's TEXT and nothing more — only a real catalog can say whether
  // Postgres agrees that these relations are owned and that the app's table is not.
  test(
    'an extension-owned table and a view are not app schema; the app table beside them is',
    async () => {
      await client.execute(sql`drop view if exists introspect_report`);
      await client.execute(sql`drop table if exists introspect_ext_owned`);
      await client.execute(sql`drop table if exists introspect_posts`);
      await client.execute(sql`create table introspect_posts (id uuid primary key)`);
      await client.execute(sql`create table introspect_ext_owned (id int primary key)`);
      await client.execute(sql`create view introspect_report as select 1 as one`);
      // The exact row `create extension` writes for a relation it owns. Written by hand because
      // PGlite ships no contrib extension that installs a relation, and the row — not the command
      // that produced it — is what `nonAppRelations()` reads. `plpgsql` is the extension every
      // database already has, so it needs no install of its own.
      await client.execute(sql`
        insert into pg_depend (classid, objid, objsubid, refclassid, refobjid, refobjsubid, deptype)
        select 'pg_class'::regclass, 'introspect_ext_owned'::regclass, 0,
               'pg_extension'::regclass, (select oid from pg_extension where extname = 'plpgsql'),
               0, 'e'
      `);

      const schema = await introspectSchema({ client });
      const names = schema.tables.map((table) => table.name);

      expect(names).toContain('introspect_posts');
      expect(names).not.toContain('introspect_ext_owned');
      expect(names).not.toContain('introspect_report');

      await client.execute(sql`drop view introspect_report`);
      // The dependency row goes first: `drop table` on an extension member is refused otherwise.
      await client.execute(sql`
        delete from pg_depend
        where classid = 'pg_class'::regclass and objid = 'introspect_ext_owned'::regclass
      `);
      await client.execute(sql`drop table introspect_ext_owned`);
      await client.execute(sql`drop table introspect_posts`);
    },
    PGLITE_BOOT_MS,
  );

  // The access method is read out of `pg_am` through `pg_class.relam`. A recording client can pin
  // the SQL text and nothing more — only a real catalog can say that the join reaches the right
  // row, and a query that silently returned no method at all would read as `btree` everywhere and
  // make drift blind to exactly the case `using` exists for.
  test(
    'a GIN index comes back as gin, and the btree beside it as btree',
    async () => {
      await client.execute(sql`drop table if exists introspect_gin`);
      await client.execute(sql`create table introspect_gin (id uuid primary key, tags jsonb)`);
      await client.execute(
        sql`create index introspect_gin_tags_idx on introspect_gin using gin ("tags")`,
      );
      await client.execute(sql`create index introspect_gin_id_idx on introspect_gin ("id")`);

      const table = findTable(await introspectSchema({ client }), 'introspect_gin');
      const method = (name: string): string | undefined =>
        table?.indexes.find((index) => index.name === name)?.using;

      expect(method('introspect_gin_tags_idx')).toBe('gin');
      expect(method('introspect_gin_id_idx')).toBe('btree');
      // The primary key's index is Postgres' own, and it is a btree like any other.
      expect(method('introspect_gin_pkey')).toBe('btree');

      await client.execute(sql`drop table introspect_gin`);
    },
    PGLITE_BOOT_MS,
  );

  test(
    'an expression key is kept in its place and marked, never dropped from the column list',
    async () => {
      await client.execute(sql`drop table if exists introspect_exprs`);
      await client.execute(sql`create table introspect_exprs (id int primary key, title text)`);
      await client.execute(
        sql`create index introspect_exprs_idx on introspect_exprs (id, lower(title))`,
      );
      const table = findTable(await introspectSchema({ client }), 'introspect_exprs');
      const index = table?.indexes.find((entry) => entry.name === 'introspect_exprs_idx');
      // The inner join on `pg_attribute` answered `['id']`: an index rebuilt by hand with an extra
      // expression key compared equal to the one migrations declare.
      expect(index?.columns).toEqual(['id', '(lower(title))']);
      await client.execute(sql`drop table introspect_exprs`);
    },
    PGLITE_BOOT_MS,
  );

  test(
    'a column type is format_type — the modifier, the element and the user type, by name',
    async () => {
      await client.execute(sql`drop table if exists introspect_types`);
      await client.execute(sql`drop type if exists introspect_mood`);
      await client.execute(sql`create type introspect_mood as enum ('ok')`);
      await client.execute(sql`
        create table introspect_types (
          price numeric(12, 2),
          name varchar(120),
          tags text[],
          mood introspect_mood,
          at timestamptz
        )
      `);
      const table = findTable(await introspectSchema({ client }), 'introspect_types');
      // `information_schema.data_type` answered numeric, character varying, ARRAY, USER-DEFINED.
      expect(Object.fromEntries(table?.columns.map((c) => [c.name, c.dataType]) ?? [])).toEqual({
        at: 'timestamp with time zone',
        mood: 'introspect_mood',
        name: 'character varying(120)',
        price: 'numeric(12,2)',
        tags: 'text[]',
      });
      await client.execute(sql`drop table introspect_types`);
      await client.execute(sql`drop type introspect_mood`);
    },
    PGLITE_BOOT_MS,
  );
});
