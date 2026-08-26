// Single responsibility: the index REMOVAL arm against a real server, because the two failure
// modes it exists to avoid are SQLSTATEs and only Postgres has an opinion about either.
// `2BP01 cannot drop index … because constraint … requires it` for a recorded unique index the
// server is backing with a CONSTRAINT — which `if exists` does NOT suppress — and `42704 index …
// does not exist` for one a retype already took out of the way. Both land inside `ROLE=migrate`,
// with the ledger recording nothing, so a string comparison cannot stand in for either.
//
// Every table and the ledger are dropped on the way in and on the way out, and `pg_class` is
// re-read at the end: nothing is left behind.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import type { SchemaDescription } from './introspect';
import { LEDGER_TABLE, migrate, rollback } from './migrate';
import { raw } from './sql';
import { sqlState } from './sqlstate';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const POSTS = 'idx_rm_posts';
const RETYPED = 'idx_rm_retyped';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const FEED_WHERE = "status <> 'draft'";

/** Three indexes of three different kinds, so one migration covers all three removal shapes. */
const postsEntity = (overrides: Partial<EntityDescriptionLike> = {}): EntityDescriptionLike => ({
  name: 'IdxRmPost',
  table: POSTS,
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('org_id', { kind: 'uuid', notNull: true }),
    // `unique` on the COLUMN — Postgres backs this with a CONSTRAINT named `<table>_slug_key`.
    column('slug', { notNull: true, unique: true }),
    column('status', { notNull: true }),
  ],
  indexes: [
    { name: `${POSTS}_slug_key`, columns: ['slug'], unique: true, where: null, order: null },
    // A declared unique index — a real index under the same shape the constraint has.
    {
      name: `${POSTS}_org_id_slug_key`,
      columns: ['org_id', 'slug'],
      unique: true,
      where: null,
      order: null,
    },
    // Partial: a UNIQUE constraint's index can never be one, so this takes the bare drop.
    {
      name: `${POSTS}_feed_idx`,
      columns: ['org_id'],
      unique: false,
      where: FEED_WHERE,
      order: null,
    },
  ],
  ...overrides,
});

/** The same table with `status` recorded as `varchar(20)`, so the entity's `text` is a retype. */
const retypedRecorded: SchemaDescription = {
  tables: [
    {
      schema: 'public',
      name: RETYPED,
      columns: [
        { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
        { name: 'org_id', dataType: 'uuid', nullable: false, default: null, position: 2 },
        { name: 'status', dataType: 'varchar(20)', nullable: false, default: null, position: 3 },
      ],
      primaryKey: ['id'],
      indexes: [
        {
          name: `${RETYPED}_feed_idx`,
          columns: ['org_id'],
          unique: false,
          primary: false,
          where: FEED_WHERE,
          order: null,
        },
      ],
      foreignKeys: [],
    },
  ],
};

const retypedEntity: EntityDescriptionLike = {
  name: 'IdxRmRetyped',
  table: RETYPED,
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('org_id', { kind: 'uuid', notNull: true }),
    column('status', { notNull: true }),
  ],
  indexes: [],
};

const at = new Date('2026-08-25T00:00:00.000Z');

