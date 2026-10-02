// The one route precedence: the request trie's order, segment by segment, as one integer.
import { describe, expect, test } from 'bun:test';
import { ROUTE_RANK_SEGMENTS, routeRank } from './route-rank';

describe('routeRank', () => {
  test('the first segment that differs decides, never a sum over segments', () => {
    // Both match `/a/b/c`; the trie takes the literal FIRST segment. A 100/10/1 sum said 210 > 120.
    expect(routeRank('/a/:x/:y')).toBeGreaterThan(routeRank('/:a/b/c'));
  });

  test('literal over param over catch-all, at the same position', () => {
    expect(routeRank('/docs/intro')).toBeGreaterThan(routeRank('/docs/:slug'));
    expect(routeRank('/docs/:slug')).toBeGreaterThan(routeRank('/docs/*path'));
  });

  test('a pattern that ends outranks a catch-all that could take an empty rest', () => {
    expect(routeRank('/docs')).toBeGreaterThan(routeRank('/docs/*path'));
    expect(routeRank('/a/:x')).toBeGreaterThan(routeRank('/a/:x/*rest'));
    expect(routeRank('/')).toBeGreaterThan(routeRank('/*path'));
  });

  test('a deeper static path outranks a shallower dynamic one', () => {
    expect(routeRank('/posts/new/draft')).toBeGreaterThan(routeRank('/posts/:id'));
  });

  test('empty and duplicate separators are no segments', () => {
    expect(routeRank('/a//b/')).toBe(routeRank('/a/b'));
    expect(routeRank('')).toBe(routeRank('/'));
  });

  test('is an exact integer at the deepest ranked pattern, and past it', () => {
    const deep = (n: number): string => `/${Array.from({ length: n }, () => 'a').join('/')}`;
    expect(Number.isSafeInteger(routeRank(deep(ROUTE_RANK_SEGMENTS)))).toBe(true);
    expect(Number.isSafeInteger(routeRank(deep(ROUTE_RANK_SEGMENTS + 8)))).toBe(true);
  });
});
