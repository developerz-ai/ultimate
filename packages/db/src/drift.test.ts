import { describe, expect, test } from 'bun:test';
import {
  appTables,
  assertNoDrift,
  checkDrift,
  declaredSchema,
  diffSchema,
  driftError,
  expectedSchema,
} from './drift';
import { createRecordingClient } from './fake';
import type { SchemaDescription, TableDescription } from './introspect';
import type { LedgerRow, Migration } from './migrate';
import { isLedgerMissing } from './migrate';

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

const index = (
  name: string,
  columns: readonly string[],
  unique = false,
): TableDescription['indexes'][number] => ({
  name,
  columns,
  unique,
  primary: false,
  where: null,
  order: null,
});

const withIndexes = (
  base: TableDescription,
  ...indexes: TableDescription['indexes']
): TableDescription => ({ ...base, indexes });

describe('an index migrations declare, against the one the catalog holds', () => {
  const posts = table('posts', ['id', 'org_id', 'created_at']);
  const declared = index('posts_org_id_created_at_idx', ['org_id', 'created_at']);

  test('a composite index rebuilt the other way round is drift, not a clean schema', () => {
    const live = schema(withIndexes(posts, index(declared.name, ['created_at', 'org_id'])));
    const report = diffSchema(live, schema(withIndexes(posts, declared)));
    expect(report.ok).toBe(false);
    expect(report.differences[0]?.kind).toBe('changed-index');
    expect(report.differences[0]?.cause).toContain('covers (created_at, org_id)');
  });

  test('an index the migrations declare and the database does not have is drift', () => {
    const report = diffSchema(schema(posts), schema(withIndexes(posts, declared)));
    expect(report.differences[0]?.kind).toBe('missing-index');
    expect(report.differences[0]?.fix).toBe('x db migrate');
  });

  test('uniqueness dropped underneath a declared index is drift', () => {
    const live = schema(withIndexes(posts, index(declared.name, declared.columns, false)));
    const report = diffSchema(live, schema(withIndexes(posts, { ...declared, unique: true })));
    expect(report.differences[0]?.cause).toContain('is not unique');
  });

  test('an index the database has and no migration declares is not drift', () => {
    // Every primary key and every unique constraint brings one, declared by no migration.
    const live = schema(withIndexes(posts, index('posts_pkey', ['id'], true)));
    expect(diffSchema(live, schema(posts)).ok).toBe(true);
  });

  test('a matching index reports nothing, predicate and direction aside', () => {
    // The catalog rewrites a predicate into its own spelling, so comparing the text would report
    // two identical indexes as drift. `x db gen` compares them, where both sides are generated.
    const live = schema(withIndexes(posts, { ...declared, where: '(deleted_at IS NULL)' }));
    const expected = schema(withIndexes(posts, { ...declared, where: '"deleted_at" is null' }));
    expect(diffSchema(live, expected).ok).toBe(true);
  });
});

describe('a foreign key migrations declare, against the one the catalog holds', () => {
  const posts = table('posts', ['id', 'org_id']);
  const key = (
    overrides: Partial<TableDescription['foreignKeys'][number]> = {},
  ): TableDescription['foreignKeys'][number] => ({
    name: 'posts_org_id_fkey',
    columns: ['org_id'],
    referencedTable: 'orgs',
    referencedColumns: ['id'],
    onDelete: null,
    ...overrides,
  });
  const withKeys = (
    base: TableDescription,
    ...foreignKeys: TableDescription['foreignKeys']
  ): TableDescription => ({ ...base, foreignKeys });

  test('a key the migrations declare and the database does not have is drift', () => {
    const report = diffSchema(schema(posts), schema(withKeys(posts, key())));
    expect(report.ok).toBe(false);
    expect(report.differences[0]?.kind).toBe('missing-foreign-key');
    expect(report.differences[0]?.cause).toContain('no foreign key on (org_id) to "orgs" (id)');
    expect(report.differences[0]?.fix).toBe('x db migrate');
  });

  test('a key repointed at another table is the declared one missing', () => {
    const live = schema(withKeys(posts, key({ referencedTable: 'tenants' })));
    expect(diffSchema(live, schema(withKeys(posts, key()))).differences[0]?.kind).toBe(
      'missing-foreign-key',
    );
  });

  test('a key repointed at another column is drift too', () => {
    const live = schema(withKeys(posts, key({ referencedColumns: ['slug'] })));
    expect(diffSchema(live, schema(withKeys(posts, key()))).ok).toBe(false);
  });

  test('the same key under another constraint name is not drift', () => {
    // Postgres names an inline clause `posts_org_id_fkey`; a hand-written migration may not.
    const live = schema(withKeys(posts, key({ name: 'fk_posts_org' })));
    expect(diffSchema(live, schema(withKeys(posts, key()))).ok).toBe(true);
  });

  test('an on delete rule the snapshot never wrote down is not drift', () => {
    // The catalog spells it `a`/`c`/`r` and no generated clause declares one.
    const live = schema(withKeys(posts, key({ onDelete: 'c' })));
    expect(diffSchema(live, schema(withKeys(posts, key()))).ok).toBe(true);
  });

  test('a key the database has and no migration declares is not drift', () => {
    expect(diffSchema(schema(withKeys(posts, key())), schema(posts)).ok).toBe(true);
  });
});

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
    expect(declared.tables[0]?.columns.map((column) => column.name)).toEqual(['id', 'title']);
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
