import { describe, expect, test } from 'bun:test';
import { tag } from '@ultimat3/cache';
import type { RenderMode } from '@ultimat3/core';
import { RENDER_MODES } from '@ultimat3/core';
import { RouteModeInvalidError } from './errors';
import {
  assertModeInvariants,
  DEFAULT_ISLAND_JS_BYTES,
  defaultHydrate,
  defaultIslandBudget,
  MODE_SPECS,
} from './modes';
import { clearRoutes, registerRoute } from './registry';
import type { RouteConfig, RouteGuard, RouteMetaFn } from './route';
import { defineRoute } from './route';
import { SURFACE_SPECS } from './surfaces';

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

  // `spa` was a mode with no renderer: `renderSpa` never read `entry.component` and the client
  // bundle that was supposed to fill `#x-root` was never built by anything, so every `spa` route
  // ever declared served an empty document. It is gone, and the refusal is what says so — a
  // deleted mode that merely stopped being listed would fail at the first blank page instead.
  test("render: 'spa' is not a mode, and the refusal lists the four that are", () => {
    let fix = '';
    let cause = '';
    try {
      // `as RenderMode` because the union no longer holds it: the value an app has on disk today
      // reaches `defineRoute` from JS and from a stale `.tsx` alike, and this is the check that
      // greets it.
      defineRoute({
        render: 'spa' as RenderMode,
        offline: 'precache',
        hydrate: 'idle',
        meta,
        policy: guard,
      });
    } catch (error) {
      fix = fixOf(error);
      cause = error instanceof RouteModeInvalidError ? error.cause : '';
    }
    expect(cause).toContain('"spa" is not a render mode');
    expect(fix).toBe('use one of static | isr | ssr | stream');
  });

  test('the mode table and the surface tables agree on exactly four modes', () => {
    // Pinned, not derived: a sixth mode arriving with no renderer is the defect `spa` was, and
    // a table that only ever grows cannot report it.
    expect(RENDER_MODES).toEqual(['static', 'isr', 'ssr', 'stream']);
    expect(Object.keys(MODE_SPECS)).toEqual([...RENDER_MODES]);
    expect(SURFACE_SPECS.app.allowedModes).toEqual(['stream', 'ssr']);
    expect(SURFACE_SPECS.site.allowedModes).toEqual(['static', 'isr', 'ssr']);
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

describe('the two shapes a mode declaration can be wrong in', () => {
  // `defineRoute` is the ONE normalizer, so its checks are the runtime half of the type: an app
  // built from a JSON config, or one `as`-casting past the union, reaches them.
  test('a render mode outside the union is refused, and the fix lists the union', () => {
    let fix = '';
    try {
      defineRoute({
        render: 'server' as unknown as RouteConfig['render'],
        offline: 'runtime',
        hydrate: 'idle',
        meta,
      });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain('static');
    expect(fix).toContain('isr');
  });

  test('a hydration strategy outside the union is refused the same way', () => {
    let fix = '';
    let cause = '';
    try {
      defineRoute({
        render: 'ssr',
        offline: 'runtime',
        hydrate: 'eager' as unknown as RouteConfig['hydrate'],
        meta,
      });
    } catch (error) {
      fix = fixOf(error);
      cause = error instanceof RouteModeInvalidError ? error.cause : '';
    }
    expect(cause).toContain('"eager"');
    expect(fix).toContain('never');
    expect(fix).toContain('interaction');
  });
});

describe('api/ renders nothing', () => {
  const config: RouteConfig = defineRoute({
    render: 'ssr',
    offline: 'runtime',
    hydrate: 'idle',
    meta,
  });

  // A page under api/ is a route with no HTML and no bundle graph, so the failure names the two
  // edits that exist — move it, or stop pretending it is a page.
  test('a defineRoute under api/ is refused before any other mode rule is consulted', () => {
    let fix = '';
    let cause = '';
    try {
      assertModeInvariants(config, {
        file: 'apps/web/api/posts/route.ts',
        path: '/api/posts',
        surface: 'api',
        suspenseBoundaries: 0,
      });
    } catch (error) {
      fix = fixOf(error);
      cause = error instanceof RouteModeInvalidError ? error.cause : '';
    }
    expect(cause).toContain('apps/web/api/posts/route.ts');
    expect(cause).toContain('renders nothing');
    expect(fix).toContain('replace defineRoute with an action');
  });

  test('the same config is accepted on app/, so the surface is what refused it', () => {
    expect(() =>
      assertModeInvariants(config, {
        file: 'apps/web/app/posts/page.tsx',
        path: '/posts',
        surface: 'app',
        suspenseBoundaries: 0,
      }),
    ).not.toThrow();
  });
});

describe('prerender belongs to a prerenderable mode', () => {
  const withPrerender = (render: 'static' | 'isr' | 'stream'): RouteConfig =>
    defineRoute({
      render,
      ...(render === 'isr' ? { revalidate: { ttl: '5m' } } : {}),
      prerender: () => [{}],
      offline: 'runtime',
      hydrate: 'never',
      meta,
    });

  // `stream` is the mode that reaches THIS check: `defineRoute` refuses `ssr` + prerender on its
  // own, so a route only arrives at registration still carrying an impossible pair when the mode
  // is per-request but not `ssr`.
  test('stream cannot be prerendered, and the fix names both ways out', () => {
    let fix = '';
    let cause = '';
    try {
      assertModeInvariants(withPrerender('stream'), {
        file: 'apps/web/app/feed/page.tsx',
        path: '/feed',
        surface: 'app',
        suspenseBoundaries: 1,
      });
    } catch (error) {
      fix = fixOf(error);
      cause = error instanceof RouteModeInvalidError ? error.cause : '';
    }
    expect(cause).toContain('apps/web/app/feed/page.tsx');
    expect(cause).toContain('not prerenderable');
    expect(fix).toContain('remove prerender');
    expect(fix).toContain("change render to 'static' | 'isr'");
  });

  test('static and isr accept it, so the refusal is the mode and not the field', () => {
    for (const render of ['static', 'isr'] as const) {
      expect(() =>
        assertModeInvariants(withPrerender(render), {
          file: 'apps/web/site/posts/page.tsx',
          path: '/posts',
          surface: 'site',
          suspenseBoundaries: 0,
        }),
      ).not.toThrow();
    }
  });
});

describe('defaultHydrate', () => {
  // The 0kb baseline as a default rather than as a rule an author has to remember: a `site/` route
  // that says nothing ships nothing, and an `app/` route that says nothing wakes when idle.
  test('site/ ships nothing unless asked; app/ wakes on idle', () => {
    expect(defaultHydrate('site')).toBe('never');
    expect(defaultHydrate('app')).toBe('idle');
    expect(defaultHydrate('api')).toBe('idle');
  });

  test('a site/ route that declares no hydrate needs no js budget, and gets none', () => {
    clearRoutes();
    const entry = registerRoute({
      file: 'apps/web/site/legal/page.tsx',
      config: defineRoute({ render: 'static', offline: 'precache', meta }),
    });
    expect(entry.config.hydrate).toBe(defaultHydrate('site'));
  });
});

describe('DEFAULT_ISLAND_JS_BYTES', () => {
  /**
   * Measured with `buildIslands` from `@ultimat3/cli`, minified, production Solid resolved, on
   * 2026-08-21. Not imported: this package may not reach tier 5, and a budget test that built a
   * bundle would be an `.e2e.` suite rather than a unit one. Restated here so the constant above
   * has a number to fail against — a budget with no test is the state that shipped a default no
   * island could meet.
   */
  const MEASURED = {
    nonSolidIsland: 875,
    solidFloor: 12_588,
    trivialCounter: 13_663,
    referenceAppIsland: 17_797,
    hydrateRuntimeOneDirective: 615,
  } as const;

  test('a Solid island can reach it — the property 4096 did not have', () => {
    // The floor is what `render()` costs before an author writes a line. A default below it is a
    // ceiling every JSX island fails on arrival, whatever it contains.
    expect(DEFAULT_ISLAND_JS_BYTES).toBeGreaterThan(
      MEASURED.solidFloor + MEASURED.hydrateRuntimeOneDirective,
    );
    expect(DEFAULT_ISLAND_JS_BYTES).toBeGreaterThan(
      MEASURED.referenceAppIsland + MEASURED.hydrateRuntimeOneDirective,
    );
  });

  test('it is still a ceiling — headroom over the real island, not a blank cheque', () => {
    const spent = MEASURED.referenceAppIsland + MEASURED.hydrateRuntimeOneDirective;
    // Under 2x, so a second copy of the same island is refused rather than waved through, which is
    // the shape of the defect this check exists for: `three` and `three/webgpu` bundled twice.
    expect(DEFAULT_ISLAND_JS_BYTES).toBeLessThan(spent * 2);
    expect(DEFAULT_ISLAND_JS_BYTES % 1024).toBe(0);
  });

  test('the derived ceiling is the surface baseline plus the allowance, per surface', () => {
    // Relative, never absolute: `site/` starts at 0 and `app/` at 14kb, so one number would be
    // either a ceiling `app/` fails on arrival or one `site/` can never reach.
    for (const surface of ['site', 'app'] as const) {
      const bytes = SURFACE_SPECS[surface].jsBaselineBytes + DEFAULT_ISLAND_JS_BYTES;
      expect(defaultIslandBudget(surface)).toBe(`${bytes / 1024}kb`);
    }
    expect(defaultIslandBudget('site')).toBe('20kb');
    expect(defaultIslandBudget('app')).toBe('34kb');
  });

  test('the non-Solid island the old default was calibrated on still fits, with room', () => {
    // Not a regression guard on 875 B — a statement that raising the number did not stop the
    // cheapest shape from being cheap. It is the *calibration* that was wrong, not the island.
    expect(MEASURED.nonSolidIsland).toBeLessThan(DEFAULT_ISLAND_JS_BYTES);
    expect(MEASURED.trivialCounter).toBeLessThan(DEFAULT_ISLAND_JS_BYTES);
  });
});
