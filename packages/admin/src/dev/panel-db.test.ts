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
});
