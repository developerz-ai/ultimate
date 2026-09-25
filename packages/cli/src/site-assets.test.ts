// The site asset table, end to end over a real directory: the hashed copy the static export
// carries, the immutable answer the served surfaces give, `X_ASSET_MISSING` for a file that is not
// there, and `asset()` answering through the table `loadApp` installs.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
// why: a scratch app root per suite; Bun ships no temp-dir or recursive-delete primitive.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: Bun exposes no tmpdir().
import { join } from 'node:path'; // why: Bun ships no path join.
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import type { AssetPath } from '@ultimat3/render';
import { asset, setAssetResolver } from '@ultimat3/render';
import { byteRange, siteAssetRoutes } from './site-asset-routes';
import {
  createSiteAssetTable,
  hashedAssetUrl,
  parseHashedAssetUrl,
  SITE_ASSETS_SOURCE,
  writeSiteAssets,
} from './site-assets';

const root = mkdtempSync(join(tmpdir(), 'x-site-assets-'));
const source = join(root, SITE_ASSETS_SOURCE);
mkdirSync(join(source, 'films'), { recursive: true });
writeFileSync(join(source, 'hero.avif'), 'avif-bytes');
writeFileSync(join(source, 'films', 'explainer.mp4'), '0123456789');
writeFileSync(join(source, 'films', 'explainer.es-co.vtt'), 'WEBVTT\n');
// A source file beside its renditions: not servable, never copied.
writeFileSync(join(source, 'hero.psd'), 'layers');

afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => setAssetResolver(undefined));

const HASH = /^[0-9a-f]{8}$/;

const get = async (
  table: ReturnType<typeof createSiteAssetTable>,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<Response> => {
  const url = new URL(`http://app.test${pathname}`);
  const ctx = createRequestContext({
    url,
    method: 'GET',
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });
  const route = siteAssetRoutes(table)[0] as ReturnType<typeof siteAssetRoutes>[number];
  return route.handler(new UltimateRequest(new Request(url, { headers }), ctx), ctx);
};

describe('X_ASSET_MISSING', () => {
  test('a file that is not there is refused by code, naming where it belongs', () => {
    const table = createSiteAssetTable(root);
    let caught: unknown;
    try {
      table.resolve('assets/missing.webp');
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining({ code: 'X_ASSET_MISSING' }));
    expect((caught as { fix: string }).fix).toContain(`${SITE_ASSETS_SOURCE}/missing.webp`);
  });

  test('asset() through an installed table fails the render the same way', () => {
    const table = createSiteAssetTable(root);
    setAssetResolver((path) => table.resolve(path).url);
    expect(() => asset('assets/nope.png')).toThrow(
      expect.objectContaining({ code: 'X_ASSET_MISSING' }),
    );
    expect(asset('assets/hero.avif')).toMatch(/^\/assets\/hero\.[0-9a-f]{8}\.avif$/);
  });
});

describe('the hashed URL', () => {
  test('is content-addressed and round-trips through the parser', () => {
    const hero = createSiteAssetTable(root).resolve('assets/hero.avif');
    expect(hero.hash).toMatch(HASH);
    expect(hero.url).toBe(`/assets/hero.${hero.hash}.avif`);
    expect(parseHashedAssetUrl(hero.url)).toEqual({ path: 'assets/hero.avif', hash: hero.hash });
    expect(hashedAssetUrl('assets/films/explainer.es-co.vtt', 'abcdef01')).toBe(
      '/assets/films/explainer.es-co.abcdef01.vtt',
    );
    expect(parseHashedAssetUrl('/assets/hero.avif')).toBeUndefined();
    expect(parseHashedAssetUrl('/assets/../x.abcdef01.png')).toBeUndefined();
  });

  test('changes when the bytes change, with no watcher and no restart', () => {
    const table = createSiteAssetTable(root);
    const file = join(source, 'changing.png');
    writeFileSync(file, 'one');
    const before = table.resolve('assets/changing.png').url;
    writeFileSync(file, 'two, and longer');
    expect(table.resolve('assets/changing.png').url).not.toBe(before);
    rmSync(file);
  });
});

describe('the static export', () => {
  test('carries every servable asset under its hashed name, and nothing else', async () => {
    const out = join(root, '.x', 'static');
    const written = writeSiteAssets(root, out);
    const table = createSiteAssetTable(root);
    const hero = table.resolve('assets/hero.avif');
    const film = table.resolve('assets/films/explainer.mp4');
    expect(written).toEqual(
      expect.arrayContaining([
        hero.url,
        film.url,
        table.resolve('assets/films/explainer.es-co.vtt').url,
      ]),
    );
    expect(written.some((url) => url.includes('psd'))).toBe(false);
    expect(await Bun.file(join(out, hero.url.slice(1))).text()).toBe('avif-bytes');
    expect(await Bun.file(join(out, 'assets', 'hero.avif')).exists()).toBe(false);
  });
});

describe('the served surface', () => {
  const table = createSiteAssetTable(root);

  test('answers the hashed URL immutable, with the type the extension names', async () => {
    const cases: readonly [AssetPath, string][] = [
      ['assets/hero.avif', 'image/avif'],
      ['assets/films/explainer.mp4', 'video/mp4'],
      ['assets/films/explainer.es-co.vtt', 'text/vtt; charset=utf-8'],
    ];
    for (const [path, type] of cases) {
      const response = await get(table, table.resolve(path).url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(type);
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(response.headers.get('accept-ranges')).toBe('bytes');
    }
  });

  test('refuses the unhashed name, a stale hash and a missing file with a 404', async () => {
    expect((await get(table, '/assets/hero.avif')).status).toBe(404);
    expect((await get(table, '/assets/hero.00000000.avif')).status).toBe(404);
    const missing = await get(table, '/assets/gone.0123abcd.png');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: 'X_ASSET_MISSING' }) }),
    );
  });

  test('answers a byte range with 206, which Safari needs to play a video', async () => {
    const url = table.resolve('assets/films/explainer.mp4').url;
    const partial = await get(table, url, { range: 'bytes=2-5' });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await partial.text()).toBe('2345');
    const beyond = await get(table, url, { range: 'bytes=40-' });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe('bytes */10');
  });

  test('byteRange reads the three single-range spellings and ignores the rest', () => {
    expect(byteRange(null, 10)).toBeUndefined();
    expect(byteRange('bytes=0-1,4-5', 10)).toBeUndefined();
    expect(byteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(byteRange('bytes=8-', 10)).toEqual({ start: 8, end: 9 });
    expect(byteRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(byteRange('bytes=6-2', 10)).toBeNull();
  });
});
