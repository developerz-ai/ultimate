// Single responsibility: the schema the MIGRATIONS declare — the newest snapshot, the applied
// subset the ledger records — and `checkDrift`, the post-migrate verification that reads a live
// catalog through a client. The pure comparison itself is `drift.test.ts`.

import { describe, expect, test } from 'bun:test';
import { appTables, checkDrift, declaredSchema, expectedSchema } from './drift';
import { schema, table } from './drift-fixtures';
import { createRecordingClient } from './fake';
import type { SchemaDescription } from './introspect';
import type { LedgerRow, Migration } from './migrate';
import { isLedgerMissing } from './migrate';

const migration = (id: string, snapshot?: SchemaDescription): Migration => ({
  id,
  name: id,
  up: '',
  down: '',
  ...(snapshot === undefined ? {} : { snapshot }),
});

const ledgerRow = (id: string): LedgerRow => ({
  id,
  name: id,
  checksum: 'x',
  applied_at: '2026-08-14T00:00:00Z',
  app_version: 'dev',
  duration_ms: 1,
});

describe('the schema migrations declare', () => {
  test('the newest snapshot wins, whatever order the migrations arrive in', () => {
    const declared = declaredSchema([
      migration('0002_b', schema(table('posts', ['id', 'title']))),
      migration('0001_a', schema(table('posts', ['id']))),
    ]);
    // `declaredSchema` answers `undefined` when the newest migration carries no snapshot, so the
    // chain has to survive that — and an `undefined` actual still fails this assertion.
    expect(declared?.tables[0]?.columns.map((column) => column.name)).toEqual(['id', 'title']);
  });

  test('no migration at all declares an empty schema — an app owes the database nothing yet', () => {
    expect(declaredSchema([])).toEqual({ tables: [] });
  });

  test('a newest migration with no snapshot declares nothing, never an older snapshot', () => {
    // The obsolete-snapshot bug: `0002` changed the schema and wrote nothing down, so answering
    // with `0001` reports the column the database correctly holds as `unexpected-column` — drift
    // against a schema that is exactly right.
    expect(declaredSchema([migration('0003_c')])).toBeUndefined();
    expect(
      declaredSchema([migration('0001_a', schema(table('posts', ['id']))), migration('0002_b')]),
    ).toBeUndefined();
  });

  test('expected is declared over the applied subset — a pending migration is not owed yet', () => {
    const migrations = [
      migration('0001_a', schema(table('posts', ['id']))),
      migration('0002_b', schema(table('posts', ['id', 'title']))),
    ];
    // `x db gen` diffs against 0002 (both are written down); the database only owes 0001.
    expect(declaredSchema(migrations)?.tables[0]?.columns).toHaveLength(2);
    expect(expectedSchema(migrations, [ledgerRow('0001_a')])?.tables[0]?.columns).toHaveLength(1);
    expect(expectedSchema(migrations, [])?.tables).toEqual([]);
  });
});

/** One `information_schema.columns` row, the shape `introspect()` reads the live schema out of. */
const columnRow = (tableName: string, column: string, position = 1) => ({
  table_name: tableName,
  column_name: column,
  data_type: 'text',
  is_nullable: 'YES',
  column_default: null,
  ordinal_position: position,
});

/** A client answering the two reads `checkDrift` makes: the ledger, then the live catalog. */
const liveDatabase = (
  ledger: readonly LedgerRow[],
  columns: readonly ReturnType<typeof columnRow>[],
) =>
  createRecordingClient()
    .on('from x_migrations', { rows: ledger })
    .on('information_schema.columns', { rows: columns });

