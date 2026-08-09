import { beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { resetGraph, tag } from '@ultimat3/cache';
import { clearRoutes, describeRoutes, registerRoute } from './registry';
import { createIsrController, parseTtlMs } from './render-isr';
import type { RenderResult, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

const postTag: CacheTag = tag('post');
const orgTag: CacheTag = tag('org');

function isrRoute(file: string, tags: readonly CacheTag[], ttl?: string): void {
  registerRoute({
    file,
    config: defineRoute({
      render: 'isr',
      revalidate: ttl === undefined ? { tags } : { tags, ttl },
      offline: 'precache',
      hydrate: 'never',
      meta,
    }),
  });
}

function sMaxAge(result: RenderResult): string | undefined {
  return /s-maxage=(\d+)/.exec(result.headers['cache-control'] ?? '')?.[1];
}

beforeEach(() => {
  clearRoutes();
  resetGraph();
});

describe('parseTtlMs', () => {
  test('parses duration strings and passes milliseconds through', () => {
    expect(parseTtlMs('5m')).toBe(300_000);
    expect(parseTtlMs('1h')).toBe(3_600_000);
    expect(parseTtlMs(1500)).toBe(1500);
    expect(parseTtlMs('soon')).toBe(null);
    expect(parseTtlMs(undefined)).toBe(null);
  });
});

describe('single-flight regeneration', () => {
  test('a burst of concurrent requests renders exactly once', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({ routes: describeRoutes });

    let calls = 0;
    const render = async (path: string): Promise<string> => {
      calls += 1;
      await Promise.resolve();
      return `<p>${path}</p>`;
    };

    const results = await Promise.all([
      controller.serve('/blog/a', render),
      controller.serve('/blog/a', render),
      controller.serve('/blog/a', render),
    ]);

    expect(calls).toBe(1);
    expect(results.map((r) => r.state)).toEqual(['miss', 'miss', 'miss']);
    expect(controller.inflight()).toBe(0);
  });

  test('a stale entry is served immediately and refreshed behind the request', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({ routes: describeRoutes });

    let version = 1;
    const render = (): string => `<p>v${version}</p>`;

    const first = await controller.serve('/blog/a', render);
    expect(first.state).toBe('miss');
    expect(first.result.body).toBe('<p>v1</p>');

    controller.markStale('/blog/a');
    version = 2;

    const stale = await controller.serve('/blog/a', render);
    expect(stale.state).toBe('stale');
    // stale-while-revalidate: the old body, right now — never a spinner.
    expect(stale.result.body).toBe('<p>v1</p>');
    expect(stale.result.headers['x-ultimate-isr']).toBe('stale');
    expect(stale.regenerating).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const fresh = await controller.serve('/blog/a', render);
    expect(fresh.state).toBe('hit');
    expect(fresh.result.body).toBe('<p>v2</p>');
  });
});

describe('the CDN is told the TTL the route declared', () => {
  test("revalidate: { ttl: '5m' } advertises s-maxage=300, not a house default", async () => {
    isrRoute('apps/web/site/pricing.tsx', [postTag], '5m');
    const controller = createIsrController({ routes: describeRoutes });

    const { result } = await controller.serve('/pricing', () => '<p>pricing</p>');
    expect(sMaxAge(result)).toBe('300');
    expect(result.headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
    );
  });

  test('a sub-minute ttl shortens the shared cache too', async () => {
    isrRoute('apps/web/site/status.tsx', [postTag], '30s');
    const controller = createIsrController({ routes: describeRoutes });

    expect(sMaxAge((await controller.serve('/status', () => '<p>ok</p>')).result)).toBe('30');
  });

  test('a tag-only route keeps the 60s floor: its clock is the invalidation graph', async () => {
    isrRoute('apps/web/site/team/page.tsx', [orgTag]);
    const controller = createIsrController({ routes: describeRoutes });

    const { entry, result } = await controller.serve('/team', () => '<p>team</p>');
    expect(entry.ttlMs).toBe(null);
    expect(sMaxAge(result)).toBe('60');
  });

  test('the served-stale copy keeps its own TTL and is marked stale', async () => {
    isrRoute('apps/web/site/pricing.tsx', [postTag], '5m');
    const controller = createIsrController({ routes: describeRoutes });

    await controller.serve('/pricing', () => '<p>v1</p>');
    controller.markStale('/pricing');

    const stale = await controller.serve('/pricing', () => '<p>v2</p>');
    expect(stale.state).toBe('stale');
    expect(stale.result.headers['x-ultimate-isr']).toBe('stale');
    expect(sMaxAge(stale.result)).toBe('300');
  });
});

describe('tag-driven revalidation', () => {
  test('a rendered page joins the invalidation graph under its route tags', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    isrRoute('apps/web/site/team/page.tsx', [orgTag]);
    const controller = createIsrController({ routes: describeRoutes });

    const render = (path: string): string => `<p>${path}</p>`;
    await controller.serve('/blog/a', render);
    await controller.serve('/blog/b', render);
    await controller.serve('/team', render);

    // invalidates: [tag.post] regenerates exactly the dependent routes, nothing else
    expect(controller.revalidateByTags([postTag])).toEqual(['/blog/a', '/blog/b']);
    expect(controller.store().get('/blog/a')?.stale).toBe(true);
    expect(controller.store().get('/team')?.stale).toBe(false);

    expect(controller.revalidateByTags([orgTag])).toEqual(['/team']);
  });

  test('a row tag busts the pages registered under its collection tag', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({ routes: describeRoutes });
    await controller.serve('/blog/a', (path) => `<p>${path}</p>`);

    expect(controller.revalidateByTags([tag('post', '1')])).toEqual(['/blog/a']);
  });

  test('attach registers the controller as the framework revalidator', async () => {
    isrRoute('apps/web/site/team/page.tsx', [orgTag]);
    const controller = createIsrController({ routes: describeRoutes });
    const detach = controller.attach();
    await controller.serve('/team', () => '<p>team</p>');

    expect(controller.store().get('/team')?.stale).toBe(false);
    detach();
    expect(controller.revalidateByTags([orgTag])).toEqual([]);
  });
});
