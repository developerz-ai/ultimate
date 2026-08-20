// The page half of `x dev`: a registered `route` primitive has to answer, in its declared mode,
// with the headers that mode earns. Driven through `@ultimat3/http`'s real pipeline (`fetch()`,
// no socket) so the authz stage is the same one production runs.

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { RegisterRouteInput, RenderMode, RouteComponent } from '@ultimat3/render';
import {
  clearRoutes,
  clearStylesheets,
  defineRoute,
  h,
  loadStylesheet,
  registerRoute,
} from '@ultimat3/render';
import { appRoutes } from './dev-render';

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

const serve = (): ReturnType<typeof createServer> =>
  createServer({
    routes: appRoutes({ buildId: BUILD_ID }),
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

  test('a dynamic segment reaches meta as a param, matched by the router', async () => {
    register({ file: 'apps/web/site/blog/[slug]/page.tsx', render: 'ssr' });
    const body = await (await get('/blog/hello-world')).text();
    expect(body).toContain('rendered http://dev.test/blog/hello-world');
  });

  test('a gated route is gated by the pipeline, not by a CLI check', async () => {
    register({
      file: 'apps/web/app/settings/page.tsx',
      render: 'spa',
      policy: { permission: 'settings.read' },
    });
    const response = await get('/settings');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      type: expect.stringContaining('X_UNAUTHENTICATED'),
    });
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

  test('the surface CSS is inlined, and a site page never carries app CSS', async () => {
    loadStylesheet('/srv/demo/apps/web/site/page.module.scss', '.hero{color:red}');
    loadStylesheet('/srv/demo/apps/web/app/feed/page.module.scss', '.feed{color:blue}');
    register({ file: 'apps/web/site/page.tsx', render: 'static' });
    const body = await (await get('/')).text();
    expect(body).toContain('<style>');
    expect(body).toContain('color:red');
    expect(body).not.toContain('color:blue');
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
});
