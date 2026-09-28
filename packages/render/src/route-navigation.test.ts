// `defineRoute({ navigation })`: one key, two values, refused when it says anything else — an
// evidence GET that meant `'document'` and typed something else must fail at module evaluation,
// not be swapped in by the router.
import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { defineRoute, type RouteNavigationMode } from './route';

const route = (navigation: unknown) =>
  defineRoute({
    render: 'ssr',
    offline: 'network-only',
    meta: () => ({ title: 't', description: 'd' }),
    navigation: navigation as RouteNavigationMode,
  });

describe('defineRoute navigation', () => {
  test.each([['doc'], ['soft'], [true], ['']])('%p is refused by code', (value) => {
    try {
      route(value);
    } catch (error) {
      if (!isUltimateError(error)) return expect.unreachable('a coded refusal');
      expect(error.code).toBe('X_ROUTE_NAVIGATION_INVALID');
      return;
    }
    expect.unreachable(`navigation: ${String(value)} was accepted`);
  });

  test("'prefetch' and 'document' are kept on the descriptor; absent stays absent", () => {
    expect(route('prefetch').navigation).toBe('prefetch');
    expect(route('document').navigation).toBe('document');
    expect(
      'navigation' in
        defineRoute({ render: 'ssr', offline: 'network-only', meta: () => ({ title: 't' }) }),
    ).toBe(false);
  });
});
