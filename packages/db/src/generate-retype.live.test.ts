// Single responsibility: a retype of a column a PARTIAL INDEX and a CHECK are written against,
// applied to a real server. Postgres compiled both predicates with the column's old type and cannot
// recompile them, so `alter column … type text using …::text` answers `42883 operator does not
// exist: text = <old type>` and the migration aborts mid-run — inside `ROLE=migrate`, with the
// ledger recording nothing. A string comparison cannot tell you that did not happen, which is why
// this file applies the generated SQL instead of matching it.
//
// Every table, type and row here is dropped on the way in and on the way out; nothing is left behind.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'rt_posts';
const ENUM = 'rt_status';

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
 * `kind` is the physical type of `status` — `rt_status` for the schema the database was built
 * with, `text` for the one the entity declares now. Every other part is identical, so the only
 * change the diff can find is the retype and what hangs off it.
 */
const entity = (kind: string): EntityDescriptionLike => ({
  name: 'RtPost',
  table: TABLE,
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('org_id', { kind: 'uuid', notNull: true }),
    column('published_at', { kind: 'timestamptz' }),
    column('status', { kind, notNull: true }),
  ],
  indexes: [
    // The dependent one: its predicate is compiled against `status`.
    {
      name: `${TABLE}_feed_idx`,
      columns: ['org_id', 'published_at'],
      unique: false,
      where: "status = 'published'",
      order: 'desc',
    },
    // A plain btree over the very column being retyped — Postgres rebuilds this one itself, and
    // dropping it would be a table scan nobody asked for.
    { name: `${TABLE}_status_idx`, columns: ['status'], unique: false, where: null, order: null },
    // A partial index whose predicate names a DIFFERENT column: not dependent, must survive.
    {
      name: `${TABLE}_org_idx`,
      columns: ['org_id'],
      unique: false,
      where: 'published_at is not null',
      order: null,
    },
  ],
  invariants: [
    {
      name: 'publish_coherent',
      kind: 'check',
      message: 'publish state is coherent',
      sql: "(status = 'published') = (published_at is not null)",
      where: null,
    },
  ],
});

const at = new Date('2026-08-25T00:00:00.000Z');
const uuid = (tail: string): string => `00000000-0000-7000-8000-${tail.padStart(12, '0')}`;

describe.skipIf(!hasPostgres)('live · postgres · retyping a column a predicate depends on', () => {
  let client: PostgresClient;

  const apply = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };

  const typeOf = async (name: string): Promise<string> => {
    const rows = await client.query<{ format_type: string }>(
      raw(
        `select format_type(a.atttypid, a.atttypmod) from pg_attribute a ` +
          `join pg_class t on t.oid = a.attrelid where t.relname = '${TABLE}' ` +
          `and a.attname = '${name}'`,
      ),
    );
    return rows[0]?.format_type ?? '';
  };

  const indexNames = async (): Promise<readonly string[]> => {
    const rows = await client.query<{ indexname: string }>(
      raw(`select indexname from pg_indexes where tablename = '${TABLE}' order by indexname`),
    );
    return rows.map((row) => row.indexname);
  };

  const constraintNames = async (): Promise<readonly string[]> => {
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
    await client.execute(raw(`drop type if exists "${ENUM}" cascade`));
  };

  beforeAll(async () => {
    client = createPostgresClient({ url: url ?? '' });
    await teardown();
    // The enum type is hand-written, exactly as `examples/dummy`'s `0001_init.sql` writes it:
    // `SchemaDescription` has no field for a CREATE TYPE, so the generator neither makes nor
    // drops one. What it does own is the column that references it.
    await client.execute(raw(`create type "${ENUM}" as enum ('draft', 'published')`));
    await apply(generateMigration({ entities: [entity(ENUM)], name: 'init', now: at }).up);
    await client.execute(
      raw(
        `insert into "${TABLE}" ("id", "org_id", "published_at", "status") values ` +
          `('${uuid('1')}', '${uuid('a')}', now(), 'published'), ` +
          `('${uuid('2')}', '${uuid('a')}', null, 'draft')`,
      ),
    );
  });

  afterAll(async () => {
    await teardown();
    await client.close();
  });

  const retype = () =>
    generateMigration({
      entities: [entity('text')],
      current: snapshotOf([entity(ENUM)]),
      name: 'status to text',
      now: at,
    });

  test('the whole migration APPLIES — the retype does not abort on 42883', async () => {
    // The failure this file exists for: `operator does not exist: text = rt_status`, thrown by the
    // ALTER itself, with every statement after it unapplied.
    await apply(retype().up);
    expect(await typeOf('status')).toBe('text');
  });

  test('the dependent partial index is back, and the independent ones were never touched', async () => {
    expect(await indexNames()).toEqual([
      `${TABLE}_feed_idx`,
      `${TABLE}_org_idx`,
      `${TABLE}_pkey`,
      `${TABLE}_status_idx`,
    ]);
    // A plain btree over the retyped column is rebuilt by Postgres itself — measured, it survives
    // the ALTER untouched — so a generator that dropped it would be paying for a rebuild twice.
    expect(retype().up).not.toContain(`drop index "${TABLE}_status_idx"`);
    expect(retype().up).not.toContain(`drop index "${TABLE}_org_idx"`);
  });

  test('the predicate the index came back with is the one the entity declares', async () => {
    const rows = await client.query<{ indexdef: string }>(
      raw(
        `select indexdef from pg_indexes where tablename = '${TABLE}' ` +
          `and indexname = '${TABLE}_feed_idx'`,
      ),
    );
    expect(rows[0]?.indexdef ?? '').toContain("status = 'published'::text");
  });

  test('the dependent CHECK is back and still refuses an incoherent row', async () => {
    expect(await constraintNames()).toEqual([`${TABLE}_publish_coherent_check`]);
    await expect(
      client.execute(
        raw(
          `insert into "${TABLE}" ("id", "org_id", "published_at", "status") ` +
            `values ('${uuid('3')}', '${uuid('a')}', null, 'published')`,
        ),
      ),
    ).rejects.toThrow();
  });

  test('every row survived the rewrite', async () => {
    const rows = await client.query<{ status: string }>(
      raw(`select "status" from "${TABLE}" order by "id"`),
    );
    expect(rows.map((row) => row.status)).toEqual(['published', 'draft']);
  });

  test('and its down reverses the whole thing — back to the enum, predicates intact', async () => {
    await apply(retype().down);
    expect(await typeOf('status')).toBe(ENUM);
    expect(await indexNames()).toEqual([
      `${TABLE}_feed_idx`,
      `${TABLE}_org_idx`,
      `${TABLE}_pkey`,
      `${TABLE}_status_idx`,
    ]);
    expect(await constraintNames()).toEqual([`${TABLE}_publish_coherent_check`]);
  });
});
