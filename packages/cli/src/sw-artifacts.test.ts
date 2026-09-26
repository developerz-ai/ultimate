// The emitter, without a browser. What belongs here is what the browser check cannot say cheaply:
// which routes cross into the worker, which do not, and what the register script is. The two
// headers are `sw-routes.test.ts`; the behaviour — installs, activates, serves the fallback
// offline — is `e2e/service-worker.e2e.test.ts`, in a real Chrome.

import { describe, expect, test } from 'bun:test';
import { contentHash } from '@ultimat3/render/server';
import { routeDescriptor } from '../e2e/route-descriptor-fixture';
import { islandBundle } from './island-bundle';
import type { PwaArtifacts } from './pwa-artifacts';
import { styleBundleOf } from './style-bundle';
import type { RenderedDocument, ServiceWorkerArtifacts } from './sw-artifacts';
import {
  SERVICE_WORKER_PATH,
  SW_REGISTER_PATH,
  SW_UPDATE_INTERVAL_MS,
  serviceWorkerArtifacts,
  serviceWorkerHead,
} from './sw-artifacts';

const BUILD_ID = 'build-7';

const pwa = (patch: Partial<PwaArtifacts> = {}): PwaArtifacts => ({
  body: '{}',
  head: '<link rel="manifest" href="/manifest.webmanifest">',
  manifests: [],
  headFor: () => '<link rel="manifest" href="/manifest.webmanifest">',
  offline: {
    fallback: '/offline',
    image: null,
    font: null,
    neverCache: [],
    personalPages: 'never',
  },
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
    styles: styleBundleOf([]),
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
        pwa: pwa({
          offline: {
            fallback: null,
            image: null,
            font: null,
            neverCache: [],
            personalPages: 'never',
          },
        }),
        buildId: BUILD_ID,
        routes: ROUTES,
        islands: islandBundle([]),
        styles: styleBundleOf([]),
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
      offline: {
        fallback: '/offline',
        image: null,
        font: null,
        neverCache: ['/auth'],
        personalPages: 'never',
      },
    }).source;

    expect(source).toContain('/auth');
  });
});

// The surface stylesheet is an `immutable`, content-addressed file exactly as an island chunk is,
// so it belongs in the precache manifest for the same reason: a document reached offline with no
// CSS is a page the visitor cannot read. It rode nowhere until 2026-09-06, because the CSS was
// inside the document.
describe('the precache manifest', () => {
  test('names every surface stylesheet beside every island chunk', () => {
    const styles = styleBundleOf([
      { surface: 'site', css: '.hero{color:red}' },
      { surface: 'app', css: '.feed{color:blue}' },
    ]);
    const built = serviceWorkerArtifacts({
      pwa: pwa(),
      buildId: BUILD_ID,
      routes: ROUTES,
      islands: islandBundle([]),
      styles,
    });
    if (built === undefined) expect.unreachable('an app with a fallback got no service worker');

    for (const chunk of styles.chunks) {
      expect(built.source).toContain(chunk.url);
    }
  });

  // An offline reload that cannot load the page boot restores no persisted record, so the like a
  // visitor took offline reads the old count — the framework scripts ride the manifest too.
  test('names the page boot and the sync worker, keyed by their source-addressed URL', () => {
    const scripts = [
      { url: '/_x/page-boot/1a2b3c4d.js', bytes: 35_000 },
      { url: '/_x/sync-worker/5e6f7a8b.js', bytes: 24_000 },
    ];
    const built = serviceWorkerArtifacts({
      pwa: pwa(),
      buildId: BUILD_ID,
      routes: ROUTES,
      islands: islandBundle([]),
      styles: styleBundleOf([]),
      scripts,
    });
    if (built === undefined) expect.unreachable('an app with a fallback got no service worker');
    for (const script of scripts) {
      const entry = built.precache.entries.find((candidate) => candidate.url === script.url);
      expect(entry?.revision).toBe(script.url);
      expect(built.source).toContain(script.url);
    }
  });
});

