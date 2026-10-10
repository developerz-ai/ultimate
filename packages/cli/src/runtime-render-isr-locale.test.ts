// A locale-prefixed ISR page through the served pipeline: the router strips `/en` before it
// matches, the ISR key keeps it, and the page must still be revalidated as ITS ROUTE declares.
// It was not — `/en/blog/a` kept answering a withdrawn post with a 200 while `/blog/a` was a 404,
// and advertised the tag-only `s-maxage=60` under a route that declared `ttl: '2m'`.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { invalidateTags, isolateGraph, tag } from '@ultimat3/cache';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import { clearRoutes, defineRoute, h, registerRoute, withStatus } from '@ultimat3/render';
import { isrController } from '@ultimat3/render/server';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'isr-locale-under-test';
const blogTag = tag('blog');
const TTL_MS = 120_000;

/** The row behind `/blog/a`: withdrawn is "no row", and `publishedAt` is an embargo on the clock. */
let withdrawn = false;
let publishedAt = 0;
let at = 1_000_000;

interface Post {
  readonly found: boolean;
}

const foundOf = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && 'found' in data && data.found === true;

function registerBlog(): void {
  registerRoute<Post>({
    file: 'apps/web/site/blog/[slug]/page.tsx',
    component: (props) => h('p', {}, foundOf(props['data']) ? 'the post' : 'no such post'),
    config: defineRoute<Post>({
      render: 'isr',
      revalidate: { tags: [blogTag], ttl: '2m' },
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      load: async () =>
        withdrawn || publishedAt > at ? withStatus(404, { found: false }) : { found: true },
      meta: () => ({ title: 'Post', description: 'an isr page read in two locales' }),
    }),
  });
}

const restoreGraph = isolateGraph();

beforeEach(() => {
  configureLocales({ supported: ['es-CO', 'en'], fallback: 'es-CO' });
  registerBlog();
});

afterEach(() => {
  clearRoutes();
  resetLocaleConfig();
  withdrawn = false;
  publishedAt = 0;
  at = 1_000_000;
});

afterAll(() => {
  isrController().attach()();
  restoreGraph();
});

/** The app's pages over a controller on this file's clock, attached as the boots attach theirs. */
function served(): {
  readonly get: (path: string) => Promise<Response>;
  readonly settled: (path: string, status: number) => Promise<Response>;
  readonly detach: () => void;
} {
  const isr = isrController({ buildId: BUILD_ID, now: () => at });
  const detach = isr.attach();
  const server = httpServer({
    routes: appRoutes({ buildId: BUILD_ID, isr }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });
  const get = (path: string): Promise<Response> =>
    server.fetch(new Request(`http://dev.test${path}`));
  return {
    get,
    detach,
    // The stale copy answers while the regeneration runs behind it: polled to a deadline.
    settled: async (path, status) => {
      let response = await get(path);
      for (const started = Date.now(); Date.now() - started < 10_000; await Bun.sleep(5)) {
        if (response.status === status && !response.headers.has('x-ultimate-isr')) break;
        response = await get(path);
      }
      return response;
    },
  };
}

const PATHS = ['/blog/a', '/en/blog/a'] as const;
const LANG = { '/blog/a': 'es-CO', '/en/blog/a': 'en' } as const;

describe('unit · a locale-prefixed isr page revalidates as its route declares', () => {
  test("both locales advertise the route's ttl, and carry its surrogate keys", async () => {
    const app = served();
    for (const path of PATHS) {
      const response = await app.get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('s-maxage=120');
      expect(response.headers.get('surrogate-key')).not.toBeNull();
      expect(await response.text()).toContain(`<html lang="${LANG[path]}">`);
    }
    app.detach();
  });

  test('a withdrawn post is a 404 in every locale once its tag is busted', async () => {
    const app = served();
    for (const path of PATHS) expect((await app.get(path)).status).toBe(200);

    withdrawn = true;
    await invalidateTags([blogTag]);
    for (const path of PATHS) {
      // Stale-while-revalidate: the old page once, marked, with the 404 rendering behind it.
      const stale = await app.get(path);
      expect(stale.headers.get('x-ultimate-isr')).toBe('stale');
      const gone = await app.settled(path, 404);
      expect(gone.status).toBe(404);
      // Regenerated behind a request, and still the document of the entry's OWN locale.
      expect(await gone.text()).toContain(`<html lang="${LANG[path]}">`);
    }
    app.detach();
  });

  test('an embargoed post goes public in every locale on the ttl alone, with no tag busted', async () => {
    const app = served();
    publishedAt = at + 60_000;
    // Asked for during the embargo: the negative answer is stored, as any isr answer is.
    for (const path of PATHS) expect((await app.get(path)).status).toBe(404);

    at = publishedAt;
    for (const path of PATHS) expect((await app.get(path)).status).toBe(404);

    at += TTL_MS;
    for (const path of PATHS) {
      const live = await app.settled(path, 200);
      expect(live.status).toBe(200);
      expect(await live.text()).toContain('the post');
    }
    app.detach();
  });
});
