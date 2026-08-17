// Every route the generators write, put through the two checks the framework runs on a real one.
// A `defineRoute` that throws at import registers NO route: `x g route --surface app` emitted
// `render: 'stream'`, which `assertModeInvariants` refuses without a <Suspense> boundary, so every
// generated app route was absent from `x routes`, from `x.manifest.json` and from `budgets` — a
// scaffolded URL that 404s, reported by nothing.

import { describe, expect, test } from 'bun:test';
import type { HydrateStrategy, OfflineStrategy, RenderMode, Surface } from '@ultimat3/render';
import {
  assertModeInvariants,
  defineRoute,
  HYDRATE_STRATEGIES,
  OFFLINE_STRATEGIES,
  RENDER_MODES,
} from '@ultimat3/render';
import { scaffoldVariants } from '../scaffold-fixture';

/** One `key: 'value'` out of an emitted `defineRoute({ … })`. Absent is `undefined`, never a guess. */
const declared = (source: string, key: string): string | undefined =>
  new RegExp(`\\b${key}: '(?<value>[^']*)'`).exec(source)?.groups?.['value'];

/** `apps/web/site/pricing/page.tsx` → `site`. `apps/admin/app/admin/page.tsx` → `app`. */
const surfaceOf = (path: string): Surface | undefined => {
  const segment = path.split('/')[2];
  return segment === 'site' || segment === 'app' ? segment : undefined;
};

interface EmittedRoute {
  readonly variant: string;
  readonly path: string;
  readonly source: string;
  readonly surface: Surface;
}

const emittedRoutes = (): readonly EmittedRoute[] =>
  scaffoldVariants().flatMap((variant) =>
    variant.files.flatMap((file) => {
      const surface = surfaceOf(file.path);
      if (surface === undefined || typeof file.contents !== 'string') return [];
      if (!file.path.endsWith('page.tsx') || !file.contents.includes('defineRoute(')) return [];
      return [{ variant: variant.name, path: file.path, source: file.contents, surface }];
    }),
  );

/**
 * The declaration, rebuilt from the emitted text and run through the real `defineRoute`. Every
 * field is asserted present before it is narrowed: a regex that silently stops matching would turn
 * this into a test of a route nobody generates.
 */
const check = (route: EmittedRoute): void => {
  const render = declared(route.source, 'render');
  const hydrate = declared(route.source, 'hydrate');
  const offline = declared(route.source, 'offline');
  expect(RENDER_MODES).toContain(render as RenderMode);
  expect(HYDRATE_STRATEGIES).toContain(hydrate as HydrateStrategy);
  expect(OFFLINE_STRATEGIES).toContain(offline as OfflineStrategy);

  const ttl = /revalidate: \{ ttl: '(?<ttl>[^']*)' \}/.exec(route.source)?.groups?.['ttl'];
  const permission = /policy: \{ permission: '(?<name>[^']*)' \}/.exec(route.source)?.groups?.[
    'name'
  ];
  const config = defineRoute({
    render: render as RenderMode,
    hydrate: hydrate as HydrateStrategy,
    offline: offline as OfflineStrategy,
    meta: () => ({ title: 'title', description: 'description' }),
    ...(ttl === undefined ? {} : { revalidate: { ttl } }),
    ...(permission === undefined ? {} : { policy: { permission } }),
  });
  // What the build counts off the module's JSX. `stream` needs at least one, and this is the half
  // `assertModeShape` cannot see — which is exactly why it is the half that shipped broken.
  assertModeInvariants(config, {
    file: route.path,
    path: `/${route.path}`,
    surface: route.surface,
    suspenseBoundaries: route.source.split('<Suspense').length - 1,
  });
};

describe('unit · every generated route is one the framework will register', () => {
  test('the fixture emits routes on both surfaces, or this test checks nothing', () => {
    const surfaces = new Set(emittedRoutes().map((route) => route.surface));
    expect([...surfaces].toSorted()).toEqual(['app', 'site']);
  });

  test('no generated defineRoute throws X_ROUTE_MODE_INVALID', () => {
    const offenders = emittedRoutes().flatMap((route) => {
      try {
        check(route);
        return [];
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'threw a non-Error';
        return [`${route.variant}: ${route.path} — ${detail}`];
      }
    });
    expect(offenders).toEqual([]);
  });
});
