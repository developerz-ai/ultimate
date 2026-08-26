// Single responsibility: what `diffSchema` reports about TABLES and COLUMNS — existence,
// nullability, a foreign key's rule, and the `X_DB_DRIFT` rendering built out of a difference.
// Indexes are `drift-index.test.ts`; the ledger and the live database are `drift-ledger.test.ts`.

import { describe, expect, test } from 'bun:test';
import { assertNoDrift, diffSchema, driftError } from './drift';
import { schema, table } from './drift-fixtures';
import type { SchemaDescription, TableDescription } from './introspect';

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

  /**
   * The `fix:` used to be `x db gen "add <table>"`, which cannot resolve this finding and never
   * could: `x db gen` diffs the ENTITY REGISTRY against the newest snapshot, and a table nothing
   * declares is on neither side of that diff — so it produced an empty diff, and the generator's
   * empty-diff branch writes NO FILE, leaving the reader with nothing to run and the same finding
   * on the next deploy (issue #345). Both replacements are things the reader can actually do.
   */
  test('the unexpected-table fix names an edit that resolves it, never x db gen', () => {
    const report = diffSchema(schema(table('drafts', ['id'])), schema(table('posts', ['id'])));
    const fix = report.differences.find((d) => d.kind === 'unexpected-table')?.fix ?? '';
    expect(fix).not.toContain('x db gen');
    // The keep branch: a migration claims it, and `x db migrate` accepts a table its own SQL
    // creates (`acceptCreatedTables`). `if not exists`, because the relation is already there.
    expect(fix).toContain('create table if not exists "drafts"');
    expect(fix).toContain('x db migrate');
    // The drop branch, for a table nothing owns — named as a command, with the table in it.
    expect(fix).toContain('psql');
    expect(fix).toContain(`drop table "drafts"`);
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

describe('nullability', () => {
  const withNullable = (
    base: TableDescription,
    column: string,
    nullable: boolean,
  ): TableDescription => ({
    ...base,
    columns: base.columns.map((held) => (held.name === column ? { ...held, nullable } : held)),
  });

  const posts = table('posts', ['id', 'org_id']);

  test('a column left nullable after a NOT NULL migration is drift, not a clean schema', () => {
    // The expand/contract flow emits a NOT NULL add as nullable plus a comment saying "backfill,
    // then set not null". Nobody runs phase 2, and until this compared nullability the check said
    // `ok: true` while a later `undefined` write landed as NULL and crashed three services away.
    const live = schema(withNullable(posts, 'org_id', true));
    const expected = schema(withNullable(posts, 'org_id', false));

    const report = diffSchema(live, expected);

    expect(report.ok).toBe(false);
    expect(report.differences[0]?.kind).toBe('changed-column');
    expect(report.differences[0]?.column).toBe('org_id');
    expect(report.differences[0]?.cause).toContain('allows NULL');
    expect(report.differences[0]?.fix).toBe(
      'alter table "posts" alter column "org_id" set not null;   # in a new migration' +
        ' — backfill the existing NULLs first',
    );
  });

  test('the other direction is drift too — a constraint no migration declares', () => {
    const report = diffSchema(
      schema(withNullable(posts, 'org_id', false)),
      schema(withNullable(posts, 'org_id', true)),
    );

    expect(report.differences[0]?.kind).toBe('changed-column');
    expect(report.differences[0]?.cause).toContain('forbids NULL');
    expect(report.differences[0]?.fix).toContain('drop not null');
  });

  test('agreeing sides report nothing', () => {
    expect(diffSchema(schema(posts), schema(posts)).ok).toBe(true);
  });

  test('a primary key column is never reported, because Postgres makes it NOT NULL itself', () => {
    // The catalog always says `id` is NOT NULL; a snapshot spelling it nullable would otherwise
    // put one finding on every table in a database that is exactly right.
    const live = withNullable(posts, 'id', false);
    const expected = withNullable(posts, 'id', true);

    expect(diffSchema(schema(live), schema(expected)).ok).toBe(true);
  });
});

describe('unit · diffSchema stays total when the catalog name is unwritable', () => {
  // `identifier()` — the package's one quoting rule — refuses a name holding whitespace, a quote
  // or a backslash, and `dropForeignKey` now goes through it. Postgres accepts every one of them
  // in a quoted name, so the catalog can hand this comparison a constraint the fix line cannot be
  // written from. `diffSchema` is documented pure and TOTAL: a report that throws is an exception
  // in place of the verdict the caller asked for.
  const withKey = (name: string, onDelete: string | null): TableDescription => ({
    ...table('posts', ['id', 'org_id']),
    foreignKeys: [
      {
        name,
        columns: ['org_id'],
        referencedTable: 'orgs',
        referencedColumns: ['id'],
        onDelete,
      },
    ],
  });

  test('a changed rule on a hand-named constraint reports rather than throwing', () => {
    const live: SchemaDescription = { tables: [withKey('fk posts org', 'c')] };
    const expected: SchemaDescription = { tables: [withKey('posts_org_id_fkey', null)] };
    const report = diffSchema(live, expected);
    expect(report.differences.map((difference) => difference.kind)).toEqual([
      'changed-foreign-key',
    ]);
    // The name still reaches the reader — it is the only thing that identifies which constraint —
    // and the instruction says outright that the statement has to be written by hand rather than
    // handing over DDL built by the splicing this package spent a release removing.
    expect(report.differences[0]?.fix).toContain(
      'drop constraint "fk posts org" on table "posts" and add it back',
    );
    expect(report.differences[0]?.fix).not.toContain('alter table');
  });

  test('a rule no Postgres has, out of a hand-edited snapshot, reports rather than throwing', () => {
    // `addForeignKey` refuses one through core's `assert` — right for DDL it SENDS, wrong for a
    // fix line. The declared side of this comparison is a `.snapshot.json` on disk.
    const live: SchemaDescription = { tables: [withKey('posts_org_id_fkey', 'c')] };
    const expected: SchemaDescription = {
      tables: [withKey('posts_org_id_fkey', 'drop table posts')],
    };
    const report = diffSchema(live, expected);
    expect(report.differences.map((difference) => difference.kind)).toEqual([
      'changed-foreign-key',
    ]);
    expect(report.differences[0]?.fix).not.toContain('drop table posts');
    expect(report.differences[0]?.fix).not.toContain('alter table');
  });

  test('a writable name still gets the drop/add pair as runnable DDL', () => {
    const live: SchemaDescription = { tables: [withKey('fk_posts_org', 'c')] };
    const expected: SchemaDescription = { tables: [withKey('posts_org_id_fkey', null)] };
    expect(diffSchema(live, expected).differences[0]?.fix).toContain(
      'alter table "posts" drop constraint "fk_posts_org"; alter table "posts" add constraint',
    );
  });
});
