// `<Hole>` in a real Chrome, over the real page handler and the real pipeline, under the ENFORCED
// policy a container sends. The proof the generated `stream` default rests on: an inline module is
// deferred until parsing ends and a document with a hole open is still parsing, so without `async`
// on the runtime the press below reaches a dead button. The server, not a clock, holds the hole open.
//
//   bun test packages/cli/e2e/stream-hole.e2e.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no file-URL-to-path API; the router's entry is located beside this file.
import { fileURLToPath } from 'node:url';
import type { Route } from '@ultimat3/http';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { clearRoutes, defineRoute, Hole, h, island, registerRoute } from '@ultimat3/render';
import { findChrome } from '@ultimat3/scraping/cdp';
import type { E2eBrowser, E2eBrowserLease, E2eTab } from '@ultimat3/testing';
import {
  E2E_BROWSER_OPEN_MS,
  E2E_TAB_OPEN_MS,
  leaseE2eBrowser,
  openE2eBrowser,
  openE2eBrowserIfAvailable,
} from '@ultimat3/testing';
import { appRoutes } from '../src/runtime-render';
import { inlineScriptSources } from '../src/script-csp';
import { styleBundle } from '../src/style-bundle';
import { styleRoutes } from '../src/style-routes';
import { buildNavigationScript } from '../src/worker-bundle';

const BUILD = 'stream-hole-build';
const TIMEOUT_MS = 45_000;
/** Bounded well under the test's own, so a dead button fails here and names what never happened. */
const WAIT_MS = 10_000;

const PRESS_ISLAND = `export function mount(el) {
  const button = el.querySelector('button');
  button.addEventListener('click', () => { button.textContent = 'answered'; });
}`;
const LATE_ISLAND = `export function mount(el) { el.textContent = 'late island mounted'; }`;

const ROUTER_ENTRY = fileURLToPath(
  new URL('../../render/src/navigation-entry.ts', import.meta.url),
);

const chunks: Readonly<Record<string, string>> = {
  './press.island.tsx': '/islands/press.js',
  './late.island.tsx': '/islands/late.js',
};

const asset = (path: string, body: string): Route => ({
  method: 'GET',
  path,
  meta: { name: path, auth: 'public' },
  handler: () => new Response(body, { headers: { 'content-type': 'text/javascript' } }),
});

let open = (): void => undefined;
let gate = new Promise<void>(() => undefined);
const closeHole = (): void => {
  open();
};

const Press = island({ src: './press.island.tsx' });
const Late = island({ src: './late.island.tsx' });

/** Under the hole: waits on the test, then renders an island the first flush knew nothing of. */
const HeldRead = async (): Promise<unknown> => {
  await gate;
  return h('section', { id: 'filled' }, h(Late, {}, 'late island shell'));
};

// At file scope: a skipped suite's hooks do not run, and the registry is process-global.
afterAll(() => {
  clearRoutes();
});

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const noBrowser = chrome === undefined && !required;

