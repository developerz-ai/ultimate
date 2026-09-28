// The fixture the four `client-navigation-*.e2e.test.ts` suites share: the client router
// (`@ultimat3/render/navigation`) as the CLI builds it, served by `@ultimat3/http`'s REAL pipeline —
// its navigation gate, its redirect hand-over, its build check and an ENFORCED content security
// policy — over documents shaped like `runtime-render.ts`'s. Every route counts its own executions
// in `ran`, because the claim is not "the page looks right": it is that a GET some app records
// evidence on runs exactly once, a prefetch runs nothing a route did not opt into, and a POST is
// never sent twice. One server per test process, `unref`'d: the suites share it, and none stops it
// under another.

import { afterAll, beforeAll, expect } from 'bun:test';
// why: Bun has no file-URL-to-path API; the router's entry is located beside this file.
import { fileURLToPath } from 'node:url';
import type { Route, RouteNavigation } from '@ultimat3/http';
import { createServer, cspHashSource, defineHttpConfig, redirect } from '@ultimat3/http';
import type { IslandDirective } from '@ultimat3/render';
import {
  clientNavigationTags,
  emitIslandAttributes,
  emitIslandProps,
  HYDRATE_RUNTIME_BODIES,
  hydrateRuntime,
  renderHead,
} from '@ultimat3/render';
import type { E2eBrowser, E2eTab } from '@ultimat3/testing';
import { findChrome, openE2eBrowser, openE2eBrowserIfAvailable } from '@ultimat3/testing';
import { buildNavigationScript } from '../src/worker-bundle';

const ENTRY = fileURLToPath(new URL('../../render/src/navigation-entry.ts', import.meta.url));
const script = await buildNavigationScript(process.cwd(), { entry: ENTRY });
if (script === undefined) expect.unreachable('the client router did not build');
export const BUILD = 'b1';
export const APP = 'web:app';

/** Every island mounts by writing its name and returns a disposer that records it. */
const ISLAND = `export function mount(el, props) {
  (window.__mounts = window.__mounts || []).push(props.name);
  el.textContent = 'mounted:' + props.name;
  return () => (window.__disposed = window.__disposed || []).push(props.name);
}`;

const islandMarkup = (name: string): { html: string; directive: IslandDirective } => {
  const directive: IslandDirective = {
    islandId: `island-${name}`,
    strategy: 'idle',
    entry: '/island.js',
    props: { name },
  };
  return {
    directive,
    html: `<div ${emitIslandAttributes(directive)}>${emitIslandProps(directive)}server:${name}</div>`,
  };
};

interface Doc {
  readonly title: string;
  readonly path: string;
  readonly surface?: string;
  readonly head?: string;
  readonly body?: string;
  readonly islands?: readonly string[];
  /** `ultimate-scope`: the principal this document was rendered for. */
  readonly scope?: string;
  /** `false` for a `navigation: 'document'` page: `runtime-render.ts` names no router on it. */
  readonly router?: boolean;
}

/** The persisted shell: a nav whose current item carries `aria-current` and the class that styles it. */
const shell = (path: string, island: string): string =>
  `<aside data-x-persist="shell" id="kept"><nav>${['/a', '/b']
    .map((href) =>
      href === path
        ? `<a href="${href}" class="on" aria-current="page">${href}</a>`
        : `<a href="${href}">${href}</a>`,
    )
    .join('')}</nav>${island}</aside>`;

const LINKS = [
  ['to-a', '/a'],
  ['to-b', '/b'],
  ['to-site', '/site'],
  ['to-json', '/data.json'],
  ['to-missing', '/missing'],
  ['to-slow', '/slow'],
  ['to-eager', '/eager'],
  ['to-eager-ns', '/eager-ns'],
  ['to-flaky', '/flaky'],
  ['to-evidence', '/evidence'],
  ['to-download', '/download'],
  ['to-doc', '/doc'],
  ['to-boom', '/boom'],
]
  .map(([id, href]) => `<a id="${id}" href="${href}">${id}</a>`)
  .join(' ');

const FORMS =
  '<form id="search" action="/search"><input name="q" value="tutela"></form>' +
  '<form id="post" method="post" action="/submit"><input name="name" value="ada"></form>' +
  '<form id="export" method="post" action="/export"><input name="id" value="7"></form>' +
  '<form id="pay" method="post" action="/pay"><input name="amount" value="1"></form>' +
  '<form id="switch" method="post" action="/switch"><input name="to" value="member:2"></form>';

/** An app's own inline head script, admitted by hash like every inline script under the CSP. */
export const INLINE_HEAD = 'window.__inlineRan = (window.__inlineRan || 0) + 1;';

