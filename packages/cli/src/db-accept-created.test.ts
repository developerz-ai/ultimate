// Issue #345's exact shape, both directions in one file: a table a migration's own SQL creates is
// accepted, and a table NOTHING creates is still reported, whole — cause and `fix:` included. The
// second half is the one that matters; without it "fixing" this is indistinguishable from turning
// the unexpected-table check off.

import { describe, expect, test } from 'bun:test';
import type { DriftReport, Migration, SchemaDescription } from '@ultimat3/db';
import { diffSchema } from '@ultimat3/db';
import { acceptCreatedTables, createdTables } from './db-accept-created';

/** A migration whose `up` is the SQL under test. `down` is never read by this rail. */
const migration = (id: string, up: string): Migration => ({ id, name: id, up, down: '' });

const table = (name: string) => ({
  schema: 'public',
  name,
  columns: [{ name: 'id', dataType: 'text', nullable: false, default: null, position: 1 }],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
});

const schema = (...names: readonly string[]): SchemaDescription => ({ tables: names.map(table) });

/**
 * The real report, from `@ultimat3/db`'s own comparison — never a hand-built one. A filter written
 * against a fabricated `DriftDifference` would keep passing after `diffSchema` started spelling
 * the kind or the table differently, which is the seam this whole rail rides on.
 */
const driftOver = (live: readonly string[], declared: readonly string[]): DriftReport =>
  diffSchema(schema(...live), schema(...declared));

describe('unit · a table an applied migration created (issue #345)', () => {
  test('a hand-written create table stops being unexpected-table on every deploy', () => {
    const migrations = [
      migration('0001_init', 'CREATE TABLE legacy_audit (\n  id text primary key\n);'),
    ];
    const before = driftOver(['posts', 'legacy_audit'], ['posts']);
    expect(before.ok).toBe(false);
    expect(before.differences.map((d) => d.table)).toEqual(['legacy_audit']);

    const after = acceptCreatedTables(before, migrations);

    expect(after.differences).toEqual([]);
    expect(after.ok).toBe(true);
  });

  /**
   * The negative control. A relation nobody declared and no migration created is the failure this
   * check exists for, and the WHOLE difference has to survive — a filter that dropped the cause or
   * the `fix:` would leave an operator a kind and a name, which is the report `x db migrate` had
   * before any of this.
   */
  test('a table NOTHING creates is still reported, cause and fix intact', () => {
    const migrations = [migration('0001_init', 'create table legacy_audit (id text);')];
    const before = driftOver(['posts', 'scratch'], ['posts']);

    const after = acceptCreatedTables(before, migrations);

    expect(after.ok).toBe(false);
    expect(after.differences).toEqual(before.differences);
    const [difference] = after.differences;
    expect(difference?.kind).toBe('unexpected-table');
    expect(difference?.cause).toContain('"scratch" is not present in any migration');
    expect(difference?.fix).toContain('create table if not exists "scratch"');
  });

  /**
   * An app with no hand-written SQL at all must come back with the identical object: the accept
   * step is a filter over a report, and a report it has nothing to say about is not its to rebuild.
   */
  test('a report with nothing to accept is returned unchanged', () => {
    const before = driftOver(['posts', 'scratch'], ['posts']);
    expect(acceptCreatedTables(before, [])).toBe(before);
  });

  test('every other difference on a created table survives, so only the table itself is accepted', () => {
    const migrations = [migration('0001_init', 'create table posts (id text);')];
    // The declared side has a column the live table does not: `missing-column` on `posts`, a table
    // a migration demonstrably creates. Accepting the TABLE must not accept its contents.
    const before = diffSchema(schema('posts'), {
      tables: [
        {
          ...table('posts'),
          columns: [
            ...table('posts').columns,
            { name: 'title', dataType: 'text', nullable: true, default: null, position: 2 },
          ],
        },
      ],
    });
    expect(before.differences.map((d) => d.kind)).toEqual(['missing-column']);

    expect(acceptCreatedTables(before, migrations)).toEqual(before);
  });
});

/**
 * Structural, and for the reason `cmd-db.test.ts` already gives about `runMigrations`: a filter
 * nothing calls is the declared-and-never-wired defect, and `runMigrations` opens the only
 * connection the post-migrate check has — so there is no seam a unit test can reach it through.
 * The moment `serve.ts` stops composing the two, `x db migrate` and `ROLE=migrate` both go back to
 * reporting a hand-written table on every deploy.
 */
describe('unit · the acceptance is wired into the post-migrate check', () => {
  test('runMigrations composes it around checkDrift, so both entrypoints get it', async () => {
    const serve = await Bun.file(`${import.meta.dir}/serve.ts`).text();
    expect(serve).toContain("import { acceptCreatedTables } from './db-accept-created'");
    expect(serve).toContain('acceptCreatedTables(await checkDrift({ migrations }), migrations)');
  });
});

