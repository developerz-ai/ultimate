// `x dev`'s route table must serve what the container serves. The container hands `/media` the
// app's `runtime.ts` image driver (`serve-web.ts`); a dev table that dropped it answered every
// variant from the builtin pipeline, so a CDN-backed transform was only ever seen in production.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { blankRaster, encodeImage, userActor } from '@ultimat3/core';
import { defineHttpConfig, httpServer, requestContext, UltimateRequest } from '@ultimat3/http';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import type { AssetPath } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import type { ImageTransformDriver } from '@ultimat3/seo';
import { defineStorage, localDriver, resetStorage } from '@ultimat3/storage';
import type { DevDashboardInput } from './dev-dashboard';
import { devRouteTable } from './dev-route-table';
import { islandBundle } from './island-bundle';
import { MEDIA_BASE_PATH } from './runtime-assets';
import { STORAGE_READ_PERMISSION } from './runtime-storage';
import { siteAssetTable } from './site-assets';
import { inlineStyleSources } from './style-csp';
import { APP_THEME_MODULE } from './theme-brand';

const SOURCE_KEY = 'covers/hero.png';
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-dev-route-table-'));
  await Bun.write(join(root, 'app.config.ts'), 'export const config = { name: "fixture" };\n');
  definePermissions([STORAGE_READ_PERMISSION]);
  defineRoles({ member: { grants: [STORAGE_READ_PERMISSION] } });
});

afterEach(async () => {
  clearPermissions();
  clearRoles();
  resetStorage();
  clearRoutes();
  await rm(root, { recursive: true, force: true });
});

