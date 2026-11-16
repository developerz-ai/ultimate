import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { dependentsOfKind, invalidateTags, isolateGraph, resetGraph, tag } from '@ultimat3/cache';
import { clearRoutes, describePages, registerRoute } from './registry';
import { isrController } from './render-isr';
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

// An empty graph is this file's subject, so the per-test reset stays. What it owes the process is
// the restore: a reset drops the edges a neighbour registered, and the leak guard reports
// additions only — so a destructive cleanup surfaces as a failure in an innocent file.
const restoreGraph = isolateGraph();

beforeEach(() => {
  clearRoutes();
  resetGraph();
});

afterAll(() => {
  // The graph AND the registry. `beforeEach` clears routes for this file's own sake; this clears
  // them for everyone else's — the registry is process-global, so the last test in this file left
  // its routes visible to every suite that ran after it, in whatever order `bun test` chose.
  clearRoutes();
  restoreGraph();
});

describe('single-flight regeneration', () => {
  test('a burst of concurrent requests renders exactly once', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = isrController({ routes: describePages });

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
    const controller = isrController({ routes: describePages });

    let version = 1;
    const render = (): string => `<p>v${version}</p>`;

    const first = await controller.serve('/blog/a', render);
    expect(first.state).toBe('miss');
    expect(first.result.body).toBe('<p>v1</p>');

    await controller.markStale('/blog/a');
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

  /**
   * The background half runs a route's own render function, and `.catch` is the last frame under
   * it: `error instanceof Error ? error.message : String(error)` RUNS app code — `String()` raises
   * on a null-prototype object — so the handler that exists to log the failure became a second,
   * unhandled rejection with nothing left to report it.
   */
  test('a regeneration that throws a value String() cannot render still logs and moves on', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = isrController({ routes: describePages });

    let fail = false;
    const render = (): string => {
      if (fail) throw Object.create(null);
      return '<p>v1</p>';
    };

    await controller.serve('/blog/a', render);
    await controller.markStale('/blog/a');
    fail = true;

    const stale = await controller.serve('/blog/a', render);
    expect(stale.regenerating).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The stale copy is still served, and the controller still answers.
    expect((await controller.serve('/blog/a', render)).result.body).toBe('<p>v1</p>');
  });
});

describe('the CDN is told the TTL the route declared', () => {
  test("revalidate: { ttl: '5m' } advertises s-maxage=300, not a house default", async () => {
    isrRoute('apps/web/site/pricing/page.tsx', [postTag], '5m');
    const controller = isrController({ routes: describePages });

    const { result } = await controller.serve('/pricing', () => '<p>pricing</p>');
    expect(sMaxAge(result)).toBe('300');
    expect(result.headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
    );
  });

  test('a sub-minute ttl shortens the shared cache too', async () => {
    isrRoute('apps/web/site/status/page.tsx', [postTag], '30s');
    const controller = isrController({ routes: describePages });

    expect(sMaxAge((await controller.serve('/status', () => '<p>ok</p>')).result)).toBe('30');
  });

  test('a tag-only route keeps the 60s floor: its clock is the invalidation graph', async () => {
    isrRoute('apps/web/site/team/page.tsx', [orgTag]);
    const controller = isrController({ routes: describePages });

    const { entry, result } = await controller.serve('/team', () => '<p>team</p>');
    expect(entry.ttlMs).toBe(null);
    expect(sMaxAge(result)).toBe('60');
  });

  test('the served-stale copy keeps its own TTL and is marked stale', async () => {
    isrRoute('apps/web/site/pricing/page.tsx', [postTag], '5m');
    const controller = isrController({ routes: describePages });

    await controller.serve('/pricing', () => '<p>v1</p>');
    await controller.markStale('/pricing');

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
    const controller = isrController({ routes: describePages });

    const render = (path: string): string => `<p>${path}</p>`;
    await controller.serve('/blog/a', render);
    await controller.serve('/blog/b', render);
    await controller.serve('/team', render);

    // invalidates: [tag.post] regenerates exactly the dependent routes, nothing else
    expect(await controller.revalidateByTags([postTag])).toEqual(['/blog/a', '/blog/b']);
    expect((await controller.store().get('/blog/a'))?.stale).toBe(true);
    expect((await controller.store().get('/team'))?.stale).toBe(false);

    expect(await controller.revalidateByTags([orgTag])).toEqual(['/team']);
  });

  test('a row tag busts the pages registered under its collection tag', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = isrController({ routes: describePages });
    await controller.serve('/blog/a', (path) => `<p>${path}</p>`);

    expect(await controller.revalidateByTags([tag('post', '1')])).toEqual(['/blog/a']);
  });

  test('attach registers the controller as the framework revalidator', async () => {
    isrRoute('apps/web/site/team/page.tsx', [orgTag]);
    const controller = isrController({ routes: describePages });
    const detach = controller.attach();
    await controller.serve('/team', () => '<p>team</p>');

    expect((await controller.store().get('/team'))?.stale).toBe(false);
    detach();
    // The GRAPH edge is what detach drops; the controller's own store is still its to ask.
    expect(dependentsOfKind([orgTag], 'isr-route')).toEqual([]);
  });
});

describe('detach releases the revalidator, not only the dependents', () => {
  // The `x dev` hot reload: controller A attaches, the reload detaches it and creates B, and
  // `invalidateTags` still called A's `markStale` — so B's pages never went stale and A's whole
  // store stayed reachable from the cache graph.
  test('a detached controller stops receiving revalidations', async () => {
    isrRoute('apps/web/site/team/page.tsx', [orgTag]);
    const a = isrController({ routes: describePages });
    const detachA = a.attach();
    await a.serve('/team', () => '<p>a</p>');
    detachA();

    // The reload's other half: a new controller renders the same path — which puts it back in
    // the graph — and never attaches, so the only revalidator installed is the detached one's.
    const b = isrController({ routes: describePages });
    await b.serve('/team', () => '<p>b</p>');

    await invalidateTags([orgTag]);

    expect((await a.store().get('/team'))?.stale).toBe(false);
    expect((await b.store().get('/team'))?.stale).toBe(false);
  });

  // Detaching in the wrong order must not silence the controller that owns the slot now.
  test('a stale detach never clears a revalidator another controller installed', async () => {
    isrRoute('apps/web/site/team/page.tsx', [orgTag]);
    const a = isrController({ routes: describePages });
    const detachA = a.attach();
    const b = isrController({ routes: describePages });
    b.attach();
    await b.serve('/team', () => '<p>b</p>');

    detachA();
    await invalidateTags([orgTag]);

    expect((await b.store().get('/team'))?.stale).toBe(true);
  });
});
