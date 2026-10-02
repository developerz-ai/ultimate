// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { handleCallFor, rawRepoSql, sqlStatements } from './repo-raw-sql';

const REPO = 'apps/web/app/post/repo.ts';
const repo = (source: string) => [{ path: REPO, source }];

/** An interpolation as SOURCE TEXT, spelled apart so this file holds no placeholder of its own. */
const hole = (name: string): string => ['$', '{', name, '}'].join('');

unitTest('a select the handle can express is refused, naming the call', () => {
  const source = [
    "import { db, sql } from '@ultimat3/db';",
    'export const byId = (id: string) =>',
    `  db().one(sql\`select * from posts where id = ${hole('id')}\`);`,
    '',
  ].join('\n');
  const findings = rawRepoSql(repo(source));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_REPO_RAW_SQL');
  expect(findings[0]?.at).toBe(`${REPO}:3`);
  expect(findings[0]?.fix).toStartWith('db.posts.where({ id }).one() — ');
});

unitTest('a page reads as the chain that pages it', () => {
  const page = 'select * from posts where org_id = ? order by created_at desc limit ?';
  expect(handleCallFor(page)).toBe(
    "db.posts.where({ orgId }).orderBy('createdAt', 'desc').limit(limit).all()",
  );
  const open = 'SELECT * FROM posts WHERE deleted_at IS NULL AND created_at >= ? LIMIT 10;';
  expect(handleCallFor(open)).toBe(
    "db.posts.andWhere('deletedAt', 'is-null').andWhere('createdAt', 'gte', value).limit(10).all()",
  );
});

unitTest('insert, update and delete on one table are the same rule', () => {
  const insert = 'insert into short_links (id, url)\n  values (?, ?)\n  returning *';
  expect(handleCallFor(insert)).toBe('db.shortLinks.insert({ … })');
  expect(handleCallFor('update posts set title = ? where id = ?')).toBe(
    'db.posts.update(id, { … })',
  );
  expect(handleCallFor('update posts set title = ? where org_id = ? and slug = ?')).toBe(
    'db.posts.updateWhere({ … }, { … })',
  );
  expect(handleCallFor('delete from posts where id = ?')).toBe('db.posts.delete(id)');
  expect(handleCallFor('delete from likes where post_id = ? and user_id = ?')).toBe(
    'db.likes.deleteWhere({ … })',
  );
});

// The legitimate lookalikes — the reason the rule can stay switched on. Each is a statement the
// handle has no word for, and raw SQL in a repo is the right answer for it.
unitTest('a statement past what the handle says is silent', () => {
  const silent = [
    'select p.*, m.name from posts p join members m on m.id = p.author_id',
    'select count(*) from posts where org_id = ?',
    'select id, title from posts where org_id = ?',
    'select * from posts where lower(title) = ?',
    'select * from posts where slug = ? or id = ?',
    'with recent as (select * from posts) select * from recent',
    'update posts set like_count = like_count + 1 where id = ?',
    'insert into likes (post_id, user_id) values (?, ?) on conflict do nothing',
  ];
  for (const sql of silent) expect(handleCallFor(sql)).toBeUndefined();
});

unitTest('a statement composed from another fragment is silent', () => {
  const inner = `sql\`and a = ${hole('a')}\``;
  const source = `const rows = sql\`select * from posts where id = ${hole('id')} ${hole(inner)}\`;`;
  expect(sqlStatements(source)).toHaveLength(1);
  expect(rawRepoSql(repo(source))).toEqual([]);
});

unitTest('a comment, a string and an untagged template are not statements', () => {
  const source = [
    "// Only this file and a query's `sql` may touch `db`.",
    `/* sql\`delete from posts where id = ${hole('id')}\` */`,
    "const note = 'sql`select * from posts`';",
    'const text = `select * from posts`;',
    '',
  ].join('\n');
  expect(sqlStatements(source)).toEqual([]);
  expect(rawRepoSql(repo(source))).toEqual([]);
});
