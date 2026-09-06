// The other half of the same seam, driven through `@ultimat3/http`'s real pipeline: the href a
// document carries has to be a URL this process answers, with the headers that make the round trip
// worth taking. A stub on either side proves nothing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { clearStylesheets, loadStylesheet } from '@ultimat3/render/server';
import { appRoutes } from './dev-render';
import { fixProblem } from './error-contract';
import { styleBundle } from './style-bundle';
import { styleRoutes } from './style-routes';

const BUILD_ID = 'styles-under-test';

const serve = (): ReturnType<typeof createServer> =>
  createServer({
    routes: [...styleRoutes(() => styleBundle()), ...appRoutes({ buildId: BUILD_ID })],
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

const page = (): void => {
  registerRoute({
    file: 'apps/web/site/page.tsx',
    config: defineRoute({
      render: 'ssr',
      hydrate: 'never',
      offline: 'network-only',
      meta: () => ({ title: 'Styled', description: 'one stylesheet' }),
    }),
    component: () => 'plain',
  });
};

beforeEach(() => {
  clearRoutes();
  clearStylesheets();
});

afterEach(() => {
  clearRoutes();
  clearStylesheets();
});

describe('surface stylesheets over HTTP', () => {
  test('the document links a file this process answers, cacheable for a year', async () => {
    loadStylesheet('/srv/demo/apps/web/site/page.module.scss', '.hero{color:red}');
    page();
    const server = serve();

    const html = await (await server.fetch(new Request('http://dev.test/'))).text();
    const href = /<link rel="stylesheet" href="(?<url>[^"]+)">/.exec(html)?.groups?.['url'] ?? '';
    expect(href).toMatch(/^\/styles\/[0-9a-f]{8}\.css$/);
    // The document itself carries no CSS any more — that is the 156,738 bytes this change is about.
    expect(html).not.toContain('<style>');

    const sheet = await server.fetch(new Request(`http://dev.test${href}`));
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get('content-type')).toContain('text/css');
    // Content-addressed, so the bytes behind the URL can never change — and the document that
    // links it is `private, no-store`, which is exactly why the CSS had to leave it.
    expect(sheet.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await sheet.text()).toContain('color:red');
  });

  test('a URL from an older build is refused with a cause and a command, not a bare 404', async () => {
    loadStylesheet('/srv/demo/apps/web/site/page.module.scss', '.hero{color:red}');
    page();
    const response = await serve().fetch(new Request('http://dev.test/styles/deadbeef.css'));

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error?: { code?: string; fix?: string } };
    expect(body.error?.code).toBe('X_ROUTE_NOT_FOUND');
    const fix = body.error?.fix ?? '';
    expect(fix).toMatch(/reload/i);
    // An instruction with no command is legal; advice with neither is not.
    expect(fixProblem(fix)).toBeUndefined();
  });

  test('an app with no CSS links nothing at all — no file, no round trip', async () => {
    page();
    const html = await (await serve().fetch(new Request('http://dev.test/'))).text();

    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toContain('<style>');
  });
});