describe('unit · x dev route table', () => {
  test("the app's runtime images driver reaches /media", async () => {
    // `covers/` is shared: an un-scoped key is served only from a prefix the app listed (27.0.0).
    const storage = defineStorage({
      disks: { local: localDriver({ root: join(root, '.s') }) },
      shared: { local: ['covers/'] },
    });
    await storage.disk().put(SOURCE_KEY, encodeImage(blankRaster(64, 32, 'fixture'), 'png'), {
      contentType: 'image/png',
    });
    const asked: string[] = [];
    const images: ImageTransformDriver = {
      name: 'fixture-cdn',
      transform: async (request) => {
        asked.push(`${request.src}@${request.width}`);
        return {
          bytes: new TextEncoder().encode('from the app driver'),
          contentType: 'image/webp',
          width: request.width,
          height: request.width,
        };
      },
      blurPlaceholder: async () => '',
    };
    const { routes } = await devRouteTable({
      root,
      env: {},
      buildId: 'dev-route-table',
      storage,
      // Only its routes are built here; nothing below asks the dashboard a question, so its
      // services are inert stand-ins (a non-memory mail driver, a database never queried).
      dashboard: {
        root,
        runtime: { mail: { name: 'unused' }, db: {} },
        status: () => ({}),
      } as unknown as DevDashboardInput,
      islands: () => islandBundle([]),
      realtime: { enabled: false },
      images,
    });
    const media = routes.find((route) => route.path === `${MEDIA_BASE_PATH}/*key`);
    expect(media).toBeDefined();
    if (media === undefined) return;
    const url = new URL(`http://dev.test${MEDIA_BASE_PATH}/${SOURCE_KEY}?w=16`);
    const ctx = requestContext({
      url,
      method: 'GET',
      role: 'web',
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    });
    ctx.params = { key: SOURCE_KEY };
    ctx.actor = userActor({ id: 'u-1', roles: ['member'], orgId: 'org-1' });
    const response = await media.handler(new UltimateRequest(new Request(url), ctx), ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('from the app driver');
    expect(asked).toEqual([`${SOURCE_KEY}@16`]);
  });
});

/** The table with inert stand-ins for everything a page document does not read. */
const pageTable = () =>
  devRouteTable({
    root,
    env: {},
    buildId: 'dev-route-table',
    storage: defineStorage({ disks: { local: localDriver({ root: join(root, '.s') }) } }),
    dashboard: {
      root,
      runtime: { mail: { name: 'unused' }, db: {} },
      status: () => ({}),
    } as unknown as DevDashboardInput,
    islands: () => islandBundle([]),
    realtime: { enabled: false },
  });

/** The server the table is served through — the same one `pageOf` asks for the document. */
const pageServer = (routes: Awaited<ReturnType<typeof pageTable>>['routes']) =>
  httpServer({
    routes,
    role: 'web',
    config: defineHttpConfig({
      dev: true,
      buildId: 'dev-route-table',
      rateLimit: { scope: 'process' },
    }),
  });

const pageOf = async (routes: Awaited<ReturnType<typeof pageTable>>['routes']) =>
  (await pageServer(routes).fetch(new Request('http://dev.test/'))).text();

describe("unit · x dev carries the app's brand", () => {
  beforeEach(() => {
    registerRoute<{ url: string; params: Record<string, string> }>({
      file: 'apps/web/site/page.tsx',
      suspenseBoundaries: 0,
      config: defineRoute<{ url: string; params: Record<string, string> }>({
        render: 'ssr',
        offline: 'network-only',
        hydrate: 'never',
        meta: () => ({ title: 'home', description: 'the page the brand is asked of' }),
      }),
    });
  });

  test('the theme module: the tag in the document, and its body for style-src', async () => {
    const ui = join(import.meta.dir, '../../ui/src/index.ts');
    await Bun.write(
      join(root, APP_THEME_MODULE),
      `import { defineTheme } from '${ui}';\nexport const brand = defineTheme({ preset: 'scifi' });\n`,
    );
    const { brandStyleCspSource, brandStyleTag, defineTheme } = await import('@ultimat3/ui');
    const brand = defineTheme({ preset: 'scifi' });
    const table = await pageTable();
    expect((await pageOf(table.routes)).split('</head>')[0]).toContain(brandStyleTag(brand));
    expect(inlineStyleSources(table.inlineStyles)).toEqual([brandStyleCspSource(brand)]);
  });

  test('no theme module: no <style>, and nothing for style-src', async () => {
    const table = await pageTable();
    expect(await pageOf(table.routes)).not.toContain('<style');
    expect(table.inlineStyles).toEqual([]);
  });
});

describe("unit · x dev carries the app's own favicon", () => {
  const FAVICON = 'assets/brand/icon.svg';

  beforeEach(async () => {
    // The declaration the boot reads: one app-level favicon, named as a site asset path.
    await Bun.write(
      join(root, 'app.config.ts'),
      'export const config = { name: "fixture", site: { favicon: "assets/brand/icon.svg" } };\n',
    );
    // And the file it names, under the app's site assets — where `asset()` looks for it.
    await mkdir(join(root, 'apps/web/site/assets/brand'), { recursive: true });
    await Bun.write(
      join(root, 'apps/web/site/assets/brand/icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    registerRoute<{ url: string; params: Record<string, string> }>({
      file: 'apps/web/site/page.tsx',
      suspenseBoundaries: 0,
      config: defineRoute<{ url: string; params: Record<string, string> }>({
        render: 'ssr',
        offline: 'network-only',
        hydrate: 'never',
        meta: () => ({ title: 'home', description: 'the page the favicon is asked of' }),
      }),
    });
  });

  test('the document carries the content-hashed SVG, and the asset surface serves it', async () => {
    const table = await pageTable();
    const html = await pageOf(table.routes);
    // The URL the app's own site asset table mints — never the raw path the config named.
    const url = siteAssetTable(root).resolve(FAVICON as AssetPath).url;
    expect(html.split('</head>')[0]).toContain(
      `<link rel="icon" type="image/svg+xml" href="${url}">`,
    );
    // And the file behind it is served at that very URL: the href names bytes the surface answers.
    const asset = await pageServer(table.routes).fetch(new Request(`http://dev.test${url}`));
    expect(asset.status).toBe(200);
  });

  // The bug this wiring exists for: the table is built ONCE, so a head frozen at boot named the
  // icon's bytes as they were — and `/assets/*` refuses a stale hash with a 404. The href must
  // move with the bytes.
  test('an edited icon moves the href, and the URL it left is refused', async () => {
    const table = await pageTable();
    const before = siteAssetTable(root).resolve(FAVICON as AssetPath).url;
    expect(await pageOf(table.routes)).toContain(`href="${before}"`);
    // The author edits the icon: different bytes, so a different content hash.
    await Bun.write(
      join(root, 'apps/web/site/assets/brand/icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>',
    );
    const after = siteAssetTable(root).resolve(FAVICON as AssetPath).url;
    expect(after).not.toBe(before);
    const html = await pageOf(table.routes);
    expect(html.split('</head>')[0]).toContain(`href="${after}"`);
    expect(html).not.toContain(`href="${before}"`);
  });
});
