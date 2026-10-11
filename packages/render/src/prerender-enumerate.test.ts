// `prerender()` answers pages in three forms — a bare string, a params object, and an entry that
// also says when the page changed and which locales list it. All three reach a build as params;
// only the last reaches a sitemap with more than a path.

import { beforeEach, describe, expect, test } from 'bun:test';
import { PrerenderFailedError } from './errors';
import { enumeratePrerender, enumeratePrerenderEntries } from './prerender-enumerate';
import { clearRoutes, registerRoute } from './registry';
import type { PrerenderFn, RouteConfig, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta: RouteMetaFn = () => ({ title: 'T', description: 'd'.repeat(60) });

function config(prerender?: PrerenderFn): RouteConfig {
  return defineRoute({
    render: 'static',
    offline: 'precache',
    hydrate: 'never',
    meta,
    ...(prerender ? { prerender } : {}),
  });
}

const blog = (prerender?: PrerenderFn) =>
  registerRoute({ file: 'apps/web/site/blog/[slug]/page.tsx', config: config(prerender) });

const refusal = async (prerender: unknown): Promise<PrerenderFailedError> => {
  const entry = blog(prerender as PrerenderFn);
  try {
    await enumeratePrerenderEntries(entry);
  } catch (error) {
    return error as PrerenderFailedError;
  }
  return expect.unreachable('the entry was accepted');
};

beforeEach(() => {
  clearRoutes();
});

describe('enumeratePrerenderEntries', () => {
  test('the three forms are one list, in the order prerender() answered', async () => {
    const changed = new Date('2026-10-01T15:04:05.000Z');
    const entry = blog(async () => [
      'a',
      { slug: 'b' },
      { params: { slug: 'c' }, lastmod: changed, locales: ['es-co'] },
      { params: { slug: 'd' }, lastmod: '2026-10-02T00:00:00Z' },
      { params: { slug: 'e' } },
    ]);
    expect(await enumeratePrerenderEntries(entry)).toEqual([
      { params: { slug: 'a' } },
      { params: { slug: 'b' } },
      { params: { slug: 'c' }, lastmod: changed, locales: ['es-co'] },
      { params: { slug: 'd' }, lastmod: '2026-10-02T00:00:00Z' },
      { params: { slug: 'e' } },
    ]);
  });

  test('enumeratePrerender answers the same pages as bare params — what a build renders', async () => {
    const entry = blog(() => ['a', { params: { slug: 'b' }, locales: [], lastmod: '2026-10-02' }]);
    expect(await enumeratePrerender(entry)).toEqual([{ slug: 'a' }, { slug: 'b' }]);
  });

  test('a route with no params and no prerender is its one page', async () => {
    const entry = registerRoute({ file: 'apps/web/site/precios/page.tsx', config: config() });
    expect(await enumeratePrerenderEntries(entry)).toEqual([{ params: {} }]);
  });

  // `params` is only an entry's key when it holds an OBJECT: a route may name its own param that.
  test('a route whose dynamic param is called `params` still takes a plain params object', async () => {
    const entry = registerRoute({
      file: 'apps/web/site/q/[params]/page.tsx',
      config: config(() => [{ params: 'a' }, 'b']),
    });
    expect(await enumeratePrerenderEntries(entry)).toEqual([
      { params: { params: 'a' } },
      { params: { params: 'b' } },
    ]);
  });
});

describe('enumeratePrerenderEntries — refusals', () => {
  test('a lastmod that is neither a string nor a Date names the route and its file', async () => {
    const error = await refusal(() => [{ params: { slug: 'a' }, lastmod: 1_760_000_000 }]);
    expect(error).toBeInstanceOf(PrerenderFailedError);
    expect(error.code).toBe('X_PRERENDER_FAILED');
    expect(error.message).toContain('/blog/:slug');
    expect(error.message).toContain('lastmod');
    expect(error.fix).toContain('apps/web/site/blog/[slug]/page.tsx');
  });

  test('locales that is not a list of strings is refused', async () => {
    for (const locales of ['es-co', [5], null]) {
      const error = await refusal(() => [{ params: { slug: 'a' }, locales }]);
      expect(error).toBeInstanceOf(PrerenderFailedError);
      expect(error.message).toContain('locales');
    }
  });

  test('a key an entry does not have is refused by name — `lastMod` is not `lastmod`', async () => {
    const error = await refusal(() => [{ params: { slug: 'a' }, lastMod: '2026-10-01' }]);
    expect(error).toBeInstanceOf(PrerenderFailedError);
    expect(error.message).toContain('"lastMod"');
    expect(error.message).toContain('params, lastmod, locales');
  });
});
