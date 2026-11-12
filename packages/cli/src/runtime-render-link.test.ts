// The `Link` header a document answers with names exactly what its tags fetch early — the
// stylesheet and every modulepreload — through the real page handler, in every buffered mode and
// in a stream's first flush. A CDN turns it into a 103 Early Hint.

import { afterEach, describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import type { RenderMode } from '@ultimat3/render';
import { clearRoutes, defineRoute, h, island, registerRoute } from '@ultimat3/render';
import { clearStylesheets, loadStylesheet } from '@ultimat3/render/server';
import type { IslandResolve } from './document-options';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'link-under-test';
const ENTRY = '/islands/counter-1.js';
const SHARED = '/islands/chunk-11111111.js';
const OTHER = '/islands/chunk-22222222.js';

const resolve: IslandResolve = Object.assign(
  (src: string): string => (src === './counter.island.tsx' ? ENTRY : src),
  { importsOf: (url: string): readonly string[] => (url === ENTRY ? [OTHER, SHARED] : []) },
);
const Counter = island({ src: './counter.island.tsx' });

afterEach(() => {
  clearRoutes();
  clearStylesheets();
});

const page = (file: string, render: RenderMode, body: () => unknown): void => {
  registerRoute({
    file,
    component: body as never,
    config: defineRoute({
      render,
      offline: render === 'static' ? 'precache' : 'network-only',
      hydrate: 'idle',
      budget: { js: '100kb' },
      meta: () => ({ title: file, description: 'a page whose early fetches are under test' }),
    }),
  });
};

const get = async (path: string): Promise<Response> =>
  httpServer({
    routes: appRoutes({ buildId: BUILD_ID, resolveIsland: () => resolve }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  }).fetch(new Request(`http://app.test${path}`, { headers: { accept: 'text/html' } }));

/** Every URL the document's own tags fetch early, in document order. */
const taggedIn = (html: string): readonly string[] =>
  [...html.matchAll(/<link rel="(?:stylesheet|modulepreload)" href="([^"]+)">/g)].map(
    (match) => match[1] ?? '',
  );

const hinted = (response: Response): readonly string[] =>
  [...(response.headers.get('link') ?? '').matchAll(/<([^>]+)>/g)].map((match) => match[1] ?? '');

describe('unit · the Link header is the tag set', () => {
  for (const render of ['ssr', 'static', 'stream'] as const) {
    test(`${render}: every preload tag is hinted, and nothing else is`, async () => {
      // `stream` is an `app/` mode: `site/` documents are shareable.
      const surface = render === 'stream' ? 'app' : 'site';
      page(`apps/web/${surface}/${render}/page.tsx`, render, () => h('main', {}, h(Counter, {})));
      const response = await get(`/${render}`);
      expect(response.status).toBe(200);
      const tags = taggedIn(await response.text());
      expect(tags).toEqual([SHARED, OTHER]);
      expect(hinted(response)).toEqual(tags);
      expect(response.headers.get('link')).toContain(`<${SHARED}>; rel=modulepreload`);
    });
  }

  test('the surface stylesheet is hinted first, as a style preload', async () => {
    loadStylesheet('/srv/demo/apps/web/site/page.module.scss', '.hero{color:red}');
    page('apps/web/site/styled/page.tsx', 'ssr', () => h('main', {}, h(Counter, {})));
    const response = await get('/styled');
    const tags = taggedIn(await response.text());
    expect(tags[0]).toMatch(/^\/styles\/[0-9a-f]{8}\.css$/);
    expect(hinted(response)).toEqual(tags);
    expect(response.headers.get('link')).toStartWith(`<${tags[0]}>; rel=preload; as=style, `);
  });

  test('a page that preloads nothing answers no Link header', async () => {
    page('apps/web/site/plain/page.tsx', 'ssr', () => h('main', {}, 'plain'));
    const response = await get('/plain');
    expect(taggedIn(await response.text())).toEqual([]);
    expect(response.headers.has('link')).toBe(false);
  });
});
