// The `repo-await-in-loop` guard as `x new` would emit it, run through the gate's own seam: an
// `await` in a loop body or an element callback in a repo is refused at its line, naming the loop
// and the one-statement call; a loop under `expectedQueryLoop`, a non-repo file and a test are silent.

import { describe, expect, test } from 'bun:test';
import { repoAwaitInLoopGuardFiles } from './guard-repo-await-in-loop';
import { shippedGuardFindings, shippedGuardReport } from './shipped-guard-fixture';

const REPO = 'apps/web/app/posts/repo.ts';
const HIT = 'for (const id of ids) await db.posts.delete(id);\n';
const run = (files: Readonly<Record<string, string>>) =>
  shippedGuardFindings('repo-await-in-loop', files);

describe('unit · shipped guard · repo-await-in-loop', () => {
  test('an await per turn of a for, a while and a .map is X_REPO_AWAIT_IN_LOOP at its line', async () => {
    const findings = await run({
      [REPO]: [
        "import { db } from '@app/db';",
        'export const touch = async (ids: readonly string[]) => {',
        '  for (const id of ids) {',
        "    await db.posts.update(id, { title: 'x' });",
        '  }',
        '  while (await db.jobs.claim()) {}',
        '  return ids.map(async (id) => await db.posts.byId(id));',
        '};',
        '',
      ].join('\n'),
      'packages/domain/src/repo-split.ts':
        'export const drop = async (ids: string[]) => { for (const id of ids) await tx.x.delete(id); };\n',
    });
    expect(findings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_REPO_AWAIT_IN_LOOP', `${REPO}:4`],
      ['X_REPO_AWAIT_IN_LOOP', `${REPO}:6`],
      ['X_REPO_AWAIT_IN_LOOP', `${REPO}:7`],
      ['X_REPO_AWAIT_IN_LOOP', 'packages/domain/src/repo-split.ts:1'],
    ]);
    expect(findings[0]?.cause).toContain(`the for at ${REPO}:3`);
    expect(findings[2]?.cause).toContain(`the .map at ${REPO}:7`);
    expect(findings[0]?.fix).toContain("expectedQueryLoop('<why one per element is optimal>', fn)");
  });

  test('a declared loop, an await before the loop, a comment, a service and a test are silent', async () => {
    const loop = 'for (const id of ids) await db.posts.delete(id);\n';
    const findings = await run({
      [REPO]: [
        "export const search = (term: string) => expectedQueryLoop('one lookup per field', async () => {",
        '  for (const field of FIELDS) await db.posts.where({ [field]: term }).limit(5).all();',
        '});',
        'export const sum = async () => {',
        '  const rows = await db.posts.limit(10).all();',
        '  for (const row of rows) total += row.n;',
        '};',
        `// ${loop}`,
      ].join('\n'),
      'apps/web/app/posts/service.ts': loop,
      'apps/web/app/posts/repo.test.ts': loop,
    });
    expect(findings).toEqual([]);
  });

  test('it is report only: a hit is a warning on the step, never a failure', async () => {
    const report = await shippedGuardReport('repo-await-in-loop', { [REPO]: HIT });
    expect(report.findings).toEqual([]);
    expect(report.warnings.map((finding) => finding.at)).toEqual([`${REPO}:1`]);
    const rule = repoAwaitInLoopGuardFiles().find(
      (file) => file.path === 'guards/repo-await-in-loop.ts',
    );
    expect(String(rule?.contents)).toContain("severity: 'warning',");
  });
});
