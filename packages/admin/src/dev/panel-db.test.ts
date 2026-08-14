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

  test('an unterminated quote leaves the rest of the statement visible to the scan', () => {
    // Failing open on a malformed quote is the same bypass by another route. Postgres rejects
    // this too, but the guard must not be the thing that let it through.
    expect(assertReadOnly("select '; delete from members")).not.toBeNull();
    expect(assertReadOnly('select "; drop table members')).not.toBeNull();
  });
});
