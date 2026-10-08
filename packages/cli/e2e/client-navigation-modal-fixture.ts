// The server behind `client-navigation-modal.e2e.test.ts`: a run list (`/runs`) and the routes a
// visitor opens over it as modals (`navigation: 'modal'` — a create form, a deeper step of it, a
// confirmation), served by `@ultimat3/http`'s REAL pipeline under an enforced CSP, with the client
// router as the CLI builds it. Every route counts its executions in `ran`: the claims are that a
// modal is fetched once, a POST is sent once, and a page the router left in place never re-ran.

import { expect } from 'bun:test';
// why: Bun has no file-URL-to-path API; the router's entry is located beside this file.
import { fileURLToPath } from 'node:url';
import type { Route, RouteNavigation } from '@ultimat3/http';
import { cspHashSource, defineHttpConfig, httpServer, redirect } from '@ultimat3/http';
import type { IslandDirective } from '@ultimat3/render';
import {
  clientNavigationTags,
  emitIslandAttributes,
  emitIslandProps,
  HYDRATE_RUNTIME_BODIES,
  hydrateRuntime,
  renderHead,
} from '@ultimat3/render';
import { buildNavigationScript } from '../src/worker-bundle';

const ENTRY = fileURLToPath(new URL('../../render/src/navigation-entry.ts', import.meta.url));
const script = await buildNavigationScript(process.cwd(), { entry: ENTRY });
if (script === undefined) expect.unreachable('the client router did not build');
const BUILD = 'm1';
const SURFACE = 'web:app';

/** Mounts by writing its name; its disposer records it — what "the page beneath stayed live" reads. */
const ISLAND = `export function mount(el, props) {
  (window.__mounts = window.__mounts || []).push(props.name);
  el.textContent = 'mounted:' + props.name;
  return () => (window.__disposed = window.__disposed || []).push(props.name);
}`;

const island = (name: string): { html: string; directive: IslandDirective } => {
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

/** The document shape `runtime-render.ts` emits; `modal` is what a `navigation: 'modal'` route names. */
const documentOf = (title: string, main: string, islands: readonly string[], modal = false) => {
  const marked = islands.map(island);
  const nav = renderHead(
    clientNavigationTags({ surface: SURFACE, buildId: BUILD, scriptUrl: script.url, modal }),
  );
  return (
    `<!doctype html><html lang="en"><head><title>${title}</title>${nav}</head><body>` +
    `<nav><a id="home" href="/runs">Runs</a></nav><main><h1>${title}</h1>${main}` +
    `${marked.map((i) => i.html).join('')}</main>` +
    `${hydrateRuntime(marked.map((i) => i.directive))}</body></html>`
  );
};

/** What `/runs` shows: the count is the page's own state, which a refresh after a create moves. */
export const state = { runs: 0 };

const runsPage = (): string =>
  documentOf(
    'Runs',
    `<p id="count">${String(state.runs)} runs</p><a id="new" href="/runs/new">New run</a>` +
      ' <a id="revoke" href="/runs/7/revoke">Revoke</a> <a id="about" href="/about">About</a>',
    ['list'],
  );

/** The create form: no `action`, so it posts to its own URL, as on its own page. */
const newRunPage = (error = '', step: string | null = null): string =>
  documentOf(
    step === null ? 'New run' : `New run, step ${step}`,
    `${error === '' ? '' : `<p id="error">${error}</p>`}<form id="create" method="post">` +
      '<input id="name" name="name" value=""><button id="submit">Create</button></form>' +
      '<a id="cancel" href="/runs">Cancel</a> <a id="advanced" href="/runs/new/advanced">Advanced</a>' +
      // Relative: against the MODAL's URL it is `/runs/new?step=2`, against the page's `/runs?step=2`.
      ' <a id="step" href="?step=2">Step 2</a>',
    ['form'],
    true,
  );

/** Every execution of every route, as `METHOD /path purpose`. */
export const ran: string[] = [];
export const count = (line: string): number => ran.filter((one) => one === line).length;

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const NAV: RouteNavigation = { surface: SURFACE, prefetch: false };

const route = (
  method: 'GET' | 'POST',
  path: string,
  handler: (request: Request) => Response | Promise<Response>,
  navigation?: RouteNavigation,
): Route => ({
  method,
  path,
  meta: { name: path, auth: 'public', ...(navigation === undefined ? {} : { navigation }) },
  handler: (request) => {
    ran.push(`${method} ${path} ${request.raw.headers.get('x-ultimate-navigation') ?? 'full'}`);
    return handler(request.raw);
  },
});

const routes: Route[] = [
  {
    method: 'GET',
    path: script.url,
    meta: { name: 'router', auth: 'public' },
    handler: () => new Response(script.code, { headers: { 'content-type': 'text/javascript' } }),
  },
  {
    method: 'GET',
    path: '/island.js',
    meta: { name: 'island', auth: 'public' },
    handler: () => new Response(ISLAND, { headers: { 'content-type': 'text/javascript' } }),
  },
  route('GET', '/runs', () => html(runsPage()), NAV),
  route(
    'GET',
    '/runs/new',
    (request) => html(newRunPage('', new URL(request.url).searchParams.get('step'))),
    NAV,
  ),
  route('POST', '/runs/new', async (request) => {
    const name = String((await request.formData()).get('name') ?? '');
    // Refused in place, as a form re-render: 422 with the same page.
    if (name === '') return html(newRunPage('A run needs a name'), 422);
    state.runs += 1;
    return redirect(name === 'detail' ? '/runs/1' : '/runs', 303);
  }),
  route(
    'GET',
    '/runs/new/advanced',
    () =>
      html(
        documentOf(
          'Advanced',
          '<a id="back-to-new" href="/runs/new">Basic</a>',
          ['advanced'],
          true,
        ),
      ),
    NAV,
  ),
  route('GET', '/runs/1', () => html(documentOf('Run 1', '<p>one run</p>', ['run'])), NAV),
  route(
    'GET',
    '/runs/7/revoke',
    () =>
      html(
        documentOf(
          'Revoke run 7?',
          '<form method="post" action="/runs/7/revoke"><button id="confirm">Revoke</button></form>' +
            '<form method="dialog"><button id="keep">Keep it</button></form>',
          [],
          true,
        ),
      ),
    NAV,
  ),
  route('POST', '/runs/7/revoke', () => {
    state.runs = Math.max(0, state.runs - 1);
    return redirect('/runs', 303);
  }),
  // A page of the surface that is NOT a modal: `#/about` addresses nothing to open.
  route('GET', '/about', () => html(documentOf('About', '<p>about</p>', [])), NAV),
];

const pipeline = httpServer({
  routes,
  role: 'web',
  config: defineHttpConfig({
    dev: false,
    buildId: BUILD,
    rateLimit: { enabled: false },
    security: {
      csp: {
        extend: { 'script-src': HYDRATE_RUNTIME_BODIES.map(cspHashSource) },
        reportUri: null,
        reportOnly: false,
      },
    },
  }),
});
const server = Bun.serve({ port: 0, fetch: (request) => pipeline.fetch(request) });
server.unref();
export const base = `http://localhost:${String(server.port)}`;
