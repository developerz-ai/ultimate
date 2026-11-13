// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { awaitsInLoops } from './repo-await-in-loop';

const REPO = 'apps/web/app/posts/repo.ts';
const repo = (...lines: readonly string[]) => [{ path: REPO, source: lines.join('\n') }];

unitTest('an await in a for body is refused at its line, naming the loop', () => {
  const findings = awaitsInLoops(
    repo(
      'export const touch = async (ids: string[]) => {',
      '  for (const id of ids) {',
      '    await db.posts.update(id, { seen: true });',
      '  }',
      '};',
    ),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_REPO_AWAIT_IN_LOOP');
  expect(findings[0]?.at).toBe(`${REPO}:3`);
  expect(findings[0]?.cause).toContain(`the for at ${REPO}:2`);
  expect(findings[0]?.fix).toStartWith(
    "db.<table>.andWhere('id', 'in', ids).limit(ids.length).all()",
  );
});

unitTest('a while condition, a do body, a brace-less for and a callback are the same rule', () => {
  expect(awaitsInLoops(repo('while (await db.jobs.claim()) count += 1;'))).toHaveLength(1);
  expect(
    awaitsInLoops(repo('do {', '  row = await db.jobs.next();', '} while (row);')),
  ).toHaveLength(1);
  expect(awaitsInLoops(repo('for (const id of ids) await db.posts.delete(id);'))).toHaveLength(1);
  const each = repo('ids.forEach(async (id) => {', '  await db.posts.delete(id);', '});');
  expect(awaitsInLoops(each)[0]?.cause).toContain('the .forEach at');
  expect(
    awaitsInLoops(repo('rows.map(async (row) => await db.tags.byId(row.tagId));')),
  ).toHaveLength(1);
});

unitTest('one finding per loop, at the innermost loop holding the await', () => {
  const nested = repo(
    'for (const a of as) {',
    '  for (const b of bs) {',
    '    await db.x.insert({ a, b });',
    '    await db.y.insert({ a, b });',
    '  }',
    '}',
  );
  const findings = awaitsInLoops(nested);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.cause).toContain(`the for at ${REPO}:2`);
});

unitTest(
  'a loop under expectedQueryLoop, an await outside the loop and a for-await header are silent',
  () => {
    const declared = repo(
      "expectedQueryLoop('one indexed lookup per field', async () => {",
      '  for (const f of fields) await db.posts.where({ [f]: term }).limit(5).all();',
      '});',
    );
    expect(awaitsInLoops(declared)).toEqual([]);
    expect(
      awaitsInLoops(
        repo(
          'const rows = await db.posts.limit(10).all();',
          'for (const row of rows) total += row.n;',
        ),
      ),
    ).toEqual([]);
    expect(awaitsInLoops(repo('await Promise.all(ids.map((id) => id.trim()));'))).toEqual([]);
    expect(awaitsInLoops(repo('for await (const row of stream) total += row.n;'))).toEqual([]);
  },
);

unitTest('a comment and a string naming the shape are not code', () => {
  expect(awaitsInLoops(repo('// for (const id of ids) await db.x.delete(id);'))).toEqual([]);
  expect(awaitsInLoops(repo("const s = 'for (const id of ids) await db.x.delete(id)';"))).toEqual(
    [],
  );
});