describe('unit · which tables a migration script creates', () => {
  test('an unquoted name folds to lower case, the way postgres stores it', () => {
    expect(createdTables('CREATE TABLE LegacyAudit (id text);')).toEqual(['legacyaudit']);
  });

  test('a quoted name keeps its case and its escaped quotes', () => {
    expect(createdTables('create table "Legacy""Audit" (id text);')).toEqual(['Legacy"Audit']);
  });

  test('if not exists and unlogged are the same creation', () => {
    const script = 'create table if not exists a (id text);\ncreate unlogged table b (id text);';
    expect(createdTables(script)).toEqual(['a', 'b']);
  });

  test('a public-qualified name is the relation drift compares, without its schema', () => {
    expect(createdTables('create table public.drafts (id text);')).toEqual(['drafts']);
  });

  /**
   * `checkDrift` introspects ONE schema, so a `create table audit.drafts` is evidence about a
   * relation the report never mentions — accepting `drafts` from it would silence a genuine
   * finding in `public` using SQL that never touched it.
   */
  test('a name qualified with another schema is not evidence about this one', () => {
    expect(createdTables('create table audit.drafts (id text);')).toEqual([]);
  });

  /**
   * A `create table` inside a comment or a string literal creates nothing, and reading one as a
   * creation hands anyone who can write a seed row a way to switch a drift finding off. The
   * anchor is what refuses the literal — the statement opens with `insert` — and `statementsOf`
   * is what drops the two comment-only chunks before this ever sees them.
   */
  test('create table inside a comment or a literal creates nothing', () => {
    const script = [
      '-- create table ghost (id text);',
      "insert into notes (body) values ('create table ghost (id text)');",
      '/* create table ghost (id text); */',
    ].join('\n');
    expect(createdTables(script)).toEqual([]);
  });

  test('a temporary table is not a relation this schema can hold', () => {
    expect(createdTables('create temp table ghost (id text);')).toEqual([]);
  });

  test('a statement that is not a creation contributes nothing', () => {
    const script = 'alter table posts add column title text;\ndrop table drafts;';
    expect(createdTables(script)).toEqual([]);
  });
});

/**
 * Ownership is a running state across the whole migration list, not a union over it. The union
 * was the shipped defect: a name every `create table` ever wrote stayed accepted forever, so a
 * relation a later migration DROPPED laundered a hand-made table of the same name into an
 * accepted one — real drift, silenced, which is the one thing this module may not do.
 */
describe('unit · ownership ends when a migration gives the relation up', () => {
  test('a table created then dropped is NOT accepted when it reappears by hand', () => {
    const migrations = [
      migration('0001_init', 'create table legacy_audit (id text);'),
      migration('0002_drop', 'drop table legacy_audit;'),
    ];
    const before = driftOver(['posts', 'legacy_audit'], ['posts']);

    const after = acceptCreatedTables(before, migrations);

    expect(after.ok).toBe(false);
    expect(after.differences.map((d) => d.table)).toEqual(['legacy_audit']);
  });

  test('drop and re-create in a later migration owns it again', () => {
    const migrations = [
      migration('0001_init', 'create table legacy_audit (id text);'),
      migration('0002_drop', 'drop table if exists legacy_audit;'),
      migration('0003_again', 'create table legacy_audit (id text, note text);'),
    ];
    const after = acceptCreatedTables(driftOver(['legacy_audit'], []), migrations);

    expect(after.ok).toBe(true);
  });

  test('a comma list drops every relation it names', () => {
    const migrations = [
      migration('0001_init', 'create table a_t (id text);\ncreate table b_t (id text);'),
      migration('0002_drop', 'drop table a_t, b_t cascade;'),
    ];
    const after = acceptCreatedTables(driftOver(['a_t', 'b_t'], []), migrations);

    expect(after.differences.map((d) => d.table).sort()).toEqual(['a_t', 'b_t']);
  });

  test('a rename moves ownership to the new name and off the old one', () => {
    const migrations = [
      migration('0001_init', 'create table old_audit (id text);'),
      migration('0002_rename', 'alter table old_audit rename to new_audit;'),
    ];

    // The new name is owned…
    expect(acceptCreatedTables(driftOver(['new_audit'], []), migrations).ok).toBe(true);
    // …and the old one is not, so re-creating it by hand is still drift.
    expect(acceptCreatedTables(driftOver(['old_audit'], []), migrations).ok).toBe(false);
  });

  test('createdTables answers the surviving set, not every name ever written', () => {
    expect(createdTables('create table gone (id text);\ndrop table gone;')).toEqual([]);
  });
});
