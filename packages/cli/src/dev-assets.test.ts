// The image pipeline is only shipped if a running app answers with bytes. These tests drive the
// routes `x dev` mounts, not the functions behind them: the icon a generated web manifest names,
// and the exact `srcset` URL `@ultimat3/seo` mints — because a variant contract that is declared
// in two packages and answered by neither is what this whole path exists to close.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun has no temp-directory, no mkdtemp and no recursive remove — and
// each case needs its own root, or a leftover `apps/web/site/icon.png` decides the next one's
// answer.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { createRaster, encodeImage, probeImage, userActor } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import { responsiveImage } from '@ultimat3/seo';
import type { Storage } from '@ultimat3/storage';
import { defineStorage, localDriver, resetStorage, variantKey } from '@ultimat3/storage';
import { assetRoutes, ICON_SOURCE, MEDIA_BASE_PATH } from './dev-assets';
import { STORAGE_READ_PERMISSION } from './dev-storage';

const SOURCE_KEY = 'covers/hero.png';

/**
 * A real PNG, so the pipeline decodes rather than refuses — the point of the whole change. The
 * raster keeps `createRaster`'s own bytes: every assertion below is about format and size, so
 * painting channel values would only claim a colour the tests never read.
 */
function png(width: number, height: number): Uint8Array {
  return encodeImage(createRaster(width, height, 'fixture'), 'png');
}

let root = '';
let storage: Storage;

const call = async (routes: readonly Route[], path: string): Promise<Response> => {
  const url = new URL(`http://dev.test${path}`);
  const route = routes.find((candidate) => matches(candidate.path, url.pathname));
  expect(route).toBeDefined();
  if (route === undefined) return new Response(null, { status: 404 });
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = createRequestContext({ url, method: 'GET', role: 'web', config });
  ctx.params = params(route.path, url.pathname);
  // `/media` is `auth: 'required'` + `storage:read` — the icons are not, and pass regardless. The
  // guard itself is proved across both storage surfaces in `storage-surfaces.test.ts`; these cases
  // are about the pipeline behind it, so they call as a reader who may.
  ctx.actor = userActor({ id: 'u-1', roles: ['member'], orgId: 'org-1' });
  return route.handler(new UltimateRequest(new Request(url), ctx), ctx);
};

/** The trie is `@ultimat3/http`'s; this only needs to pick the same route it would. */
function matches(pattern: string, pathname: string): boolean {
  if (!pattern.includes('*')) return pattern === pathname;
  return pathname.startsWith(`${pattern.slice(0, pattern.indexOf('*'))}`);
}

function params(pattern: string, pathname: string): Record<string, string> {
  const star = pattern.indexOf('*');
  if (star === -1) return {};
  return { [pattern.slice(star + 1)]: pathname.slice(star) };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-assets-'));
  storage = defineStorage({ disks: { local: localDriver({ root: join(root, '.storage') }) } });
  await storage.disk().put(SOURCE_KEY, png(1200, 600), { contentType: 'image/png' });
  definePermissions([STORAGE_READ_PERMISSION]);
  defineRoles({ member: { grants: [STORAGE_READ_PERMISSION] } });
});

afterEach(() => {
  clearPermissions();
  clearRoles();
  resetStorage();
  rmSync(root, { recursive: true, force: true });
});

describe('unit · dev assets · pwa icons', () => {
  test('every icon the matrix declares is a mounted route', async () => {
    const routes = assetRoutes({ root, storage });
    const paths = routes.map((route) => route.path);
    expect(paths).toContain('/icons/icon-192.png');
    expect(paths).toContain('/icons/icon-maskable-512.png');
    expect(paths).toContain('/icons/apple-touch-icon.png');
  });

  // Mounted through THIS composition, which is what `x dev` and the container both call — a
  // favicon route added to one of them alone is a 404 that comes back in production only.
  test('the favicon rides on the same asset surface both boots mount', () => {
    expect(assetRoutes({ root, storage }).map((route) => route.path)).toContain('/favicon.ico');
  });

  test('an icon stays public while /media is not', () => {
    const routes = assetRoutes({ root, storage });
    // An install prompt fetches these before anyone signs in, and they are rendered from a file
    // committed in the app — so `public` here is a fact, not the oversight it was one route down.
    const icon = routes.find((route) => route.path === '/icons/icon-192.png');
    expect(icon?.meta.auth).toBe('public');
    expect(icon?.meta.policy).toBeUndefined();

    const media = routes.find((route) => route.path === `${MEDIA_BASE_PATH}/*key`);
    expect(media?.meta).toMatchObject({
      auth: 'required',
      policy: STORAGE_READ_PERMISSION,
      enforcedBy: 'handler',
    });
  });

  test('an icon route answers with a square PNG of that entry size', async () => {
    await Bun.write(join(root, ICON_SOURCE), png(1024, 1024));
    const routes = assetRoutes({ root, storage });

    const response = await call(routes, '/icons/icon-192.png');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(probeImage(new Uint8Array(await response.arrayBuffer()))).toMatchObject({
      format: 'png',
      width: 192,
      height: 192,
    });
  });

  // The route stays mounted with no source behind it, so the answer is a coded refusal carrying a
  // runnable fix — never a bare 404 an agent has to guess the meaning of.
  test('a missing source icon is refused by code, not by a silent 404', async () => {
    const routes = assetRoutes({ root, storage });
    expect(routes.map((route) => route.path)).toContain('/icons/icon-192.png');
    await expect(call(routes, '/icons/icon-192.png')).rejects.toBeUltimateError(
      'X_PWA_ICON_MISSING',
    );
  });
});