describe.skipIf(noBrowser)('stream · a hole open, in a browser, under the enforced policy', () => {
  let lease: E2eBrowserLease | undefined;
  let browser: E2eBrowser | undefined;
  let tab: E2eTab;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let pipeline: ReturnType<typeof httpServer>;
  let base = '';

  beforeAll(async () => {
    registerRoute({
      file: 'apps/web/app/streamed/page.tsx',
      config: defineRoute({
        render: 'stream',
        offline: 'network-only',
        hydrate: 'idle',
        budget: { js: '100kb' },
        meta: () => ({ title: 'streamed', description: 'a hole under the enforced policy' }),
      }),
      component: (() =>
        h(
          'main',
          {},
          h(Press, {}, h('button', { id: 'press', type: 'button' }, 'press me')),
          h(Hole, { fallback: h('p', { id: 'waiting' }, 'waiting') }, h(HeldRead as never, {})),
        )) as never,
    });
    registerRoute({
      file: 'apps/web/app/before/page.tsx',
      config: defineRoute({
        render: 'stream',
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '100kb' },
        meta: () => ({ title: 'before', description: 'the page a soft visit leaves' }),
      }),
      component: (() => h('main', {}, h('a', { id: 'go', href: '/streamed' }, 'go'))) as never,
    });
    const router = await buildNavigationScript(process.cwd(), { entry: ROUTER_ENTRY });
    if (router === undefined) expect.unreachable('the client router did not build');
    pipeline = httpServer({
      routes: [
        asset(router.url, router.code),
        asset('/islands/press.js', PRESS_ISLAND),
        asset('/islands/late.js', LATE_ISLAND),
        // The sheet the document links, served as `serve-web.ts` serves it: without it every
        // `/styles/*` the page asks for is a 404 the browser logs against the run.
        ...styleRoutes(() => styleBundle()),
        ...appRoutes({
          buildId: BUILD,
          navigation: {
            surfaces: new Set(['app']),
            scriptUrl: router.url,
            buildId: BUILD,
            app: 'web',
          },
          resolveIsland: () => (src) => chunks[src] ?? expect.unreachable(`unknown island ${src}`),
        }),
      ],
      role: 'web',
      config: defineHttpConfig({
        dev: false,
        buildId: BUILD,
        rateLimit: { enabled: false },
        // What `role-start.ts` sends: the framework's own list of inline bodies, by hash.
        security: {
          csp: {
            extend: { 'script-src': inlineScriptSources() },
            reportUri: null,
            reportOnly: false,
          },
        },
      }),
    });
    server = Bun.serve({ port: 0, fetch: (request) => pipeline.fetch(request) });
    base = `http://localhost:${String(server.port)}`;
    lease = leaseE2eBrowser('cli:stream-hole', () =>
      required ? openE2eBrowser() : openE2eBrowserIfAvailable(),
    );
    browser = await lease.opened;
    if (browser === undefined) expect.unreachable('a browser was found and then would not open');
    tab = await browser.session.newTab();
  }, E2E_BROWSER_OPEN_MS + E2E_TAB_OPEN_MS);

  afterAll(async () => {
    await tab?.close();
    await lease?.release();
    await server?.stop(true);
  }, E2E_BROWSER_OPEN_MS);

  test(
    'a shell island answers a press while the hole is open; the hole then fills and hydrates',
    async () => {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      // Not `goto`: it waits for the load event, and that is the very thing a hole holds back.
      await tab.evaluate(`location.href = ${JSON.stringify(`${base}/streamed`)}`);
      await tab.waitFor(
        'document.getElementById("press") !== null && document.getElementById("waiting") !== null',
        'the first flush to arrive with the hole still open',
        WAIT_MS,
      );
      expect(await tab.evaluate('document.readyState')).toBe('loading');

      await tab.waitFor(
        'document.querySelector("[data-x-island] button") !== null && document.querySelector("[data-x-mounted]") !== null',
        'the shell island to mount while the document is still parsing',
        WAIT_MS,
      );
      await tab.pointerClick('#press');
      await tab.waitFor(
        'document.getElementById("press").textContent === "answered"',
        'the shell island to answer the press',
        WAIT_MS,
      );
      // Before the reveal, or the runtime waited for the hole and this proves nothing.
      expect(await tab.evaluate('document.getElementById("waiting") !== null')).toBe(true);
      expect(await tab.evaluate('document.querySelector("x-hole") !== null')).toBe(true);

      closeHole();
      await tab.waitFor('document.getElementById("filled") !== null', 'the hole to fill', WAIT_MS);
      expect(await tab.evaluate('document.getElementById("waiting") === null')).toBe(true);
      await tab.waitFor(
        'document.getElementById("filled").textContent === "late island mounted"',
        'the island the first flush never knew of to hydrate from its chunk',
        WAIT_MS,
      );
      await tab.waitFor('document.readyState === "complete"', 'the document to close', WAIT_MS);
    },
    TIMEOUT_MS,
  );

  test(
    'a soft visit waits for the whole answer, then its holes fill and its islands hydrate',
    async () => {
      gate = Promise.resolve();
      await tab.goto(`${base}/before`);
      await tab.waitFor('window.__xNavigation !== undefined', 'the router to start', WAIT_MS);
      await tab.evaluate('window.__kept = "same-document"');
      await tab.pointerClick('#go');
      await tab.waitFor(
        'document.getElementById("filled") !== null',
        'the swapped document’s hole to fill through its re-run scripts',
        WAIT_MS,
      );
      expect(await tab.evaluate('document.querySelector("template[data-x-hole]") === null')).toBe(
        true,
      );
      await tab.waitFor(
        'document.getElementById("filled").textContent === "late island mounted"',
        'the hole’s island to hydrate after the swap',
        WAIT_MS,
      );
      await tab.pointerClick('#press');
      await tab.waitFor(
        'document.getElementById("press").textContent === "answered"',
        'the shell island to answer after the swap',
        WAIT_MS,
      );
      // The same document all along: a full load would have proved none of the above.
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
    },
    TIMEOUT_MS,
  );

  test(
    'the policy is enforced, so what ran above ran because its hash is listed',
    async () => {
      gate = Promise.resolve();
      const response = await pipeline.fetch(new Request(`${base}/streamed`));
      expect(response.headers.get('content-security-policy')).toContain('script-src');
      expect(response.headers.get('content-security-policy-report-only')).toBeNull();
      await response.text();
    },
    TIMEOUT_MS,
  );
});
