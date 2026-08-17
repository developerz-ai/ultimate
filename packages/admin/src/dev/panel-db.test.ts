import { describe, expect, test } from 'bun:test';
import { assertReadOnly } from './panel-db';

describe('assertReadOnly', () => {
  test('admits a plain SELECT', () => {
    expect(assertReadOnly('select * from members')).toBeNull();
  });

  test('refuses a real write statement', () => {
    expect(assertReadOnly("update members set name = 'x'")).not.toBeNull();
    expect(assertReadOnly('drop table members')).not.toBeNull();
  });

  test('does not false-positive on a write word inside a string literal', () => {
    // The bug: `\bcreate\b` matched the *word* anywhere, including inside a quoted value —
    // refusing a read-only SELECT that merely filters on one.
    expect(assertReadOnly("select * from events where kind = 'create'")).toBeNull();
    expect(assertReadOnly("select * from events where kind = 'delete'")).toBeNull();
    expect(assertReadOnly("select * from events where kind = 'update'")).toBeNull();
  });

  test('a write word split across an escaped quote inside a literal is still just a literal', () => {
    expect(assertReadOnly("select * from t where note = 'it''s a create event'")).toBeNull();
  });

  test('ignores a line comment naming a write word', () => {
    expect(assertReadOnly('select * from members -- drop everything\n')).toBeNull();
  });

  test('ignores a block comment naming a write word', () => {
    expect(assertReadOnly('select * from members /* insert here later */')).toBeNull();
    expect(assertReadOnly('/* multi\nline\ndelete */ select 1')).toBeNull();
  });

  test('a real write statement hidden after a comment is still refused', () => {
    expect(assertReadOnly('-- looks safe\ndelete from members')).not.toBeNull();
    expect(assertReadOnly('/* comment */ drop table members')).not.toBeNull();
  });

  test('refuses a write statement wrapped in a read-looking CTE', () => {
    expect(
      assertReadOnly('with x as (delete from members returning id) select * from x'),
    ).not.toBeNull();
  });

  test('blank / comment-only input is not a refusal — the panel treats it as "nothing typed yet"', () => {
    expect(assertReadOnly('')).toBeNull();
    expect(assertReadOnly('   ')).toBeNull();
    expect(assertReadOnly('-- just a comment')).toBeNull();
  });

  test('refuses a statement that is not a recognized read form', () => {
    expect(assertReadOnly('call some_procedure()')).not.toBeNull();
  });

  test('a comment marker smuggled through a quoted identifier does not hide the write', () => {
    // The bypass this guard existed to stop and did not: blanking `--` before quoted spans left
    // the scan looking at `select 1 as "` and calling it a read, while Postgres ran both
    // statements. Same shape for a dollar-quoted body, which is a string Postgres does not
    // terminate on `'`.
    expect(assertReadOnly('select 1 as "--"; delete from members')).not.toBeNull();
    expect(assertReadOnly('select $$--$$; drop table members')).not.toBeNull();
    expect(assertReadOnly('select $tag$--$tag$; truncate members')).not.toBeNull();
  });

  test('a quoted identifier that only looks like a write is still a read', () => {
    expect(assertReadOnly('select "delete" from members')).toBeNull();
    expect(assertReadOnly('select id as "update count" from members')).toBeNull();
    expect(assertReadOnly('select $$ delete from members $$ as note')).toBeNull();
  });

  // The gap that made this a second, weaker guard: the keyword scan had no notion of a CALL, so
  // every statement below is a syntactically perfect SELECT and every one of them does something
  // a read may not do. `@ultimat3/mcp`'s guard already refused all of them; this panel now asks it.
  test('refuses a read that calls out of the database, or holds a lock, or burns the clock', () => {
    expect(assertReadOnly("select pg_read_file('/etc/passwd')")).not.toBeNull();
    expect(assertReadOnly('select pg_sleep(60)')).not.toBeNull();
    expect(assertReadOnly('select pg_advisory_lock(1)')).not.toBeNull();
    expect(assertReadOnly("select set_config('work_mem', '1GB', false)")).not.toBeNull();
    expect(assertReadOnly('select * from members for update')).not.toBeNull();
  });

  test('refuses a batch, even when every statement in it reads', () => {
    // Batching is how a write rides in behind a read; the old scan tested the whole blob at once.
    expect(assertReadOnly('select 1; select 2')).not.toBeNull();
  });

  test('a column whose name merely starts with a forbidden family is still readable', () => {
    // The rule is a prefix on a CALL, never on a bare word — otherwise this is a false refusal.
    expect(assertReadOnly('select pg_sleep_for_seconds from timings')).toBeNull();
  });

  // An unterminated delimiter blanks the remainder, so the `;` and the write keyword vanish
  // before the statement count, the leader check and the write-keyword scan ever look. ALL FIVE
  // forms failed open at once; a local test for a surviving `'`/`"` covered three of them and
  // called a dollar-quoted body "a quote". Pinned here as one table because it is one mechanism.
  test.each([
    ['single quote', "select '; delete from members"],
    ['E-string', "select E'x ; delete from members"],
    ['double quote', 'select "; drop table members'],
    ['dollar quote', 'select $tag$ ; delete from members'],
    ['block comment', 'select 1 /* ; delete from members'],
  ])('an unterminated %s cannot hide the statement behind it', (_form, sql) => {
    expect(assertReadOnly(sql)).not.toBeNull();
  });

  test('a refusal never sends the developer to a flag that cannot fix it', () => {
    // `x db psql --write` grants writes; it does not close a delimiter. Asserting the shape of
    // the sentence, never another package's prose — only that this panel stopped claiming the
    // write flag IS the fix.
    const refusal = assertReadOnly("select '; delete from members") ?? '';
    expect(refusal).toContain('Fix the statement, or');
    expect(refusal).toContain('x db psql --write');
  });
});
