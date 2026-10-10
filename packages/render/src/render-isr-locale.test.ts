// A locale-prefixed ISR page is the route's page: `/en/blog/a` is `/blog/:slug` in English. The
// store key keeps the prefix (one document per locale), and every question asked of the ROUTE
// TABLE has to drop it, as the router does before it matches. It did not: `/en/blog/a` matched no
// route, so the entry carried no ttl and joined no tag — fresh forever, a withdrawn post still 200.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTag } from '@ultimat3/cache';
import { invalidateTags, isolateGraph, resetGraph, tag } from '@ultimat3/cache';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import { clearRoutes, describePages, registerRoute } from './registry';
import { isrController } from './render-isr';
import { isrKey } from './render-isr-key';
import type { IsrRendered } from './render-isr-types';
import type { RenderResult, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;
const blogTag: CacheTag = tag('blog');
const TTL_MS = 120_000;

/** The key the served app derives for a request: the pathname AS REQUESTED, and its locale. */
const keyOf = (path: string, locale: string): string =>
  isrKey(new URL(`https://app.test${path}`), locale);

const EN = keyOf('/en/blog/a', 'en');
const ES = keyOf('/blog/a', 'es-CO');

const sMaxAge = (result: RenderResult): string | undefined =>
  /s-maxage=(\d+)/.exec(result.headers['cache-control'] ?? '')?.[1];

const restoreGraph = isolateGraph();

beforeEach(() => {
  clearRoutes();
  resetGraph();
  configureLocales({ supported: ['es-CO', 'en'], fallback: 'es-CO' });
  for (const file of ['apps/web/site/blog/page.tsx', 'apps/web/site/blog/[slug]/page.tsx']) {
    registerRoute({
      file,
      config: defineRoute({
        render: 'isr',
        revalidate: { tags: [blogTag], ttl: '2m' },
        offline: 'precache',
        hydrate: 'never',
        meta,
      }),
    });
  }
});

afterEach(() => {
  resetLocaleConfig();
});

afterAll(() => {
  clearRoutes();
  restoreGraph();
});

/** A clock the test owns, and a controller attached as the framework's revalidator. */
function attached(): {
  readonly controller: ReturnType<typeof isrController>;
  readonly advance: (ms: number) => void;
  readonly detach: () => void;
} {
  let at = 1_000_000;
  const controller = isrController({ routes: describePages, now: () => at });
  return {
    controller,
    advance: (ms) => {
      at += ms;
    },
    detach: controller.attach(),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('a locale-prefixed isr page is revalidated as its route declares', () => {
  test("the prefixed entry carries the route's ttl, s-maxage and surrogate keys", async () => {
    const { controller, detach } = attached();
    const served = await controller.serve(EN, () => '<p>en</p>');
    detach();
    expect(served.entry.ttlMs).toBe(TTL_MS);
    expect(sMaxAge(served.result)).toBe('120');
    expect(served.result.headers['surrogate-key']).toBe(
      (await controller.serve(ES, () => '<p>es</p>')).result.headers['surrogate-key'],
    );
    expect(served.result.headers['surrogate-key']).not.toBeUndefined();
    // The index too: `/en/blog` is `/blog`, and `/en` alone is `/`.
    expect((await controller.serve(keyOf('/en/blog', 'en'), () => '<p>i</p>')).entry.ttlMs).toBe(
      TTL_MS,
    );
  });

  test('a tag bust marks the prefixed entry stale, in its own locale, beside the default one', async () => {
    const { controller, detach } = attached();
    let version = 1;
    const render = (key: string): string => `<p>${key} v${String(version)}</p>`;
    await controller.serve(EN, render);
    await controller.serve(ES, render);

    version = 2;
    const report = await invalidateTags([blogTag]);
    expect([...report.isr].sort()).toEqual([EN, ES].sort());

    for (const key of [EN, ES]) {
      const stale = await controller.serve(key, render);
      expect(stale.state).toBe('stale');
      expect(stale.result.headers['x-ultimate-isr']).toBe('stale');
      expect(stale.regenerating).toBe(true);
    }
    await settle();
    // Regenerated under its OWN key: the English entry is the English render, never the default's.
    const fresh = await controller.serve(EN, render);
    detach();
    expect(fresh.state).toBe('hit');
    expect(fresh.result.body).toBe(`<p>${EN} v2</p>`);
    expect(controller.store().get(ES)?.html).toBe(`<p>${ES} v2</p>`);
  });

  test('the ttl alone expires the prefixed entry: an embargo that lifts with the clock', async () => {
    const { controller, advance, detach } = attached();
    // `publishedAt <= now`: nothing is written when the instant passes, so no tag is busted.
    let published = false;
    const render = (): IsrRendered =>
      published ? { html: '<p>post</p>', status: 200 } : { html: '<p>none</p>', status: 404 };

    for (const key of [EN, ES]) {
      const early = await controller.serve(key, render);
      expect(early.result.status).toBe(404);
      expect(early.entry.ttlMs).toBe(TTL_MS);
    }
    published = true;
    advance(TTL_MS - 1);
    for (const key of [EN, ES]) expect((await controller.serve(key, render)).state).toBe('hit');

    advance(1);
    for (const key of [EN, ES]) {
      const stale = await controller.serve(key, render);
      // The stored negative answer, once more, while the page it became renders behind it.
      expect(stale.state).toBe('stale');
      expect(stale.result.status).toBe(404);
    }
    await settle();
    for (const key of [EN, ES]) {
      const live = await controller.serve(key, render);
      expect(live.state).toBe('hit');
      expect(live.result.status).toBe(200);
      expect(live.result.body).toBe('<p>post</p>');
    }
    detach();
  });

  test('a stored 404 under a prefix is purged by the tag, and its edge is dropped on eviction', async () => {
    const { controller, detach } = attached();
    let exists = false;
    const render = (): IsrRendered =>
      exists ? { html: '<p>post</p>', status: 200 } : { html: '<p>none</p>', status: 404 };
    expect((await controller.serve(EN, render)).result.status).toBe(404);

    exists = true;
    expect(controller.revalidateByTags([blogTag])).toEqual([EN]);
    await controller.serve(EN, render);
    await settle();
    expect((await controller.serve(EN, render)).result.status).toBe(200);

    // The registration follows the store: an evicted prefixed page leaves the graph with it.
    controller.store().delete(EN);
    await controller.serve(ES, render);
    expect(controller.revalidateByTags([blogTag])).toEqual([ES]);
    detach();
  });

  test('a prefix naming no routed locale is not stripped: `/fr/blog/a` is no route', async () => {
    const { controller, detach } = attached();
    const served = await controller.serve(keyOf('/fr/blog/a', 'es-CO'), () => '<p>x</p>');
    detach();
    expect(served.entry.ttlMs).toBe(null);
  });
});
