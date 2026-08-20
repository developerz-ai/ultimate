/**
 * `render-spa` builds the shell for a gated, client-only route. This file covers the
 * defense-in-depth policy guard, the shell markup, and the `RenderResult` wrapper.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { RouteModeInvalidError } from './errors';
import type { RouteEntry } from './registry';
import { clearRoutes, compilePattern, registerRoute } from './registry';
import type { SpaShellInput } from './render-spa';
import { renderSpa, renderSpaShell, SPA_ROOT_ID } from './render-spa';
import { contentHash } from './render-static';
import type { RouteConfig, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

function spaRoute(policy = { permission: 'dashboard:read' }): RouteEntry {
  return registerRoute({
    file: 'apps/web/app/dashboard/page.tsx',
    config: defineRoute({
      render: 'spa',
      offline: 'runtime',
      hydrate: 'idle',
      meta,
      policy,
    }),
  });
}

/**
 * `defineRoute` already rejects `render: 'spa'` with no `policy` (modes.ts), so the only
 * way to exercise `renderSpaShell`'s own defense-in-depth check is a config that never went
 * through `defineRoute` — same shape as `RouteConfig`, built by hand, with `policy` absent.
 */
function spaEntryWithoutPolicy(): RouteEntry {
  const config: RouteConfig = {
    kind: 'route',
    render: 'spa',
    offline: 'runtime',
    hydrate: 'idle',
    meta: async () => ({ title: 'T', description: 'd'.repeat(60) }),
    budget: {},
    // Required on the descriptor, and the honest value: this shell declares no island.
    islands: [],
  };
  return {
    file: 'apps/web/app/dashboard/page.tsx',
    path: '/dashboard',
    surface: 'app',
    config,
    suspenseBoundaries: 0,
    islands: [],
    pattern: compilePattern('/dashboard'),
  };
}

beforeEach(() => {
  clearRoutes();
});

describe('the no-policy guard', () => {
  test('renderSpaShell throws RouteModeInvalidError when the entry has no policy', () => {
    const entry = spaEntryWithoutPolicy();
    expect(() =>
      renderSpaShell({ entry, buildId: 'b1', head: '', chunks: [], lang: 'en' }),
    ).toThrow(RouteModeInvalidError);
  });

  test('renderSpa throws too, since it delegates to renderSpaShell', () => {
    const entry = spaEntryWithoutPolicy();
    expect(() => renderSpa({ entry, buildId: 'b1', head: '', chunks: [], lang: 'en' })).toThrow(
      RouteModeInvalidError,
    );
  });
});

describe('renderSpaShell', () => {
  test('produces the shell markup: doctype, lang/dir, head, chunks in order, build meta, root', () => {
    const entry = spaRoute();
    const input: SpaShellInput = {
      entry,
      buildId: 'build-7',
      head: '<title>Dashboard</title>',
      chunks: ['/chunks/a.js', '/chunks/b.js'],
      lang: 'en',
    };
    const shell = renderSpaShell(input);

    expect(shell.html).toContain('<!doctype html>');
    expect(shell.html).toContain('<html lang="en" dir="ltr">');
    expect(shell.html).toContain('<title>Dashboard</title>');
    expect(shell.html).toContain(
      '<link rel="modulepreload" href="/chunks/a.js"><link rel="modulepreload" href="/chunks/b.js">',
    );
    expect(shell.html).toContain(
      '<script type="module" src="/chunks/a.js"></script>' +
        '<script type="module" src="/chunks/b.js"></script>',
    );
    expect(shell.html).toContain('<meta name="x-ultimate-build" content="build-7">');
    expect(shell.html).toContain(`<div id="${SPA_ROOT_ID}">`);
    expect(shell.hash).toBe(contentHash(shell.html));
  });

  test('defaults dir to ltr and the root id to SPA_ROOT_ID', () => {
    const entry = spaRoute();
    const shell = renderSpaShell({ entry, buildId: 'b1', head: '', chunks: [], lang: 'en' });
    expect(shell.html).toContain('dir="ltr"');
    expect(shell.html).toContain(`<div id="${SPA_ROOT_ID}">`);
  });

  test('honors a custom dir and rootId', () => {
    const entry = spaRoute();
    const shell = renderSpaShell({
      entry,
      buildId: 'b1',
      head: '',
      chunks: [],
      lang: 'ar',
      dir: 'rtl',
      rootId: 'app-root',
    });
    expect(shell.html).toContain('<html lang="ar" dir="rtl">');
    expect(shell.html).toContain('<div id="app-root">');
    expect(shell.html).not.toContain(`id="${SPA_ROOT_ID}"`);
  });

  test('an empty chunks array produces no preload or script tags, and still valid html', () => {
    const entry = spaRoute();
    const shell = renderSpaShell({ entry, buildId: 'b1', head: '', chunks: [], lang: 'en' });

    expect(shell.html).not.toContain('modulepreload');
    expect(shell.html).not.toContain('<script');
    expect(shell.html).toContain('<!doctype html>');
    expect(shell.html).toContain(`<div id="${SPA_ROOT_ID}">`);
  });
});

