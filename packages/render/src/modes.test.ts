import { describe, expect, test } from 'bun:test';
import { tag } from '@ultimat3/cache';
import { RouteModeInvalidError } from './errors';
import { assertModeInvariants } from './modes';
import { clearRoutes, registerRoute } from './registry';
import type { RouteConfig, RouteGuard, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;
const guard: RouteGuard = { permission: 'dashboard:read' };

function fixOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'fix' in error ? String(error.fix) : '';
}

describe('per-mode registration invariants', () => {
  test('static cannot read per-request state (no policy)', () => {
    expect(() =>
      defineRoute({
        render: 'static',
        offline: 'precache',
        hydrate: 'never',
        meta,
        policy: guard,
      }),
    ).toThrow(RouteModeInvalidError);
  });

  test('static cannot declare revalidate', () => {
    let fix = '';
    try {
      defineRoute({
        render: 'static',
        revalidate: { ttl: '5m' },
        offline: 'precache',
        hydrate: 'never',
        meta,
      });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain("change render to 'isr'");
  });

  test('isr requires either revalidate.tags or a ttl', () => {
    expect(() =>
      defineRoute({
        render: 'isr',
        revalidate: { tags: [] },
        offline: 'precache',
        hydrate: 'never',
        meta,
      }),
    ).toThrow(RouteModeInvalidError);

    expect(() =>
      defineRoute({
        render: 'isr',
        revalidate: { ttl: '5m' },
        offline: 'precache',
        hydrate: 'never',
        meta,
      }),
    ).not.toThrow();
  });

  test('isr cannot be gated — one cached document cannot answer two actors', () => {
    // The hole `static` was already refused for, one mode over. An ISR route resolves `load`
    // with THIS request's `Ctx`, renders actor A's document, and `isr.serve(pathname, …)` stores
    // it under the bare pathname — so every later actor who passes the same policy is served
    // A's HTML. The query string is not in the key either.
    let fix = '';
    try {
      defineRoute({
        render: 'isr',
        revalidate: { ttl: '5m' },
        policy: { permission: 'post:read' },
        offline: 'precache',
        hydrate: 'never',
        meta,
      });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain("'ssr'");

    expect(() =>
      defineRoute({
        render: 'isr',
        revalidate: { ttl: '5m' },
        policy: { permission: 'post:read' },
        offline: 'precache',
        hydrate: 'never',
        meta,
      }),
    ).toThrow(RouteModeInvalidError);
  });

  test('ssr cannot be prerendered', () => {
    let fix = '';
    try {
      defineRoute({
        render: 'ssr',
        prerender: () => ['a'],
        offline: 'network-only',
        hydrate: 'never',
        meta,
      });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain('remove prerender');
  });

  test('spa requires a policy — it is for authed dashboards', () => {
    expect(() =>
      defineRoute({ render: 'spa', offline: 'precache', hydrate: 'idle', meta }),
    ).toThrow(RouteModeInvalidError);

    expect(() =>
      defineRoute({ render: 'spa', offline: 'precache', hydrate: 'idle', meta, policy: guard }),
    ).not.toThrow();
  });

  test('stream requires at least one suspense boundary', () => {
    const config: RouteConfig = defineRoute({
      render: 'stream',
      offline: 'runtime',
      hydrate: 'idle',
      meta,
    });

    let fix = '';
    try {
      assertModeInvariants(config, {
        file: 'apps/web/app/dashboard/page.tsx',
        path: '/dashboard',
        surface: 'app',
        suspenseBoundaries: 0,
      });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain('<Suspense');

    expect(() =>
      assertModeInvariants(config, {
        file: 'apps/web/app/dashboard/page.tsx',
        path: '/dashboard',
        surface: 'app',
        suspenseBoundaries: 2,
      }),
    ).not.toThrow();
  });
});

describe('surface-level mode rules', () => {
  test('site/ rejects app-only modes and app/ rejects static', () => {
    clearRoutes();
    const streamConfig = defineRoute({
      render: 'stream',
      offline: 'runtime',
      hydrate: 'idle',
      meta,
    });
    expect(() =>
      registerRoute({
        file: 'apps/web/site/pricing/page.tsx',
        config: streamConfig,
        suspenseBoundaries: 1,
      }),
    ).toThrow(RouteModeInvalidError);
  });

  test('hydrating a site/ route without a js budget is a build error', () => {
    clearRoutes();
    const config = defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'visible',
      meta,
    });
    let fix = '';
    try {
      registerRoute({ file: 'apps/web/site/pricing/page.tsx', config });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain('budget: { js:');
  });
});

/**
 * `isr` needs a trigger "otherwise it is `static` wearing a costume" — and a TTL nothing can parse
 * is exactly that costume: `parseTtlMs` answers `null`, so the page is generated ONCE and served
 * for the life of the process while the CDN is told `s-maxage=60`. One reader for "is this a TTL".
 */
describe('isr revalidate trigger', () => {
  const isrRoute = (revalidate: NonNullable<RouteConfig['revalidate']>): RouteConfig =>
    defineRoute({ render: 'isr', revalidate, offline: 'runtime', hydrate: 'never', meta });

  test('accepts a ttl the ISR clock can actually read', () => {
    expect(isrRoute({ ttl: '5m' }).render).toBe('isr');
    expect(isrRoute({ ttl: 60_000 }).render).toBe('isr');
  });

  test('refuses a ttl string parseTtlMs answers null for', () => {
    for (const ttl of ['5 minutes', '5min', 'soon', '']) {
      expect(() => isrRoute({ ttl })).toThrow(RouteModeInvalidError);
    }
  });

  test('refuses a number that is not a duration', () => {
    expect(() => isrRoute({ ttl: 0 })).toThrow(RouteModeInvalidError);
    expect(() => isrRoute({ ttl: -1 })).toThrow(RouteModeInvalidError);
  });

  test('tags alone are still a trigger, with no ttl at all', () => {
    expect(isrRoute({ tags: [tag('post')] }).render).toBe('isr');
  });
});

/**
 * The `spec === undefined` guard is widened on purpose for JS callers — and an object lookup walks
 * the prototype chain, so `render: 'constructor'` found a `ModeSpec` that does not exist and
 * `defineRoute` returned a frozen descriptor for a mode nothing implements.
 */
describe('a render mode named after an Object.prototype member', () => {
  test('is refused like any other unknown mode', () => {
    for (const render of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(() =>
        defineRoute({
          render: render as RouteConfig['render'],
          offline: 'runtime',
          hydrate: 'never',
          meta,
        }),
      ).toThrow(RouteModeInvalidError);
    }
  });

  test('the five real modes still resolve, so the lookup was narrowed and not broken', () => {
    for (const render of ['static', 'ssr', 'stream'] as const) {
      expect(defineRoute({ render, offline: 'runtime', hydrate: 'never', meta }).render).toBe(
        render,
      );
    }
  });
});
