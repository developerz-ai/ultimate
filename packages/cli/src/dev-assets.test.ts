// The image pipeline is only shipped if a running app answers with bytes. These tests drive the
// routes `x dev` mounts, not the functions behind them: the icon a generated web manifest names,
// and the exact `srcset` URL `@ultimat3/seo` mints — because a variant contract that is declared
// in two packages and answered by neither is what this whole path exists to close.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// `node:` by necessity: Bun has no temp-directory, no mkdtemp and no recursive remove — and each
// case needs its own root, or a leftover `apps/web/site/icon.png` decides the next one's answer.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRaster, encodeImage, probeImage } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import { responsiveImage } from '@ultimat3/seo';
import type { Storage } from '@ultimat3/storage';
import { defineStorage, localDriver, variantKey } from '@ultimat3/storage';
import { assetRoutes, ICON_SOURCE, MEDIA_BASE_PATH } from './dev-assets';

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
  const config = defineHttpConfig({});
  const ctx = createRequestContext({ url, method: 'GET', role: 'web', config });
  ctx.params = params(route.path, url.pathname);
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
});

afterEach(() => {
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

  test('an unusable width is refused before any byte is decoded', async () => {
    const routes = assetRoutes({ root, storage });
    await expect(call(routes, `${MEDIA_BASE_PATH}/${SOURCE_KEY}?w=0`)).rejects.toBeUltimateError(
      'X_IMAGE_QUERY_INVALID',
    );
  });
});
