// Single responsibility: pin `isPlainRead`'s bias. Every case here is chosen so that being wrong
// costs a replica opportunity and never an answer — the inversion that separates this from the
// `readonly.ts` deny-list this package deleted, whose default was permission.

import { describe, expect, test } from 'bun:test';
import { isPlainRead } from './replica-route';
import { statementKind } from './statement-shape';

describe('isPlainRead', () => {
  test('a plain select, a table and a values list are reads', () => {
    expect(isPlainRead('select id from posts where org_id = $1')).toBe(true);
    expect(isPlainRead('SELECT 1')).toBe(true);
    expect(isPlainRead('table posts')).toBe(true);
    expect(isPlainRead('values (1), (2)')).toBe(true);
  });

  test('a CTE that only reads is a read; a CTE that writes is not', () => {
    expect(isPlainRead('with recent as (select id from posts limit 10) select * from recent')).toBe(
      true,
    );
    const writingCte =
      'with done as (update posts set seen = true returning id) select * from done';
    expect(isPlainRead(writingCte)).toBe(false);
    // The reason this function exists rather than `statementKind`: that one calls the same text a
    // read, which is correct for an N+1 report and catastrophic for a routing decision.
    expect(statementKind(writingCte)).toBe('read');
  });

  test('every write verb is refused', () => {
    for (const text of [
      'insert into posts (id) values ($1)',
      'update posts set x = 1',
      'delete from posts',
      'merge into posts using src on true',
      'truncate posts',
      'copy posts from stdin',
      'create table t (id int)',
      'drop table t',
      'alter table t add column c int',
      'begin',
      'commit',
      'rollback',
    ]) {
      expect(isPlainRead(text)).toBe(false);
    }
  });

  test('a locking read stays on the primary — a standby cannot take the row lock', () => {
    expect(isPlainRead('select * from posts where id = $1 for update')).toBe(false);
    expect(isPlainRead('select * from posts for no key update')).toBe(false);
    expect(isPlainRead('select * from posts for share')).toBe(false);
    expect(isPlainRead('select * from posts for key share')).toBe(false);
  });

  test('`select … into` creates a table, so it is not a read', () => {
    expect(isPlainRead('select * into archive from posts')).toBe(false);
  });

  test('a function a word boundary cannot reach is refused by name', () => {
    // A standby answers these instead of refusing them, so the server cannot be the safety net:
    // `pg_advisory_lock` on a replica takes the lock on the wrong server and nothing says so.
    expect(isPlainRead('select pg_advisory_lock(1)')).toBe(false);
    expect(isPlainRead('select pg_try_advisory_lock(1)')).toBe(false);
    expect(isPlainRead("select set_config('x', 'y', false)")).toBe(false);
    expect(isPlainRead("select nextval('posts_id_seq')")).toBe(false);
    expect(isPlainRead("select setval('posts_id_seq', 1)")).toBe(false);
    expect(isPlainRead("select * from dblink('conn', 'select 1') as t(x int)")).toBe(false);
  });

  test('a false positive costs a read, never an answer', () => {
    // `'update'` is a literal here and nothing is being written. The statement goes to the primary
    // anyway: blanking every statement on the hot path to buy this one read back is a cost axiom 6
    // refuses, and the mistake is on the side that cannot be wrong.
    expect(isPlainRead("select id from posts where status = 'update'")).toBe(false);
    // But a column that merely CONTAINS a keyword is not a keyword — no word boundary, no match.
    expect(isPlainRead('select updated_at, settings, todos from posts')).toBe(true);
  });

  test('a statement with no verb at all is refused', () => {
    expect(isPlainRead('/* a comment first */ select 1')).toBe(false);
    expect(isPlainRead('')).toBe(false);
  });
});
