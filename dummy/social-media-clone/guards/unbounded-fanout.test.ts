// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { readsFile, unboundedFanouts } from './unbounded-fanout';

const file = (source: string) => [{ path: 'apps/web/app/posts/service.ts', source }];

unitTest('a database call per row, all at once, is refused at its line', () => {
  const source =
    'const a = 1;\nawait Promise.all(rows.map(async (row) => db.posts.update(row.id, row)));';
  const findings = unboundedFanouts(file(source));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_UNBOUNDED_FANOUT');
  expect(findings[0]?.at).toBe('apps/web/app/posts/service.ts:2');
  expect(findings[0]?.fix).toStartWith('mapBounded(rows, <the same async callback>, { width: 8 })');
});

unitTest('allSettled, a tx, a repo and a chained list are the same rule', () => {
  const settled = 'Promise.allSettled(ids.map(async (id) => tx.posts.delete(id)));';
  expect(unboundedFanouts(file(settled))).toHaveLength(1);
  const chained =
    'Promise.all(\n  rows\n    .filter((row) => row.ok)\n    .map(async (row) => repo.byId(row.id)),\n);';
  expect(unboundedFanouts(file(chained))[0]?.cause).toContain('rows .filter((row) => row.ok)');
});

unitTest('an array literal, a map with no database call and a why: are not refused', () => {
  const literal = 'Promise.all([a, b].map(async (one) => db.posts.byId(one)));';
  expect(unboundedFanouts(file(literal))).toEqual([]);
  expect(unboundedFanouts(file('Promise.all(urls.map(async (url) => hash(url)));'))).toEqual([]);
  const why = '// why: at most three locales\nPromise.all(locales.map(async (l) => db.t.byId(l)));';
  expect(unboundedFanouts(file(why))).toEqual([]);
});

unitTest('a comment and a string naming the shape are not code', () => {
  expect(unboundedFanouts(file('// Promise.all(rows.map(async (r) => db.x(r)))'))).toEqual([]);
  expect(
    unboundedFanouts(file("const s = 'Promise.all(rows.map(async (r) => db.x(r)))';")),
  ).toEqual([]);
});

unitTest('every source file is read but a test', () => {
  expect(readsFile('apps/web/app/posts/service.ts')).toBe(true);
  expect(readsFile('packages/domain/src/rules.ts')).toBe(true);
  expect(readsFile('apps/web/app/posts/service.test.ts')).toBe(false);
});
