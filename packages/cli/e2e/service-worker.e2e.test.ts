// The check issue #390's fourth requirement names, and the reason the worker could not ship
// before one existed: **"a real browser check that the emitted worker installs, activates and
// serves the fallback offline. Until it exists, do not ship the worker."**
//
//   bun test packages/cli/e2e
//
// A bad `sw.js` is sticky in a way no other artifact is. A manifest a browser dislikes is ignored;
// a worker that installs and caches wrong keeps serving wrong bytes until the user clears site
// data. So this drives the REAL emitted file in a REAL Chrome: registers it, waits for it to take
// control, takes the network away with `Network.emulateNetworkConditions`, and asserts what the
// page renders — which is the only place the answer exists.
//
// It skips with no browser and REFUSES to skip under `E2E_BROWSER_REQUIRED=1`, which `ci.yml`
// sets. `cdp-browser.e2e.test.ts` carries the reason.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PageLike } from '@ultimat3/testing';
import type { E2eBrowser } from '../src/cdp-browser';
import { openE2eBrowser, openE2eBrowserIfAvailable } from '../src/cdp-browser';
import { findChrome } from '../src/cdp-launch';
import { e2ePage } from '../src/e2e-page';
import { islandBundle } from '../src/island-bundle';
import type { PwaArtifacts } from '../src/pwa-artifacts';
import { SERVICE_WORKER_PATH, SW_REGISTER_PATH, serviceWorkerArtifacts } from '../src/sw-artifacts';
import { routeDescriptor } from './route-descriptor-fixture';

const BUILD_ID = 'sw-e2e-build';

/** Exactly what `loadPwaArtifacts` answers for an installable app, minus the manifest bytes. */
const pwa: PwaArtifacts = {
  body: '{}',
  head: '',
  offline: { fallback: '/offline', image: null, font: null, neverCache: [] },
  backgroundSync: false,
  push: false,
};

// Three routes, one per behaviour the worker has to get right: a precached document, the offline
// fallback itself, and a runtime page with nothing cached — which is the one that must fall back.
const artifacts = serviceWorkerArtifacts({
  pwa,
  buildId: BUILD_ID,
  routes: [
    routeDescriptor({ path: '/', surface: 'site', mode: 'static', offline: 'precache' }),
    routeDescriptor({ path: '/offline', surface: 'site', mode: 'static', offline: 'precache' }),
    routeDescriptor({ path: '/feed', surface: 'app', mode: 'ssr', offline: 'runtime' }),
  ],
  islands: islandBundle([]),
});
if (artifacts === undefined) expect.unreachable('an installable app with a fallback got no worker');

const MARKER = {
  home: 'home-document',
  offline: 'offline-document',
  feed: 'feed-document',
} as const;

/** Every document names itself, so an assertion can say WHICH one the browser resolved. */
const documentFor = (marker: string): string =>
  `<!doctype html><html lang="en"><head><title>${marker}</title>` +
  `<script src="${SW_REGISTER_PATH}" defer></script></head>` +
  `<body><h1>${marker}</h1></body></html>`;

const html = (body: string): Response =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

const server = Bun.serve({
  port: 0,
  fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    if (path === SERVICE_WORKER_PATH) {
      return new Response(artifacts.source, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'service-worker-allowed': '/',
          // `no-store`, exactly as `serviceWorkerRoutes` serves it: a cached `sw.js` is a worker
          // that cannot be replaced, and this fixture must not differ from the real route on the
          // one header that decides it.
          'cache-control': 'no-store',
        },
      });
    }
    if (path === SW_REGISTER_PATH) {
      return new Response(artifacts.register, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }
    if (path === '/offline') return html(documentFor(MARKER.offline));
    if (path === '/feed') return html(documentFor(MARKER.feed));
    if (path === '/') return html(documentFor(MARKER.home));
    return new Response('not found', { status: 404 });
  },
});
// `localhost`, never `127.0.0.1`: a service worker needs a secure context, and `localhost` is the
// one insecure origin every browser treats as one.
const baseUrl = `http://localhost:${String(server.port)}`;

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
console.log(
  chrome === undefined
    ? `sw e2e browser: none found${required ? ' — and one was required' : ' — skipping'}`
    : `sw e2e browser: ${chrome}`,
);

const HOOK_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 45_000;

let browser: E2eBrowser | undefined;
let page: PageLike;

/** The `<h1>` the browser actually resolved — the one fact this whole file exists to read. */
const heading = (): Promise<unknown> =>
  page.evaluate(() => document.querySelector('h1')?.textContent);

describe.skipIf(chrome === undefined && !required)(
  'the emitted service worker, in a browser',
  () => {
    beforeAll(async () => {
      browser = required ? await openE2eBrowser() : await openE2eBrowserIfAvailable();
      if (browser === undefined) expect.unreachable('a browser was found and then would not open');
      page = e2ePage({ page: browser.page, baseUrl });

      await page.goto('/');
      // Bounded IN THE PAGE, for `waitForServiceWorker`'s reason: one retry mechanism, and an
      // unbounded wait is a test that hangs instead of failing. `controllerchange` as well as
      // `ready`, because a worker that has activated is not yet the page's controller — an offline
      // assertion made in that window tests nothing.
      await page.waitForServiceWorker();
    }, HOOK_TIMEOUT_MS);

    afterAll(() => {
      browser?.close();
    });

    test(
      'it installs, activates and takes control of the page',
      async () => {
        expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
        // The precache ran: the worker `addAll`s its manifest at install, so the cache exists and
        // holds the fallback before any navigation has needed it.
        expect(
          await page.evaluate(() =>
            caches
              .open('x-precache-sw-e2e-build')
              .then((cache) => cache.match('/offline'))
              .then((hit) => hit !== undefined),
          ),
        ).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'a precached document renders offline, from the cache',
      async () => {
        await browser?.page.offline?.(true);
        try {
          await page.goto('/');
          expect(await heading()).toBe(MARKER.home);
        } finally {
          await browser?.page.offline?.(false);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'a runtime route with nothing cached falls back to the offline document',
      async () => {
        // Online first, and deliberately NOT visiting /feed: `networkFirst` would cache it, and a test
        // that asserts a fallback against a page the cache can answer proves nothing.
        await page.goto('/');
        await browser?.page.offline?.(true);
        try {
          await page.goto('/feed');

          // The fallback, not `/feed` — this single assertion is the whole of requirement 4.
          expect(await heading()).toBe(MARKER.offline);
        } finally {
          await browser?.page.offline?.(false);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      'back online, the network answers again rather than the cache',
      async () => {
        await page.goto('/feed');

        expect(await heading()).toBe(MARKER.feed);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

afterAll(() => {
  server.stop(true);
});
