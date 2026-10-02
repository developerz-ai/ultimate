// A tag-revalidated ISR document is the one tagged public response the framework ships, and the
// CDN purges by exact key — so the keys on that document are the whole of "an action's
// `invalidates` reaches the edge". Until this file they were absent: every purge named keys no
// response carried, and answered `errors: []`.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag, PurgeDriver } from '@ultimat3/cache';
import { createCdnTier, isolateGraph, resetGraph, tag } from '@ultimat3/cache';
import { clearRoutes, describeRoutes, registerRoute } from './registry';
import { createIsrController } from './render-isr';
import type { RenderResult, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

const restoreGraph = isolateGraph();

beforeEach(() => {
  clearRoutes();
  resetGraph();
});

afterAll(() => {
  clearRoutes();
  restoreGraph();
});

function isrRoute(file: string, revalidate: { tags?: readonly CacheTag[]; ttl?: string }): void {
  registerRoute({
    file,
    config: defineRoute({
      render: 'isr',
      revalidate,
      offline: 'precache',
      hydrate: 'never',
      meta,
    }),
  });
}

const BLOG = 'apps/web/site/blog/page.tsx';
const render = (): string => '<p>page</p>';

const serveOnce = async (path: string): Promise<RenderResult> =>
  (await createIsrController({ routes: describeRoutes }).serve(path, render)).result;

const carried = (result: RenderResult): string[] =>
  (result.headers['surrogate-key'] ?? '').split(' ').filter((key) => key !== '');

/** What a bust of `tags` asks the edge to purge, through the real CDN tier. */
const purgedBy = async (tags: readonly CacheTag[]): Promise<string[]> => {
  const purged: string[] = [];
  const driver: PurgeDriver = {
    name: 'spy',
    purge(keys) {
      purged.push(...keys);
      return Promise.resolve(keys);
    },
    purgeAll: () => Promise.resolve(),
  };
  await createCdnTier({ purge: driver }).invalidateTags(tags);
  return purged;
};

const reaches = async (bust: CacheTag, result: RenderResult): Promise<boolean> => {
  const purged = await purgedBy([bust]);
  return carried(result).some((key) => purged.includes(key));
};

describe('a tag-revalidated ISR document carries its purge keys', () => {
  test('each tag, plus the entity index, in both spellings', async () => {
    isrRoute(BLOG, { tags: [tag('post', '1'), tag('author')] });
    const { headers } = await serveOnce('/blog');
    expect(headers['surrogate-key']).toBe('post:1 e:post author e:author');
    expect(headers['cache-tag']).toBe('post:1,e:post,author,e:author');
  });

  test('a TTL-only page carries neither header', async () => {
    isrRoute(BLOG, { ttl: '5m' });
    const { headers } = await serveOnce('/blog');
    expect(headers['surrogate-key']).toBeUndefined();
    expect(headers['cache-tag']).toBeUndefined();
    expect(headers['cache-control']).toContain('s-maxage=300');
  });

  test('a miss, a hit and a served-stale answer all carry them', async () => {
    isrRoute(BLOG, { tags: [tag('post')] });
    const controller = createIsrController({ routes: describeRoutes });

    const miss = await controller.serve('/blog', render);
    const hit = await controller.serve('/blog', render);
    controller.markStale('/blog');
    const stale = await controller.serve('/blog', render);

    expect([miss.state, hit.state, stale.state]).toEqual(['miss', 'hit', 'stale']);
    for (const answer of [miss, hit, stale]) {
      expect(answer.result.headers['surrogate-key']).toBe('post e:post');
      expect(answer.result.headers['cache-tag']).toBe('post,e:post');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('a dynamic route carries its keys on every path it answers', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', { tags: [tag('post')] });
    expect(carried(await serveOnce('/blog/a'))).toEqual(['post', 'e:post']);
  });
});

describe('what a document carries is what a bust purges', () => {
  // The property the whole row exists for, proved across the package boundary: the keys come
  // from `surrogateKeys` here and the purge list from the CDN tier there.
  test('a bust of each of its own tags reaches it', async () => {
    const tags = [tag('post', '1'), tag('author')];
    isrRoute(BLOG, { tags });
    const result = await serveOnce('/blog');
    for (const bust of tags) expect(await reaches(bust, result)).toBe(true);
  });

  test('a COLLECTION bust reaches a document tagged with one row', async () => {
    isrRoute(BLOG, { tags: [tag('post', '1')] });
    expect(await reaches(tag('post'), await serveOnce('/blog'))).toBe(true);
  });

  test('a ROW bust reaches a document tagged with the collection', async () => {
    isrRoute(BLOG, { tags: [tag('post')] });
    expect(await reaches(tag('post', '1'), await serveOnce('/blog'))).toBe(true);
  });

  test('a bust of another row, or another entity, does not', async () => {
    isrRoute(BLOG, { tags: [tag('post', '1')] });
    const result = await serveOnce('/blog');
    expect(await reaches(tag('post', '2'), result)).toBe(false);
    expect(await reaches(tag('author'), result)).toBe(false);
  });
});
