// The blanker is what three guards read SQL through, so what it erases and what it keeps is their
// contract. The ordering cases are the ones that matter: a marker inside a literal is data.

import { describe, expect, test } from 'bun:test';
import { stripSqlNoise } from './sql-noise';

describe('stripSqlNoise', () => {
  test('a comment marker inside a literal does not erase the statement after it', () => {
    // The bug this file exists for: blanking comments before literals read the `--` as a comment
    // and took `; delete from posts` with it, so a mutating fragment reached the server as a
    // SELECT nobody inspected.
    expect(stripSqlNoise("select '--'; delete from posts")).toContain('delete from posts');
  });

  test('a quote inside a comment does not open a literal', () => {
    expect(stripSqlNoise("-- it's fine\ndelete from posts")).toContain('delete from posts');
  });

  test('a comment marker inside a quoted identifier is data too', () => {
    expect(stripSqlNoise('select "a--b"; drop table posts')).toContain('drop table posts');
  });

  test('a comment marker inside a dollar body is data too', () => {
    expect(stripSqlNoise('do $fn$ -- x $fn$; drop table posts')).toContain('drop table posts');
  });

  test('comments go, and the keywords around them stay', () => {
    expect(stripSqlNoise('select 1 -- drop table posts\n, 2')).not.toContain('drop table');
    expect(stripSqlNoise('select /* drop table posts */ 1')).not.toContain('drop table');
  });

  test('a literal and an identifier each leave an empty pair behind', () => {
    expect(stripSqlNoise("insert into t values ('drop table posts')")).not.toContain('drop table');
    expect(stripSqlNoise("insert into t values ('x')")).toContain("''");
    expect(stripSqlNoise('drop table "posts"')).toContain('""');
  });

  test('a doubled quote is an escape, not the end of the literal', () => {
    expect(stripSqlNoise("select 'it''s; drop table posts'")).not.toContain('drop table');
  });
});
