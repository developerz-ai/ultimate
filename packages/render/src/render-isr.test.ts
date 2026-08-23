import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { invalidateTags, isolateGraph, resetGraph, tag } from '@ultimat3/cache';
import { clearRoutes, describeRoutes, registerRoute } from './registry';
import { createIsrController, isrKey, memoryIsrStore } from './render-isr';
import type { RenderResult, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

/** The store key for a path in this file's one locale — `isrKey` owns the derivation. */
const isrKeyOf = (path: string): string => isrKey(new URL(`https://app.test${path}`), 'en');

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

  /**
   * The background half runs a route's own render function, and `.catch` is the last frame under
   * it: `error instanceof Error ? error.message : String(error)` RUNS app code — `String()` raises
   * on a null-prototype object — so the handler that exists to log the failure became a second,
   * unhandled rejection with nothing left to report it.
   */
  test('a regeneration that throws a value String() cannot render still logs and moves on', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({ routes: describeRoutes });

    let fail = false;
    const render = (): string => {
      if (fail) throw Object.create(null);
      return '<p>v1</p>';
    };

    await controller.serve('/blog/a', render);
    controller.markStale('/blog/a');
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
    const controller = createIsrController({ routes: describeRoutes });

    const { result } = await controller.serve('/pricing', () => '<p>pricing</p>');
    expect(sMaxAge(result)).toBe('300');
    expect(result.headers['cache-control']).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
    );
  });

  test('a sub-minute ttl shortens the shared cache too', async () => {
    isrRoute('apps/web/site/status/page.tsx', [postTag], '30s');
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
    isrRoute('apps/web/site/pricing/page.tsx', [postTag], '5m');
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

describe('detach releases the revalidator, not only the dependents', () => {
  // The `x dev` hot reload: controller A attaches, the reload detaches it and creates B, and
  // `invalidateTags` still called A's `markStale` — so B's pages never went stale and A's whole
  // store stayed reachable from the cache graph.
  test('a detached controller stops receiving revalidations', async () => {
    isrRoute('apps/web/site/team/page.tsx', [orgTag]);
    const a = createIsrController({ routes: describeRoutes });
    const detachA = a.attach();
    await a.serve('/team', () => '<p>a</p>');
    detachA();

    // The reload's other half: a new controller renders the same path — which puts it back in
    // the graph — and never attaches, so the only revalidator installed is the detached one's.
    const b = createIsrController({ routes: describeRoutes });
    await b.serve('/team', () => '<p>b</p>');

    await invalidateTags([orgTag]);

    expect(a.store().get('/team')?.stale).toBe(false);
    expect(b.store().get('/team')?.stale).toBe(false);
  });

  // Detaching in the wrong order must not silence the controller that owns the slot now.
  test('a stale detach never clears a revalidator another controller installed', async () => {
    isrRoute('apps/web/site/team/page.tsx', [orgTag]);
    const a = createIsrController({ routes: describeRoutes });
    const detachA = a.attach();
    const b = createIsrController({ routes: describeRoutes });
    b.attach();
    await b.serve('/team', () => '<p>b</p>');

    detachA();
    await invalidateTags([orgTag]);

    expect(b.store().get('/team')?.stale).toBe(true);
  });
});

describe('the default ISR store is bounded', () => {
  test('evicts the least recently generated page once the cap is spent', () => {
    const store = memoryIsrStore({ maxEntries: 3 });
    const entry = (path: string) => ({
      path,
      html: `<p>${path}</p>`,
      hash: path,
      generatedAt: 0,
      ttlMs: null,
      stale: false,
    });

    for (const path of ['/a', '/b', '/c', '/d']) store.set(entry(path));

    expect(store.paths()).toEqual(['/b', '/c', '/d']);
    expect(store.get('/a')).toBeUndefined();
  });

  test('re-generating a page makes it the most recent, not a second entry', () => {
    const store = memoryIsrStore({ maxEntries: 2 });
    const entry = (path: string, generatedAt: number) => ({
      path,
      html: `<p>${path}</p>`,
      hash: path,
      generatedAt,
      ttlMs: null,
      stale: false,
    });

    store.set(entry('/a', 1));
    store.set(entry('/b', 2));
    store.set(entry('/a', 3)); // /a regenerates, so /b is now the oldest
    store.set(entry('/c', 4));

    expect(store.paths()).toEqual(['/a', '/c']);
  });

  // The store was bounded; the controller's dependent registrations were not. `registerPath` only
  // ever added, and an eviction is silent, so a crawler over 100k slugs left 100k edges in the
  // cache graph pointing at pages the store no longer holds — an unbounded map in a process that
  // runs for weeks, and a `revalidateByTags` that reported marking pages it did not mark.
  test('an evicted page leaves the invalidation graph with it', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({
      routes: describeRoutes,
      store: memoryIsrStore({ maxEntries: 2 }),
    });
    const render = (path: string): string => `<p>${path}</p>`;

    await controller.serve('/blog/a', render);
    await controller.serve('/blog/b', render);
    await controller.serve('/blog/c', render);

    expect(controller.store().paths()).toEqual(['/blog/b', '/blog/c']);
    expect(controller.revalidateByTags([postTag])).toEqual(['/blog/b', '/blog/c']);
  });

  test('a page rendered again after its eviction rejoins the graph', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({
      routes: describeRoutes,
      store: memoryIsrStore({ maxEntries: 2 }),
    });
    const render = (path: string): string => `<p>${path}</p>`;

    await controller.serve('/blog/a', render);
    await controller.serve('/blog/b', render);
    await controller.serve('/blog/c', render); // evicts /blog/a
    await controller.serve('/blog/a', render); // evicts /blog/b

    expect(controller.revalidateByTags([postTag])).toEqual(['/blog/a', '/blog/c']);
  });
});

