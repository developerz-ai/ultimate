// `pageNavigation` is the one composition the three document writers (`x dev`, the container, the
// static export) take the client router from; `appRoutes` is where a document names it and where
// each page's route meta tells `@ultimat3/http`'s gate which router requests it may answer. What
// is pinned, failures first: a page that did not opt into prefetch never RUNS for one (its `load`
// counts zero), a `navigation: 'document'` page never runs for a soft visit, a page rendered for
// another principal is refused before `load`, a misplaced `navigation` key refuses the boot — and
// a surface that did not opt in pays nothing.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-dir or recursive-delete API.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: Bun exposes no temp-directory path of its own.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
// why: Bun has no file-URL-to-path API; the router's entry is located beside this file.
import { fileURLToPath } from 'node:url';
import { isUltimateError, userActor } from '@ultimat3/core';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { RouteNavigationMode } from '@ultimat3/render';
import {
  clearRoutes,
  defineRoute,
  NAVIGATION_META,
  registerRoute,
  routeEntries,
} from '@ultimat3/render';
import type { NavigationDocumentHead } from './page-navigation';
import {
  assertRouteNavigation,
  loadNavigation,
  navigationHeadFor,
  pageNavigation,
} from './page-navigation';
import { appRoutes } from './runtime-render';
import { buildNavigationScript, navigationRoutes } from './worker-bundle';

const BUILD_ID = 'build-under-test';
const OUTSIDE = tmpdir();
const HEAD: NavigationDocumentHead = {
  surfaces: new Set(['app']),
  scriptUrl: '/_x/navigation/n.js',
  buildId: BUILD_ID,
  app: 'web',
};

afterEach(() => {
  clearRoutes();
});

/** Every `load` a page ran, by path — the one count a gate is judged by. */
const loads: string[] = [];

function page(
  file: string,
  options: { navigation?: RouteNavigationMode; gated?: boolean; render?: 'ssr' | 'stream' } = {},
): void {
  registerRoute({
    file,
    suspenseBoundaries: options.render === 'stream' ? 1 : 0,
    config: defineRoute({
      render: options.render ?? 'ssr',
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      load: ({ url }) => {
        loads.push(new URL(url).pathname);
        return { url };
      },
      meta: () => ({ title: file, description: 'navigation under test' }),
      ...(options.navigation === undefined ? {} : { navigation: options.navigation }),
      ...(options.gated ? { policy: { permission: 'casos.read' } } : {}),
    }),
  });
}

const ALICE = userActor({ id: 'alice@example.com', permissions: ['casos.read'] });

const serverFor = (actor: ReturnType<typeof userActor> | null = null) =>
  createServer({
    routes: appRoutes({ buildId: BUILD_ID, navigation: HEAD }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actor, authorize: () => ({ allowed: true }) },
  });

const router = (purpose: 'soft' | 'prefetch', extra: Record<string, string> = {}) => ({
  'x-ultimate-navigation': purpose,
  'x-ultimate-surface': 'web:app',
  accept: 'text/html',
  ...extra,
});

describe('unit · the gate over real pages — what a router request may run', () => {
  test('a prefetch of a page that did not opt in: 204, and its load never ran', async () => {
    page('apps/web/app/casos/page.tsx');
    loads.length = 0;
    const answer = await serverFor().fetch(
      new Request('http://dev.test/casos', { headers: router('prefetch') }),
    );
    expect(answer.status).toBe(204);
    expect(loads).toEqual([]);
  });

  test("navigation: 'document' — a soft visit runs nothing and names itself for the real load", async () => {
    page('apps/web/app/r/[token]/page.tsx', { navigation: 'document' });
    loads.length = 0;
    const answer = await serverFor().fetch(
      new Request('http://dev.test/r/abc', { headers: router('soft') }),
    );
    expect(answer.status).toBe(204);
    expect(answer.headers.get('x-ultimate-location')).toBe('http://dev.test/r/abc');
    expect(loads).toEqual([]);
  });

  test("a page of another app on the same origin is not this router's to swap", async () => {
    page('apps/web/app/casos/page.tsx');
    loads.length = 0;
    const answer = await serverFor().fetch(
      new Request('http://dev.test/casos', {
        headers: router('soft', { 'x-ultimate-surface': 'admin:app' }),
      }),
    );
    expect(answer.status).toBe(204);
    expect(loads).toEqual([]);
  });

  test('a page rendered for another principal is refused before its load runs', async () => {
    page('apps/web/app/casos/page.tsx', { gated: true });
    loads.length = 0;
    // The router's document was rendered for nobody (no scope header); this page is alice's.
    const answer = await serverFor(ALICE).fetch(
      new Request('http://dev.test/casos', { headers: router('soft') }),
    );
    expect(answer.status).toBe(204);
    expect(answer.headers.get('x-ultimate-location')).toBe('http://dev.test/casos');
    expect(loads).toEqual([]);
  });

  test('passes: a soft visit, same principal; an opted-in prefetch', async () => {
    page('apps/web/app/casos/page.tsx');
    page('apps/web/app/plazos/page.tsx', { navigation: 'prefetch' });
    loads.length = 0;
    const server = serverFor();
    expect(
      (await server.fetch(new Request('http://dev.test/casos', { headers: router('soft') })))
        .status,
    ).toBe(200);
    expect(
      (await server.fetch(new Request('http://dev.test/plazos', { headers: router('prefetch') })))
        .status,
    ).toBe(200);
    expect(loads).toEqual(['/casos', '/plazos']);
  });
});

