// The fixture the two `stream-hole*.e2e.test.ts` suites share: a `stream` page whose one hole the
// TEST holds open, served by the real page handler and pipeline under the ENFORCED policy a container
// sends, with the client router as the CLI builds it — and the levers a suite pulls on the wire: a
// held hole, a failing read, a body that dies after its shell, an answer held before it is sent.

import { afterAll, beforeAll, expect } from 'bun:test';
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
export const TIMEOUT_MS = 45_000;
/** Bounded well under the test's own, so a dead button fails here and names what never happened. */
export const WAIT_MS = 10_000;

const PRESS_ISLAND = `export function mount(el) {
  const button = el.querySelector('button');
  button.addEventListener('click', () => { button.textContent = 'answered'; });
}`;
const LATE_ISLAND = `export function mount(el) { el.textContent = 'late island mounted'; }`;

const ROUTER_ENTRY = fileURLToPath(
  new URL('../../render/src/navigation-entry.ts', import.meta.url),
);

const chunks: ReadonlyMap<string, string> = new Map([
  ['./press.island.tsx', '/islands/press.js'],
  ['./late.island.tsx', '/islands/late.js'],
]);

const asset = (path: string, body: string): Route => ({
  method: 'GET',
  path,
  meta: { name: path, auth: 'public' },
  handler: () => new Response(body, { headers: { 'content-type': 'text/javascript' } }),
});

const Press = island({ src: './press.island.tsx' });
const Late = island({ src: './late.island.tsx' });

// A foreign failure handed to the renderer: test input, never its verdict.
const READ_FAILED = new TypeError('the read under the hole failed');

/** What a suite sets and reads on the wire. One server per suite, one test at a time. */
export const wire = {
  /** Resolved by `closeHole()`: the held read then answers. */
  gate: new Promise<void>(() => undefined),
  open: (): void => undefined,
  /** The held read then fails, and the hole shows its error branch. */
  failing: false,
  /** The signal the held read ran under, as the hole handed it: what a read stops on. */
  heldSignal: undefined as AbortSignal | undefined,
  /** The next `?break` answer breaks; the real load that recovers it does not. */
  breakNext: false,
  /** Errors the broken answer's body, after its shell went out. */
  breakBody: (): void => undefined,
  /** Sends a `?hold` answer held before it was sent. */
  release: (): void => undefined,
  /** POSTs the server answered, by path: a POST is never re-sent. */
  posts: [] as string[],
  /** Waiting for the client to cancel a streamed answer, by path. */
  cancels: new Map<string, () => void>(),
};

export const closeHole = (): void => {
  wire.open();
};

/** The hole held until `closeHole()`, its read answering rather than failing. */
export const holdHole = (): void => {
  wire.failing = false;
  wire.gate = new Promise<void>((resolve) => {
    wire.open = resolve;
  });
};

/** Resolves when the client cancels its read of `path`. */
export const cancelOf = (path: string): Promise<void> =>
  new Promise<void>((resolve) => {
    wire.cancels.set(path, resolve);
  });

/** Under the hole: waits on the test, then renders an island the first flush knew nothing of. */
const HeldRead = async (): Promise<unknown> => {
  wire.heldSignal = tryUseContext()?.signal;
  await wire.gate;
  if (wire.failing) throw READ_FAILED;
  return h('section', { id: 'filled' }, h(Late, {}, 'late island shell'));
};

/**
 * A `?break` answer: the shell is passed through, then the body errors when the test says — a
 * connection that dies under a page already on screen, which no hole's error branch can stand for.
 */
const broken = (response: Response): Response => {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const failure = new Promise<void>((resolve) => {
    wire.breakBody = resolve;
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
      wire.cancels.get(path)?.();
      return reader.cancel(reason);
    },
  });
  return new Response(body, response);
};

function registerPages(): void {
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
}

async function pipelineFor(): Promise<ReturnType<typeof httpServer>> {
  const router = await buildNavigationScript(process.cwd(), { entry: ROUTER_ENTRY });
  if (router === undefined) return expect.unreachable('the client router did not build');
  return httpServer({
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
        resolveIsland: () => (src) =>
          chunks.get(src) ?? expect.unreachable(`unknown island ${src}`),
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
}

/** The wire's levers over the pipeline: `?hold`, `?break`, and a POST answered as the page. */
async function serve(pipeline: ReturnType<typeof httpServer>, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.has('hold')) {
    await new Promise<void>((resolve) => {
      wire.release = resolve;
    });
  }
  let asked = request;
  if (request.method === 'POST') {
    wire.posts.push(url.pathname);
    // The streamed page stands for a form's answer: rendered for the POST, as a GET.
    asked = new Request(request.url, { headers: request.headers });
  }
  const answer = watched(url.pathname, await pipeline.fetch(asked));
  if (!url.searchParams.has('break') || !wire.breakNext) return answer;
  wire.breakNext = false;
  return broken(answer);
}

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
/** `describe.skipIf(noBrowser)`: skipped with no Chrome, refused under `E2E_BROWSER_REQUIRED=1`. */
export const noBrowser = chrome === undefined && !required;

export interface StreamHoleRun {
  readonly tab: E2eTab;
  readonly base: string;
  readonly pipeline: ReturnType<typeof httpServer>;
}

/** The pages, the server and a tab for the calling suite; torn down with it. */
export function useStreamHole(): () => StreamHoleRun {
  let lease: E2eBrowserLease | undefined;
  let browser: E2eBrowser | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let run: StreamHoleRun | undefined;

  beforeAll(async () => {
    registerPages();
    const pipeline = await pipelineFor();
    server = Bun.serve({ port: 0, fetch: (request) => serve(pipeline, request) });
    lease = leaseE2eBrowser('cli:stream-hole', () =>
      required ? openE2eBrowser() : openE2eBrowserIfAvailable(),
    );
    browser = await lease.opened;
    if (browser === undefined) expect.unreachable('a browser was found and then would not open');
    const tab = await browser.session.newTab();
    run = { tab, base: `http://localhost:${String(server.port)}`, pipeline };
  }, E2E_BROWSER_OPEN_MS + E2E_TAB_OPEN_MS);

  afterAll(async () => {
    await run?.tab.close();
    await lease?.release();
    await server?.stop(true);
    clearRoutes();
  }, E2E_BROWSER_OPEN_MS);

  return () => run ?? expect.unreachable('the stream-hole suite has not started');
}

/** A fresh `/before`, marked, with the router listening: a full load is what loses the mark. */
export async function freshBefore(run: StreamHoleRun): Promise<void> {
  await run.tab.goto(`${run.base}/before`);
  await run.tab.waitFor('window.__xNavigation !== undefined', 'the router to start', WAIT_MS);
  await run.tab.evaluate('window.__kept = "same-document"');
}

/** Resolves once `signal` aborts — the moment, not a poll of it. */
export const aborted = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
