// A re-enumeration that fails keeps the sitemap it was replacing. `prerender()` reads rows; when
// the hourly memo expired during a database blip the running web role answered `/sitemap.xml` a
// 500, and the previous — correct — list of pages was already forgotten.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { seoRoutes } from './seo-routes';

const BUILD_ID = 'seo-kept-under-test';
const ENV = { ULTIMATE_ENV: 'production', APP_URL: 'https://www.example.com/' };
const HOUR_MS = 3_600_000;

let slugs: readonly string[] | 'down' = ['hello', 'world'];
let enumerations = 0;
let clock = 0;

beforeEach(() => {
  clearRoutes();
  slugs = ['hello', 'world'];
  enumerations = 0;
  clock = 0;
  registerRoute({
    file: 'apps/web/site/blog/[slug]/page.tsx',
    component: () => 'post',
    config: defineRoute({
      render: 'isr',
      revalidate: { ttl: '5m' },
      hydrate: 'never',
      offline: 'network-only',
      prerender: () => {
        enumerations += 1;
        // A foreign failure handed to the code under test: the driver's, not this test's verdict.
        if (slugs === 'down') return Promise.reject(new Error('the pool refused a connection'));
        return slugs;
      },
      meta: () => ({ title: 'Post', description: 'a post' }),
    }),
  });
});

afterEach(() => {
  clearRoutes();
});

const server = () =>
  httpServer({
    routes: seoRoutes({ env: ENV, now: () => clock }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

const locsOf = async (response: Response): Promise<readonly string[]> =>
  [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? '').sort();

describe('unit · a failed sitemap re-enumeration keeps the previous answer', () => {
  test('the memo expires during a failing read: the last good sitemap is served, then retried', async () => {
    const app = server();
    const get = () => app.fetch(new Request('https://www.example.com/sitemap.xml'));
    const good = ['https://www.example.com/blog/hello', 'https://www.example.com/blog/world'];
    expect(await locsOf(await get())).toEqual(good);
    expect(enumerations).toBe(1);

    slugs = 'down';
    clock += HOUR_MS + 1;
    const during = await get();
    expect(during.status).toBe(200);
    expect(await locsOf(during)).toEqual(good);
    expect(enumerations).toBe(2);

    // Not asked again on the very next request — a crawler's burst is not a retry storm.
    expect((await get()).status).toBe(200);
    expect(enumerations).toBe(2);

    // A minute later it is, and the read has recovered with one more post.
    slugs = ['hello', 'world', 'again'];
    clock += 60_001;
    expect(await locsOf(await get())).toEqual(
      [...good, 'https://www.example.com/blog/again'].sort(),
    );
    expect(enumerations).toBe(3);
  });

  test('a FIRST enumeration that fails has nothing to keep: the request fails and the next asks again', async () => {
    slugs = 'down';
    const app = server();
    const get = () => app.fetch(new Request('https://www.example.com/sitemap.xml'));
    expect((await get()).status).toBeGreaterThanOrEqual(500);
    slugs = ['hello'];
    expect(await locsOf(await get())).toEqual(['https://www.example.com/blog/hello']);
  });
});
