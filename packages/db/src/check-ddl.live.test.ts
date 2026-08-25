// Single responsibility: a column's CHECK, read back out of the CATALOG of a real server, on the
// two databases the generator cannot tell apart — one holding the OLD inline anonymous form under
// Postgres' own name, one holding nothing. A string comparison cannot say a CHECK exists and cannot
// say an insert is refused, which is exactly how `enumerated()`'s value set left the database under
// a green gate: `drift` hashes entity source against a sidecar and never reads the SQL.
//
// Every table here is dropped on the way in and on the way out; nothing is left behind.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import type { SchemaDescription } from './introspect';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

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

const STATUS_CHECK = "status in ('draft', 'published')";
/** What the OLD anonymous form on `chk_old` allows: the set before the entity narrowed it. */
const WIDER_STATUS_CHECK = "status in ('draft', 'published', 'archived')";
const SCALE_CHECK = 'price_scale is null or (price_scale >= 0 and price_scale <= 6)';

const TABLE = 'chk_posts';

const entity = (
  table: string,
  overrides: Partial<EntityDescriptionLike> = {},
): EntityDescriptionLike => ({
  name: 'ChkPost',
  table,
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('title', { notNull: true }),
    column('status', { notNull: true, check: STATUS_CHECK }),
    column('price_scale', { kind: 'integer', check: SCALE_CHECK }),
  ],
  indexes: [],
  ...overrides,
});

/** The sidecar an app generated BEFORE column checks were recorded: every `check` field silent. */
const preFieldSnapshot = (table: string): SchemaDescription =>
  snapshotOf([
    entity(table, {
      columns: entity(table).columns.map((each) => ({ ...each, check: null })),
    }),
  ]);

const at = new Date('2026-08-25T00:00:00.000Z');
const uuid = (tail: string): string => `00000000-0000-7000-8000-${tail.padStart(12, '0')}`;

describe.skipIf(!hasPostgres)('live · postgres · a column CHECK survives a regeneration', () => {
  let client: PostgresClient;

  const apply = async (sql: string): Promise<void> => {
    for (const statement of statementsOf(sql)) await client.execute(raw(statement));
  };

  const checkNames = async (table: string): Promise<readonly string[]> => {
    const rows = await client.query<{ conname: string }>(
      raw(
        `select conname from pg_constraint c join pg_class t on t.oid = c.conrelid ` +
          `where t.relname = '${table}' and c.contype = 'c' order by conname`,
      ),
    );
    return rows.map((row) => row.conname);
  };

  const insertStatus = (table: string, id: string, status: string): Promise<unknown> =>
    client.execute(
      raw(
        `insert into "${table}" ("id", "title", "status") ` +
          `values ('${uuid(id)}', 't', '${status}')`,
      ),
    );

  const drop = async (...tables: readonly string[]): Promise<void> => {
    for (const table of tables)
      await client.execute(raw(`drop table if exists "${table}" cascade`));
  };

  beforeAll(async () => {
    client = createPostgresClient({ url: url ?? '' });
    await drop(TABLE, 'chk_old', 'chk_absent');
  });

  afterAll(async () => {
    await drop(TABLE, 'chk_old', 'chk_absent');
    await client.close();
  });

  test("Postgres' own name for an anonymous single-column CHECK is `<table>_<column>_check`", async () => {
    // The premise the whole repair rests on. If this is not the name, the repair migration adds a
    // SECOND constraint beside the one an already-generated database is holding.
    await client.execute(
      raw(
        `create table "chk_old" ("id" uuid primary key, "title" text not null, ` +
          `"status" text not null check (${WIDER_STATUS_CHECK}), ` +
          `"price_scale" integer check (${SCALE_CHECK}))`,
      ),
    );
    expect(await checkNames('chk_old')).toEqual([
      'chk_old_price_scale_check',
      'chk_old_status_check',
    ]);
  });

  test('the repair APPLIES on a database holding the old anonymous form — no 42710', async () => {
    const repair = generateMigration({
      entities: [entity('chk_old')],
      current: preFieldSnapshot('chk_old'),
      name: 'name the checks',
      now: at,
    });
    expect(repair.up).toContain('drop constraint if exists "chk_old_status_check"');
    // An unguarded `add constraint` is `42710` here, inside ROLE=migrate, with the server's words.
    await apply(repair.up);
    expect(await checkNames('chk_old')).toEqual([
      'chk_old_price_scale_check',
      'chk_old_status_check',
    ]);
  });

  test("and what the table now enforces is the ENTITY's set, not the one it was created with", async () => {
    // `chk_old` was created allowing `archived`; the entity narrowed the set and this run is the
    // only thing that can move the constraint. A repair that left the old anonymous one in place
    // — under any name — accepts this row, which is why the assertion is the narrowed value and
    // not a value neither set allows.
    await expect(insertStatus('chk_old', '1', 'archived')).rejects.toThrow();
    await expect(insertStatus('chk_old', '2', 'nope')).rejects.toThrow();
    await insertStatus('chk_old', '3', 'draft');
  });

  test('the repair APPLIES on a database holding nothing — the same statement, no drop to do', async () => {
    // The other half the generator cannot tell apart: a check declared after the table was created
    // emitted NOTHING under the old generator, so this database has no constraint at all.
    await client.execute(
      raw(
        `create table "chk_absent" ("id" uuid primary key, "title" text not null, ` +
          `"status" text not null, "price_scale" integer)`,
      ),
    );
    expect(await checkNames('chk_absent')).toEqual([]);
    await apply(
      generateMigration({
        entities: [entity('chk_absent')],
        current: preFieldSnapshot('chk_absent'),
        name: 'name the checks',
        now: at,
      }).up,
    );
    expect(await checkNames('chk_absent')).toEqual([
      'chk_absent_price_scale_check',
      'chk_absent_status_check',
    ]);
    await expect(insertStatus('chk_absent', '3', 'nope')).rejects.toThrow();
  });

  test('a table this generator creates carries the CHECK under the same name', async () => {
    await apply(generateMigration({ entities: [entity(TABLE)], name: 'init', now: at }).up);
    expect(await checkNames(TABLE)).toEqual([
      `${TABLE}_price_scale_check`,
      `${TABLE}_status_check`,
    ]);
  });

  test('regenerating against its own snapshot emits nothing AND applies', async () => {
    const second = generateMigration({
      entities: [entity(TABLE)],
      current: snapshotOf([entity(TABLE)]),
      name: 'again',
      now: at,
    });
    expect(second.up).toBe('');
    await apply(second.up);
    // The measured claim: after a regeneration `status` STILL refuses a value outside the set.
    await expect(insertStatus(TABLE, '4', 'nope')).rejects.toThrow();
    await insertStatus(TABLE, '5', 'published');
  });

  test('the repair is reversible — its down applies and leaves the table without the constraints', async () => {
    const repair = generateMigration({
      entities: [entity('chk_absent')],
      current: preFieldSnapshot('chk_absent'),
      name: 'name the checks',
      now: at,
    });
    await apply(repair.down);
    expect(await checkNames('chk_absent')).toEqual([]);
  });
});