describe('unit · dev assets · responsive variants', () => {
  test('no transform query serves the stored object untouched', async () => {
    const routes = assetRoutes({ root, storage });
    const response = await call(routes, `${MEDIA_BASE_PATH}/${SOURCE_KEY}`);
    expect(probeImage(new Uint8Array(await response.arrayBuffer()))).toMatchObject({ width: 1200 });
  });

  test('?w= resizes and caches the variant under its storage key', async () => {
    const routes = assetRoutes({ root, storage });
    const cached = variantKey(SOURCE_KEY, { width: 320, format: 'png' });
    expect(await storage.disk().exists(cached)).toBe(false);

    const response = await call(routes, `${MEDIA_BASE_PATH}/${SOURCE_KEY}?w=320&f=png`);
    expect(probeImage(new Uint8Array(await response.arrayBuffer()))).toMatchObject({
      format: 'png',
      width: 320,
    });
    // Derived, not stored — but derived once. The second request is a disk read, not a decode.
    expect(await storage.disk().exists(cached)).toBe(true);
    const again = await call(routes, `${MEDIA_BASE_PATH}/${SOURCE_KEY}?w=320&f=png`);
    expect(new Uint8Array(await again.arrayBuffer()).length).toBeGreaterThan(0);
  });

  test('the srcset URL seo mints is a URL this route answers', async () => {
    const routes = assetRoutes({ root, storage });
    const image = responsiveImage({
      src: `${MEDIA_BASE_PATH}/${SOURCE_KEY}`,
      width: 1200,
      height: 600,
      alt: 'hero',
    });
    // Ascending widths; take the narrowest entry the markup actually promises.
    const first = image.img.srcset.split(', ')[0] ?? '';
    const url = first.slice(0, first.lastIndexOf(' '));
    expect(url).toContain('w=320');

    const response = await call(routes, url);
    expect(probeImage(new Uint8Array(await response.arrayBuffer())).width).toBe(320);
  });

  test('a format core cannot encode is refused by the driver, not silently downgraded', async () => {
    const routes = assetRoutes({ root, storage });
    await expect(
      call(routes, `${MEDIA_BASE_PATH}/${SOURCE_KEY}?w=320&f=avif`),
    ).rejects.toBeUltimateError('X_IMAGE_UNSUPPORTED');
  });

  // The bug this guards: the variant cache was keyed ENTIRELY on caller-supplied query values with
  // no cap of its own, so an authenticated reader holding `storage:read` could mint one stored
  // object per `?w=` on the app's only disk — `?w=1`, `?w=2`, … up to seo's `MAX_IMAGE_WIDTH`.
  // The route is intentionally reachable by every signed-in tenant, so the write has to be bounded
  // by what the framework can MINT, not by what a URL can ask for.
  test('a width no srcset can mint is served but never written to the disk', async () => {
    const routes = assetRoutes({ root, storage });
    const cached = variantKey(SOURCE_KEY, { width: 7, format: 'png' });

    const response = await call(routes, `${MEDIA_BASE_PATH}/${SOURCE_KEY}?w=7&f=png`);
    // Still answered — refusing would break nothing an attacker cares about and would turn a
    // cache decision into a new 4xx an app has to learn about.
    expect(probeImage(new Uint8Array(await response.arrayBuffer())).width).toBe(7);
    expect(await storage.disk().exists(cached)).toBe(false);
  });

  // `usableWidths` appends the SOURCE's own width when it is not one of `DEFAULT_WIDTHS`, so the
  // widest entry of a real `srcset` is a width outside the closed set — clamping to that set alone
  // would refuse a URL the framework itself mints.
  test("the source's own intrinsic width is cacheable, because a srcset names it", async () => {
    const routes = assetRoutes({ root, storage });
    const cached = variantKey(SOURCE_KEY, { width: 1200, format: 'png' });

    await call(routes, `${MEDIA_BASE_PATH}/${SOURCE_KEY}?w=1200&f=png`);
    expect(await storage.disk().exists(cached)).toBe(true);
  });

  test('an unusable width is refused before any byte is decoded', async () => {
    const routes = assetRoutes({ root, storage });
    await expect(call(routes, `${MEDIA_BASE_PATH}/${SOURCE_KEY}?w=0`)).rejects.toBeUltimateError(
      'X_IMAGE_QUERY_INVALID',
    );
  });
});
