// `/llms.txt` over a DYNAMIC `site/` route: each page `prerender()` enumerates is listed by the
// title and description its own `meta` gives it — through its `load` — and the bytes a running web
// role serves are the bytes the static export writes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; the export's files are root-relative.
import { join } from 'node:path';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import type { RouteConfig } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { processRoot } from './process-root-fixture';
import { seoRoutes } from './seo-routes';
import { siteSeo } from './site-seo';
import { writeSiteSeo } from './site-seo-write';

const BASE = 'https://www.example.com';
const ROOT = processRoot(join(import.meta.dir, '..', '.site-llms-fixture'));

const route = (file: string, patch: Partial<RouteConfig> = {}): void => {
  registerRoute({
    file,
    config: defineRoute({
      render: 'static',
      hydrate: 'never',
      offline: 'network-only',
      meta: () => ({ title: 'Home', description: 'the home page' }),
      ...patch,
    } as Parameters<typeof defineRoute>[0]),
    component: () => 'page',
  });
};

const POSTS: Readonly<Record<string, { title: string; summary: string }>> = {
  hello: { title: 'Hello', summary: 'the first post' },
  world: { title: 'World', summary: 'the second post' },
  draft: { title: 'Draft', summary: 'not for crawlers' },
};

/** A blog: one page per post, each titled from its own row by a `load`. */
const site = (): void => {
  route('apps/web/site/page.tsx');
  route('apps/web/site/blog/[slug]/page.tsx', {
    prerender: () => Object.keys(POSTS),
    load: ({ params }: { params: Readonly<Record<string, string>> }) =>
      Promise.resolve(POSTS[params['slug'] ?? ''] ?? { title: '?', summary: '?' }),
    meta: ({ data }: { data: { title: string; summary: string } }) => ({
      title: `Post: ${data.title}`,
      description: data.summary,
      ...(data.title === 'Draft' ? { robots: { index: false } } : {}),
    }),
  } as unknown as Partial<RouteConfig>);
};

beforeEach(() => clearRoutes());
afterEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
});

describe('/llms.txt over a dynamic route', () => {
  test('lists each prerendered page by its own meta, less the one that asked for noindex', async () => {
    site();
    const { llms } = await siteSeo({ baseUrl: BASE, environment: 'production', root: ROOT });
    expect(llms).toContain(`- [Post: Hello](${BASE}/blog/hello): the first post`);
    expect(llms).toContain(`- [Post: World](${BASE}/blog/world): the second post`);
    expect(llms).not.toContain('/blog/draft');
    expect(llms).not.toContain(':slug');
  });

  test('a static export lists only the pages it emitted, as the sitemap does', async () => {
    site();
    const { llms } = await siteSeo({
      baseUrl: BASE,
      environment: 'production',
      root: ROOT,
      pagesFor: () => ['/blog/world'],
    });
    expect(llms).toContain(`${BASE}/blog/world`);
    expect(llms).not.toContain(`${BASE}/blog/hello`);
  });

  test('served bytes equal exported bytes', async () => {
    site();
    const exported = await siteSeo({ baseUrl: BASE, environment: 'production', root: ROOT });
    const out = join(ROOT, 'out');
    await writeSiteSeo(out, exported);
    const server = httpServer({
      routes: [...seoRoutes({ env: { ULTIMATE_ENV: 'production', APP_URL: BASE }, root: ROOT })],
      role: 'web',
      config: defineHttpConfig({ dev: true, buildId: 'b', rateLimit: { scope: 'process' } }),
    });
    const served = await (await server.fetch(new Request(`${BASE}/llms.txt`))).text();
    expect(served).toContain('/blog/hello');
    expect(served).toBe(await Bun.file(join(out, 'llms.txt')).text());
  });
});
