// The document-level HEADS a route cannot decide: the install head (#362 — `pwa.enabled` had no
// reader, so no document ever carried a manifest link), the no-flash theme boot, and the app's own
// favicon. Each is ONE string on EVERY document — an installable app is one whose every page
// carries the manifest, and a favicon is one per app. The `stream` branch builds its head
// separately from `documentFrom`, so it could carry a link and lose the title, or the reverse.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no throwaway-directory API: mkdtempSync/rmSync own a fixture app root's lifetime,
// and mkdirSync creates the nested asset directory the favicon case writes into.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import type { RegisterRouteInput, RenderMode } from '@ultimat3/render';
import {
  asset,
  clearRoutes,
  defineRoute,
  h,
  registerRoute,
  SURFACE_SPECS,
  setAssetResolver,
} from '@ultimat3/render';
import { clearStylesheets, loadStylesheet } from '@ultimat3/render/server';
import { renderRoute } from '@ultimat3/testing';
import { faviconBytes } from './favicon';
import { appFaviconHead, appRoutes } from './runtime-render';
import { siteAssetTable } from './site-assets';

const BUILD_ID = 'build-under-test';
type Data = { url: string; params: Record<string, string> };

function register(fixture: {
  readonly file: string;
  readonly render: RenderMode;
  readonly revalidate?: { readonly ttl: string };
}): void {
  // Generic, matching the `defineRoute<…>` below: `RegisterRouteInput` defaults `TData` to
  // `RouteData`, and a `meta` written against `{ url, params }` cannot be handed a bare record.
  const input: RegisterRouteInput<Data> = {
    file: fixture.file,
    suspenseBoundaries: fixture.render === 'stream' ? 1 : 0,
    config: defineRoute<Data>({
      render: fixture.render,
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      meta: (data) => ({ title: `title of ${fixture.file}`, description: `rendered ${data.url}` }),
      ...(fixture.revalidate === undefined ? {} : { revalidate: fixture.revalidate }),
    }),
  };
  registerRoute(input);
}

const serve = (
  pwaHead?: string,
  themeHead?: string,
  faviconHead?: string,
): ReturnType<typeof httpServer> =>
  httpServer({
    routes: appRoutes({
      buildId: BUILD_ID,
      ...(pwaHead === undefined ? {} : { pwaHead }),
      ...(themeHead === undefined ? {} : { themeHead }),
      ...(faviconHead === undefined ? {} : { faviconHead }),
    }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

const get = async (path: string): Promise<Response> =>
  serve().fetch(new Request(`http://dev.test${path}`));

/**
 * Every (surface, mode) pair the framework allows, DERIVED from `SURFACE_SPECS` rather than
 * listed: a mode added to a surface joins these tests on its own.
 */
const PAGES = [
  { surface: 'site', file: 'apps/web/site/page.tsx', url: '/' },
  { surface: 'app', file: 'apps/web/app/feed/page.tsx', url: '/feed' },
] as const;
const CASES = PAGES.flatMap((page) =>
  SURFACE_SPECS[page.surface].allowedModes.map((render) => ({ ...page, render })),
);

/** A throwaway app root: its `app.config.ts` and whatever else the case needs on disk. */
const appRoot = async (config: string, files: Record<string, string> = {}): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'x-favicon-'));
  await Bun.write(join(root, 'app.config.ts'), config);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    await Bun.write(join(root, path), body);
  }
  return root;
};

// The process lifecycle is a module global: a test elsewhere in this package that drains it (or a
// drain still settling from one) left every route here answering 503 X_DRAINING when the files ran
// in one process (main CI, packages 2/2, 2026-10-20). Each test starts from a live lifecycle.
beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  clearRoutes();
  clearStylesheets();
  setAssetResolver(undefined);
  resetLifecycle();
});

