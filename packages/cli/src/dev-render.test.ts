// The page half of `x dev`: a registered `route` primitive has to answer, in its declared mode,
// with the headers that mode earns. Driven through `@ultimat3/http`'s real pipeline (`fetch()`,
// no socket) so the authz stage is the same one production runs.

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { RegisterRouteInput, RenderMode } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { appRoutes } from './dev-render';

const BUILD_ID = 'build-under-test';

interface RouteFixture {
  readonly file: string;
  readonly render: RenderMode;
  readonly policy?: { readonly permission: string };
  readonly revalidate?: { readonly ttl: string };
}

function register(fixture: RouteFixture): void {
  const input: RegisterRouteInput = {
    file: fixture.file,
    suspenseBoundaries: fixture.render === 'stream' ? 1 : 0,
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
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID }),
  });

const get = async (path: string): Promise<Response> =>
  serve().fetch(new Request(`http://dev.test${path}`));

afterEach(() => {
  clearRoutes();
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
});
