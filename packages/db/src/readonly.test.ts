import { beforeEach, describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient } from './fake';
import { inspectStatement, readOnly } from './readonly';
import { sql } from './sql';
import { stripSqlNoise } from './sql-noise';

let client: RecordingClient;

beforeEach(() => {
  client = createRecordingClient();
});

const reject = async (fragment: ReturnType<typeof sql>): Promise<{ code: string; fix: string }> => {
  try {
    await readOnly(client, { seal: false }).query(fragment);
  } catch (error) {
    return error as { code: string; fix: string };
  }
  throw new Error('expected X_READONLY_VIOLATION');
};

describe('readOnly', () => {
  test('an UPDATE is rejected with X_READONLY_VIOLATION', async () => {
    const error = await reject(sql`UPDATE posts SET title = ${'x'}`);
    expect(error.code).toBe('X_READONLY_VIOLATION');
    expect(error.fix).toContain('use db() instead of readOnly(db())');
  });

  test('a WITH ... INSERT CTE is rejected', async () => {
    const error = await reject(
      sql`WITH moved AS (INSERT INTO archive SELECT * FROM posts RETURNING id) SELECT * FROM moved`,
    );
    expect(error.code).toBe('X_READONLY_VIOLATION');
  });

  test('lowercase and comment-prefixed variants do not slip through', async () => {
    expect((await reject(sql`delete from posts`)).code).toBe('X_READONLY_VIOLATION');
    expect((await reject(sql`  /* harmless */ drop table posts`)).code).toBe(
      'X_READONLY_VIOLATION',
    );
    expect((await reject(sql`-- select 1\ntruncate posts`)).code).toBe('X_READONLY_VIOLATION');
  });

  test('a second statement smuggled after a SELECT is rejected', async () => {
    expect((await reject(sql`select 1; drop table posts`)).code).toBe('X_READONLY_VIOLATION');
  });

  test('the full mutating keyword set is covered', () => {
    for (const statement of [
      'insert into t values (1)',
      'update t set a = 1',
      'delete from t',
      'truncate t',
      'drop table t',
      'alter table t add column a text',
      'create index i on t (a)',
      'grant select on t to r',
      'revoke select on t from r',
      "copy t from '/tmp/x'",
      'set statement_timeout = 0',
      'call do_something()',
      'do $$ begin end $$',
      'refresh materialized view v',
      'vacuum t',
    ]) {
      expect(inspectStatement(statement).mutating).toBe(true);
    }
  });

  test('a SELECT passes through to the wrapped client', async () => {
    client.on('select', { rows: [{ id: 'p1' }] });
    const rows = await readOnly(client, { seal: false }).query<{ id: string }>(
      sql`select id from posts where org_id = ${'org_1'}`,
    );
    expect(rows).toEqual([{ id: 'p1' }]);
    expect(client.texts).toEqual(['select id from posts where org_id = $1']);
  });

  test('read-ish words inside identifiers and literals are not mutations', () => {
    expect(inspectStatement('select updated_at, offset_ms from posts').mutating).toBe(false);
    expect(inspectStatement("select * from posts where body = 'drop table posts'").mutating).toBe(
      false,
    );
    expect(inspectStatement('select "insert" from posts').mutating).toBe(false);
    expect(stripSqlNoise("select 'delete'")).not.toContain('delete');
  });

  test('SET TRANSACTION READ ONLY is issued as a backstop before the first read', async () => {
    const guarded = readOnly(client);
    await guarded.query(sql`select 1`);
    await guarded.query(sql`select 2`);
    expect(client.texts).toEqual(['SET TRANSACTION READ ONLY', 'select 1', 'select 2']);
  });
});
