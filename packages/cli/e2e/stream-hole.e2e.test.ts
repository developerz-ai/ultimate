// `<Hole>` in a real Chrome, over the real page handler and the real pipeline, under the ENFORCED
// policy a container sends. The proof the generated `stream` default rests on: an inline module is
// deferred until parsing ends and a document with a hole open is still parsing, so without `async`
// on the runtime the press below reaches a dead button. The server, not a clock, holds the hole open.
//
//   bun test packages/cli/e2e/stream-hole.e2e.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no file-URL-to-path API; the router's entry is located beside this file.
import { fileURLToPath } from 'node:url';
import { tryUseContext } from '@ultimat3/core';
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

// A foreign failure handed to the renderer: test input, never its verdict.
const READ_FAILED = new TypeError('the read under the hole failed');

/** Set by a test: the held read then fails, and the hole shows its error branch. */
let failing = false;
/** Waiting for the client to cancel a streamed answer, by path. */
const cancels = new Map<string, () => void>();
const cancelOf = (path: string): Promise<void> =>
  new Promise<void>((resolve) => {
    cancels.set(path, resolve);
  });

/** The signal the held read ran under, as the hole handed it: what a read stops on. */
let heldSignal: AbortSignal | undefined;

/** Under the hole: waits on the test, then renders an island the first flush knew nothing of. */
const HeldRead = async (): Promise<unknown> => {
  heldSignal = tryUseContext()?.signal;
  await gate;
  if (failing) throw READ_FAILED;
  return h('section', { id: 'filled' }, h(Late, {}, 'late island shell'));
};

/** Set by a test: a `?break` answer errors its body here, after the shell went out. */
let breakBody = (): void => undefined;
/** Set by a test: the next `?break` answer breaks; the real load that recovers it does not. */
let breakNext = false;
/** Set by a test: a `?hold` answer is held here before it is sent. */
let release = (): void => undefined;
/** POSTs the server answered, by path: a POST is never re-sent. */
const posts: string[] = [];

/**
 * A `?break` answer: the shell is passed through, then the body errors when the test says — a
 * connection that dies under a page already on screen, which no hole's error branch can stand for.
 */
const broken = (response: Response): Response => {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const failure = new Promise<void>((resolve) => {
    breakBody = resolve;
  });
  let shellSent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (shellSent) {
        await failure;
        await reader.cancel();
        controller.error(new TypeError('the connection died under the page'));
        return;
      }
      const { done, value } = await reader.read();
      if (done) return controller.close();
      controller.enqueue(value);
      shellSent = new TextDecoder().decode(value).includes('<!--x:flush-->');
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, response);
};

