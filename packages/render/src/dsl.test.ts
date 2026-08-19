/**
 * Pins the `route` DSL surface's *shape*, which `route.test.ts` (validation) does not:
 * `route` is the one primitive whose façade is a normalized descriptor rather than
 * projection methods, so every reader must see one shape and none may branch.
 */
import { describe, expect, test } from 'bun:test';
import { assertModeInvariants, assertModeShape } from './modes';
import { clearRoutes, registerRoute, routeFor } from './registry';
import type { RouteConfig, RouteDefinition } from './route';
import { defineRoute, isRouteConfig, tagKeys } from './route';

/** The stable code every route-shape refusal carries; a bare `toThrow()` would accept any. */
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  return '';
};

// The exact contract: `RouteConfig` (route.ts). Kept in sync by hand on purpose — a
// silent drift here is exactly the regression this file exists to catch. Optional
// declaration keys are omitted rather than set to undefined, so they are not listed.
const DESCRIPTOR_MEMBERS = [
  'kind',
  'render',
  'offline',
  'hydrate',
  'meta',
  'budget',
  'islands',
] as const;

const minimal: RouteDefinition = {
  render: 'ssr',
  offline: 'network-only',
  hydrate: 'never',
  meta: () => ({ title: 'Post', description: 'A post' }),
};

describe('the route DSL surface', () => {
  test('a minimal route carries exactly the descriptor members, nothing more', () => {
    const config = defineRoute(minimal);
    expect(Object.keys(config).sort()).toEqual([...DESCRIPTOR_MEMBERS].sort());
  });

  test('every declared key is carried onto the descriptor', () => {
    // Two routes, because `policy` and `revalidate`/`prerender` no longer belong to one mode:
    // `isr` caches a document per URL, so a gated one would serve the first actor's HTML to
    // everybody after them (`modes.ts`).
    const cached = defineRoute({
      ...minimal,
      render: 'isr',
      revalidate: { ttl: '5m' },
      prerender: () => ['first-post'],
      budget: { js: '40kb' },
    });
    expect(Object.keys(cached).sort()).toEqual(
      [...DESCRIPTOR_MEMBERS, 'revalidate', 'prerender'].sort(),
    );
    expect(cached.revalidate).toEqual({ ttl: '5m' });

    const gated = defineRoute({ ...minimal, render: 'ssr', policy: { permission: 'post:read' } });
    expect(Object.keys(gated).sort()).toEqual([...DESCRIPTOR_MEMBERS, 'policy'].sort());
    expect(gated.policy).toEqual({ permission: 'post:read' });
  });

  test('the descriptor is branded and frozen — a declaration object is neither', () => {
    const config = defineRoute(minimal);
    expect(config.kind).toBe('route');
    expect(Object.isFrozen(config)).toBe(true);
    expect(isRouteConfig(config)).toBe(true);
    // The author's own object never counts: only `defineRoute` normalizes.
    expect(isRouteConfig(minimal)).toBe(false);
    expect(isRouteConfig({ kind: 'route' })).toBe(true);
  });

  test('`meta` is one shape — a sync declaration is not reachable as a sync member', () => {
    const sync = defineRoute(minimal);
    const async = defineRoute({ ...minimal, meta: async () => ({ title: 'A', description: 'B' }) });
    // Both are promises. No consumer branches on a thenable.
    expect(sync.meta({})).toBeInstanceOf(Promise);
    expect(async.meta({})).toBeInstanceOf(Promise);
    // And the descriptor's `meta` is a wrapper, never the function the author passed.
    expect(sync.meta).not.toBe(minimal.meta);
  });

  test('`budget` is always an object, so no consumer needs an undefined-check', () => {
    expect(defineRoute(minimal).budget).toEqual({});
    expect(defineRoute({ ...minimal, budget: { js: '40kb' } }).budget).toEqual({ js: '40kb' });
  });

  test('the always-present budget still leaves `budget.js` undeclared', () => {
    // The normalization must not launder a missing JS budget into a satisfied one.
    // `modes.ts` fails a hydrating `site/` route on exactly this, and that has to hold
    // through the descriptor — otherwise the check silently stops engaging.
    const hydrating = defineRoute({ ...minimal, render: 'static', hydrate: 'visible' });
    expect(hydrating.budget.js).toBeUndefined();
    const ctx = {
      file: 'site/posts/page.tsx',
      path: '/posts',
      surface: 'site',
      suspenseBoundaries: 0,
    } as const;
    expect(codeOf(() => assertModeInvariants(hydrating, ctx))).toBe('X_ROUTE_MODE_INVALID');
    const budgeted = defineRoute({ ...hydrating, budget: { js: '40kb' } });
    expect(() => assertModeInvariants(budgeted, ctx)).not.toThrow();
  });

  test('mode invariants are checked on the descriptor, at declaration time', () => {
    // `defineRoute` runs `assertModeShape` itself, so a bad route fails at module
    // evaluation — build time — not on the first request.
    expect(codeOf(() => defineRoute({ ...minimal, render: 'isr' }))).toBe('X_ROUTE_MODE_INVALID');
    expect(() => assertModeShape(defineRoute(minimal))).not.toThrow();
  });

  test('the registry accepts the descriptor and refuses a raw declaration', () => {
    clearRoutes();
    const config = defineRoute(minimal);
    const entry = registerRoute({ file: 'app/posts/page.tsx', config });
    expect(entry.config).toBe(config);
    expect(entry.config.budget).toEqual({});
    // The author's own object carries no normalized `budget`, so registering it would seat a
    // route the descriptor's readers cannot read — `describeRoutes()` reaches `budget.js`.
    const raw = minimal as unknown as RouteConfig;
    expect(codeOf(() => registerRoute({ file: 'app/drafts/page.tsx', config: raw }))).toBe(
      'X_ROUTE_UNNORMALIZED',
    );
    expect(routeFor('/drafts')).toBeUndefined();
    clearRoutes();
  });

  test('tags reach the descriptor in the cache wire form, never a private convention', () => {
    const config = defineRoute({
      ...minimal,
      render: 'isr',
      revalidate: { tags: [{ entity: 'post', id: '123' }, { entity: 'feed' }] },
    });
    expect(tagKeys(config.revalidate?.tags)).toEqual(['post:123', 'feed']);
    expect(tagKeys(undefined)).toEqual([]);
  });
});
