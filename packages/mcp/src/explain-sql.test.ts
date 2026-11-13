// `db.explain`'s screen: a write hidden anywhere — in a CTE, after a `;`, behind a comment-closed
// line — never reaches a statement this tool would EXPLAIN ANALYZE, i.e. execute.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from '@ultimat3/core';
import { explainStatement, planOf } from './explain-sql';

const caught = (fn: () => unknown): UltimateError => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!isUltimateError(thrown)) expect.unreachable('expected the call to throw an UltimateError');
  return thrown;
};

describe('explainStatement refuses every write, wherever it hides', () => {
  test.each([
    ['a data-modifying CTE', 'with gone as (delete from posts returning id) select * from gone'],
    ['an UPDATE inside a CTE', 'with u as (update posts set title = 1 returning id) select 1'],
    [
      'an INSERT inside a CTE',
      'with i as (insert into posts default values returning id) select 1',
    ],
    ['a write after a ;', 'select 1; delete from posts'],
    ['a write after a ; and a comment', 'select 1; -- note\nupdate posts set title = null'],
    ['a write after a CR-ended line comment', "select 1;--\rupdate members set role='admin'"],
    ['a second EXPLAIN ANALYZE of a write', 'select 1; explain analyze delete from posts'],
  ])('%s is X_MCP_QUERY_REJECTED, analyze or not', (_name, sql) => {
    for (const analyze of [true, false]) {
      expect(caught(() => explainStatement(sql, analyze)).code).toBe('X_MCP_QUERY_REJECTED');
    }
  });

  test.each([
    ['EXPLAIN written by the caller', 'explain analyze select 1'],
    ['SHOW', 'show search_path'],
    ['VALUES', 'values (1)'],
    ['TABLE', 'table posts'],
    ['a leading comment', '/* hi */ select 1'],
  ])('%s is not a SELECT, and is refused with a call to paste', (_name, sql) => {
    const error = caught(() => explainStatement(sql, false));
    expect(error.code).toBe('X_MCP_QUERY_REJECTED');
    expect(error.fix).toContain('db.explain({ sql:');
  });
});

describe('explainStatement answers the EXPLAIN it will send', () => {
  test('a SELECT is planned without executing unless analyze is asked', () => {
    expect(explainStatement('select id from posts;', false)).toBe(
      'EXPLAIN (FORMAT JSON) select id from posts',
    );
    expect(explainStatement('select id from posts', true)).toBe(
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) select id from posts',
    );
  });

  test('a read-only WITH … SELECT is planned verbatim', () => {
    const sql = 'with recent as (select id from posts limit 5) select * from recent';
    expect(explainStatement(sql, true)).toBe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
  });

  test('a literal that looks like a write is data, kept byte for byte', () => {
    const sql = "select 'delete from posts' as note";
    expect(explainStatement(sql, true)).toEndWith(sql);
  });
});

describe('planOf', () => {
  test('reads a plan handed back as text or as parsed JSON, and leaves anything else alone', () => {
    expect(planOf('[{"Plan":{"Node Type":"Seq Scan"}}]')).toEqual([
      { Plan: { 'Node Type': 'Seq Scan' } },
    ]);
    expect(planOf([{ Plan: {} }])).toEqual([{ Plan: {} }]);
    expect(planOf('not json')).toBe('not json');
  });
});
