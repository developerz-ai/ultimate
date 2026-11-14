// The `repo-unbounded` guard as `x new` would emit it, run through the gate's own seam: a handle
// chain in a repo ending in `.all()` with no `.limit(n)` is refused at the chain's first line with
// the bounded call to write; a limit, a `.one()`, a `// why:`, a service and a test are silent.
// A new app gets it as an error; the report-only form apps scaffolded before 31.23 hold stays.

import { describe, expect, test } from 'bun:test';
import { repoUnboundedGuardFiles } from './guard-repo-unbounded';
import { shippedGuardFindings, shippedGuardReport } from './shipped-guard-fixture';

const REPO = 'apps/web/app/posts/repo.ts';
const HIT = 'export const every = () => db.tags.all();\n';
const run = (files: Readonly<Record<string, string>>) =>
  shippedGuardFindings('repo-unbounded', files);

describe('unit · shipped guard · repo-unbounded', () => {
  test('a db or tx chain ending in a bare .all() is X_REPO_UNBOUNDED, naming .limit', async () => {
    const findings = await run({
      [REPO]: [
        "import { db } from '@app/db';",
        'export const mine = (orgId: string) =>',
        '  db.posts',
        '    .where({ orgId })',
        "    .orderBy('id')",
        '    .all();',
        'export const every = () => db.tags.all();',
        '',
      ].join('\n'),
      'packages/domain/src/repo-split.ts':
        'export const kids = (postId: string) => tx.comments.where({ postId }).all();\n',
    });
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_REPO_UNBOUNDED', `${REPO}:3`],
      ['X_REPO_UNBOUNDED', `${REPO}:7`],
      ['X_REPO_UNBOUNDED', 'packages/domain/src/repo-split.ts:1'],
    ]);
    expect(findings[0]?.cause).toContain('50 rows');
    expect(findings[0]?.fix).toStartWith(
      'db.posts….limit(<the most rows this caller needs>).all()',
    );
  });

  test('a bound, a one(), a why:, Promise.all, a comment, a service and a test are silent', async () => {
    const bare = 'export const every = () => db.tags.all();\n';
    const findings = await run({
      [REPO]: [
        'export const page = (limit: number) => db.posts.orderBy("id").limit(limit).all();',
        'export const one = (id: string) => db.posts.where({ id }).one();',
        '// why: the four plans the catalog seeds',
        'export const plans = () => db.plans.all();',
        'export const each = (ids: string[]) => Promise.all(ids.map((id) => db.posts.byId(id)));',
        `// ${bare}`,
      ].join('\n'),
      'apps/web/app/posts/service.ts': bare,
      'apps/web/app/posts/repo.test.ts': bare,
    });
    expect(findings).toEqual([]);
  });

  test('a new app refuses: x new and x g guard write it as an error on the step', async () => {
    const report = await shippedGuardReport('repo-unbounded', { [REPO]: HIT });
    expect(report.warnings).toEqual([]);
    expect(report.findings.map((finding) => finding.at)).toEqual([`${REPO}:1`]);
    const rule = repoUnboundedGuardFiles().find((file) => file.path === 'guards/repo-unbounded.ts');
    // `severity` absent IS the error: 'warning' is the only value a guard may export (`guards.ts`).
    expect(String(rule?.contents)).not.toContain('severity');
  });

  test('the report-only form an existing app holds is still one template away', () => {
    const rule = repoUnboundedGuardFiles('warning').find(
      (file) => file.path === 'guards/repo-unbounded.ts',
    );
    expect(String(rule?.contents)).toContain("severity: 'warning',");
    expect(String(rule?.contents)).toContain('REPORT ONLY');
  });
});
