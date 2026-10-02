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

  test('only a repo.ts is read: the same statement in a query source is not this rule', async () => {
    const statement = `export const q = sql\`select * from posts where id = ${hole('id')}\`;\n`;
    expect(
      await shippedGuardFindings('repo-raw-sql', { 'apps/web/app/post/live/feed.ts': statement }),
    ).toEqual([]);
    expect(
      await shippedGuardFindings('repo-raw-sql', { 'apps/web/app/post/repo.ts': statement }),
    ).toHaveLength(1);
  });
});
