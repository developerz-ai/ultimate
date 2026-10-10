// A re-enumeration that fails — or hangs — keeps the sitemap it was replacing. `prerender()` reads
// rows; when the hourly memo expired during a database blip the running web role answered
// `/sitemap.xml` a 500, and a read that never answered held every request on its pending promise.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setLogSink } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { seoRoutes } from './seo-routes';

const BUILD_ID = 'seo-kept-under-test';
const ENV = { ULTIMATE_ENV: 'production', APP_URL: 'https://www.example.com/' };
const HOUR_MS = 3_600_000;

let slugs: readonly string[] | 'down' | 'hung' = ['hello', 'world'];
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
        // A read that never answers: a connection the pool handed out and the network dropped.
        if (slugs === 'hung') return new Promise<readonly string[]>(() => undefined);
        return slugs;
      },
      meta: () => ({ title: 'Post', description: 'a post' }),
    }),
  });
});

afterEach(() => {
  clearRoutes();
});

const server = (enumerationTimeoutMs?: number) =>
  httpServer({
    routes: seoRoutes({
      env: ENV,
      now: () => clock,
      ...(enumerationTimeoutMs === undefined ? {} : { enumerationTimeoutMs }),
    }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

const locsOf = async (response: Response): Promise<readonly string[]> =>
  [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1] ?? '').sort();

/** One turn of the loop: a refresh runs BEHIND the answer, so its result lands after the request. */
const settle = (): Promise<void> => Bun.sleep(5);

describe('unit · a sitemap refresh runs behind the answer it would replace', () => {
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
    await settle();
    expect(enumerations).toBe(2);

    // Not asked again on the very next request — a crawler's burst is not a retry storm.
    expect((await get()).status).toBe(200);
    await settle();
    expect(enumerations).toBe(2);

    // A minute later it is, and the read has recovered with one more post: the request that
    // started the refresh still gets the kept answer, and the next one the new sitemap.
    slugs = ['hello', 'world', 'again'];
    clock += 60_001;
    expect(await locsOf(await get())).toEqual(good);
    await settle();
    expect(enumerations).toBe(3);
    expect(await locsOf(await get())).toEqual(
      [...good, 'https://www.example.com/blog/again'].sort(),
    );

    // And the refreshed answer is itself refreshed an hour on.
    clock += HOUR_MS + 1;
    await get();
    await settle();
    expect(enumerations).toBe(4);
  });

  test('a refresh that HANGS blocks nobody: every request gets the kept sitemap, and it is tried again', async () => {
    const app = server(20);
    const get = () => app.fetch(new Request('https://www.example.com/sitemap.xml'));
    const good = ['https://www.example.com/blog/hello', 'https://www.example.com/blog/world'];
    expect(await locsOf(await get())).toEqual(good);

    slugs = 'hung';
    clock += HOUR_MS + 1;
    for (let request = 0; request < 3; request += 1)
      expect(await locsOf(await get())).toEqual(good);
    expect(enumerations).toBe(2);

    // Past the enumeration's own deadline and the retry wait, a new refresh starts.
    await Bun.sleep(40);
    slugs = ['only'];
    clock += 60_001;
    expect(await locsOf(await get())).toEqual(good);
    await settle();
    expect(enumerations).toBe(3);
    expect(await locsOf(await get())).toEqual(['https://www.example.com/blog/only']);
  });

  test('the third consecutive failed refresh is logged as an error, not a warning', async () => {
    const app = server();
    const get = () => app.fetch(new Request('https://www.example.com/sitemap.xml'));
    await get();
    slugs = 'down';
    const lines: string[] = [];
    const previous = setLogSink((line) => {
      lines.push(line);
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        clock += HOUR_MS + 1;
        await get();
        await settle();
      }
    } finally {
      setLogSink(previous);
    }
    const kept = lines
      .filter((line) => line.includes('seo.enumeration.kept'))
      .map((line) => JSON.parse(line) as { level: string; failures: number });
    expect(kept.map((line) => [line.level, line.failures])).toEqual([
      ['warn', 1],
      ['warn', 2],
      ['error', 3],
    ]);
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