describe.skipIf(!hasPostgres)('live · postgres · a recorded index the entities dropped', () => {
  let client: PostgresClient;

  // One chain, built once. `auditLedger` refuses a `migrate()` whose list is short of a row the
  // ledger already holds, so every call below passes a PREFIX of this and never one migration.
  const created = generateMigration({ entities: [postsEntity()], name: 'create posts', now: at });
  const dropped = generateMigration({
    entities: [postsEntity({ columns: strippedColumns(), indexes: [] })],
    current: snapshotOfPosts(),
    name: 'drop every index',
    now: at,
  });
  const retyped = generateMigration({
    entities: [retypedEntity],
    current: retypedRecorded,
    name: 'status becomes text',
    now: at,
  });
  const chain = [created, dropped, retyped];

  const clean = async (): Promise<void> => {
    for (const table of [POSTS, RETYPED])
      await client.execute(raw(`drop table if exists "${table}" cascade`));
    await client.execute(raw(`drop table if exists ${LEDGER_TABLE}`));
  };

  /** Every index on `table`, and whether a CONSTRAINT owns it — the discriminator itself. */
  const objects = async (
    table: string,
  ): Promise<readonly { readonly name: string; readonly constraint: string | null }[]> => {
    const rows = await client.query<{ name: string; constraint: string | null }>(
      raw(
        `select c.relname as name, con.conname as constraint from pg_class c ` +
          `join pg_index i on i.indexrelid = c.oid join pg_class t on t.oid = i.indrelid ` +
          `left join pg_constraint con on con.conindid = c.oid ` +
          `where t.relname = '${table}' order by c.relname`,
      ),
    );
    return rows.map((row) => ({ name: row.name, constraint: row.constraint }));
  };

  const names = async (table: string): Promise<readonly string[]> =>
    (await objects(table)).map((row) => row.name);

  /** Apply the first `count` migrations of the chain — the ledger sees the whole list either way. */
  const applyThrough = async (count: number): Promise<readonly string[]> => {
    const report = await migrate({ migrations: chain.slice(0, count), client });
    return report.applied.map((applied) => applied.id);
  };

  beforeAll(async () => {
    client = createPostgresClient({ url: url ?? '' });
    await clean();
  });

  afterAll(async () => {
    await clean();
    // Re-read, so "nothing leaked" is measured rather than assumed by the teardown having run.
    const left = await client.query<{ n: number }>(
      raw(`select count(*)::int as n from pg_class where relname like 'idx\\_rm\\_%'`),
    );
    expect(left[0]?.n).toBe(0);
    await client.close();
  });

  test('a `unique` COLUMN reaches the server as a CONSTRAINT, and a declared index does not', async () => {
    // The premise the whole pair rests on. If a column clause did not produce a constraint, a bare
    // `drop index` would be correct and the second statement would be noise.
    expect(await applyThrough(1)).toEqual([created.id]);

    expect(await objects(POSTS)).toEqual([
      { name: `${POSTS}_feed_idx`, constraint: null },
      { name: `${POSTS}_org_id_slug_key`, constraint: null },
      { name: `${POSTS}_pkey`, constraint: `${POSTS}_pkey` },
      { name: `${POSTS}_slug_key`, constraint: `${POSTS}_slug_key` },
    ]);
  });

  test('`drop index` on that one is 2BP01, and `if exists` does NOT suppress it', async () => {
    for (const statement of [
      `drop index "${POSTS}_slug_key"`,
      `drop index if exists "${POSTS}_slug_key"`,
    ]) {
      const failure = await client.execute(raw(statement)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(sqlState(failure)).toBe('2BP01');
    }
    // Still there — neither statement did anything.
    expect(await names(POSTS)).toContain(`${POSTS}_slug_key`);
  });

  test('the generated removal APPLIES, and takes all three shapes off the table', async () => {
    // The pair for the two total unique ones, a bare drop for the partial.
    expect(dropped.up).toContain(
      `alter table "${POSTS}" drop constraint if exists "${POSTS}_slug_key";`,
    );
    expect(dropped.up).toContain(`drop index if exists "${POSTS}_slug_key";`);
    expect(dropped.up).toContain(`drop index "${POSTS}_feed_idx";`);

    expect(await applyThrough(2)).toEqual([dropped.id]);
    // Only the primary key's own index is left; the constraint went with its index.
    expect(await objects(POSTS)).toEqual([{ name: `${POSTS}_pkey`, constraint: `${POSTS}_pkey` }]);
  });

  test('its down restores every one — as an INDEX, which is the recorded shape it can rebuild', async () => {
    expect(await rollback({ migrations: chain.slice(0, 2), client, steps: 1 })).toEqual([
      dropped.id,
    ]);

    // Named asymmetry: `<table>_slug_key` comes back as a plain unique index and not as the
    // constraint it was. `TableDescription` records no discriminator, so `create unique index` —
    // the one statement this generator has — is what the reversal can honestly write.
    expect(await objects(POSTS)).toEqual([
      { name: `${POSTS}_feed_idx`, constraint: null },
      { name: `${POSTS}_org_id_slug_key`, constraint: null },
      { name: `${POSTS}_pkey`, constraint: `${POSTS}_pkey` },
      { name: `${POSTS}_slug_key`, constraint: null },
    ]);
    // The predicate rides back too — restored from what the SNAPSHOT recorded, which is the only
    // side that still describes it. A total index here silently widens nothing and constrains
    // nothing, and it would read as `ok` to every name-level check.
    const [partial] = await client.query<{ def: string }>(
      raw(`select indexdef as def from pg_indexes where indexname = '${POSTS}_feed_idx'`),
    );
    expect(partial?.def).toContain("WHERE (status <> 'draft'::text)");
  });

  test('and it re-applies on the reversed database too — the pair is correct on both', async () => {
    // Now `<table>_slug_key` is a plain index rather than a constraint, which is the OTHER of the
    // two databases the generator cannot tell apart. The same `up` has to be right on both.
    expect(await applyThrough(2)).toEqual([dropped.id]);
    expect(await objects(POSTS)).toEqual([{ name: `${POSTS}_pkey`, constraint: `${POSTS}_pkey` }]);
  });

  test('an index a retype moved aside is dropped ONCE — a second drop is 42704', async () => {
    await client.execute(
      raw(
        `create table "${RETYPED}" ("id" uuid primary key, "org_id" uuid not null, ` +
          `"status" varchar(20) not null)`,
      ),
    );
    await client.execute(
      raw(`create index "${RETYPED}_feed_idx" on "${RETYPED}" ("org_id") where (${FEED_WHERE})`),
    );
    // The measured half, and the APPLY is the assertion: a second drop in the same script is
    // 42704, `migrate()` aborts the whole transaction, and the column comes out still
    // `varchar(20)`. The statement count is checked after, so the server answers first.
    expect(await applyThrough(3)).toEqual([retyped.id]);
    expect(retyped.up.match(/drop index "idx_rm_retyped_feed_idx"/g)).toHaveLength(1);
    expect(await names(RETYPED)).toEqual([`${RETYPED}_pkey`]);
    const [type] = await client.query<{ data_type: string }>(
      raw(
        `select data_type from information_schema.columns ` +
          `where table_name = '${RETYPED}' and column_name = 'status'`,
      ),
    );
    expect(type?.data_type).toBe('text');

    expect(await rollback({ migrations: chain, client, steps: 1 })).toEqual([retyped.id]);
    expect(await names(RETYPED)).toEqual([`${RETYPED}_feed_idx`, `${RETYPED}_pkey`]);
  });
});

/** The columns after `slug` stops being unique — everything else about the entity is unchanged. */
function strippedColumns(): readonly ColumnDescriptionLike[] {
  return postsEntity().columns.map((each) =>
    each.column === 'slug' ? { ...each, unique: false } : each,
  );
}

/** What the sidecar recorded when the table was created: the three indexes, before the removal. */
function snapshotOfPosts(): SchemaDescription {
  return {
    tables: [
      {
        schema: 'public',
        name: POSTS,
        columns: [
          { name: 'id', dataType: 'uuid', nullable: false, default: null, position: 1 },
          { name: 'org_id', dataType: 'uuid', nullable: false, default: null, position: 2 },
          { name: 'slug', dataType: 'text', nullable: false, default: null, position: 3 },
          { name: 'status', dataType: 'text', nullable: false, default: null, position: 4 },
        ],
        primaryKey: ['id'],
        indexes: [
          {
            name: `${POSTS}_slug_key`,
            columns: ['slug'],
            unique: true,
            primary: false,
            where: null,
            order: null,
          },
          {
            name: `${POSTS}_org_id_slug_key`,
            columns: ['org_id', 'slug'],
            unique: true,
            primary: false,
            where: null,
            order: null,
          },
          {
            name: `${POSTS}_feed_idx`,
            columns: ['org_id'],
            unique: false,
            primary: false,
            where: FEED_WHERE,
            order: null,
          },
        ],
        foreignKeys: [],
      },
    ],
  };
}