describe('unit · pageNavigation', () => {
  test('no surface opted in: nothing built, served or named — even where nothing resolves', async () => {
    expect(await pageNavigation(OUTSIDE, { app: 'web', surfaces: [] }, BUILD_ID)).toEqual({
      routes: [],
      script: undefined,
      head: undefined,
    });
  });

  test('opted in with no router to build is refused, never a silent full-page app', async () => {
    try {
      await pageNavigation(OUTSIDE, { app: 'web', surfaces: ['app'] }, BUILD_ID);
    } catch (error) {
      if (!isUltimateError(error)) return expect.unreachable('a coded refusal');
      expect(error.code).toBe('X_BUILD_FAILED');
      expect(error.cause).toContain('@ultimat3/render/navigation');
      return;
    }
    expect.unreachable('pageNavigation built a router from nothing');
  });

  test('a page declaring navigation on a surface with none refuses the boot, by file', () => {
    page('apps/web/site/precios/page.tsx', { navigation: 'prefetch' });
    try {
      assertRouteNavigation(['app'], routeEntries());
    } catch (error) {
      if (!isUltimateError(error)) return expect.unreachable('a coded refusal');
      expect(error.code).toBe('X_ROUTE_NAVIGATION_INVALID');
      expect(error.cause).toContain('apps/web/site/precios/page.tsx');
      return;
    }
    expect.unreachable('a navigation key nothing can honour was accepted');
  });

  test('a document names its router as <app>:<surface>; another surface gets no head', () => {
    expect(navigationHeadFor(HEAD, 'site')).toBeUndefined();
    expect(navigationHeadFor(undefined, 'app')).toBeUndefined();
    expect(navigationHeadFor(HEAD, 'app')).toEqual({
      surface: 'web:app',
      buildId: BUILD_ID,
      scriptUrl: '/_x/navigation/n.js',
    });
  });
});

describe('unit · loadNavigation', () => {
  test('no config file is no opt-in; only real surfaces are read back, with the app name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ultimate-nav-'));
    try {
      expect((await loadNavigation(root)).surfaces).toEqual([]);
      await writeFile(
        join(root, 'app.config.ts'),
        "export const config = { name: 'notificado', navigation: { client: ['app', 'api'] } };\n",
      );
      expect(await loadNavigation(root)).toEqual({ app: 'notificado', surfaces: ['app'] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('unit · the router route and the document that names it', () => {
  const entry = fileURLToPath(new URL('../../render/src/navigation-entry.ts', import.meta.url));

  test('served immutable at its content address; any other name is a 404 naming the fix', async () => {
    const script = await buildNavigationScript(OUTSIDE, { entry });
    if (script === undefined) return expect.unreachable('the router did not build');
    const server = createServer({
      routes: navigationRoutes(() => script),
      role: 'web',
      config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
    });
    const served = await server.fetch(new Request(`http://dev.test${script.url}`));
    expect(served.status).toBe(200);
    expect(served.headers.get('cache-control')).toContain('immutable');
    expect(await served.text()).toBe(script.code);
    const stale = await server.fetch(new Request('http://dev.test/_x/navigation/0000.js'));
    expect(stale.status).toBe(404);
  });

  test('only an opted-in surface names the router, the surface and the build', async () => {
    page('apps/web/app/casos/page.tsx');
    page('apps/web/site/precios/page.tsx');
    const server = serverFor();
    const app = await (await server.fetch(new Request('http://dev.test/casos'))).text();
    const site = await (await server.fetch(new Request('http://dev.test/precios'))).text();

    expect(app).toContain(`<meta name="${NAVIGATION_META}" content="web:app">`);
    expect(app).toContain(`<meta name="x-ultimate-build" content="${BUILD_ID}">`);
    expect(app).toContain('<script src="/_x/navigation/n.js" defer></script>');
    expect(site).not.toContain(NAVIGATION_META);
    expect(site).not.toContain('/_x/navigation/');
  });
});
