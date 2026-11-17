// `planScope` renders predicate values through core's injective `canonicalJson`, never a local
// serializer: two distinct filters sharing one rendering share one cursor scope, so a position
// minted under one is honoured under the other. Pinned too: the plans whose rendering did not
// move keep the scope they had, so cursors already in flight across the upgrade still decode.

import { describe, expect, test } from 'bun:test';
import { planScope } from './cursor';
import type { QueryPlan } from './tenancy';

const BASE: QueryPlan = {
  entity: 'cursor_test_posts',
  where: [],
  orderBy: [
    { column: 'createdAt', direction: 'desc' },
    { column: 'id', direction: 'desc' },
  ],
  limit: 20,
};

const filtered = (value: unknown): string =>
  planScope({ ...BASE, where: [{ column: 'title', op: 'eq', value }] });

describe('unit · a cursor scope tells distinct filters apart', () => {
  test.each([
    ['a number and its digits', 1, '1'],
    ['a boolean and its word', true, 'true'],
    ['a Date and its ISO string', new Date('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z'],
    ['a member holding a number and one holding its digits', { n: 1 }, { n: '1' }],
    ['a list of numbers and a list of their digits', [1, 2], ['1', '2']],
    ['a bigint and its spelling', 5n, '5n'],
    ['null and the word null', null, 'null'],
  ] as const)('%s are two scopes', (_, one, other) => {
    expect(filtered(one)).not.toBe(filtered(other));
  });
});

describe('unit · a scope that did not need to move did not', () => {
  // Literal hashes taken from the serializer this replaced: a plan with no filter, or with string,
  // string-list and null-test predicates only, renders the same text under `canonicalJson`.
  test('no filter', () => {
    expect(planScope(BASE)).toBe('cca64bedb5958168');
  });

  test('string, string-list and null-test predicates', () => {
    const scope = planScope({
      ...BASE,
      where: [
        { column: 'title', op: 'eq', value: 'a' },
        { column: 'tag', op: 'in', value: ['x', 'y'] },
        { column: 'deletedAt', op: 'is-null' },
      ],
    });
    // Measured on the code before this change: the same hash, so these scopes do not move.
    expect(scope).toBe('02519b060b889f9d');
  });
});
