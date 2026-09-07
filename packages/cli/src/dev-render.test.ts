// The page half of `x dev`: a registered `route` primitive has to answer, in its declared mode,
// with the headers that mode earns. Driven through `@ultimat3/http`'s real pipeline (`fetch()`,
// no socket) so the authz stage is the same one production runs.

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { RegisterRouteInput, RenderMode, RouteComponent } from '@ultimat3/render';
import {
  clearRoutes,
  defineRoute,
  h,
  RENDER_MODES,
  registerRoute,
  SURFACE_SPECS,
  withStatus,
} from '@ultimat3/render';
import { clearStylesheets, loadStylesheet } from '@ultimat3/render/server';
import { appRoutes } from './dev-render';
import { styleBundle } from './style-bundle';

const BUILD_ID = 'build-under-test';

interface RouteFixture {
  readonly file: string;
  readonly render: RenderMode;
  readonly policy?: { readonly permission: string };
  readonly revalidate?: { readonly ttl: string };
  readonly component?: RouteComponent;
}

function register(fixture: RouteFixture): void {
  // Generic, matching the `defineRoute<…>` below: `RegisterRouteInput` defaults `TData` to
  // `RouteData`, and a `meta` written against `{ url, params }` cannot be handed a bare record.
  const input: RegisterRouteInput<{ url: string; params: Record<string, string> }> = {
    file: fixture.file,
    suspenseBoundaries: fixture.render === 'stream' ? 1 : 0,
    ...(fixture.component === undefined ? {} : { component: fixture.component }),
    config: defineRoute<{ url: string; params: Record<string, string> }>({
      render: fixture.render,
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      meta: (data) => ({
        title: `title of ${fixture.file}`,
        description: `rendered ${data.url}`,
      }),
      ...(fixture.policy === undefined ? {} : { policy: fixture.policy }),
      ...(fixture.revalidate === undefined ? {} : { revalidate: fixture.revalidate }),
    }),
  };
  registerRoute(input);
}

