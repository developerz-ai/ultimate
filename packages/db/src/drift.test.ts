import { describe, expect, test } from 'bun:test';
import { assertNoDrift, declaredSchema, diffSchema, driftError, expectedSchema } from './drift';
import type { SchemaDescription, TableDescription } from './introspect';
import type { LedgerRow, Migration } from './migrate';

const table = (name: string, columns: readonly string[]): TableDescription => ({
  schema: 'public',
  name,
  columns: columns.map((column, index) => ({
    name: column,
    dataType: 'text',
    nullable: true,
    default: null,
    position: index + 1,
  })),
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
});

const schema = (...tables: readonly TableDescription[]): SchemaDescription => ({ tables });

describe('drift', () => {
  test('a live column absent from the ledger renders the pinned contract output', () => {
    const live = schema(table('posts', ['id', 'title', 'publish_at']));
    const expected = schema(table('posts', ['id', 'title']));

    const report = diffSchema(live, expected);
    expect(report.ok).toBe(false);
    expect(report.differences).toHaveLength(1);

    const difference = report.differences[0];
    expect(difference?.kind).toBe('unexpected-column');
    expect(difference?.table).toBe('posts');
    expect(difference?.column).toBe('publish_at');

    let thrown: unknown;
    try {
      assertNoDrift(report);
    } catch (error) {
      thrown = error;
    }

    const error = thrown as { code: string; cause: string; fix: string; format(): string };
    expect(error.code).toBe('X_DB_DRIFT');
    expect(error.cause).toBe('table "posts" has column "publish_at" not present in any migration');
    expect(error.fix).toBe('x db gen "add publish_at"');
    expect(error.format()).toBe(
      [
        'X_DB_DRIFT: schema differs from migrations',
        '  cause: table "posts" has column "publish_at" not present in any migration',
        '  fix:   x db gen "add publish_at"',
      ].join('\n'),
    );
  });

  test('a migrated column missing from the live schema points at x db migrate', () => {
    const report = diffSchema(
      schema(table('posts', ['id'])),
      schema(table('posts', ['id', 'publish_at'])),
    );
    expect(report.differences[0]?.kind).toBe('missing-column');
    expect(report.differences[0]?.cause).toBe(
      'table "posts" is missing column "publish_at" that migrations declare',
    );
    expect(report.differences[0]?.fix).toBe('x db migrate');
  });

  test('an unknown table and a missing table both report precisely', () => {
    const report = diffSchema(schema(table('drafts', ['id'])), schema(table('posts', ['id'])));
    const kinds = report.differences.map((difference) => difference.kind);
    expect(kinds).toEqual(['unexpected-table', 'missing-table']);
    expect(report.differences.find((d) => d.kind === 'unexpected-table')?.cause).toBe(
      'table "drafts" is not present in any migration',
    );
    expect(report.differences.find((d) => d.kind === 'missing-table')?.cause).toBe(
      'table "posts" is declared by migrations but does not exist',
    );
  });

  test('matching schemas produce an empty --json report', () => {
    const report = diffSchema(
      schema(table('posts', ['id', 'title'])),
      schema(table('posts', ['title', 'id'])),
    );
    expect(report).toEqual({ ok: true, differences: [] });
    expect(() => assertNoDrift(report)).not.toThrow();
  });

  test('driftError carries machine-readable meta for --json', () => {
    const error = driftError({
      kind: 'unexpected-column',
      table: 'posts',
      column: 'publish_at',
      cause: 'table "posts" has column "publish_at" not present in any migration',
      fix: 'x db gen "add publish_at"',
    });
    expect(error.toJSON().meta).toEqual({
      kind: 'unexpected-column',
      table: 'posts',
      column: 'publish_at',
    });
  });
});

describe('the schema migrations declare', () => {
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

  test('the newest snapshot wins, whatever order the migrations arrive in', () => {
    const declared = declaredSchema([
      migration('0002_b', schema(table('posts', ['id', 'title']))),
      migration('0001_a', schema(table('posts', ['id']))),
    ]);
    expect(declared.tables[0]?.columns.map((column) => column.name)).toEqual(['id', 'title']);
  });

  test('a migration with no snapshot is skipped, and no snapshot at all is an empty schema', () => {
    expect(declaredSchema([migration('0003_c')]).tables).toEqual([]);
    expect(
      declaredSchema([migration('0001_a', schema(table('posts', ['id']))), migration('0002_b')])
        .tables,
    ).toHaveLength(1);
  });

  test('expected is declared over the applied subset — a pending migration is not owed yet', () => {
    const migrations = [
      migration('0001_a', schema(table('posts', ['id']))),
      migration('0002_b', schema(table('posts', ['id', 'title']))),
    ];
    // `x db gen` diffs against 0002 (both are written down); the database only owes 0001.
    expect(declaredSchema(migrations).tables[0]?.columns).toHaveLength(2);
    expect(expectedSchema(migrations, [ledgerRow('0001_a')]).tables[0]?.columns).toHaveLength(1);
    expect(expectedSchema(migrations, []).tables).toEqual([]);
  });
});
