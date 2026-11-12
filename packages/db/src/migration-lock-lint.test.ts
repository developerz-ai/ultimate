// The lock-heavy rail over committed SQL: the two statements that hold a live table still for a
// full scan, and the two-step forms that do not. Lexical, like `rolling.test.ts`'s rail.

import { describe, expect, test } from 'bun:test';
import {
  LOCK_HEAVY_MARKER,
  LOCK_HEAVY_SINCE,
  lockHeavyJudged,
  lockHeavyStatements,
  migrationLockHeavy,
} from './migration-lock-lint';

const kinds = (up: string): readonly string[] =>
  lockHeavyStatements(up).map(({ kind, table }) => `${kind} ${table}`);

describe('lockHeavyStatements: set not null', () => {
  test('a bare set not null on an existing table is reported, with its names', () => {
    expect(lockHeavyStatements('alter table "t" alter column "c" set not null;')).toEqual([
      {
        kind: 'set-not-null',
        table: 't',
        column: 'c',
        statement: 'alter table "t" alter column "c" set not null',
      },
    ]);
  });

  test('every spelling is one', () => {
    for (const up of [
      'ALTER TABLE t ALTER c SET NOT NULL;',
      'alter table only public.t add column x text, alter column c set not null;',
      'alter table if exists "t" alter column "c" set not null;',
    ]) {
      expect(kinds(up)).toEqual(['set-not-null t']);
    }
  });

  test('the two-step form is admitted: a validate on the table before it', () => {
    const up = [
      'alter table t validate constraint t_c_not_null;',
      'alter table t alter column c set not null;',
      'alter table t drop constraint t_c_not_null;',
    ].join('\n');
    expect(kinds(up)).toEqual([]);
  });

  test('a validate after it, or on another table, admits nothing', () => {
    expect(
      kinds('alter table t alter column c set not null;\nalter table t validate constraint k;'),
    ).toEqual(['set-not-null t']);
    expect(
      kinds('alter table u validate constraint k;\nalter table t alter column c set not null;'),
    ).toEqual(['set-not-null t']);
  });

  test('a table created in the same file has no rows to scan', () => {
    expect(kinds('create table "t" (c text);\nalter table t alter column c set not null;')).toEqual(
      [],
    );
  });

  test('drop not null and a commented note are not it', () => {
    expect(kinds('alter table t alter column c drop not null;')).toEqual([]);
    expect(kinds('-- backfill "c", then: alter table "t" alter column "c" set not null;')).toEqual(
      [],
    );
  });
});

describe('lockHeavyStatements: create index', () => {
  test('a non-concurrent build on an existing table is reported', () => {
    expect(lockHeavyStatements('create index "t_c_idx" on "t" ("c");')).toEqual([
      {
        kind: 'create-index',
        table: 't',
        column: null,
        statement: 'create index "t_c_idx" on "t" ("c")',
      },
    ]);
    expect(kinds('CREATE UNIQUE INDEX IF NOT EXISTS i ON public.t USING btree (c);')).toEqual([
      'create-index t',
    ]);
    expect(kinds('create index on t (c);')).toEqual(['create-index t']);
  });

  test('concurrently, on only, and a table created in the same file are admitted', () => {
    expect(kinds('create index concurrently i on t (c);')).toEqual([]);
    expect(kinds('create unique index concurrently if not exists i on t (c);')).toEqual([]);
    expect(kinds('create index i on only t (c);')).toEqual([]);
    expect(
      kinds('create table if not exists public."t" (c text);\ncreate index i on t (c);'),
    ).toEqual([]);
    expect(kinds('create unlogged table t (c text);\ncreate index i on "t" (c);')).toEqual([]);
  });

  test('a materialized view created in the same file is new too, a plain view is not a table', () => {
    expect(
      kinds('create materialized view "v" as select 1 as c;\ncreate unique index i on "v" (c);'),
    ).toEqual([]);
    expect(kinds('create view v as select 1;\ncreate index i on v (c);')).toEqual([
      'create-index v',
    ]);
  });

  test('a table created in the same file is that table, by its folded name', () => {
    expect(kinds('create table "T" (c text);\ncreate index i on t (c);')).toEqual([
      'create-index t',
    ]);
  });

  test('inside a literal or a dollar body it is no statement', () => {
    expect(kinds("insert into notes values ('create index i on t (c)');")).toEqual([]);
    expect(
      kinds(
        'create function f() returns void as $$ begin create index i on t (c); end $$ language plpgsql;',
      ),
    ).toEqual([]);
  });
});

