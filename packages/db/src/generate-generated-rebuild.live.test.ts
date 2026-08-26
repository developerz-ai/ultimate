// Single responsibility: what a column becoming GENERATED takes down with it, applied to a real
// server. Plain -> generated has no `set expression`, so `regenerate` drops the column and adds it
// back — and `drop column` silently takes every partial index whose PREDICATE names it and every
// CHECK whose expression does, measured here on 18.4. `diffTable`'s `rebuilt` set is keyed on an
// index's COLUMNS, so neither of those is a name it can find: the table came back without them,
// the snapshot beside it still recording both, and `down` unable to restore either.
//
// A string comparison cannot see that. This file applies the generated SQL in both directions and
// reads `pg_indexes` and `pg_constraint` back.
//
// Every table here is dropped on the way in and on the way out; nothing is left behind.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'gc_docs';
const INDEX = `${TABLE}_title_idx`;
const CHECK = `${TABLE}_slug_present_check`;

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

/**
 * `generated` is the only thing that moves between the two versions. The index's KEY column is
 * `title` and only its predicate reads `slug`, which is what puts it out of reach of the `rebuilt`
 * set — an index keyed on the rebuilt column was already being re-created.
 */
const docs = (generated: string | undefined): EntityDescriptionLike => ({
  name: 'GcDoc',
  table: TABLE,
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('title', { notNull: true }),
    column('slug', generated === undefined ? {} : { generated }),
  ],
  indexes: [{ name: INDEX, columns: ['title'], unique: false, where: "slug <> ''", order: null }],
  invariants: [
    {
      name: 'slug_present',
      kind: 'check',
      message: 'slug is present',
      sql: "slug <> ''",
      where: null,
    },
  ],
});

const at = new Date('2026-08-25T00:00:00.000Z');
const uuid = (tail: string): string => `00000000-0000-7000-8000-${tail.padStart(12, '0')}`;

describe.skipIf(!hasPostgres)('live · postgres · a column that becomes generated', () => {
  let client: PostgresClient;

  const apply = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };

  const indexNames = async (): Promise<readonly string[]> => {
    const rows = await client.query<{ indexname: string }>(
      raw(`select indexname from pg_indexes where tablename = '${TABLE}' order by indexname`),
    );
    return rows.map((row) => row.indexname);
  };

  const checkNames = async (): Promise<readonly string[]> => {
    const rows = await client.query<{ conname: string }>(
      raw(
        `select conname from pg_constraint c join pg_class t on t.oid = c.conrelid ` +
          `where t.relname = '${TABLE}' and c.contype = 'c' order by conname`,
      ),
    );
    return rows.map((row) => row.conname);
  };

  const teardown = async (): Promise<void> => {
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
  };

  beforeAll(async () => {
    client = createPostgresClient({ url: url ?? '' });
    await teardown();
    await apply(generateMigration({ entities: [docs(undefined)], name: 'init', now: at }).up);
    await client.execute(
      raw(
        `insert into "${TABLE}" ("id", "title", "slug") values ('${uuid('1')}', 'Hello', 'hello')`,
      ),
    );
  });

  afterAll(async () => {
    await teardown();
    await client.close();
  });

  const rebuild = () =>
    generateMigration({
      entities: [docs('lower("title")')],
      current: snapshotOf([docs(undefined)]),
      name: 'slug becomes generated',
      now: at,
    });

  test('the dependents are dropped BEFORE the column, never left to drop silently with it', () => {
    const statements = statementsOf(rebuild().up);
    const droppedColumn = statements.findIndex((each) => each.includes('drop column "slug"'));
    const droppedIndex = statements.findIndex((each) => each.includes(`drop index "${INDEX}"`));
    const droppedCheck = statements.findIndex((each) =>
      each.includes(`drop constraint "${CHECK}"`),
    );
    expect(droppedIndex).toBeGreaterThanOrEqual(0);
    expect(droppedCheck).toBeGreaterThanOrEqual(0);
    expect(droppedIndex).toBeLessThan(droppedColumn);
    expect(droppedCheck).toBeLessThan(droppedColumn);
  });

  test('the whole migration APPLIES and the column is computed for the rows already there', async () => {
    await apply(rebuild().up);
    const rows = await client.query<{ slug: string }>(
      raw(`select "slug" from "${TABLE}" order by "id"`),
    );
    expect(rows.map((row) => row.slug)).toEqual(['hello']);
  });

  test('the partial index whose predicate names the column is back', async () => {
    expect(await indexNames()).toEqual([`${TABLE}_pkey`, INDEX]);
  });

  test('so is the CHECK, and it still refuses the row it always refused', async () => {
    expect(await checkNames()).toEqual([CHECK]);
    await expect(
      client.execute(raw(`insert into "${TABLE}" ("id", "title") values ('${uuid('2')}', '')`)),
    ).rejects.toThrow();
  });

  test('and its down reverses the whole thing — plain column, both dependents restored', async () => {
    await apply(rebuild().down);
    expect(await indexNames()).toEqual([`${TABLE}_pkey`, INDEX]);
    expect(await checkNames()).toEqual([CHECK]);
    const rows = await client.query<{ is_generated: string }>(
      raw(
        `select is_generated from information_schema.columns ` +
          `where table_name = '${TABLE}' and column_name = 'slug'`,
      ),
    );
    expect(rows[0]?.is_generated).toBe('NEVER');
  });
});
