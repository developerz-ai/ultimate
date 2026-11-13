// The `repo-raw-sql` guard as `x new` emits it, run through the gate's own seam.
// It refuses the statement it names — with the file, the line and the handle call to write — and
// stays silent on a statement the handle cannot say. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const REPO = 'apps/web/app/post/repo.ts';

/** An interpolation as SOURCE TEXT, spelled apart so this file holds no placeholder of its own. */
const hole = (name: string): string => ['$', '{', name, '}'].join('');

describe('unit · shipped guard · repo-raw-sql', () => {
  test('a select the handle can express is X_REPO_RAW_SQL, with the call to write', async () => {
    const findings = await shippedGuardFindings('repo-raw-sql', {
      [REPO]: [
        "import { db, sql } from '@ultimat3/db';",
        'export const listByOrg = (orgId: string, limit = 50) =>',
        '  db().query(',
        `    sql\`select * from posts where org_id = ${hole('orgId')} order by created_at desc limit ${hole('limit')}\`,`,
        '  );',
        '',
      ].join('\n'),
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_REPO_RAW_SQL']);
    expect(findings[0]?.at).toBe(`${REPO}:4`);
    expect(findings[0]?.fix).toStartWith(
      "db.posts.where({ orgId }).orderBy('createdAt', 'desc').limit(limit).all() — ",
    );
  });

  test('a row locked by its id names db.<table>.lock, where the guard used to be silent', async () => {
    const findings = await shippedGuardFindings('repo-raw-sql', {
      [REPO]: [
        "import { db, sql } from '@ultimat3/db';",
        'export const lockPost = (id: string) =>',
        `  db().one(sql\`select * from posts where id = ${hole('id')} for update\`);`,
        '',
      ].join('\n'),
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_REPO_RAW_SQL']);
    expect(findings[0]?.at).toBe(`${REPO}:3`);
    expect(findings[0]?.fix).toStartWith('db.posts.lock(id, fn) — ');
  });

  test('another lock mode and a lock with no id are past what the handle says', async () => {
    for (const statement of [
      'select * from jobs where state = ? for update skip locked',
      'select * from posts where id = ? for no key update',
      'select * from posts where org_id = ? for update',
    ]) {
      const source = `export const q = sql\`${statement}\`;\n`;
      expect(await shippedGuardFindings('repo-raw-sql', { [REPO]: source })).toEqual([]);
    }
  });

  test('a join, the handle itself and a comment naming sql are silent', async () => {
    const findings = await shippedGuardFindings('repo-raw-sql', {
      [REPO]: [
        `// It was: sql\`delete from posts where id = ${hole('id')}\``,
        "// Only this file and a query's `sql` may touch `db`.",
        "import { db as raw, sql } from '@ultimat3/db';",
        "import { db } from '@app/db';",
        `export const byId = (id: string) => db.posts.where({ id }).one();`,
        'export const withAuthor = (id: string) =>',
        `  raw().one(sql\`select p.*, m.name from posts p join members m on m.id = p.author_id where p.id = ${hole('id')}\`);`,
        '',
      ].join('\n'),
    });
    expect(findings).toEqual([]);
  });

  test('a millisecond-truncated order names keyset(), whose seek keeps the index', async () => {
    const findings = await shippedGuardFindings('repo-raw-sql', {
      [REPO]: [
        "import { db, sql } from '@ultimat3/db';",
        'export const feed = (orgId: string) =>',
        '  db().query(',
        `    sql\`select p.*, m.name from posts p join members m on m.id = p.author_id where p.org_id = ${hole('orgId')} order by date_trunc('milliseconds', p.created_at) desc, p.id desc\`,`,
        '  );',
        '',
      ].join('\n'),
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_REPO_RAW_SQL']);
    expect(findings[0]?.at).toBe(`${REPO}:4`);
    expect(findings[0]?.fix).toStartWith('keyset({ scope, keys: [');
    expect(findings[0]?.cause).toContain('Seq Scan');
  });

  test('a truncated order in a comment, or in a predicate only, is silent', async () => {
    const findings = await shippedGuardFindings('repo-raw-sql', {
      [REPO]: [
        "// It was: sql`select p.* from posts p order by date_trunc('milliseconds', p.created_at) desc`",
        `export const q = sql\`select p.* from posts p join members m on m.id = p.author_id -- order by date_trunc('milliseconds', p.created_at)\nwhere date_trunc('day', p.created_at) = ${hole('day')} order by p.created_at desc\`;`,
        '',
      ].join('\n'),
    });
    expect(findings).toEqual([]);
  });

  // A keyset page written by hand: the row comparison is the seek `keyset()` builds, with its
  // tie-break, its direction and the cursor's codec — and the one detail a hand copy gets wrong.
  test('a hand row-comparison names keyset(), in a join or not', async () => {
    for (const statement of [
      `select * from posts where org_id = ${hole('org')} and (created_at, id) < (${hole('at')}, ${hole('id')}) order by created_at desc, id desc limit 20`,
      `select p.* from posts p join members m on m.id = p.author_id where (p.created_at, p.id) > (${hole('at')}, ${hole('id')})`,
    ]) {
      const findings = await shippedGuardFindings('repo-raw-sql', {
        [REPO]: `export const page = sql\`${statement}\`;\n`,
      });
      expect([statement, findings.map((finding) => finding.code)]).toEqual([
        statement,
        ['X_REPO_RAW_SQL'],
      ]);
      expect(findings[0]?.fix).toStartWith('keyset({ scope, keys: [');
      expect(findings[0]?.cause).toContain('row comparison');
    }
  });

  test('a pg_advisory_xact_lock literal names lockKeys, the ordered set of keys', async () => {
    const findings = await shippedGuardFindings('repo-raw-sql', {
      [REPO]: [
        "import { db, sql } from '@ultimat3/db';",
        'export const hold = (key: string) =>',
        `  db().query(sql\`select pg_advisory_xact_lock(hashtext(${hole('key')}))\`);`,
        '',
      ].join('\n'),
    });
    expect(findings.map((finding) => finding.code)).toEqual(['X_REPO_RAW_SQL']);
    expect(findings[0]?.at).toBe(`${REPO}:3`);
    expect(findings[0]?.fix).toStartWith('db.<table>.lockKeys([key], async (tx) => …) — ');
  });

  // The two lookalikes the new shapes must not catch: the words inside a quoted literal are data,
  // and a range on two separate columns is a filter, not a row comparison.
  test('a quoted literal and a plain range predicate are not those shapes', async () => {
    for (const statement of [
      "select p.* from posts p join notes n on n.post_id = p.id where n.body = '(a, b) < (c, d)'",
      "select p.* from posts p join notes n on n.post_id = p.id where n.body = 'pg_advisory_xact_lock(1)'",
      `select p.* from posts p join likes l on l.post_id = p.id where p.created_at < ${hole('at')} and (p.id < ${hole('id')})`,
    ]) {
      const source = `export const q = sql\`${statement}\`;\n`;
      expect([statement, await shippedGuardFindings('repo-raw-sql', { [REPO]: source })]).toEqual([
        statement,
        [],
      ]);
    }
  });

  // A literal is not a binding: `.where({ status })` names a variable the caller never declared.
  test('a quoted literal in a where the handle expresses is spliced as its value', async () => {
    const findings = await shippedGuardFindings('repo-raw-sql', {
      [REPO]: `export const q = sql\`select * from posts where status = 'published' and org_id = ${hole('org')} and rank >= 3\`;\n`,
    });
    expect(findings[0]?.fix).toStartWith(
      "db.posts.where({ status: 'published', orgId }).andWhere('rank', 'gte', 3).all() — ",
    );
  });

  // `deleteWhere` takes equalities only, so naming it for a range would advise a wider write. The
  // adopters' copies silenced ranges for that reason; the chain's `deleteAll()` keeps the range.
  test('a range in a delete names the chain write, never deleteWhere', async () => {
    const findings = await shippedGuardFindings('repo-raw-sql', {
      [REPO]: `export const q = sql\`delete from run_logs where run_id = ${hole('run')} and seq <= ${hole('seq')}\`;\n`,
    });
    expect(findings[0]?.fix).toStartWith(
      "db.runLogs.where({ runId }).andWhere('seq', 'lte', value).deleteAll() — ",
    );
  });

  test('only a repo.ts is read: the same statement in a query source is not this rule', async () => {
    const statement = `export const q = sql\`select * from posts where id = ${hole('id')}\`;\n`;
    expect(
      await shippedGuardFindings('repo-raw-sql', { 'apps/web/app/post/live/feed.ts': statement }),
    ).toEqual([]);
    expect(
      await shippedGuardFindings('repo-raw-sql', { 'apps/web/app/post/repo.ts': statement }),
    ).toHaveLength(1);
  });

  // A repo split at the file ceiling is still the repo: `repo-window.ts` beside `repo.ts`.
  test('a repo-<part>.ts is read too; a repository.ts or report.ts is not', async () => {
    const statement = `export const q = sql\`select * from posts where id = ${hole('id')}\`;\n`;
    const at = (name: string) =>
      shippedGuardFindings('repo-raw-sql', { [`apps/web/app/post/${name}`]: statement });
    expect(await at('repo-window.ts')).toHaveLength(1);
    expect(await at('repository.ts')).toEqual([]);
    expect(await at('report.ts')).toEqual([]);
    // The glob reaches `repo-join.test.ts` too, and a test's fixture SQL is not the repo's.
    expect(await at('repo-join.test.ts')).toEqual([]);
  });
});
