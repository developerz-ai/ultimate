// The two headers a worker that must be replaceable depends on, and the paths it is mounted at.
// Through a real `UltimateRequest` and a real `RequestContext`, `pwa-artifacts.test.ts`'s shape.

import { describe, expect, test } from 'bun:test';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import { routeDescriptor } from '../e2e/route-descriptor-fixture';
import { islandBundle } from './island-bundle';
import type { PwaArtifacts } from './pwa-artifacts';
import type { ServiceWorkerArtifacts } from './sw-artifacts';
import { SERVICE_WORKER_PATH, SW_REGISTER_PATH, serviceWorkerArtifacts } from './sw-artifacts';
import { serviceWorkerRoutes } from './sw-routes';

const BUILD_ID = 'build-7';

const pwa = (patch: Partial<PwaArtifacts> = {}): PwaArtifacts => ({
  body: '{}',
  head: '<link rel="manifest" href="/manifest.webmanifest">',
  offline: { fallback: '/offline', image: null, font: null, neverCache: [] },
  backgroundSync: false,
  push: false,
  ...patch,
});

const ROUTES = [
  routeDescriptor({ path: '/', surface: 'site', mode: 'static', offline: 'precache' }),
  routeDescriptor({ path: '/offline', surface: 'site', mode: 'static', offline: 'precache' }),
  routeDescriptor({ path: '/feed', surface: 'app', mode: 'ssr', offline: 'runtime' }),
  routeDescriptor({ path: '/api/posts', surface: 'api', mode: 'ssr', offline: 'network-only' }),
  routeDescriptor({ path: '/shared/x', surface: 'shared', mode: 'ssr', offline: 'network-only' }),
];

const build = (patch: Partial<PwaArtifacts> = {}): ServiceWorkerArtifacts => {
  const built = serviceWorkerArtifacts({
    pwa: pwa(patch),
    buildId: BUILD_ID,
    routes: ROUTES,
    islands: islandBundle([]),
  });
  if (built === undefined) expect.unreachable('an app with a fallback got no service worker');
  return built;
};

describe('serviceWorkerRoutes', () => {
  const routes = serviceWorkerRoutes(build());

  test('mounts both files, public, at the paths the head and the register script name', () => {
    expect(routes.map((route) => route.path)).toEqual([SERVICE_WORKER_PATH, SW_REGISTER_PATH]);
    // A browser fetches a worker before anyone has signed in, and an app that needs a session to
    // describe its own offline behaviour has none.
    expect(routes.every((route) => route.meta.auth === 'public')).toBe(true);
  });

  test('sw.js is served uncacheable and scope-allowed', async () => {
    const route = routes[0];
    if (route === undefined) expect.unreachable('the sw route was not mounted');
    // Through a real `UltimateRequest` and a real `RequestContext`, `pwa-artifacts.test.ts`'s
    // shape: a cast would hide a dependency on either appearing later.
    const url = new URL(`http://dev.test${SERVICE_WORKER_PATH}`);
    const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
    const ctx = createRequestContext({ url, method: 'GET', role: 'web', config });
    const response = await route.handler(new UltimateRequest(new Request(url), ctx), ctx);

    // A cached `sw.js` is a worker that cannot be replaced: the browser re-fetches it to decide
    // whether an update exists, and an intermediary answering the old bytes pins every client to
    // the deploy that shipped them.
    expect(response.headers.get('cache-control')).toContain('max-age=0');
    // Without it the browser refuses to let a worker served from `/` control `/` — the failure
    // `assertScope` cannot see, because the scope a REGISTRATION asks for has to be allowed by the
    // script's own response and not only by its path.
    expect(response.headers.get('service-worker-allowed')).toBe('/');
    expect(response.headers.get('content-type')).toContain('javascript');
  });
});