const serve = (pwaHead?: string): ReturnType<typeof createServer> =>
  createServer({
    routes: appRoutes({ buildId: BUILD_ID, ...(pwaHead === undefined ? {} : { pwaHead }) }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

const get = async (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  serve().fetch(new Request(`http://dev.test${path}`, { headers }));

afterEach(() => {
  clearRoutes();
  clearStylesheets();
});

describe('unit · x dev renders the app routes', () => {
  test('a loader that answers withStatus(404) is a 404 with the route’s own page, in every mode', async () => {
    // Measured in ai-maxxing 2026-09-07: `/fleet/nope` rendered the app's "Not found" page inside
    // its own shell and answered 200, because the only route to a 404 was a throw — which renders
    // the framework's error page instead. The status rides on the data; this file mints it.
    for (const render of ['ssr', 'static', 'stream', 'isr'] as const) {
      clearRoutes();
      const surface = render === 'static' || render === 'isr' ? 'site' : 'app';
      registerRoute<{ url: string; params: Record<string, string> }>({
        file: `apps/web/${surface}/${render}/page.tsx`,
        suspenseBoundaries: render === 'stream' ? 1 : 0,
        config: defineRoute<{ url: string; params: Record<string, string> }>({
          render,
          offline: 'network-only',
          hydrate: 'never',
          budget: { js: '0kb' },
          ...(render === 'isr' ? { revalidate: { ttl: '5m' } } : {}),
          load: async (ctx) => withStatus(404, { url: ctx.url, params: ctx.params }),
          meta: (data) => ({ title: `missing ${render}`, description: `rendered ${data.url}` }),
        }),
      });
      const response = await get(`/${render}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain(`<title>missing ${render}</title>`);
    }
  });

  test('a static page answers with its own head and content-hashed headers', async () => {
    register({ file: 'apps/web/site/page.tsx', render: 'static' });
    const response = await get('/');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/html');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]+"$/);
    expect(response.headers.get('x-ultimate-build')).toBe(BUILD_ID);
    expect(body).toContain('<title>title of apps/web/site/page.tsx</title>');
    expect(body).toContain('<meta name="description" content="rendered http://dev.test/">');
  });

  test('every mode gets its own cache posture, from render and not from the CLI', async () => {
    register({ file: 'apps/web/site/page.tsx', render: 'static' });
    register({ file: 'apps/web/site/pricing/page.tsx', render: 'isr', revalidate: { ttl: '5m' } });
    register({ file: 'apps/web/site/blog/[slug]/page.tsx', render: 'ssr' });
    register({ file: 'apps/web/app/feed/page.tsx', render: 'stream' });

    const cacheControl = async (path: string): Promise<string | null> =>
      (await get(path)).headers.get('cache-control');

    expect(await cacheControl('/')).toContain('must-revalidate');
    // The route declared `ttl: '5m'`, and that TTL is what the CDN is told — not a fixed 60.
    expect(await cacheControl('/pricing')).toContain('s-maxage=300');
    expect(await cacheControl('/blog/hello')).toContain('s-maxage=30');
    expect(await cacheControl('/feed')).toBe('private, no-store');
  });

  test('two ISR URLs that differ only in their query are two documents, never one', async () => {
    // #171, the half a build error cannot close. `resultFor` keyed the ISR store on
    // `url.pathname`, so `?page=2` and `?page=3` were ONE entry: the first render was stored under
    // `/pricing` and every later query string was served that body.
    //
    // ONE server for both requests, deliberately. `serve()` builds a fresh `IsrController` per
    // call, so a test that used it twice could never observe a cache hit at all — it would pass
    // against the leak and against the fix alike. The route's own `meta` renders `data.url`, so
    // the served document names the URL it was rendered for and a collision is visible from
    // outside rather than inferred from the store.
    register({ file: 'apps/web/site/pricing/page.tsx', render: 'isr', revalidate: { ttl: '5m' } });
    const server = serve();
    const fetchOnce = async (path: string): Promise<string> =>
      await (await server.fetch(new Request(`http://dev.test${path}`))).text();

    const second = await fetchOnce('/pricing?page=2');
    const third = await fetchOnce('/pricing?page=3');

    expect(second).toContain('rendered http://dev.test/pricing?page=2');
    expect(third).toContain('rendered http://dev.test/pricing?page=3');
  });

  test('two locales are two ISR documents, never one', async () => {
    // The document is rendered with `<html lang>` and every `t()` in the request's own locale, so
    // a key without it served visitor 2 the document negotiated for visitor 1 — for the whole TTL,
    // and `s-maxage` told the CDN to do the same. `examples/dummy` ships en + es and three `isr`
    // routes, so this was every one of them.
    //
    // ONE server for both requests, for the reason the query test above gives: `serve()` builds a
    // fresh `IsrController` per call, so two servers could never observe a cache hit at all.
    register({ file: 'apps/web/site/pricing/page.tsx', render: 'isr', revalidate: { ttl: '5m' } });
    const server = serve();
    const langOf = async (locale: string): Promise<string> => {
      const response = await server.fetch(
        new Request('http://dev.test/pricing', { headers: { 'accept-language': locale } }),
      );
      return /<html lang="(?<lang>[^"]*)"/.exec(await response.text())?.groups?.['lang'] ?? '';
    };

    expect(await langOf('es')).toBe('es');
    expect(await langOf('en')).toBe('en');
  });

  test('a dynamic segment reaches meta as a param, matched by the router', async () => {
    register({ file: 'apps/web/site/blog/[slug]/page.tsx', render: 'ssr' });
    const body = await (await get('/blog/hello-world')).text();
    expect(body).toContain('rendered http://dev.test/blog/hello-world');
  });

  test('a gated route is gated by the pipeline, not by a CLI check', async () => {
    register({
      file: 'apps/web/app/settings/page.tsx',
      render: 'ssr',
      policy: { permission: 'settings.read' },
    });
    const response = await get('/settings');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      type: expect.stringContaining('X_UNAUTHENTICATED'),
    });
  });

  // The reload half of the test above: `app-load.ts` replaces the entry for a saved route module
  // under a server whose route table was built at boot. The handler read the new entry from the
  // first save; the pipeline's `meta` was a snapshot, so a policy ADDED by that save gated nothing
  // until a restart — the new page, served under the old guard.
  test('a policy added by a reload is enforced on the next request, on the same server', async () => {
    const file = 'apps/web/app/settings/page.tsx';
    register({ file, render: 'ssr' });
    const server = serve();
    const fetch = (): Promise<Response> => server.fetch(new Request('http://dev.test/settings'));
    expect((await fetch()).status).toBe(200);
    // What `app-load.ts` does on a save: the same file, registered again, now with a policy.
    register({ file, render: 'ssr', policy: { permission: 'settings.read' } });
    const gated = await fetch();
    expect(gated.status).toBe(401);
    expect(await gated.json()).toMatchObject({
      type: expect.stringContaining('X_UNAUTHENTICATED'),
    });
    // And the other direction: a policy REMOVED by a save opens the page, on the same server.
    register({ file, render: 'ssr' });
    expect((await fetch()).status).toBe(200);
  });

  test('a streamed page arrives as a stream, chunked and unbuffered', async () => {
    register({ file: 'apps/web/app/feed/page.tsx', render: 'stream' });
    const response = await get('/feed');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(await response.text()).toContain('<title>title of apps/web/app/feed/page.tsx</title>');
  });

  test('an unregistered path is a 404, not a blank page', async () => {
    register({ file: 'apps/web/site/page.tsx', render: 'static' });
    expect((await get('/nope')).status).toBe(404);
  });

  test('no registered routes means no page routes — and no crash', () => {
    expect(appRoutes({ buildId: BUILD_ID })).toEqual([]);
  });

  // Driven off `RENDER_MODES` and not off a list written here, because the defect it closes was a
  // mode with no renderer at all: `spa` never reached `routeBody`, so every `spa` route in every
  // app served `<div id="x-root"></div>` — a blank page, 200, correct headers, for the framework's
  // whole history. A mode that forgets its body is now a red test rather than a shipped blank page.
  test('every render mode puts the route component inside the hydration root', async () => {
    for (const mode of RENDER_MODES) {
      clearRoutes();
      const surface = SURFACE_SPECS.site.allowedModes.includes(mode) ? 'site' : 'app';
      register({
        file: `apps/web/${surface}/probe/page.tsx`,
        render: mode,
        ...(mode === 'isr' ? { revalidate: { ttl: '5m' } } : {}),
        component: () => h('main', { class: 'probe' }, mode),
      });

      const body = await (await get('/probe')).text();
      expect(body).toContain(`<div id="x-root"><main class="probe">${mode}</main></div>`);
    }
  });

  test("a route's component reaches the body, inside the hydration root", async () => {
    register({
      file: 'apps/web/site/page.tsx',
      render: 'static',
      component: (props) => h('main', { class: 'hero' }, h('h1', null, String(props['url']))),
    });
    const body = await (await get('/')).text();
    expect(body).toContain('<div id="x-root"><main class="hero"><h1>http://dev.test/</h1></main>');
    expect(body).not.toContain('<div id="x-root"></div>');
  });

  test('a module with no component still serves its shell, never a 404', async () => {
    register({ file: 'apps/web/site/page.tsx', render: 'static' });
    expect(await (await get('/')).text()).toContain('<div id="x-root"></div>');
  });

  // The document LINKS its surface stylesheet and carries none of it. Both halves matter: the
  // bytes leaving the document is the fix (156,738 of them, in a `no-store` response, on every
  // navigation), and the per-surface split is axiom 6 — a `site/` page must not be handed `app/`
  // CSS, whether inline or by href.
  test('the surface CSS is linked, not inlined, and a site page never links app CSS', async () => {
    loadStylesheet('/srv/demo/apps/web/site/page.module.scss', '.hero{color:red}');
    loadStylesheet('/srv/demo/apps/web/app/feed/page.module.scss', '.feed{color:blue}');
    register({ file: 'apps/web/site/page.tsx', render: 'static' });
    const body = await (await get('/')).text();
    expect(body).not.toContain('<style>');
    expect(body).not.toContain('color:red');
    const site = styleBundle().hrefFor('site');
    expect(body).toContain(`<link rel="stylesheet" href="${site}">`);
    expect(body).not.toContain(String(styleBundle().hrefFor('app')));
    // In `<head>`, which is the whole of "no flash of unstyled content": a `<link>` there is
    // render-blocking in every browser, exactly as the inline block was. Anywhere else it is not,
    // and the page paints naked first. Sliced rather than compared with `indexOf`, which answers
    // `-1` and passes a `toBeLessThan` when the thing it orders was never emitted.
    expect(body).toContain('</head>');
    expect(body.split('</head>')[0] ?? '').toContain('<link rel="stylesheet"');
  });

  // `<html lang>` was the literal `'en'` on every document this file emits, while the pipeline's
  // `locale` stage had negotiated the real one a stage earlier. A screen reader and `hreflang`
  // both read that attribute, so the constant was wrong for every non-English request.
  test("`<html lang>` is the request's negotiated locale, never a constant", async () => {
    register({ file: 'apps/web/site/page.tsx', render: 'static' });
    register({ file: 'apps/web/app/feed/page.tsx', render: 'stream' });

    expect(await (await get('/', { 'accept-language': 'de-DE,de;q=0.9' })).text()).toContain(
      '<html lang="de">',
    );
    expect(await (await get('/feed', { 'accept-language': 'ja' })).text()).toContain(
      '<html lang="ja">',
    );
    // No preference is the app's configured fallback, which is where `'en'` legitimately comes from.
    expect(await (await get('/')).text()).toContain('<html lang="en">');
  });

  test('a streamed page flushes the component in its first chunk', async () => {
    register({
      file: 'apps/web/app/feed/page.tsx',
      render: 'stream',
      component: () => h('section', null, 'feed'),
    });
    expect(await (await get('/feed')).text()).toContain('<section>feed</section>');
  });

  // #362: `pwa.enabled` had no reader, so no document any Ultimate app served ever carried a
  // manifest link and no browser would offer to install one. The head is a document-level string
  // rather than a per-route `meta()` member because an installable app is one whose EVERY page
  // carries it — a visitor lands on whichever page they land on.
  describe('the install head, on every mode and every page', () => {
    const PWA_HEAD = '<link rel="manifest" href="/manifest.webmanifest">';

    // Every (surface, mode) pair the framework allows, DERIVED from `SURFACE_SPECS` rather than
    // listed: a mode added to a surface joins this test on its own, and `documentFrom` is not the
    // only place a head is assembled.
    const PAGES = [
      { surface: 'site', file: 'apps/web/site/page.tsx', url: '/' },
      { surface: 'app', file: 'apps/web/app/feed/page.tsx', url: '/feed' },
    ] as const;
    const CASES = PAGES.flatMap((page) =>
      SURFACE_SPECS[page.surface].allowedModes.map((render) => ({ ...page, render })),
    );

    test.each(CASES)('$surface/ in $render carries it', async ({ file, url, render }) => {
      // `isr` is the one mode whose shape check demands a TTL; every other one takes none.
      register({ file, render, ...(render === 'isr' ? { revalidate: { ttl: '5m' } } : {}) });
      const response = await serve(PWA_HEAD).fetch(new Request(`http://dev.test${url}`));
      expect(await response.text()).toContain(PWA_HEAD);
    });

    // The `stream` branch builds its head separately from `documentFrom`, so it is the one that
    // could carry the link and lose the title, or the reverse. Both, in the first flush.
    test('a streamed page carries it beside its own title, in the first flush', async () => {
      register({ file: 'apps/web/app/feed/page.tsx', render: 'stream' });
      const body = await (await serve(PWA_HEAD).fetch(new Request('http://dev.test/feed'))).text();
      expect(body).toContain('<title>title of apps/web/app/feed/page.tsx</title>');
      expect(body).toContain(PWA_HEAD);
    });

    // The 0kb baseline: an app that is not installable pays nothing, and a `<link>` to a file no
    // route serves is a 404 in every visitor's console.
    test('an app that is not installable carries nothing', async () => {
      register({ file: 'apps/web/site/page.tsx', render: 'static' });
      expect(await (await get('/')).text()).not.toContain('rel="manifest"');
    });
  });
});
