// The emitter, without a browser. What belongs here is what the browser check cannot say cheaply:
// which routes cross into the worker, which do not, what the register script is, and the two
// headers a worker that must be replaceable depends on. The behaviour — installs, activates,
// serves the fallback offline — is `e2e/service-worker.e2e.test.ts`, in a real Chrome.

import { describe, expect, test } from 'bun:test';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import { routeDescriptor } from '../e2e/route-descriptor-fixture';
import { islandBundle } from './island-bundle';
import type { PwaArtifacts } from './pwa-artifacts';
import type { ServiceWorkerArtifacts } from './sw-artifacts';
import {
  SERVICE_WORKER_PATH,
  SW_REGISTER_PATH,
  serviceWorkerArtifacts,
  serviceWorkerRoutes,
} from './sw-artifacts';

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

describe('serviceWorkerArtifacts', () => {
  test('an app with no offline fallback gets no worker at all', () => {
    // Never a path the framework invented: offline, a cached 404 answers every navigation, and
    // the app has no way to tell that from a fallback that is simply empty.
    expect(
      serviceWorkerArtifacts({
        pwa: pwa({ offline: { fallback: null, image: null, font: null, neverCache: [] } }),
        buildId: BUILD_ID,
        routes: ROUTES,
        islands: islandBundle([]),
      }),
    ).toBeUndefined();
  });

  test('the two navigable surfaces cross, and api/ and shared/ do not', () => {
    const source = build().source;

    expect(source).toContain('/feed');
    expect(source).toContain('/offline');
    // An API response is a JSON document whose freshness is the app's business, and precaching one
    // serves a stale answer to a client that had a network.
    expect(source).not.toContain('/api/posts');
    // `shared/` is not a URL at all — the surface exists so two routes can import one module.
    expect(source).not.toContain('/shared/x');
  });

  test('the emitted worker is byte-identical for identical input', () => {
    // The whole reason `sw.js` is generated rather than written: an update check that fires on a
    // no-op deploy re-downloads every precached asset for every client.
    expect(build().source).toBe(build().source);
  });

  test('the head names the register script, and the register script is external', () => {
    const artifacts = build();

    expect(artifacts.head).toBe(`<script src="${SW_REGISTER_PATH}" defer></script>`);
    // NEVER inline: `startWeb` computes a `script-src` sha256 per inline script, so an unhashed
    // one is blocked in the container while passing report-only under `x dev` — which is how the
    // hydration runtime shipped broken once already.
    expect(artifacts.head).not.toContain('navigator.serviceWorker');
    expect(artifacts.register).toContain(`register("${SERVICE_WORKER_PATH}"`);
    expect(artifacts.register).toContain('scope: "/"');
    // A registration that throws where service workers are disabled — an incognito profile, an
    // enterprise policy — must not take an otherwise working page down with it.
    expect(artifacts.register).toContain('.catch(');
  });

  test('backgroundSync is read, and its handler is absent without it', () => {
    // On the LISTENER, never the word `sync`: `async function cacheFirst` contains it, so the
    // obvious assertion passes on a worker with no background sync at all — a test that cannot
    // fail, which is the thing this repo bans outright.
    expect(build().source).not.toContain("addEventListener('sync'");
    expect(build({ backgroundSync: true }).source).toContain("addEventListener('sync'");
  });

  test('pwa.push with no VAPID key is a WARNING, because the generator drops it in silence', () => {
    // `generateServiceWorker` emits a push handler only when a VAPID key comes with the
    // capability. There is no `pwa.vapid` key yet, so `push: true` wires nothing — and wiring
    // nothing while reporting nothing is `jobs.driver`'s shape one package over.
    expect(build().source).not.toContain("addEventListener('push'");
    expect(build({ push: true }).source).not.toContain("addEventListener('push'");
    expect(build({ push: true }).warnings.join(' ')).toContain('no VAPID key is configured');
    expect(build().warnings).toEqual([]);
  });

  test('neverCache reaches the worker, so an auth path is never answered from a cache', () => {
    const source = build({
      offline: { fallback: '/offline', image: null, font: null, neverCache: ['/auth'] },
    }).source;

    expect(source).toContain('/auth');
  });
});

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