describe('renderSpa', () => {
  test('wraps the shell into a 200 RenderResult with cache and etag headers', () => {
    const entry = spaRoute();
    const input: SpaShellInput = {
      entry,
      buildId: 'b1',
      head: '<title>D</title>',
      chunks: ['/c.js'],
      lang: 'en',
    };
    const shell = renderSpaShell(input);
    const result = renderSpa(input);

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(result.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect(result.headers['etag']).toBe(`"${shell.hash}"`);
    expect(result.headers['x-ultimate-build']).toBe('b1');
    expect(result.body).toBe(shell.html);
  });
});

/**
 * `renderSpaShell` is a public export: every value it interpolates into an attribute goes through
 * `html.ts`'s one escaper, the same contract row `emitIslandAttributes` was fixed to obey. `lang`
 * is safe on the framework's own path — `currentLocale()` normalises it against the configured
 * `supported` list — but a caller supplies it directly, and the escaper is what makes that safe by
 * construction rather than by a second package's invariant holding.
 */
describe('renderSpaShell escapes every value it puts in an attribute', () => {
  const entry = spaRoute;

  test('a lang carrying a quote cannot open a second attribute', () => {
    const shell = renderSpaShell({
      entry: entry(),
      buildId: 'b1',
      head: '',
      chunks: [],
      lang: 'en" onload="alert(1)',
    });
    expect(shell.html).not.toContain('onload="alert(1)"');
    expect(shell.html).toContain('&quot;');
  });

  test('a buildId carrying one cannot escape the meta tag', () => {
    const shell = renderSpaShell({
      entry: entry(),
      buildId: 'b1"><script>alert(1)</script>',
      head: '',
      chunks: [],
      lang: 'en',
    });
    expect(shell.html).not.toContain('<script>alert(1)</script>');
  });

  test('a chunk url carrying one cannot escape the preload or the module script', () => {
    const shell = renderSpaShell({
      entry: entry(),
      buildId: 'b1',
      head: '',
      chunks: ['/c.js" onerror="alert(1)'],
      lang: 'en',
    });
    expect(shell.html).not.toContain('onerror="alert(1)"');
  });

  test('a rootId and dir carrying one are escaped too', () => {
    const shell = renderSpaShell({
      entry: entry(),
      buildId: 'b1',
      head: '',
      chunks: [],
      lang: 'en',
      dir: 'ltr" onload="alert(1)' as 'ltr',
      rootId: 'root" onclick="alert(1)',
    });
    expect(shell.html).not.toContain('onload="alert(1)"');
    expect(shell.html).not.toContain('onclick="alert(1)"');
  });

  test('the head is still passed through verbatim — it is already-merged markup', () => {
    const shell = renderSpaShell({
      entry: entry(),
      buildId: 'b1',
      head: '<title>Dashboard</title>',
      chunks: [],
      lang: 'en',
    });
    expect(shell.html).toContain('<title>Dashboard</title>');
  });
});
