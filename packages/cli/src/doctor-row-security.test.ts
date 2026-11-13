import { describe, expect, test } from 'bun:test';
import { ROW_SECURITY_OFF, rawTenantSql, rowSecurityOffFindings } from './doctor-row-security';

const TENANT = new Set(['posts', 'members']);
const scan = (source: string) => rawTenantSql('apps/web/app/posts/repo.ts', source, TENANT);

describe('unit · raw tenant sql', () => {
  test('a raw sql template naming a tenant table is found, at its line', () => {
    const source =
      "import { sql } from '@ultimat3/db';\nconst q = sql`select * from posts where id = 1`;";
    expect(scan(source)).toEqual([{ at: 'apps/web/app/posts/repo.ts:2', table: 'posts' }]);
  });

  test('joins, writes and quoted or schema-qualified names are found, once per table', () => {
    const source =
      'sql`update "public"."posts" set x = 1 from members m join posts p on true; insert into posts values (1)`';
    expect(scan(source).map((hit) => hit.table)).toEqual(['posts', 'members']);
  });

  test('a table no tenant declares, a comment and a quoted string are not raw tenant sql', () => {
    expect(scan('sql`select * from audit_log`')).toEqual([]);
    expect(scan('// sql`select * from posts`')).toEqual([]);
    expect(scan("const s = 'sql`select * from posts`';")).toEqual([]);
    // A longer name ending in sql is not the tag; Bun's own and a handle's `.sql` are.
    expect(scan('mysql`select * from posts`')).toEqual([]);
    expect(scan('Bun.sql`select * from posts`').map((hit) => hit.table)).toEqual(['posts']);
  });

  test('a transaction handle, a comma join and delete … using are raw tenant sql', () => {
    expect(scan('tx.sql`select * from posts`').map((hit) => hit.table)).toEqual(['posts']);
    expect(scan('sql`select * from orgs o, posts p where true`').map((hit) => hit.table)).toEqual([
      'posts',
    ]);
    expect(scan('sql`select * from orgs, "public"."members"`').map((hit) => hit.table)).toEqual([
      'members',
    ]);
    expect(scan('sql`delete from audit using posts where true`').map((hit) => hit.table)).toEqual([
      'posts',
    ]);
    // A comma inside a SET list or a column list names no table.
    expect(scan('sql`update audit set a = 1, posts = 2`')).toEqual([]);
    expect(scan('sql`insert into audit (a, posts) values (1, 2)`')).toEqual([]);
  });

  test('raw("…") and identifier("…") naming a tenant table are found, at their line', () => {
    expect(scan('const q = raw("select * from posts");')).toEqual([
      { at: 'apps/web/app/posts/repo.ts:1', table: 'posts' },
    ]);
    expect(scan(`\nsql\`select * from \${identifier('members')}\``)).toEqual([
      { at: 'apps/web/app/posts/repo.ts:2', table: 'members' },
    ]);
    expect(scan("identifier('audit'); draw('posts'); x.raw('from posts')")).toEqual([]);
  });
});

describe('unit · row security off', () => {
  const touches = [{ at: 'apps/web/app/posts/repo.ts:2', table: 'posts' }];

  test('off, with raw sql on a tenant table, is reported with the edit that turns it on', () => {
    const [finding] = rowSecurityOffFindings({ declared: false, touches });
    expect(finding?.code).toBe(ROW_SECURITY_OFF);
    expect(finding?.cause).toContain('apps/web/app/posts/repo.ts:2 (posts)');
    expect(finding?.fix).toContain('database: { rowSecurity: true }');
  });

  test('on, or off with nothing raw riding on it, is not', () => {
    expect(rowSecurityOffFindings({ declared: true, touches })).toEqual([]);
    expect(rowSecurityOffFindings({ declared: false, touches: [] })).toEqual([]);
  });
});
