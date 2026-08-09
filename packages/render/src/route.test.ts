import { describe, expect, test } from 'bun:test';
import { RouteMetaMissingError, RouteModeInvalidError, RouteOfflineMissingError } from './errors';
import { assertModeInvariants } from './modes';
import type { RouteConfig, RouteDefinition, RouteMetaFn } from './route';
import { defineRoute, isRouteConfig } from './route';

/** UltimateError carries a `fix`; read it structurally so the test needs no core import. */
export function fixOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'fix' in error ? String(error.fix) : '';
}

const DESCRIPTION = 'A description that is comfortably inside the fifty-to-one-sixty range.';

const meta = (() => ({
  title: 'Title',
  description: DESCRIPTION,
})) as unknown as RouteMetaFn;

describe('defineRoute', () => {
  test('offline is required by the type — axiom 3 lives in the type system', () => {
    // @ts-expect-error `offline` is not optional: a route cannot ship without a strategy.
    const definition: RouteDefinition = { render: 'static', hydrate: 'never', meta };
    expect(() => defineRoute(definition)).toThrow(RouteOfflineMissingError);
  });

  test('meta is required by the type on every route', () => {
    // @ts-expect-error `meta` is not optional: a route cannot ship without a <head>.
    const definition: RouteDefinition = { render: 'static', offline: 'precache', hydrate: 'never' };
    expect(() => defineRoute(definition)).toThrow(RouteMetaMissingError);
  });

  test('an unknown offline strategy is rejected with the allowed set', () => {
    let fix = '';
    try {
      defineRoute({
        render: 'static',
        // @ts-expect-error not an offline strategy
        offline: 'sometimes',
        hydrate: 'never',
        meta,
      });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain('precache | runtime | network-only');
  });

  test('returns a frozen, branded config with optional keys omitted', () => {
    const config = defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'never',
      meta,
    });
    expect(isRouteConfig(config)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect('revalidate' in config).toBe(false);
    expect('policy' in config).toBe(false);
  });
});

describe('the descriptor normalizes meta to one shape', () => {
  const route = (metaFn: RouteMetaFn): RouteConfig =>
    defineRoute({ render: 'static', offline: 'precache', hydrate: 'never', meta: metaFn });

  test('a synchronous meta is awaitable and resolves to what it returned', async () => {
    const config = route((data) => ({ title: `Sync ${String(data['id'] ?? '')}`.trim() }));
    const resolved = config.meta({ id: '7' });
    expect(resolved).toBeInstanceOf(Promise);
    expect(await resolved).toEqual({ title: 'Sync 7' });
  });

  test('an async meta behaves identically — the caller cannot tell them apart', async () => {
    const syncRoute = route(() => ({ title: 'Same', description: DESCRIPTION }));
    const asyncRoute = route(async () => ({ title: 'Same', description: DESCRIPTION }));
    expect(syncRoute.meta({})).toBeInstanceOf(Promise);
    expect(asyncRoute.meta({})).toBeInstanceOf(Promise);
    expect(await syncRoute.meta({})).toEqual(await asyncRoute.meta({}));
  });

  test('a meta that throws synchronously rejects instead, so one catch covers both', async () => {
    const config = route(() => {
      throw new RangeError('no post');
    });
    await expect(config.meta({})).rejects.toThrow('no post');
  });
});

describe('the descriptor always carries a budget', () => {
  test('a route that declares no budget key still has one', () => {
    const config = defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'never',
      meta,
    });
    expect(config.budget).toEqual({});
    expect(config.budget.js).toBeUndefined();
  });

  test('a declared budget is carried through untouched', () => {
    const config = defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'never',
      budget: { js: '40kb', lcp: 2000 },
      meta,
    });
    expect(config.budget).toEqual({ js: '40kb', lcp: 2000 });
  });

  test('the always-present budget does not satisfy the site/ hydration check', () => {
    const config = defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'visible',
      meta,
    });
    // `budget` exists, `budget.js` does not — a hydrating site/ route must still fail.
    expect(config.budget).toBeDefined();
    expect(() =>
      assertModeInvariants(config, {
        file: 'apps/web/site/pricing/page.tsx',
        path: '/pricing',
        surface: 'site',
        suspenseBoundaries: 0,
      }),
    ).toThrow(RouteModeInvalidError);
  });

  test('the same route passes once it declares budget.js', () => {
    const config = defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'visible',
      budget: { js: '10kb' },
      meta,
    });
    expect(() =>
      assertModeInvariants(config, {
        file: 'apps/web/site/pricing/page.tsx',
        path: '/pricing',
        surface: 'site',
        suspenseBoundaries: 0,
      }),
    ).not.toThrow();
  });
});