describe('checkDrift is the post-migrate verification', () => {
  const applied = [migration('0001_a', schema(table('posts', ['id', 'title'])))];
  const ledger = [ledgerRow('0001_a')];

  test('the live database is diffed against the ledger, not against the files on disk', async () => {
    const client = liveDatabase(ledger, [columnRow('posts', 'id'), columnRow('posts', 'title', 2)]);
    expect(await checkDrift({ migrations: applied, client })).toEqual({
      ok: true,
      differences: [],
    });
  });

  test('a column added by hand is what only this check can see', async () => {
    const client = liveDatabase(ledger, [
      columnRow('posts', 'id'),
      columnRow('posts', 'title', 2),
      columnRow('posts', 'hotfix', 3),
    ]);
    const report = await checkDrift({ migrations: applied, client });
    expect(report.ok).toBe(false);
    expect(report.differences).toEqual([
      {
        kind: 'unexpected-column',
        table: 'posts',
        column: 'hotfix',
        cause: 'table "posts" has column "hotfix" not present in any migration',
        fix: 'x db gen "add hotfix"',
      },
    ]);
  });

  test('a table the ledger says was applied and that is gone points at x db migrate', async () => {
    const report = await checkDrift({ migrations: applied, client: liveDatabase(ledger, []) });
    expect(report.differences.map((difference) => difference.kind)).toEqual(['missing-table']);
    expect(report.differences[0]?.fix).toBe('x db migrate');
  });

  test('a migration the ledger has not recorded is not owed yet, so it is not drift', async () => {
    // Pending, not drifted: `expectedSchema` reads the ledger's own subset, so a database that has
    // simply not run 0001 yet reports clean. Reporting it here would fail every fresh database.
    expect((await checkDrift({ migrations: applied, client: liveDatabase([], []) })).ok).toBe(true);
  });

  test('every framework table is bookkeeping — no migration declares one, so none is drift', async () => {
    // Each of these is created by `create table if not exists` at boot, by the package that owns
    // it. Counted as app schema they are eight `unexpected-table` findings on a correct database.
    const bookkeeping = [
      'x_migrations',
      'x_jobs',
      'x_job_steps',
      'x_outbox',
      'x_users',
      'x_sessions',
      'x_accounts',
      'x_verifications',
      'x_api_keys',
    ].map((name) => columnRow(name, 'id'));
    const client = liveDatabase(ledger, [
      columnRow('posts', 'id'),
      columnRow('posts', 'title', 2),
      ...bookkeeping,
    ]);
    expect((await checkDrift({ migrations: applied, client })).ok).toBe(true);
  });

  test('appTables keeps the app schema and drops the whole x_ namespace', () => {
    const live = schema(table('posts', ['id']), table('x_jobs', ['id']));
    expect(appTables(live).tables.map((entry) => entry.name)).toEqual(['posts']);
    expect(appTables(schema()).tables).toEqual([]);
  });
});

describe('a snapshot the migrations do not carry', () => {
  test('the report says so instead of answering clean', async () => {
    // The newest applied migration wrote nothing down, so there is no schema to compare against —
    // and `ok: true` here would be the false green drift detection exists to prevent.
    const client = liveDatabase(
      [ledgerRow('0001_a'), ledgerRow('0002_b')],
      [columnRow('posts', 'id')],
    );
    const report = await checkDrift({
      client,
      migrations: [
        migration('0001_a', schema(table('posts', ['id']))),
        { id: '0002_b', name: 'b', up: '', down: '' },
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.differences[0]?.kind).toBe('unknown-schema');
    expect(report.differences[0]?.cause).toContain('0002_b');
    expect(report.differences[0]?.fix).toContain('x db gen');
  });
});

describe('isLedgerMissing', () => {
  test('only Postgres undefined_table is a ledger that does not exist', () => {
    expect(isLedgerMissing({ sourceError: { code: '42P01' } })).toBe(true);
    // A permission denied is a ledger nobody read, not an empty one.
    expect(isLedgerMissing({ sourceError: { code: '42501' } })).toBe(false);
    expect(isLedgerMissing({ code: 'X_DB_UNAVAILABLE' })).toBe(false);
    expect(isLedgerMissing(new Error('nope'))).toBe(false);
    expect(isLedgerMissing(undefined)).toBe(false);
  });
});