/** The answer, passed through unchanged, noting when the client cancels its body. */
const watched = (path: string, response: Response): Response => {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      cancels.get(path)?.();
      return reader.cancel(reason);
    },
  });
  return new Response(body, response);
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
          h('a', { id: 'back', href: '/before' }, 'back'),
          h('a', { id: 'held', href: '/before?hold' }, 'held'),
          // Taller than the viewport: a fragment inside the hole is somewhere to scroll to.
          ...Array.from({ length: 120 }, (_, i) => h('p', {}, `line ${String(i)}`)),
          h(
            Hole,
            {
              fallback: h('p', { id: 'waiting' }, 'waiting'),
              error: h('p', { id: 'failed' }, 'could not load'),
            },
            h(HeldRead as never, {}),
          ),
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
      component: (() =>
        h(
          'main',
          {},
          h('a', { id: 'go', href: '/streamed' }, 'go'),
          h('a', { id: 'go-late', href: '/streamed#filled' }, 'go to the late part'),
          h('a', { id: 'go-broken', href: '/streamed?break#filled' }, 'go, then lose the line'),
          h('a', { id: 'go-broken-plain', href: '/streamed?break' }, 'go, then lose the line'),
        )) as never,
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
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.searchParams.has('hold')) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        let asked = request;
        if (request.method === 'POST') {
          posts.push(url.pathname);
          // The streamed page stands for a form's answer: rendered for the POST, as a GET.
          asked = new Request(request.url, { headers: request.headers });
        }
        const answer = watched(url.pathname, await pipeline.fetch(asked));
        if (!url.searchParams.has('break') || !breakNext) return answer;
        breakNext = false;
        return broken(answer);
      },
    });
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

  /** A fresh `/before`, marked, with the router listening: a full load is what loses the mark. */
  const before = async (): Promise<void> => {
    await tab.goto(`${base}/before`);
    await tab.waitFor('window.__xNavigation !== undefined', 'the router to start', WAIT_MS);
    await tab.evaluate('window.__kept = "same-document"');
  };

  const holdHole = (): void => {
    failing = false;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
  };

  // was: "a soft visit waits for the whole answer, then its holes fill and its islands hydrate"
  test(
    'a soft visit paints its shell while the hole is open; the hole then fills and hydrates',
    async () => {
      holdHole();
      await before();
      await tab.evaluate(`document.addEventListener('ultimate:navigated', (e) => {
        window.__navigated = { url: e.detail.url, open: document.getElementById('waiting') !== null };
      }, { once: true })`);
      await tab.pointerClick('#go');
      await tab.waitFor(
        'document.title === "streamed" && document.getElementById("waiting") !== null',
        'the shell to be swapped in with the hole still open',
        WAIT_MS,
      );
      // The event says the page landed while its hole is still held, not once the stream ended.
      expect(await tab.evaluate('window.__navigated')).toEqual({
        url: `${base}/streamed`,
        open: true,
      });
      expect(await tab.evaluate('document.getElementById("filled") === null')).toBe(true);
      await tab.pointerClick('#press');
      await tab.waitFor(
        'document.getElementById("press").textContent === "answered"',
        'the shell island to answer while the hole is open',
        WAIT_MS,
      );

      closeHole();
      await tab.waitFor('document.getElementById("filled") !== null', 'the hole to fill', WAIT_MS);
      expect(await tab.evaluate('document.getElementById("waiting") === null')).toBe(true);
      expect(await tab.evaluate('document.querySelector("template[data-x-hole]") === null')).toBe(
        true,
      );
      await tab.waitFor(
        'document.getElementById("filled").textContent === "late island mounted"',
        'the hole’s island to hydrate after the swap',
        WAIT_MS,
      );
      // The same document all along: a full load would have proved none of the above.
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
    },
    TIMEOUT_MS,
  );

  test(
    'a failed hole shows its error branch after a soft visit, not a blank box',
    async () => {
      holdHole();
      failing = true;
      await before();
      await tab.pointerClick('#go');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      closeHole();
      await tab.waitFor(
        'document.getElementById("failed")?.textContent === "could not load"',
        'the hole’s error branch',
        WAIT_MS,
      );
      expect(await tab.evaluate('document.getElementById("waiting") === null')).toBe(true);
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
    },
    TIMEOUT_MS,
  );

  test(
    'a second navigation cancels the first one’s open holes: nothing of it lands',
    async () => {
      holdHole();
      await before();
      await tab.pointerClick('#go');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      const cut = cancelOf('/streamed');
      await tab.pointerClick('#back');
      await tab.waitFor('document.title === "before"', 'the second page', WAIT_MS);
      // The server hears it: the open hole's request is cancelled, so its work stops. Never
      // cancelled, this waits out the test's own deadline, which names it.
      await cut;
      // And the read under the hole is told, while it is still held: its signal is what stops it.
      for (let i = 0; i < 100 && heldSignal?.aborted !== true; i += 1) await Bun.sleep(10);
      expect(heldSignal?.aborted).toBe(true);
      closeHole();
      expect(await tab.evaluate('document.getElementById("filled") === null')).toBe(true);
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
    },
    TIMEOUT_MS,
  );

  test(
    'stop() from an ultimate:navigated listener: the stopped router fills nothing',
    async () => {
      holdHole();
      await before();
      await tab.evaluate(
        "document.addEventListener('ultimate:navigated', () => window.__xNavigation.stop(), { once: true })",
      );
      const cut = cancelOf('/streamed');
      await tab.pointerClick('#go');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      // The stopped router cancels the answer it was still reading.
      await cut;
      closeHole();
      await Bun.sleep(300);
      expect(await tab.evaluate('document.getElementById("filled") === null')).toBe(true);
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
    },
    TIMEOUT_MS,
  );

  test(
    'a fragment inside a hole is scrolled to when the hole lands',
    async () => {
      holdHole();
      await before();
      await tab.pointerClick('#go-late');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      expect(await tab.evaluate('window.scrollY')).toBe(0);
      closeHole();
      await tab.waitFor('document.getElementById("filled") !== null', 'the hole to fill', WAIT_MS);
      await tab.waitFor(
        'window.scrollY > 0 && document.getElementById("filled").getBoundingClientRect().top < innerHeight',
        'the fragment the hole carried to be scrolled to',
        WAIT_MS,
      );
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
    },
    TIMEOUT_MS,
  );

  test(
    'a GET whose body dies after the shell is loaded for real, a fragment URL too',
    async () => {
      holdHole();
      await before();
      breakNext = true;
      await tab.pointerClick('#go-broken');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
      // The real load asks for the hole again: it is answered at once.
      gate = Promise.resolve();
      breakBody();
      await tab.waitFor(
        'window.__kept === undefined && document.getElementById("filled") !== null',
        'a full load of the page, whose URL only differs by its fragment',
        WAIT_MS,
      );
      expect(await tab.evaluate('location.pathname + location.search')).toBe('/streamed?break');
    },
    TIMEOUT_MS,
  );

  test(
    'a POST whose body dies after the shell: ultimate:navigation-error, and never sent again',
    async () => {
      holdHole();
      await before();
      posts.length = 0;
      await tab.evaluate(`document.addEventListener('ultimate:navigation-error', (e) => {
        e.preventDefault();
        window.__failed = e.detail;
      }, { once: true })`);
      breakNext = true;
      await tab.evaluate(
        `window.__xNavigation.navigate(${JSON.stringify(`${base}/streamed?break`)}, { method: 'POST', body: new FormData() })`,
      );
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      breakBody();
      await tab.waitFor('window.__failed !== undefined', 'the error event', WAIT_MS);
      expect(await tab.evaluate('window.__failed.method')).toBe('POST');
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
      expect(posts).toEqual(['/streamed']);
      closeHole();
    },
    TIMEOUT_MS,
  );

  test(
    'a body that dies while the next visit is still on its way leaves that visit alone',
    async () => {
      holdHole();
      await before();
      breakNext = true;
      await tab.pointerClick('#go-broken-plain');
      await tab.waitFor('document.getElementById("waiting") !== null', 'the shell', WAIT_MS);
      await tab.pointerClick('#held');
      breakBody();
      // Not sent back to the broken page's URL while the visitor's next page is coming.
      await Bun.sleep(300);
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
      release();
      await tab.waitFor('document.title === "before"', 'the next page', WAIT_MS);
      await Bun.sleep(300);
      expect(await tab.evaluate('location.pathname')).toBe('/before');
      expect(await tab.evaluate('window.__kept')).toBe('same-document');
      closeHole();
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
