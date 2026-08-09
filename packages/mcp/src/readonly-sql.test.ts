// The two halves of the gate, tested apart: what it refuses, and what it hands back to be run.
// The second half is the one that bites — the caller executes the return value, so a validator
// that "normalises" the statement silently changes the query the agent asked for.

import { describe, expect, test } from 'bun:test';
import { assertBranchDatabase, assertReadOnlyQuery } from './readonly-sql';

const refusal = { code: 'X_MCP_READONLY_VIOLATION' };

describe('assertReadOnlyQuery returns what will actually run', () => {
  test('a read is returned byte-for-byte, minus surrounding whitespace and one trailing ;', () => {
    expect(assertReadOnlyQuery('  select id from posts  ')).toBe('select id from posts');
    expect(assertReadOnlyQuery('select id from posts;')).toBe('select id from posts');
    expect(assertReadOnlyQuery('select id from posts ;')).toBe('select id from posts');
  });

  test('a string literal holding a write keyword passes and survives verbatim', () => {
    const sql = "select 'delete from posts' as note";
    // Validation reads the stripped form; execution must read the author's form, or the row
    // comes back as `select   as note`.
    expect(assertReadOnlyQuery(sql)).toBe(sql);
  });

  test("SQL's doubled-quote escape does not leak the literal into the keyword scan", () => {
    const sql = "select 'it''s a drop table joke' as note";
    expect(assertReadOnlyQuery(sql)).toBe(sql);
  });

  test('a quoted identifier that looks like a write is a column name, not a statement', () => {
    const sql = 'select "update" from posts';
    expect(assertReadOnlyQuery(sql)).toBe(sql);
  });

  test('a comment holding a write keyword is ignored by validation and preserved', () => {
    const line = 'select id from posts -- drop table posts';
    expect(assertReadOnlyQuery(line)).toBe(line);

    const block = 'select /* drop table posts */ id from posts';
    expect(assertReadOnlyQuery(block)).toBe(block);
  });

  test('a dollar-quoted body is opaque to the scan and untouched in the result', () => {
    const sql = 'select $tag$ truncate posts $tag$ as note';
    expect(assertReadOnlyQuery(sql)).toBe(sql);
  });

  test('every read leader is accepted', () => {
    for (const sql of [
      'select 1',
      'with t as (select 1) select * from t',
      'explain select 1',
      'show timezone',
      'table posts',
      'values (1)',
    ]) {
      expect(assertReadOnlyQuery(sql)).toBe(sql);
    }
  });
});

describe('assertReadOnlyQuery refuses', () => {
  test('an empty statement', () => {
    expect(() => assertReadOnlyQuery('   ')).toThrowError(expect.objectContaining(refusal));
    expect(() => assertReadOnlyQuery(';;')).toThrowError(expect.objectContaining(refusal));
  });

  test('a batch, because batching hides a write behind a read', () => {
    expect(() => assertReadOnlyQuery('select 1; drop table posts')).toThrowError(
      expect.objectContaining(refusal),
    );
  });

  test('a non-read leader', () => {
    expect(() => assertReadOnlyQuery("update posts set title = 'x'")).toThrowError(
      expect.objectContaining(refusal),
    );
  });

  test('a data-modifying CTE, which reads like a SELECT and is not one', () => {
    expect(() =>
      assertReadOnlyQuery('with d as (delete from posts returning id) select * from d'),
    ).toThrowError(expect.objectContaining(refusal));
  });

  test('a locking read', () => {
    expect(() => assertReadOnlyQuery('select id from posts for update')).toThrowError(
      expect.objectContaining(refusal),
    );
    expect(() => assertReadOnlyQuery('select id from posts FOR NO KEY UPDATE')).toThrowError(
      expect.objectContaining(refusal),
    );
  });

  test('a function that reaches outside the database', () => {
    expect(() => assertReadOnlyQuery("select pg_read_file('/etc/passwd')")).toThrowError(
      expect.objectContaining(refusal),
    );
    expect(() => assertReadOnlyQuery('select pg_sleep(10)')).toThrowError(
      expect.objectContaining(refusal),
    );
  });

  test('EXPLAIN ANALYZE, which executes the plan it claims to describe', () => {
    expect(() => assertReadOnlyQuery('explain analyze select 1')).toThrowError(
      expect.objectContaining(refusal),
    );
  });
});

describe('assertBranchDatabase', () => {
  test('a branch database is allowed and names itself', () => {
    expect(assertBranchDatabase({ label: 'dev', branch: 'feat-x', production: false })).toBe(
      'feat-x',
    );
  });

  test('production and shared non-branch targets are refused separately', () => {
    expect(() =>
      assertBranchDatabase({ label: 'prod', branch: 'main', production: true }),
    ).toThrowError(expect.objectContaining(refusal));
    expect(() =>
      assertBranchDatabase({ label: 'staging', branch: null, production: false }),
    ).toThrowError(expect.objectContaining(refusal));
  });
});