// #171's second half. A gated ISR route is refused at `defineRoute` (`modes.ts`), which closes the
// actor axis at build time — but two URLs that differ only in their query are two documents no
// build error can tell apart, and the store keyed both as the bare pathname.
describe('the store key carries the query, and the route lookup does not', () => {
  test('two queries on one path are two entries, not one served twice', async () => {
    isrRoute('apps/web/site/blog/page.tsx', [postTag], '5m');
    const isr = createIsrController({ store: memoryIsrStore() });

    const first = await isr.serve('/blog?page=2', () => '<p>page 2</p>');
    const second = await isr.serve('/blog?page=3', () => '<p>page 3</p>');

    expect(first.result.body).toBe('<p>page 2</p>');
    // The whole issue in one assertion: keyed on `/blog`, this was `<p>page 2</p>` and `state`
    // was `hit` — a second visitor served the first visitor's document.
    expect(second.result.body).toBe('<p>page 3</p>');
    expect(second.state).toBe('miss');
    expect(isr.store().paths()).toEqual(['/blog?page=2', '/blog?page=3']);
  });

  test('a query-keyed entry still resolves ITS ROUTE for the declared TTL', async () => {
    // The trap in the obvious fix. `descriptorFor` asks the route TABLE, and `/blog?page=2`
    // matches no route pattern — so a key change without stripping the query first would answer
    // `ttlMs: null`, and `revalidate: { ttl: '5m' }` would silently become tag-only. `s-maxage`
    // is where that surfaces: 300 is the declared five minutes, 60 is the tag-only fallback.
    isrRoute('apps/web/site/blog/page.tsx', [postTag], '5m');
    const isr = createIsrController({ store: memoryIsrStore() });

    const served = await isr.serve('/blog?page=2', () => '<p>x</p>');

    expect(sMaxAge(served.result)).toBe('300');
    expect(served.entry.ttlMs).toBe(300_000);
  });

  test('a dynamic route with a query resolves through its pattern too', async () => {
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag], '5m');
    const isr = createIsrController({ store: memoryIsrStore() });

    const served = await isr.serve('/blog/hello?utm_source=x', () => '<p>x</p>');

    expect(sMaxAge(served.result)).toBe('300');
  });

  test('a tag bust marks the query-keyed entries, so nothing escapes invalidation', async () => {
    isrRoute('apps/web/site/blog/page.tsx', [postTag], '5m');
    const isr = createIsrController({ store: memoryIsrStore() });
    await isr.serve('/blog?page=2', () => '<p>a</p>');
    await isr.serve('/blog?page=3', () => '<p>b</p>');

    expect(isr.revalidateByTags([postTag])).toEqual(['/blog?page=2', '/blog?page=3']);
  });
});

