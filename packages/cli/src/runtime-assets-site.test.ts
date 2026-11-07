// A served page's `responsiveImage` over an `asset()` URL mints `?w=&f=` candidates; `/assets`
// answered every one with the full PNG. Each case drives the route `x dev` and the container mount,
// over a real `apps/web/site/assets/` directory: the declared variants, the refusals, the cache.

import { afterAll, describe, expect, test } from 'bun:test';
// why: a scratch app root per suite; Bun ships no temp-dir or recursive-delete primitive.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: Bun exposes no tmpdir().
import { join } from 'node:path'; // why: Bun ships no path join.
import { blankRaster, encodeImage, probeImage } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { defineHttpConfig, requestContext, UltimateRequest } from '@ultimat3/http';
import type { ImageTransformDriver } from '@ultimat3/seo';
import { responsiveImage } from '@ultimat3/seo';
import { defineStorage, memoryStorageDriver } from '@ultimat3/storage';
import { assetRoutes } from './runtime-assets';
import { siteAssetVariantRoutes } from './runtime-assets-site';
import { SITE_ASSETS_SOURCE, siteAssetTable } from './site-assets';

const root = mkdtempSync(join(tmpdir(), 'x-site-variants-'));
mkdirSync(join(root, SITE_ASSETS_SOURCE), { recursive: true });
writeFileSync(join(root, SITE_ASSETS_SOURCE, 'hero.png'), encodeImage(blankRaster(960, 540)));
writeFileSync(
  join(root, SITE_ASSETS_SOURCE, 'logo.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg"/>',
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const table = siteAssetTable(root);
const HERO = table.resolve('assets/hero.png');
const LOGO = table.resolve('assets/logo.svg');

/** The route the app mounts, unless a case hands in its own set. */
function call(path: string, routes: readonly Route[] = mounted()): Promise<Response> {
  const route = routes.find((candidate) => candidate.meta?.name === 'assets.site');
  if (route === undefined) return expect.unreachable('/assets was not mounted');
  const url = new URL(`http://app.test${path}`);
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = requestContext({ url, method: 'GET', role: 'web', config });
  return Promise.resolve(route.handler(new UltimateRequest(new Request(url), ctx), ctx));
}

function mounted(): readonly Route[] {
  return assetRoutes({
    root,
    storage: defineStorage({ disks: { memory: memoryStorageDriver() } }),
  });
}

/** A driver that never decodes, counting how often it was asked. */
function counting(): { readonly driver: ImageTransformDriver; calls: number } {
  const state = {
    calls: 0,
    driver: {
      name: 'stub',
      async transform() {
        state.calls += 1;
        return {
          bytes: encodeImage(blankRaster(8, 8)),
          contentType: 'image/png',
          width: 8,
          height: 8,
        };
      },
      blurPlaceholder: async () => '',
    } satisfies ImageTransformDriver,
  };
  return state;
}

const sizeOf = async (response: Response) =>
  probeImage(new Uint8Array(await response.arrayBuffer()));

const refusal = async (response: Response): Promise<string> => {
  expect(response.status).toBe(404);
  const body = (await response.json()) as { error: { code: string; fix: string } };
  expect(body.error.fix).toStartWith('responsiveImage(');
  return body.error.code;
};

describe('unit · /assets answers the variants responsiveImage() mints', () => {
  test('every candidate of a served <picture> is the type and the width it promises', async () => {
    const image = responsiveImage({ src: HERO.url, width: 960, height: 540, alt: '' });
    const promised = [
      ...image.sources.map((source) => ({ type: source.type, srcset: source.srcset })),
      { type: 'image/png', srcset: image.img.srcset },
    ];
    expect(promised.map((one) => one.type)).toEqual(['image/webp', 'image/png']);
    for (const { type, srcset } of promised) {
      for (const candidate of srcset.split(', ')) {
        const [url = '', descriptor = ''] = candidate.split(' ');
        const response = await call(url);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(type);
        expect(response.headers.get('cache-control')).toContain('immutable');
        expect((await sizeOf(response)).width).toBe(Number.parseInt(descriptor, 10));
      }
    }
  });

  test('a format alone keeps the intrinsic width; no query is the file itself', async () => {
    const webp = await call(`${HERO.url}?f=webp`);
    expect(webp.headers.get('content-type')).toBe('image/webp');
    expect((await sizeOf(webp)).width).toBe(960);
    const plain = await call(HERO.url);
    expect(plain.headers.get('content-type')).toBe('image/png');
    expect(plain.headers.get('accept-ranges')).toBe('bytes');
  });
});

describe('X_ASSET_VARIANT_UNDECLARED · a public route is no resize service', () => {
  test.each([
    ['a width the srcset never names', '?w=321'],
    ['an upscale past the source', '?w=1280'],
    ['a format the pipeline cannot write', '?f=avif'],
    ['a format responsiveImage never offers', '?w=320&f=jpeg'],
    ['a quality, which responsiveImage never mints', '?w=320&q=40'],
  ])('%s is refused before any decode', async (_, query) => {
    const stub = counting();
    const routes = siteAssetVariantRoutes(table, { images: stub.driver });
    expect(await refusal(await call(`${HERO.url}${query}`, routes))).toBe(
      'X_ASSET_VARIANT_UNDECLARED',
    );
    expect(stub.calls).toBe(0);
  });

  test('a source that is not a raster has no variants', async () => {
    expect(await refusal(await call(`${LOGO.url}?w=320`))).toBe('X_ASSET_VARIANT_UNDECLARED');
  });

  test('a stale hash keeps the plain route answer, query or not', async () => {
    const stale = HERO.url.replace(HERO.hash, '00000000');
    expect(await (await call(`${stale}?w=320&f=webp`)).json()).toEqual(
      await (await call(stale)).json(),
    );
  });

  test('a malformed width is the query parser code, as on /media', async () => {
    const thrown = await call(`${HERO.url}?w=0`).then(
      () => expect.unreachable('?w=0 was answered'),
      (error: unknown) => error,
    );
    expect(thrown).toMatchObject({ code: 'X_IMAGE_QUERY_INVALID' });
  });
});

describe('unit · one decode per variant per content hash', () => {
  test('a repeat and a concurrent burst both reach the driver once', async () => {
    const stub = counting();
    const routes = siteAssetVariantRoutes(table, { images: stub.driver });
    await Promise.all([1, 2, 3].map(() => call(`${HERO.url}?w=320&f=webp`, routes)));
    await call(`${HERO.url}?w=320&f=webp`, routes);
    expect(stub.calls).toBe(1);
    await call(`${HERO.url}?w=480&f=webp`, routes);
    expect(stub.calls).toBe(2);
  });

  test('the byte budget evicts the least recently used variant', async () => {
    const stub = counting();
    const one = encodeImage(blankRaster(8, 8)).byteLength;
    const routes = siteAssetVariantRoutes(table, { images: stub.driver, cacheBytes: one });
    await call(`${HERO.url}?w=320`, routes);
    await call(`${HERO.url}?w=480`, routes);
    await call(`${HERO.url}?w=320`, routes);
    expect(stub.calls).toBe(3);
  });

  test('a budget that is not a whole byte count is refused at mount', () => {
    expect(() => siteAssetVariantRoutes(table, { cacheBytes: Number.NaN })).toThrow(/cacheBytes/);
  });
});