// `precache.ts`' own header: "the revision is the content hash, never the build id, or every
// deploy would re-fetch everything". Every route entry carried `revision: <buildId>` and
// `bytes: 0` — `pwaRoutes` projected four of `PwaRoute`'s fields and neither of these two — so two
// deploys of a byte-identical site invalidated every precached document, and the precache budget
// could not count one byte of HTML.
describe('a route revision is its document, not the deploy', () => {
  const HTML = '<!doctype html><title>home</title>';

  const documents = (): ReadonlyMap<string, RenderedDocument> =>
    new Map([['/', { revision: contentHash(HTML), bytes: Buffer.byteLength(HTML, 'utf8') }]]);

  const built = (buildId: string): ServiceWorkerArtifacts => {
    const artifacts = serviceWorkerArtifacts({
      pwa: pwa(),
      buildId,
      routes: ROUTES,
      islands: islandBundle([]),
      styles: styleBundleOf([]),
      documents: documents(),
    });
    if (artifacts === undefined) expect.unreachable('an app with a fallback got no worker');
    return artifacts;
  };

  const entryFor = (artifacts: ServiceWorkerArtifacts, url: string) =>
    artifacts.precache.entries.find((entry) => entry.url === url);

  test('two builds of one document agree on the revision, whatever the build id', () => {
    const a = entryFor(built('build-aaa'), '/');
    const b = entryFor(built('build-bbb'), '/');

    expect(a?.revision).toBe(contentHash(HTML));
    expect(a?.revision).toBe(b?.revision ?? 'no entry');
    // The defect, spelled as the thing that must not happen again.
    expect(a?.revision).not.toBe('build-aaa');
  });

  test('the bytes are the document`s, so the precache budget can count HTML', () => {
    const entry = entryFor(built('build-aaa'), '/');
    expect(entry?.bytes).toBe(Buffer.byteLength(HTML, 'utf8'));
    expect(built('build-aaa').precache.totalBytes).toBeGreaterThan(0);
  });

  // A route no build rendered — an `ssr` page, or a document this pass could not produce — keeps
  // the build id, which is `buildPrecacheManifest`'s own default. Inventing a hash for bytes that
  // do not exist would be a revision that never changes when the page does.
  test('a route with no rendered document keeps the build id', () => {
    const entry = entryFor(built('build-aaa'), '/offline');
    expect(entry?.revision).toBe('build-aaa');
    expect(entry?.bytes).toBe(0);
  });

  // The offline document is the one entry `buildPrecacheManifest` adds itself, before any route,
  // and `add()` keeps the first per url — so `offlineFallbackRevision` is what decides it, and
  // nothing fed one until `@ultimat3/pwa` grew the pair. The single page an offline navigation
  // depends on was re-downloaded on every deploy.
  test('the offline document takes its hash and bytes from the same pass', () => {
    const html = '<!doctype html><title>offline</title>';
    const artifacts = serviceWorkerArtifacts({
      pwa: pwa(),
      buildId: 'build-aaa',
      routes: ROUTES,
      islands: islandBundle([]),
      styles: styleBundleOf([]),
      documents: new Map([
        ['/offline', { revision: contentHash(html), bytes: Buffer.byteLength(html, 'utf8') }],
      ]),
    });
    if (artifacts === undefined) expect.unreachable('an app with a fallback got no worker');
    const entry = artifacts.precache.entries.find((row) => row.url === '/offline');

    expect(entry?.revision).toBe(contentHash(html));
    expect(entry?.bytes).toBe(Buffer.byteLength(html, 'utf8'));
    // The entry the fallback SHADOWS is the route of the same url, so there is exactly one and it
    // is not the build id.
    expect(artifacts.precache.entries.filter((row) => row.url === '/offline')).toHaveLength(1);
    expect(entry?.revision).not.toBe('build-aaa');
  });

  test('the head is the same string with or without a document list', () => {
    // `serviceWorkerHead` is what a caller needs BEFORE the render loop, and it must be the tag
    // this function emits or the documents name a script the export does not carry.
    expect(serviceWorkerHead(pwa())).toBe(built('build-aaa').head);
    // And an app with no fallback gets no worker and therefore no tag — one predicate, read twice.
    expect(
      serviceWorkerHead(
        pwa({
          offline: {
            fallback: null,
            image: null,
            font: null,
            neverCache: [],
            personalPages: 'never',
          },
        }),
      ),
    ).toBeUndefined();
  });
});

/**
 * The register script, EXECUTED against a stub `navigator` / `document` / clock. A browser checks
 * for a new `sw.js` on a navigation, so a tab left open for days found the new worker only on the
 * click the old one had already answered. The script asks again when a hidden tab comes back —
 * throttled, and never with a reload or a `skip-waiting` (the worker skips waiting itself).
 */
describe('the register script, executed', () => {
  function run() {
    let now = 1_000_000;
    let visibility: 'visible' | 'hidden' = 'visible';
    let updates = 0;
    let reloads = 0;
    const posted: unknown[] = [];
    const onLoad: (() => void)[] = [];
    const onVisibility: (() => void)[] = [];
    const registration = {
      update: async (): Promise<void> => {
        updates += 1;
      },
      waiting: { postMessage: (data: unknown): void => void posted.push(data) },
    };
    const navigatorStub = {
      serviceWorker: {
        register: async (path: string, options: { scope: string }) => {
          expect([path, options.scope]).toEqual([SERVICE_WORKER_PATH, '/']);
          return registration;
        },
      },
    };
    const documentStub = {
      get visibilityState() {
        return visibility;
      },
      addEventListener: (type: string, fn: () => void): void => {
        if (type === 'visibilitychange') onVisibility.push(fn);
      },
    };
    const script = new Function(
      'navigator',
      'addEventListener',
      'document',
      'Date',
      'location',
      build().register,
    ) as (...args: unknown[]) => void;
    script(
      navigatorStub,
      (type: string, fn: () => void) => (type === 'load' ? onLoad.push(fn) : undefined),
      documentStub,
      { now: () => now },
      {
        reload: (): void => {
          reloads += 1;
        },
      },
    );
    return {
      load: async (): Promise<void> => {
        for (const fn of onLoad) fn();
        await Bun.sleep(0);
      },
      show: async (elapsedMs: number): Promise<void> => {
        now += elapsedMs;
        visibility = 'hidden';
        for (const fn of onVisibility) fn();
        visibility = 'visible';
        for (const fn of onVisibility) fn();
        await Bun.sleep(0);
      },
      updates: (): number => updates,
      reloads: (): number => reloads,
      posted,
    };
  }

  test('a tab that comes back after the interval asks the browser for a new worker', async () => {
    const page = run();
    await page.load();
    expect(page.updates()).toBe(0);

    await page.show(SW_UPDATE_INTERVAL_MS);
    expect(page.updates()).toBe(1);
  });

  test('a tab refocused inside the interval does not re-download the worker', async () => {
    const page = run();
    await page.load();
    await page.show(SW_UPDATE_INTERVAL_MS - 1);
    expect(page.updates()).toBe(0);
    await page.show(1);
    await page.show(1_000);
    expect(page.updates()).toBe(1);
  });

  test('it never reloads the page and never posts skip-waiting — the worker skips on its own', async () => {
    const page = run();
    await page.load();
    await page.show(SW_UPDATE_INTERVAL_MS);
    expect(page.reloads()).toBe(0);
    expect(page.posted).toEqual([]);
  });
});