describe('the marker admits the one statement under it', () => {
  test('directly above a statement, it admits that statement', () => {
    expect(kinds(`${LOCK_HEAVY_MARKER}\ncreate index i on t (c);`)).toEqual([]);
    expect(kinds(`select 1;\n  ${LOCK_HEAVY_MARKER}\n  create index i on t (c);`)).toEqual([]);
    expect(kinds(`${LOCK_HEAVY_MARKER}\nalter table t alter column c set not null;`)).toEqual([]);
  });

  test('it never admits a second statement: a hand-added set not null beside a marked build', () => {
    const up = [
      LOCK_HEAVY_MARKER,
      'create index "runs_status_idx" on "runs" ("status");',
      'alter table "runs" alter column "status" set not null;',
    ].join('\n');
    expect(kinds(up)).toEqual(['set-not-null runs']);
  });

  test('a marker at the top of the file admits only the first statement', () => {
    const up = `${LOCK_HEAVY_MARKER}\ncreate index a on t (c);\ncreate index b on t (d);`;
    expect(lockHeavyStatements(up).map(({ statement }) => statement)).toEqual([
      'create index b on t (d)',
    ]);
  });

  test('two identical statements are judged where each one stands', () => {
    // The second marker trails the first statement's line, so it declares nothing.
    const build = `${LOCK_HEAVY_MARKER}\ncreate index i on t (c);`;
    expect(kinds(`${build} ${build}`)).toEqual(['create-index t']);
  });

  test('not directly above, not a line of its own, or inside a comment: it admits nothing', () => {
    for (const up of [
      `${LOCK_HEAVY_MARKER}\n-- why\ncreate index i on t (c);`,
      `${LOCK_HEAVY_MARKER}\n\ncreate index i on t (c);`,
      `select 1; ${LOCK_HEAVY_MARKER}\ncreate index i on t (c);`,
      `/*\n${LOCK_HEAVY_MARKER}\n*/ create index i on t (c);`,
      `-- ${LOCK_HEAVY_MARKER} is how you admit one\ncreate index i on t (c);`,
    ]) {
      expect(kinds(up)).toEqual(['create-index t']);
    }
  });
});

describe('the marker and the bound', () => {
  test('the marker is read in any case and with CRLF, never as prose', () => {
    expect(kinds('-- LOCK-HEAVY: TRUE\r\ncreate index i on t (c);')).toEqual([]);
    expect(kinds('-- lock-heavy: true is how you admit one\ncreate index i on t (c);')).toEqual([
      'create-index t',
    ]);
  });

  test('only a migration newer than the release that shipped the rail is judged', () => {
    expect(lockHeavyJudged('0000_initial')).toBe(false);
    expect(lockHeavyJudged('20261111162033_drop_duplicate_pre_rename_indexes')).toBe(false);
    expect(lockHeavyJudged('20261112235959_the_day_before')).toBe(false);
    expect(lockHeavyJudged(LOCK_HEAVY_SINCE)).toBe(false);
    expect(lockHeavyJudged('20261113000001_add_index')).toBe(true);
    expect(lockHeavyJudged('20270101000000_x')).toBe(true);
  });
});

describe('migrationLockHeavy', () => {
  test('names the file, the statement, the count, and both ways out', () => {
    const file = 'packages/db/migrations/20261201000000_x.sql';
    const [first] = lockHeavyStatements('alter table "t" alter column "c" set not null;');
    if (first === undefined) return expect.unreachable('the statement was not reported');
    const error = migrationLockHeavy(file, first, 2);
    expect(error.code).toBe('X_MIGRATION_LOCK_HEAVY');
    expect(error.cause).toContain(file);
    expect(error.cause).toContain('(and 2 more)');
    expect(error.cause).toContain('alter table "t" alter column "c" set not null');
    expect(error.fix).toContain('check ("c" is not null) not valid');
    expect(error.fix).toContain('validate constraint');
    expect(error.fix).toContain(LOCK_HEAVY_MARKER);
  });

  test('an index build is told to build concurrently, outside the transaction', () => {
    const [first] = lockHeavyStatements('create index i on t (c);');
    if (first === undefined) return expect.unreachable('the statement was not reported');
    const error = migrationLockHeavy('m.sql', first);
    expect(error.cause).not.toContain('more');
    expect(error.fix).toContain('create index concurrently');
    expect(error.fix).toContain('-- transaction: false');
  });
});
