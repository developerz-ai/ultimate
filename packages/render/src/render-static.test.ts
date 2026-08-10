/**
 * `render-static` builds a route's HTML once and content-hashes it — this file exercises
 * the hash, the pattern-filling, the per-request-state guard and the prerender enumeration.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { createContext, runWithContext } from '@ultimat3/core';
import { PrerenderFailedError, RouteModeInvalidError } from './errors';
import { clearRoutes, registerRoute } from './registry';
import type { StaticArtifact, StaticRenderFn } from './render-static';
import {
  assertNoPerRequestState,
  contentHash,
  enumeratePrerender,
  fillPath,
  renderStatic,
  staticHeaders,
  staticResult,
} from './render-static';
import type { PrerenderFn, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

function staticConfig(overrides: {
  readonly prerender?: PrerenderFn;
}): ReturnType<typeof defineRoute> {
  return defineRoute({
    render: 'static',
    offline: 'precache',
    hydrate: 'never',
    meta,
    ...(overrides.prerender ? { prerender: overrides.prerender } : {}),
  });
}

function blogRoute(prerender?: PrerenderFn) {
  return registerRoute({
    file: 'apps/web/site/blog/[slug]/page.tsx',
    config: staticConfig({ ...(prerender ? { prerender } : {}) }),
  });
}

beforeEach(() => {
  clearRoutes();
});

describe('contentHash', () => {
  test('is deterministic for the same input, twice', () => {
    expect(contentHash('<p>hi</p>')).toBe(contentHash('<p>hi</p>'));
  });

  test('differs for different inputs', () => {
    expect(contentHash('<p>a</p>')).not.toBe(contentHash('<p>b</p>'));
  });

  test('returns an 8-char lowercase hex string', () => {
    expect(contentHash('anything at all')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('fillPath', () => {
  test('fills a named param', () => {
    expect(fillPath('/blog/:slug', { slug: 'hello' })).toBe('/blog/hello');
  });

  test('replaces the whole catch-all segment with the param value verbatim', () => {
    expect(fillPath('/docs/*path', { path: 'a/b' })).toBe('/docs/a/b');
  });

  test('an empty catch-all param leaves a bare trailing segment, then gets trimmed', () => {
    expect(fillPath('/docs/*path', {})).toBe('/docs');
  });

  test('a missing named param falls back to the literal :segment text', () => {
    expect(fillPath('/blog/:slug', {})).toBe('/blog/:slug');
  });

  test('trailing slashes are stripped', () => {
    expect(fillPath('/pricing/', {})).toBe('/pricing');
  });

  test('the root path stays / rather than becoming empty', () => {
    expect(fillPath('/', {})).toBe('/');
  });
});

describe('assertNoPerRequestState', () => {
  test('does not throw with no ambient context', () => {
    expect(() => assertNoPerRequestState('apps/web/site/pricing/page.tsx')).not.toThrow();
  });

  test('throws RouteModeInvalidError naming the file when a context is live', () => {
    const run = (): void =>
      runWithContext(createContext({}), () =>
        assertNoPerRequestState('apps/web/site/pricing/page.tsx'),
      );
    expect(run).toThrow(RouteModeInvalidError);
    expect(run).toThrow(/apps\/web\/site\/pricing\/page\.tsx/);
  });
});

describe('enumeratePrerender', () => {
  test('no prerender and zero dynamic params enumerates the single empty set', async () => {
    const entry = registerRoute({
      file: 'apps/web/site/pricing/page.tsx',
      config: staticConfig({}),
    });
    expect(await enumeratePrerender(entry)).toEqual([{}]);
  });

  test('no prerender and a dynamic param enumerates nothing', async () => {
    const entry = blogRoute();
    expect(await enumeratePrerender(entry)).toEqual([]);
  });

  test('an array of plain objects passes through unchanged', async () => {
    const entry = blogRoute(async () => [{ slug: 'a' }, { slug: 'b' }]);
    expect(await enumeratePrerender(entry)).toEqual([{ slug: 'a' }, { slug: 'b' }]);
  });

  test('bare strings fill the route’s single dynamic param', async () => {
    const entry = blogRoute(async () => ['a', 'b']);
    expect(await enumeratePrerender(entry)).toEqual([{ slug: 'a' }, { slug: 'b' }]);
  });

  test('a bare string with zero dynamic params throws PrerenderFailedError', async () => {
    const entry = registerRoute({
      file: 'apps/web/site/pricing/page.tsx',
      config: staticConfig({ prerender: async () => ['x'] }),
    });
    await expect(enumeratePrerender(entry)).rejects.toThrow(PrerenderFailedError);
  });

  test('a bare string with more than one dynamic param throws PrerenderFailedError', async () => {
    const entry = registerRoute({
      file: 'apps/web/site/blog/[category]/[slug]/page.tsx',
      config: staticConfig({ prerender: async () => ['x'] }),
    });
    await expect(enumeratePrerender(entry)).rejects.toThrow(PrerenderFailedError);
  });

  test('a synchronously throwing prerender surfaces as PrerenderFailedError', async () => {
    const entry = registerRoute({
      file: 'apps/web/site/pricing/page.tsx',
      config: staticConfig({
        prerender: () => {
          throw new Error('boom');
        },
      }),
    });
    await expect(enumeratePrerender(entry)).rejects.toThrow(PrerenderFailedError);
  });

  test('a rejecting prerender surfaces as PrerenderFailedError, not the original error', async () => {
    const entry = registerRoute({
      file: 'apps/web/site/status/page.tsx',
      config: staticConfig({
        prerender: async () => {
          throw new Error('boom');
        },
      }),
    });
    await expect(enumeratePrerender(entry)).rejects.toThrow(PrerenderFailedError);
  });

  test('a non-array resolution throws PrerenderFailedError', async () => {
    const badPrerender = (async () => ({ oops: true })) as unknown as PrerenderFn;
    const entry = registerRoute({
      file: 'apps/web/site/pricing/page.tsx',
      config: staticConfig({ prerender: badPrerender }),
    });
    await expect(enumeratePrerender(entry)).rejects.toThrow(PrerenderFailedError);
  });
});

describe('renderStatic', () => {
  test('rejects inside an ambient context, same guard as assertNoPerRequestState', async () => {
    const entry = blogRoute(async () => ['a']);
    const render: StaticRenderFn = () => '<p>x</p>';
    const promise = runWithContext(createContext({}), () =>
      renderStatic(entry, render, { buildId: 'b1' }),
    );
    await expect(promise).rejects.toThrow(RouteModeInvalidError);
  });

  test('builds one artifact with hash, outputPath and headers', async () => {
    const entry = blogRoute(async () => ['hello']);
    const render: StaticRenderFn = ({ path }) => `<p>${path}</p>`;
    const artifacts = await renderStatic(entry, render, { buildId: 'b1' });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toBe('/blog/hello');
    expect(artifacts[0]?.html).toBe('<p>/blog/hello</p>');
    expect(artifacts[0]?.hash).toBe(contentHash('<p>/blog/hello</p>'));
    expect(artifacts[0]?.outputPath).toBe('blog/hello/index.html');
    expect(artifacts[0]?.headers).toEqual(staticHeaders(artifacts[0]?.hash ?? '', 'b1'));
  });

  test('the root path outputs index.html, never //index.html', async () => {
    const entry = registerRoute({
      file: 'apps/web/site/page.tsx',
      config: staticConfig({}),
    });
    const render: StaticRenderFn = () => '<p>home</p>';
    const artifacts = await renderStatic(entry, render, { buildId: 'b1' });
    expect(artifacts[0]?.outputPath).toBe('index.html');
  });

  test('honors a custom indexFile', async () => {
    const entry = registerRoute({
      file: 'apps/web/site/page.tsx',
      config: staticConfig({}),
    });
    const render: StaticRenderFn = () => '<p>home</p>';
    const artifacts = await renderStatic(entry, render, { buildId: 'b1', indexFile: 'home.html' });
    expect(artifacts[0]?.outputPath).toBe('home.html');
  });

  test('a render failure rejects with PrerenderFailedError naming the failing path', async () => {
    const entry = blogRoute(async () => ['a', 'b']);
    const render: StaticRenderFn = ({ path }) => {
      if (path === '/blog/b') throw new Error('boom');
      return `<p>${path}</p>`;
    };

    try {
      await renderStatic(entry, render, { buildId: 'b1' });
      throw new Error('expected renderStatic to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(PrerenderFailedError);
      expect((error as Error).message).toContain('/blog/b');
    }
  });

  test('produces one artifact per enumerated param set, in order', async () => {
    const entry = blogRoute(async () => ['a', 'b', 'c']);
    const render: StaticRenderFn = ({ path }) => `<p>${path}</p>`;
    const artifacts = await renderStatic(entry, render, { buildId: 'b1' });
    expect(artifacts.map((a) => a.path)).toEqual(['/blog/a', '/blog/b', '/blog/c']);
  });
});

describe('staticHeaders', () => {
  test('returns the exact static header shape', () => {
    expect(staticHeaders('abcd1234', 'build-9')).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
      etag: '"abcd1234"',
      'x-ultimate-build': 'build-9',
    });
  });
});

describe('staticResult', () => {
  test('wraps an artifact into a 200 RenderResult', () => {
    const artifact: StaticArtifact = {
      path: '/x',
      params: {},
      html: '<p>x</p>',
      hash: 'deadbeef',
      outputPath: 'x/index.html',
      headers: staticHeaders('deadbeef', 'b1'),
    };
    expect(staticResult(artifact)).toEqual({
      status: 200,
      headers: artifact.headers,
      body: artifact.html,
    });
  });
});