describe('unit · the document-level heads, on every mode and every page', () => {
  const INSTALL_HEAD = '<link rel="manifest" href="/manifest.webmanifest">';
  const THEME_HEAD = '<script>document.documentElement.setAttribute("data-theme","dark")</script>';
  const FAVICON_HEAD =
    '<link rel="icon" type="image/svg+xml" href="/assets/brand/icon.0123abcd.svg">';

  test.each(CASES)('$surface/ in $render carries them in <head>', async ({ file, url, render }) => {
    // `isr` is the one mode whose shape check demands a TTL; every other one takes none.
    register({ file, render, ...(render === 'isr' ? { revalidate: { ttl: '5m' } } : {}) });
    const body = await (
      await serve(INSTALL_HEAD, THEME_HEAD, FAVICON_HEAD).fetch(
        new Request(`http://dev.test${url}`),
      )
    ).text();
    const head = body.slice(0, body.indexOf('</head>'));
    expect(head).toContain(INSTALL_HEAD);
    expect(head).toContain(THEME_HEAD);
    expect(head).toContain(FAVICON_HEAD);
  });
  test('a streamed page carries them beside its own title, in the first flush', async () => {
    register({ file: 'apps/web/app/feed/page.tsx', render: 'stream' });
    const body = await (
      await serve(INSTALL_HEAD, THEME_HEAD, FAVICON_HEAD).fetch(new Request('http://dev.test/feed'))
    ).text();
    expect(body).toContain('<title>title of apps/web/app/feed/page.tsx</title>');
    expect(body).toContain(INSTALL_HEAD);
    expect(body).toContain(FAVICON_HEAD);
  });
  // The theme boot's ORDER is the point: it must run before the stylesheet paints.
  test('the theme boot precedes the stylesheet link when the surface has one', async () => {
    loadStylesheet('/srv/demo/apps/web/site/page.module.scss', '.a{color:red}');
    register({ file: 'apps/web/site/page.tsx', render: 'static' });
    const body = await (
      await serve(undefined, THEME_HEAD).fetch(new Request('http://dev.test/'))
    ).text();
    const script = body.indexOf(THEME_HEAD);
    const link = body.indexOf('rel="stylesheet"');
    expect(script).toBeGreaterThan(-1);
    expect(link === -1 || script < link).toBe(true);
  });
  // The 0kb baseline: an app that is not installable pays nothing, and a `<link>` to a file no
  // route serves is a 404 in every visitor's console. An app with no favicon declared pays
  // nothing either — the browser's own `/favicon.ico` request is the only one.
  test('an app that declares neither carries nothing', async () => {
    register({ file: 'apps/web/site/page.tsx', render: 'static' });
    const body = await (await get('/')).text();
    expect(body).not.toContain('rel="manifest"');
    expect(body).not.toContain('rel="icon"');
  });
  // The favicon's href is the URL the ASSET SURFACE serves, not the path the config named: the
  // site asset table hashes the bytes, and `asset()` answers from that same table. The PNG/ICO
  // surface is untouched: the app's own file wins as `image/x-icon`, and the framework's
  // placeholder answers `image/png` when the app committed none.
  test('the favicon href is the content-hashed asset URL, and /favicon.ico is unchanged', async () => {
    const root = await appRoot(
      "export const config = { name: 'fixture', site: { favicon: 'assets/brand/icon.svg' } };\n",
      {
        'apps/web/site/assets/brand/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
        'apps/web/site/favicon.ico': 'icon',
      },
    );
    const table = siteAssetTable(root);
    setAssetResolver((path) => table.resolve(path).url);
    expect(await appFaviconHead(root)).toBe(
      `<link rel="icon" type="image/svg+xml" href="${asset('assets/brand/icon.svg')}">`,
    );
    expect((await faviconBytes(root)).contentType).toBe('image/x-icon');
    rmSync(root, { recursive: true, force: true });
    const bare = await appRoot("export const config = { name: 'fixture' };\n");
    expect((await faviconBytes(bare)).contentType).toBe('image/png');
    rmSync(bare, { recursive: true, force: true });
  });
  // The favicon is resolved AT BOOT, so a document never asks the asset table for it: a route
  // renders with no site asset table installed at all, and no favicon setup.
  test('a route renders with no asset resolver installed, and no favicon setup', async () => {
    setAssetResolver(undefined);
    const rendered = await renderRoute({
      config: defineRoute({
        render: 'ssr',
        offline: 'network-only',
        hydrate: 'never',
        meta: () => ({ title: 'plain' }),
      }),
      Page: () => h('p', {}, 'a page'),
    });
    expect(rendered.text).toBe('a page');
  });
});