describe('a bust that lands mid-render', () => {
  test('is not erased by the pre-write HTML the render was already holding', async () => {
    // `regenerate` rendered, then wrote `{ stale: false }` unconditionally. A `markStale` that
    // landed between the two — `invalidateTags` -> the revalidator -> `markStale` — was erased by
    // an entry built from rows read BEFORE the write, and for a tag-only route `isFresh` is then
    // true forever: the process serves pre-write HTML for the rest of its life.
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({ routes: describeRoutes });
    controller.attach();

    let release = (_html: string): void => undefined;
    const key = isrKeyOf('/blog/a');
    const served = controller.serve(key, async () => {
      return await new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    // The bust lands while the render above is still in flight.
    await Promise.resolve();
    await invalidateTags([postTag]);
    release('<p>PRE-WRITE</p>');
    await served;

    // Present or forgotten, but never a FRESH entry holding pre-write HTML.
    const stored = controller.store().get(key);
    expect(stored?.html).not.toBe('<p>PRE-WRITE</p>');
  });

  test('a cold path is in the invalidation graph before its first render finishes', async () => {
    // `registerPath` ran AFTER the render, so `revalidateByTags` could not see a path whose first
    // render was still in flight — the window in which the bust that matters most arrives.
    isrRoute('apps/web/site/blog/[slug]/page.tsx', [postTag]);
    const controller = createIsrController({ routes: describeRoutes });

    let release = (_html: string): void => undefined;
    const key = isrKeyOf('/blog/b');
    const served = controller.serve(key, async () => {
      return await new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    await Promise.resolve();
    expect(controller.revalidateByTags([postTag])).toEqual([key]);

    release('<p>b</p>');
    await served;
  });
});

describe('memoryIsrStore eviction order', () => {
  test('marking a page stale does not make it the newest — eviction is by generation', () => {
    // `markStale` re-inserted through `set`, so the Map's iteration order — which IS the eviction
    // order — put the STALEST page last. A tag bust therefore protected exactly the pages that
    // most needed regenerating and evicted the freshest one instead.
    const store = memoryIsrStore({ maxEntries: 2 });
    const entry = (path: string): void =>
      store.set({ path, html: path, hash: path, generatedAt: 0, ttlMs: null, stale: false });

    entry('/a');
    entry('/b');
    store.markStale('/a');
    entry('/c');

    expect(store.paths()).toEqual(['/b', '/c']);
  });

  test('an in-place mark answers false for a page the store never held', () => {
    expect(memoryIsrStore().markStale('/nothing')).toBe(false);
  });
});

describe('isrKey', () => {
  test('a bare path carries the locale and nothing else', () => {
    expect(isrKey(new URL('https://app.test/blog'), 'en')).toBe('/blog?__x_locale=en');
  });

  test('params are SORTED, so one page is not rendered twice under two spellings', () => {
    expect(isrKey(new URL('https://app.test/blog?b=2&a=1'), 'en')).toBe(
      '/blog?__x_locale=en&a=1&b=2',
    );
    expect(isrKey(new URL('https://app.test/blog?a=1&b=2'), 'en')).toBe(
      '/blog?__x_locale=en&a=1&b=2',
    );
  });

  test('the fragment is never in the key — a browser never sends it', () => {
    expect(isrKey(new URL('https://app.test/blog?a=1#section'), 'en')).toBe(
      '/blog?__x_locale=en&a=1',
    );
  });

  // The document is rendered with `<html lang>` and every `t()` in the request's own locale, so
  // one entry per path handed visitor 2 the document negotiated for visitor 1 — and told the CDN
  // to do the same for the whole TTL. Two locales are two documents.
  test('two locales are two keys for one path', () => {
    const url = new URL('https://app.test/blog/hello');
    expect(isrKey(url, 'es')).not.toBe(isrKey(url, 'en'));
  });

  test('the key still resolves to its own route, so the TTL is the route’s', () => {
    // `routePathOf` splits at the `?`; the locale rides in the query for exactly this reason —
    // a prefix would make `descriptorFor` match no route and silently drop a declared ttl.
    expect(isrKey(new URL('https://app.test/blog/hello'), 'es').split('?')[0]).toBe('/blog/hello');
  });
});
