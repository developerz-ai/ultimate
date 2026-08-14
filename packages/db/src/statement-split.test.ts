// Where a `;` separates and where it is data. Every case here is one a generated migration holds.

import { describe, expect, test } from 'bun:test';
import { statementsOf } from './statement-split';

describe('statementsOf', () => {
  test('a script holding two commands is two statements, separators dropped', () => {
    const script =
      'create table "posts" ("id" uuid);\ncreate index "posts_id_idx" on "posts" ("id");';
    expect(statementsOf(script)).toEqual([
      'create table "posts" ("id" uuid)',
      'create index "posts_id_idx" on "posts" ("id")',
    ]);
  });

  test('a trailing statement with no separator still arrives', () => {
    expect(statementsOf('select 1;\nselect 2')).toEqual(['select 1', 'select 2']);
  });

  test('a semicolon inside a string literal does not separate', () => {
    const script = `alter table "orgs" add constraint "c" check ("slug" ~ 'a;b');\nselect 1;`;
    expect(statementsOf(script)).toEqual([
      `alter table "orgs" add constraint "c" check ("slug" ~ 'a;b')`,
      'select 1',
    ]);
  });

  test('a doubled quote inside a literal is data, not the end of it', () => {
    expect(statementsOf(`insert into "t" values ('it''s; fine');`)).toEqual([
      `insert into "t" values ('it''s; fine')`,
    ]);
    // The escape matters where closing-and-reopening is *not* the same answer: an `E''` string
    // holding both escapes. Read as two runs, the second is no longer E-prefixed, its `\'` closes
    // it early, and the `;` that follows separates a statement that was never there.
    expect(statementsOf(`select E'a''b\\';', 1;`)).toEqual([`select E'a''b\\';', 1`]);
  });

  test("a backslash escapes only inside an E'' string", () => {
    // `E'\';'` is one literal holding a quote and a semicolon; `'a\'` is a complete standard
    // string ending in a backslash, so the `;` after it is the separator it looks like.
    expect(statementsOf(`select E'\\';', 1;`)).toEqual([`select E'\\';', 1`]);
    expect(statementsOf(`select 'a\\';select 2;`)).toEqual([`select 'a\\'`, 'select 2']);
  });

  test('a semicolon inside a quoted identifier does not separate', () => {
    expect(statementsOf('create table "a;b" ("id" uuid);')).toEqual([
      'create table "a;b" ("id" uuid)',
    ]);
  });

  test('a semicolon inside a line comment does not separate', () => {
    // Exactly what `generateMigration` emits for a NOT NULL column added to a populated table.
    const script = [
      'alter table "posts" add column "slug" text;',
      '-- backfill "slug", then: alter table "posts" alter column "slug" set not null;',
      'create index "posts_slug_idx" on "posts" ("slug");',
    ].join('\n');
    const statements = statementsOf(script);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe('alter table "posts" add column "slug" text');
    expect(statements[1]).toContain('create index "posts_slug_idx"');
  });

  test('a semicolon inside a block comment does not separate, and blocks nest', () => {
    expect(statementsOf('select 1 /* a; /* b; */ c; */ + 2;')).toEqual([
      'select 1 /* a; /* b; */ c; */ + 2',
    ]);
  });

  test('a semicolon inside a dollar-quoted body does not separate', () => {
    const script = [
      'create function "bump"() returns trigger as $$',
      'begin; new."n" := new."n" + 1; return new;',
      '$$ language plpgsql;',
      'select 1;',
    ].join('\n');
    const statements = statementsOf(script);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('$$ language plpgsql');
    expect(statements[1]).toBe('select 1');
  });

  test('a tagged dollar body closes on its own tag, never on a bare one inside it', () => {
    const script = 'do $fn$ select $$ inner; $$ ; $fn$;\nselect 1;';
    expect(statementsOf(script)).toEqual(['do $fn$ select $$ inner; $$ ; $fn$', 'select 1']);
  });

  test('a bound parameter never opens a dollar body', () => {
    expect(statementsOf('delete from "t" where "id" = $1;\nselect $2;')).toEqual([
      'delete from "t" where "id" = $1',
      'select $2',
    ]);
  });

  test('a chunk of only comments or whitespace is not a statement', () => {
    expect(statementsOf('')).toEqual([]);
    expect(statementsOf('   \n\t ')).toEqual([]);
    expect(statementsOf('-- nothing to do here\n')).toEqual([]);
    expect(statementsOf('/* nothing */\n;\n;\n')).toEqual([]);
    expect(statementsOf('-- "posts" cannot be restored; recover it from a backup')).toEqual([]);
  });

  test('a leading comment travels with the statement it documents', () => {
    expect(statementsOf('-- why\nselect 1;')).toEqual(['-- why\nselect 1']);
  });

  test('an unterminated literal is returned as it stands, for Postgres to name', () => {
    expect(statementsOf("select 'oops;")).toEqual(["select 'oops;"]);
    expect(statementsOf('select $$oops;')).toEqual(['select $$oops;']);
    expect(statementsOf('select 1 /* oops;')).toEqual(['select 1 /* oops;']);
  });
});

describe('a dollar delimiter needs separating from what precedes it', () => {
  // `$` is a legal identifier character after the first, so Postgres reads `foo$tag$` as one
  // identifier and the `;` after it as a separator. Read as a body opener instead, the rest of
  // the script was swallowed and two statements went out as one send.
  test('an identifier ending in $tag$ does not open a body', () => {
    expect(statementsOf('select foo$tag$; select 2;')).toEqual(['select foo$tag$', 'select 2']);
  });

  test('the same tag with a space before it still opens one', () => {
    expect(statementsOf('select foo $tag$ body; $tag$; select 2;')).toEqual([
      'select foo $tag$ body; $tag$',
      'select 2',
    ]);
  });

  test('the run is judged by what it began as, not by one character', () => {
    // `a1$$x$$` is one identifier: every character of it is legal in a name.
    expect(statementsOf('select a1$$x$$; select 2;')).toEqual(['select a1$$x$$', 'select 2']);
    // `$1` cannot be a name, so the delimiter after it is a real one and the body is data.
    expect(statementsOf('select $1$t$ a; b $t$; select 2;')).toEqual([
      'select $1$t$ a; b $t$',
      'select 2',
    ]);
  });
});