/** The document shape `runtime-render.ts` emits: head tags, then body, then the runtime. */
const documentOf = (doc: Doc): string => {
  const kept = islandMarkup('shell');
  const islands = (doc.islands ?? []).map(islandMarkup);
  const nav =
    doc.router === false
      ? ''
      : renderHead(
          clientNavigationTags({
            surface: doc.surface ?? APP,
            buildId: BUILD,
            scriptUrl: script.url,
          }),
        );
  return (
    `<!doctype html><html lang="en"><head><title>${doc.title}</title>` +
    `<meta name="description" content="about ${doc.title}">${nav}${doc.head ?? ''}` +
    (doc.scope === undefined ? '' : `<meta name="ultimate-scope" content="${doc.scope}">`) +
    '</head><body>' +
    shell(doc.path, kept.html) +
    `<main><h1>${doc.title}</h1>${LINKS} <a id="to-hash" href="#below">hash</a>` +
    ` <a id="to-reload" href="/b" data-x-reload>reload</a>${FORMS}${doc.body ?? ''}` +
    `${islands.map((i) => i.html).join('')}<p id="below">below</p></main>` +
    hydrateRuntime([kept.directive, ...islands.map((i) => i.directive)]) +
    '</body></html>'
  );
};

/** Every execution of every route, as `METHOD /path purpose` — the verdict of this whole file. */
export const ran: string[] = [];
export const count = (line: string): number => ran.filter((one) => one === line).length;

const html = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });

const nav = (patch: Partial<RouteNavigation> = {}): RouteNavigation => ({
  surface: APP,
  prefetch: false,
  ...patch,
});

type Handler = (request: Request, url: URL) => Response | Promise<Response>;

const route = (
  method: 'GET' | 'POST',
  path: string,
  handler: Handler,
  navigation?: RouteNavigation,
): Route => ({
  method,
  path,
  meta: { name: path, auth: 'public', ...(navigation === undefined ? {} : { navigation }) },
  handler: (request) => {
    ran.push(`${method} ${path} ${request.raw.headers.get('x-ultimate-navigation') ?? 'full'}`);
    return handler(request.raw, request.url);
  },
});

const asset = (path: string, body: string, type: string, delayMs = 0): Route => ({
  method: 'GET',
  path,
  meta: { name: path, auth: 'public' },
  handler: async () => {
    if (delayMs > 0) await Bun.sleep(delayMs);
    return new Response(body, { headers: { 'content-type': type } });
  },
});

const page = (
  path: string,
  doc: (url: URL) => Doc,
  // `null`: not a page the router may swap in. (`undefined` would take this default.)
  navigation: RouteNavigation | null = nav(),
  answer: { status?: number; headers?: Record<string, string> } = {},
): Route =>
  route(
    'GET',
    path,
    (_request, url) => html(documentOf(doc(url)), answer.status, answer.headers),
    navigation ?? undefined,
  );

/** Mutable per-route counters a suite resets and reads. */
export const state = { flaky: 0, paid: 0 };
const other = Bun.serve({
  port: 0,
  fetch(request): Response {
    // The page only: the browser also asks this origin for its favicon.
    if (new URL(request.url).pathname === '/paid') state.paid += 1;
    return html('<!doctype html><title>Paid</title><h1>Paid</h1>');
  },
});
const OTHER = `http://127.0.0.1:${String(other.port)}`;

