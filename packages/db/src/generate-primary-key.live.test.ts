// Single responsibility: a changed primary key, applied to a real server in both directions. A
// string comparison cannot say the pair RUNS — that the inline key `create table` wrote really is
// named `<table>_pkey`, that dropping a key column takes its constraint with it, and that Postgres
// refuses the drop while another table's foreign key hangs off it (`2BP01`), which is the refusal
// `primary-key.ts` raises one step earlier. Every table here is dropped on the way in and out.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import { diffSchema } from './drift';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { introspect } from './introspect';
import { raw } from './sql';
import { sqlState } from './sqlstate';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const POSTS = 'pk_posts';
const COMMENTS = 'pk_comments';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: true,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const posts = (
  primaryKey: readonly string[],
  columns: readonly string[],
): EntityDescriptionLike => ({
  name: 'PkPost',
  table: POSTS,
  primaryKey,
  columns: columns.map((name) => column(name, { primaryKey: primaryKey.includes(name) })),
  indexes: [],
});

const at = new Date('2026-10-02T00:00:00.000Z');

describe.skipIf(!hasPostgres)('live · postgres · changing a primary key', () => {
  let client: PostgresClient;

  const apply = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };

  const liveKey = async (): Promise<readonly string[]> =>
    (await introspect({ client })).tables.find((table) => table.name === POSTS)?.primaryKey ?? [];

  const teardown = async (): Promise<void> => {
    await client.execute(raw(`drop table if exists "${COMMENTS}" cascade`));
    await client.execute(raw(`drop table if exists "${POSTS}" cascade`));
  };

  const before = posts(['id'], ['id', 'slug', 'org_id']);

  beforeAll(async () => {
    client = createPostgresClient({ url: url ?? '' });
    await teardown();
    await apply(generateMigration({ entities: [before], name: 'init', now: at }).up);
    await client.execute(
      raw(
        `insert into "${POSTS}" ("id", "slug", "org_id") values ('1', 'a', 'o'), ('2', 'b', 'o')`,
      ),
    );
  });

  afterAll(async () => {
    await teardown();
    await client.close();
  });

  test('a new key over existing columns applies, and rolls back, on a populated table', async () => {
    const after = posts(['org_id', 'slug'], ['id', 'slug', 'org_id']);
    const migration = generateMigration({
      entities: [after],
      current: snapshotOf([before]),
      name: 'rekey',
      now: at,
    });

    await apply(migration.up);
    expect(await liveKey()).toEqual(['org_id', 'slug']);
    // The snapshot the migration recorded is the database it left behind — which it was not, for
    // as long as `up` was empty.
    const live = await introspect({ client });
    const mine = { tables: live.tables.filter((table) => table.name === POSTS) };
    expect(diffSchema(mine, migration.snapshot).differences).toEqual([]);

    await apply(migration.down);
    expect(await liveKey()).toEqual(['id']);
  });

  test('a key column dropped by the same migration takes its constraint, and the pair still runs', async () => {
    const after = posts(['slug'], ['slug', 'org_id']);
    const migration = generateMigration({
      entities: [after],
      current: snapshotOf([before]),
      name: 'drop id',
      now: at,
      allowDestructive: true,
    });
    await apply(migration.up);
    expect(await liveKey()).toEqual(['slug']);
    await client.execute(raw(`alter table "${POSTS}" drop constraint "${POSTS}_pkey"`));
    await client.execute(raw(`alter table "${POSTS}" add column "id" text`));
    await client.execute(raw(`update "${POSTS}" set "id" = "slug"`));
    await client.execute(
      raw(`alter table "${POSTS}" add constraint "${POSTS}_pkey" primary key ("id")`),
    );
  });

  test('the server refuses what the generator refuses: a key a foreign key hangs off', async () => {
    await client.execute(
      raw(
        `create table "${COMMENTS}" ("id" text primary key, "post_id" text references "${POSTS}" ("id"))`,
      ),
    );
    const refused = await client
      .execute(raw(`alter table "${POSTS}" drop constraint "${POSTS}_pkey"`))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // `dependent_objects_still_exist` — the statement `dropChangedKey` never emits.
    expect(sqlState(refused)).toBe('2BP01');
  });

  // Postgres marks a key column NOT NULL and leaves it so when the key is dropped — measured:
  // without the `drop not null` in `down`, `slug` came back NOT NULL and the two reads differed.
  test('up then down returns the exact prior schema, nullability included', async () => {
    const NULLABLE = 'pk_nullable';
    const shape = (primaryKey: readonly string[]): EntityDescriptionLike => ({
      name: 'PkNullable',
      table: NULLABLE,
      primaryKey,
      columns: [
        column('id', { primaryKey: primaryKey.includes('id'), notNull: false }),
        column('slug', { primaryKey: primaryKey.includes('slug'), notNull: false }),
      ],
      indexes: [],
    });
    const read = async () =>
      (await introspect({ client })).tables.find((table) => table.name === NULLABLE);

    await client.execute(raw(`drop table if exists "${NULLABLE}"`));
    await apply(generateMigration({ entities: [shape(['id'])], name: 'init', now: at }).up);
    await client.execute(raw(`insert into "${NULLABLE}" ("id", "slug") values ('1', 'a')`));
    const before = await read();
    expect(before?.columns.find((each) => each.name === 'slug')?.nullable).toBe(true);

    const migration = generateMigration({
      entities: [shape(['slug'])],
      current: snapshotOf([shape(['id'])]),
      name: 'rekey nullable',
      now: at,
    });
    await apply(migration.up);
    const keyed = await read();
    expect(keyed?.primaryKey).toEqual(['slug']);
    // `id` left the key and is declared nullable: its NOT NULL went with the constraint.
    expect(keyed?.columns.find((each) => each.name === 'id')?.nullable).toBe(true);

    await apply(migration.down);
    expect(await read()).toEqual(before);
    await client.execute(raw(`drop table "${NULLABLE}"`));
  });
});
