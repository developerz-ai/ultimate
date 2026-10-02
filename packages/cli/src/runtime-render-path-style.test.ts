// The path style a rendered document hands the browser: stamped once, by the server, from the
// style `defineApi` declared — so an island's `rpc()` states nothing and cannot disagree. Driven
// through `@ultimat3/http`'s real pipeline, like `runtime-render.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import { configureActionPathStyle, forgetHandedOutActionPaths } from '@ultimat3/action';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { RenderMode } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'build-under-test';
const STAMP = '<meta name="ultimate-path-style" content="readable">';

/** One page per render mode, on the surface that mode is legal on. */
const PAGES: readonly {
  readonly render: RenderMode;
  readonly file: string;
  readonly path: string;
}[] = [
  { render: 'static', file: 'apps/web/site/page.tsx', path: '/' },
  { render: 'isr', file: 'apps/web/site/pricing/page.tsx', path: '/pricing' },
  { render: 'ssr', file: 'apps/web/app/account/page.tsx', path: '/account' },
  { render: 'stream', file: 'apps/web/app/feed/page.tsx', path: '/feed' },
];

function registerPages(): void {
  for (const page of PAGES) {
    registerRoute({
      file: page.file,
      suspenseBoundaries: page.render === 'stream' ? 1 : 0,
      config: defineRoute({
        render: page.render,
        offline: 'network-only',
        hydrate: 'never',
        budget: { js: '0kb' },
        ...(page.render === 'isr' ? { revalidate: { ttl: '5m' } } : {}),
        meta: () => ({ title: `page ${page.render}`, description: 'd'.repeat(60) }),
      }),
    });
  }
}

async function documentAt(path: string): Promise<string> {
  const server = createServer({
    routes: appRoutes({ buildId: BUILD_ID }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });
  const response = await server.fetch(new Request(`http://dev.test${path}`));
  expect(response.status).toBe(200);
  return response.text();
}

afterEach(() => {
  clearRoutes();
  // The style is process-wide and outlives this file in a shared worker.
  forgetHandedOutActionPaths();
  configureActionPathStyle('resource');
});

describe("unit · a document carries the server's action path style", () => {
  test("a 'readable' app stamps it into every document, whatever the render mode", async () => {
    configureActionPathStyle('readable');
    registerPages();
    for (const page of PAGES) {
      const body = await documentAt(page.path);
      expect(body.split(STAMP)).toHaveLength(2);
      // In the head, where core's reader looks — read as a slice, never as two `indexOf`s.
      expect(body.split('</head>')[0]).toContain(STAMP);
    }
  });

  test("an app that declared no style renders no stamp — absent IS 'resource'", async () => {
    registerPages();
    for (const page of PAGES) {
      expect(await documentAt(page.path)).not.toContain('ultimate-path-style');
    }
  });

  test('the style is read per render, so one declared after the routes mounted still lands', async () => {
    registerPages();
    const routes = appRoutes({ buildId: BUILD_ID });
    configureActionPathStyle('readable');
    const server = createServer({
      routes,
      role: 'web',
      config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
    });
    const body = await (await server.fetch(new Request('http://dev.test/account'))).text();
    expect(body).toContain(STAMP);
  });
});
