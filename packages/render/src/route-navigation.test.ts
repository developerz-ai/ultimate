// `defineRoute({ navigation })`: one key, three values and one object (a modal that may be
// prefetched), refused when it says anything else — an evidence GET that meant `'document'` and
// typed something else must fail at module evaluation, not be swapped in by the router.
import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { defineRoute } from './route';
import {
  navigationModeOf,
  navigationPrefetches,
  type RouteNavigationDeclaration,
} from './route-navigation';

const route = (navigation: unknown) =>
  defineRoute({
    render: 'ssr',
    offline: 'network-only',
    meta: () => ({ title: 't', description: 'd' }),
    navigation: navigation as RouteNavigationDeclaration,
  });

describe('defineRoute navigation', () => {
  test.each([
    ['doc'],
    ['soft'],
    ['dialog'],
    [true],
    [''],
    [null],
    [{}],
    [{ modal: true }],
    [{ prefetch: 'intent' }],
    [{ modal: false, prefetch: 'intent' }],
    [{ modal: true, prefetch: true }],
    [{ modal: true, prefetch: 'hover' }],
    [{ modal: true, prefetch: 'intent', extra: 1 }],
    [['modal']],
  ])('%p is refused by code', (value) => {
    try {
      route(value);
    } catch (error) {
      if (!isUltimateError(error)) return expect.unreachable('a coded refusal');
      expect(error.code).toBe('X_ROUTE_NAVIGATION_INVALID');
      return;
    }
    expect.unreachable(`navigation: ${String(value)} was accepted`);
  });

  test("'prefetch', 'document' and 'modal' are kept on the descriptor; absent stays absent", () => {
    expect(route('prefetch').navigation).toBe('prefetch');
    expect(route('document').navigation).toBe('document');
    expect(route('modal').navigation).toBe('modal');
    expect(
      'navigation' in
        defineRoute({ render: 'ssr', offline: 'network-only', meta: () => ({ title: 't' }) }),
    ).toBe(false);
  });

  test("{ modal: true, prefetch: 'intent' } is kept: a modal, and a prefetch the server answers", () => {
    const declared = route({ modal: true, prefetch: 'intent' }).navigation;
    expect(declared).toEqual({ modal: true, prefetch: 'intent' });
    expect(navigationModeOf(declared)).toBe('modal');
    expect(navigationPrefetches(declared)).toBe(true);
  });

  test.each([
    [undefined, undefined, false],
    ['prefetch', 'prefetch', true],
    ['document', 'document', false],
    ['modal', 'modal', false],
  ] as const)('%p reads as mode %p, prefetched %p', (declared, mode, prefetched) => {
    expect(navigationModeOf(declared)).toBe(mode);
    expect(navigationPrefetches(declared)).toBe(prefetched);
  });
});
