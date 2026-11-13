// The test `x new` writes beside the `repo-unbounded` guard: the rule's own cases, run in the app.
// Split from `guard-repo-unbounded.ts` at the file target; the code is handed in, never restated.

export const repoUnboundedTest = (
  code: string,
): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { unboundedReads } from './repo-unbounded';

const REPO = 'apps/web/app/posts/repo.ts';
const repo = (...lines: readonly string[]) => [{ path: REPO, source: lines.join('\\n') }];

unitTest('a handle read ending in .all() with no limit is refused at its first line', () => {
  const findings = unboundedReads(
    repo(
      '// the typed handle, imported from this app db package',
      'export const mine = (orgId: string) =>',
      '  db.posts',
      '    .where({ orgId })',
      "    .orderBy('id')",
      '    .all();',
    ),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${code}');
  expect(findings[0]?.at).toBe(\`\${REPO}:3\`);
  expect(findings[0]?.cause).toContain('reads db.posts with .all()');
  expect(findings[0]?.fix).toStartWith('db.posts….limit(<the most rows this caller needs>).all()');
});

unitTest('a bare table, a tx, ctx.db and an optional chain are the same rule', () => {
  expect(unboundedReads(repo('const all = await db.posts.all();'))).toHaveLength(1);
  expect(unboundedReads(repo('await tx.comments.where({ postId }).all();'))).toHaveLength(1);
  expect(unboundedReads(repo('ctx.db.tags.orderBy("name").all();'))[0]?.cause).toContain('db.tags');
  expect(unboundedReads(repo('db.tags.where({ a })?.all();'))).toHaveLength(1);
});

unitTest('a limit, a one, a why:, Promise.all and a chain off no handle are silent', () => {
  expect(unboundedReads(repo('db.posts.where({ orgId }).limit(limit).all();'))).toEqual([]);
  expect(unboundedReads(repo('db.posts.where({ id }).one();'))).toEqual([]);
  expect(
    unboundedReads(repo('// why: at most the four plans the catalog seeds', 'db.plans.all();')),
  ).toEqual([]);
  expect(unboundedReads(repo('await Promise.all(ids.map((id) => db.posts.byId(id)));'))).toEqual(
    [],
  );
  expect(unboundedReads(repo('query.all();', 'rows.all();'))).toEqual([]);
});

unitTest('a comment and a string naming the shape are not code', () => {
  expect(unboundedReads(repo('// db.posts.all()'))).toEqual([]);
  expect(unboundedReads(repo("const s = 'db.posts.all()';"))).toEqual([]);
});
`;
