// Single responsibility: a retype whose column a VIEW is written against, run through `migrate()`
// against a real server. Postgres refuses it outright — `0A000 cannot alter type of a column used
// by a view or rule`, with the view named only in the DETAIL — and nothing in `x db gen` can see
// it coming: `SchemaDescription` has no field for a view, `introspect()` reads none by
// construction (`app-relation.ts`), and no entity can declare one. So the refusal has to come from
// the one place in this package that has a connection open while the statement is still unsent.
//
// What it replaces: `X_DB_UNAVAILABLE: cannot reach the database`, whose registered `fix:` is
// "set DATABASE_URL to a reachable Postgres url" — advice that is wrong in every particular for a
// database the migrator is connected to and mid-transaction on.
//
// Every table, view and the ledger itself are dropped on the way in and on the way out.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { createPostgresClient, type PostgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { LEDGER_TABLE, type Migration, migrate } from './migrate';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'dv_docs';
const VIEW = 'dv_docs_published';
/** A second table, for the pairing the catalog read must NOT confuse — see the last test. */
const NOTES = 'dv_notes';
const NOTES_VIEW = 'dv_notes_ranked';

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

const docs = (kind: string): EntityDescriptionLike => ({
  name: 'DvDoc',
  table: TABLE,
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('rank', { kind, notNull: true }),
  ],
  indexes: [],
});

const at = new Date('2026-08-25T00:00:00.000Z');

describe.skipIf(!hasPostgres)('live · postgres · a view over a retyped column', () => {
  let client: PostgresClient;

  const retype: Migration = {
    id: '20260825000000_dv_rank_to_text',
    name: 'rank to text',
    up: generateMigration({
      entities: [docs('text')],
      current: snapshotOf([docs('integer')]),
      name: 'rank to text',
      now: at,
    }).up,
    down: 'select 1',
  };

  const typeOfRank = async (): Promise<string> => {
    const rows = await client.query<{ format_type: string }>(
      raw(
        `select format_type(a.atttypid, a.atttypmod) from pg_attribute a ` +
          `join pg_class t on t.oid = a.attrelid where t.relname = '${TABLE}' ` +
          `and a.attname = 'rank'`,
      ),
    );
    return rows[0]?.format_type ?? '';
  };

  const teardown = async (): Promise<void> => {
    await client.execute(raw(`drop view if exists "${VIEW}" cascade`));
    await client.execute(raw(`drop view if exists "${NOTES_VIEW}" cascade`));
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
    await client.execute(raw(`drop table if exists "${NOTES}" cascade`));
    await client.execute(raw(`drop table if exists ${LEDGER_TABLE}`));
  };

  beforeAll(async () => {
    client = createPostgresClient({ url: url ?? '' });
    await teardown();
    const create = generateMigration({ entities: [docs('integer')], name: 'init', now: at }).up;
    for (const statement of statementsOf(create)) await client.execute(raw(statement));
    await client.execute(raw(`create view "${VIEW}" as select "id", "rank" from "${TABLE}"`));
  });

  afterAll(async () => {
    await teardown();
    await client.close();
  });

  test('migrate() refuses by name instead of letting the server abort mid-transaction', async () => {
    const failure = await migrate({ migrations: [retype], client }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(UltimateError);
    const error = failure as UltimateError;
    expect(error.code).toBe('X_MIGRATION_VIEW_DEPENDS');
    // The view, the table and the column: everything an operator needs to write the two statements
    // that unblock the deploy. The server puts the view name in a DETAIL field nothing printed.
    expect(error.message).toContain(VIEW);
    expect(error.message).toContain(TABLE);
    expect(error.message).toContain('rank');
    // And the `fix:` is the view's own definition, so recreating it is a paste and not an archaeology.
    expect(error.fix).toContain(`drop view "${VIEW}"`);
    expect(error.fix).toContain(`create view "${VIEW}" as SELECT id, rank FROM ${TABLE}`);
  });

  test('nothing was applied and the ledger records nothing', async () => {
    expect(await typeOfRank()).toBe('integer');
    const rows = await client.query<{ id: string }>(raw(`select id from ${LEDGER_TABLE}`));
    expect(rows).toEqual([]);
  });

  test('with the view gone the same migration applies unchanged', async () => {
    await client.execute(raw(`drop view "${VIEW}"`));
    const report = await migrate({ migrations: [retype], client });
    expect(report.applied.map((each) => each.id)).toEqual([retype.id]);
    expect(await typeOfRank()).toBe('text');
  });

  // The catalog read asks for every retyped TABLE against every retyped COLUMN, one round trip, so
  // it answers pairs nobody retypes: here `dv_notes"."rank`, out of `dv_docs"."rank` and
  // `dv_notes"."mark`. Refusing on that is a deploy stopped over a view standing in nobody's way,
  // which is strictly worse than the message this whole preflight exists to improve.
  test('a pair the cross product invents is not a refusal', async () => {
    await client.execute(
      raw(`create table "${NOTES}" ("id" uuid primary key, "rank" integer, "mark" integer)`),
    );
    await client.execute(raw(`create view "${NOTES_VIEW}" as select "id", "rank" from "${NOTES}"`));
    const both: Migration = {
      id: '20260825000100_dv_two_retypes',
      name: 'two retypes',
      up:
        `alter table "${TABLE}" alter column "rank" type integer using "rank"::integer;\n` +
        `alter table "${NOTES}" alter column "mark" type text using "mark"::text;`,
      down: 'select 1',
    };
    // `retype` rides along because it is already in the ledger: `auditLedger` refuses a build that
    // does not ship a migration the ledger records, which is a different refusal entirely.
    const report = await migrate({ migrations: [retype, both], client });
    expect(report.applied.map((each) => each.id)).toEqual([both.id]);
    expect(await typeOfRank()).toBe('integer');
  });
});