const routes: Route[] = [
  asset(script.url, script.code, 'text/javascript'),
  asset('/island.js', ISLAND, 'text/javascript'),
  asset('/head.js', 'window.__headRan = (window.__headRan || 0) + 1;', 'text/javascript'),
  asset('/a.css', 'h1 { word-spacing: 1px }', 'text/css'),
  // Held back, so a swap that did not wait for it would read the unstyled heading.
  asset('/b.css', 'h1 { letter-spacing: 3px }', 'text/css', 300),
  page('/a', () => ({
    title: 'A',
    path: '/a',
    islands: ['a'],
    head: '<link rel="stylesheet" href="/a.css"><script type="application/ld+json">{"name":"A"}</script>',
  })),
  page('/b', () => ({
    title: 'B',
    path: '/b',
    islands: ['b'],
    head:
      '<link rel="stylesheet" href="/b.css"><script type="application/ld+json">{"name":"B"}</script>' +
      `<script src="/head.js" defer></script><script>${INLINE_HEAD}</script>`,
  })),
  page(
    '/site',
    () => ({ title: 'Site', path: '/site', surface: 'web:site' }),
    nav({ surface: 'web:site' }),
  ),
  page('/missing', () => ({ title: 'Not found', path: '/missing' }), nav(), { status: 404 }),
  page('/eager', () => ({ title: 'Eager', path: '/eager' }), nav({ prefetch: true })),
  page('/eager-ns', () => ({ title: 'Eager NS', path: '/eager-ns' }), nav({ prefetch: true }), {
    headers: { 'cache-control': 'private, no-store' },
  }),
  route(
    'GET',
    '/flaky',
    () => {
      state.flaky += 1;
      return state.flaky === 1
        ? html('<!doctype html><title>Broken</title>', 500)
        : html(documentOf({ title: 'Flaky', path: '/flaky' }));
    },
    nav({ prefetch: true }),
  ),
  route(
    'GET',
    '/slow',
    async () => {
      // Slower than the navigation that overtakes it.
      await Bun.sleep(1_500);
      return html(documentOf({ title: 'Slow', path: '/slow' }));
    },
    nav(),
  ),
  page('/search', (url) => ({
    title: `Search ${url.searchParams.get('q') ?? ''}`,
    path: '/search',
  })),
  page('/done', (url) => ({ title: `Done ${url.searchParams.get('name') ?? ''}`, path: '/done' })),
  // A page that must be a real document load — a recipient's open, a token consumed.
  page('/doc', () => ({ title: 'Doc', path: '/doc', router: false }), null),
  // Not pages at all: an evidence GET, a download, JSON.
  route(
    'GET',
    '/evidence',
    () => new Response('recorded', { headers: { 'content-type': 'text/plain' } }),
  ),
  route(
    'GET',
    '/download',
    () =>
      new Response('zip-bytes', {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="evidencia.zip"',
        },
      }),
  ),
  route('GET', '/data.json', () => Response.json({ ok: true })),
  route('POST', '/submit', async (request) => {
    const name = (await request.formData()).get('name');
    return redirect(`/done?name=${String(name)}`, 303);
  }),
  route(
    'POST',
    '/export',
    () =>
      new Response('zip-bytes', {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename*=UTF-8''constancia%20n%C2%BA7.zip`,
        },
      }),
  ),
  route('POST', '/pay', () => redirect(`${OTHER}/paid`, 303)),
  // Answered in place, for someone else: a sign-in that renders instead of redirecting.
  route('POST', '/switch', () =>
    html(documentOf({ title: 'Switched', path: '/switch', scope: 'member:2' })),
  ),
  // A page whose load wrote and then threw: the framework's own error page answers it.
  route(
    'GET',
    '/boom',
    () => {
      throw new TypeError('the load wrote, then failed');
    },
    nav(),
  ),
];

const pipeline = createServer({
  routes,
  role: 'web',
  config: defineHttpConfig({
    dev: false,
    buildId: BUILD,
    rateLimit: { enabled: false },
    // ENFORCED, with the one inline script admitted by hash — as `x dev` and the container do.
    security: {
      csp: {
        extend: { 'script-src': [...HYDRATE_RUNTIME_BODIES, INLINE_HEAD].map(cspHashSource) },
        reportUri: null,
        reportOnly: false,
      },
    },
  }),
});
/** Every REQUEST the browser sent a page route, as `METHOD /path purpose` — a refused one too. */
export const requests: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/_x/') && !/\.(js|css)$/.test(url.pathname)) {
      requests.push(
        `${request.method} ${url.pathname} ${request.headers.get('x-ultimate-navigation') ?? 'full'}`,
      );
    }
    return pipeline.fetch(request);
  },
});
server.unref();
other.unref();
export const base = `http://localhost:${String(server.port)}`;

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
/** `describe.skipIf(noBrowser)`: skipped with no Chrome, refused under `E2E_BROWSER_REQUIRED=1`. */
export const noBrowser = chrome === undefined && !required;
export const TIMEOUT_MS = 45_000;

let browser: E2eBrowser | undefined;
let tab: E2eTab;

/** The open browser, for a suite that needs a second tab or the offline switch. */
export const session = (): E2eBrowser | undefined => browser;
/** The suite's tab. */
export const currentTab = (): E2eTab => tab;

/** A hook's own deadline — above the browser's 30 s launch budget, never Bun's 5 s default. */
const HOOK_TIMEOUT_MS = 60_000;

/**
 * Opens this suite's own browser and tab; call inside the suite's `describe`. Deterministic both
 * ways, because the suites share one test process with every other suite of the package: the close
 * is AWAITED until Chrome has exited (a browser still shutting down slowed the next suite's launch
 * past its deadline on a 4-CPU runner), and a launch that outlived its `beforeAll` — whose hook
 * already failed — is still waited for and closed in `afterAll`, or it would keep the process alive.
 */
export function useBrowser(): void {
  let opening: Promise<E2eBrowser | undefined> | undefined;
  beforeAll(async () => {
    opening = required ? openE2eBrowser() : openE2eBrowserIfAvailable();
    browser = await opening;
    if (browser === undefined) expect.unreachable('a browser was found and then would not open');
    tab = await browser.session.newTab();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    const launched = await opening?.catch(() => undefined);
    await (launched ?? browser)?.closed?.();
    browser = undefined;
  }, HOOK_TIMEOUT_MS);
}

export const read = (expression: string): Promise<unknown> => tab.evaluate(expression);
/** Set on a document; a full load is the one thing that loses it. */
export const MARK = 'window.__kept = "same-document"';
export const sameDocument = (): Promise<unknown> => read('window.__kept === "same-document"');
export const click = (id: string): Promise<unknown> =>
  read(`document.getElementById('${id}').click()`);
export const hover = (id: string): Promise<unknown> =>
  read(
    `document.getElementById('${id}').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`,
  );

/** A fresh document at `path`, marked, with the router listening. */
export async function start(path: string, on: E2eTab = tab): Promise<void> {
  await on.goto(`${base}${path}`);
  await on.waitFor('window.__xNavigation !== undefined', 'the router to start');
  await on.waitFor('document.querySelector("[data-x-mounted]") !== null', 'the islands to mount');
  await on.evaluate(MARK);
  ran.length = 0;
}
