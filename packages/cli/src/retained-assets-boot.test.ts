// The web boot's half of `assets.retain`: off unless declared, a disk the app did not declare
// refuses the boot by name, and a declared window publishes every hashed file this build serves —
// stylesheets, island entries and shared chunks, framework scripts, site assets — under the app's
// and environment's own prefix, and hands back the reader the routes miss into.

import { afterAll, describe, expect, test } from 'bun:test';
// why: a scratch app root; Bun ships no temp-dir or recursive-delete primitive.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: Bun exposes no tmpdir().
import { join } from 'node:path'; // why: Bun ships no path join.
import { defineConfig, isUltimateError } from '@ultimat3/core';
import { defineHttpConfig, requestContext, UltimateRequest } from '@ultimat3/http';
import { defineStorage, memoryStorageDriver } from '@ultimat3/storage';
import type { IslandBundle } from './island-bundle';
import { buildAssetsOf, retainBuildAssets } from './retained-assets-boot';
import { manifestKey, retainedFileKey, retainedPrefix } from './retained-assets-layout';
import { SITE_ASSETS_SOURCE } from './site-assets';
import { styleBundleOf } from './style-bundle';

const root = mkdtempSync(join(tmpdir(), 'x-retained-boot-'));
mkdirSync(join(root, SITE_ASSETS_SOURCE), { recursive: true });
writeFileSync(join(root, SITE_ASSETS_SOURCE, 'logo.svg'), '<svg/>');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const chunk = { file: 'apps/web/site/a.island.tsx', moduleId: 'a', imports: [] };
const islands: IslandBundle = {
  chunks: [{ ...chunk, url: '/islands/a-1a1a1a1a.js', code: 'a', bytes: 1 }],
  shared: [{ url: '/islands/chunk-2b2b2b2b.js', code: 'b', bytes: 1, importers: [chunk.file] }],
  resolverFor: () => (src: string) => src,
  realtime: new Map(),
  chunkAt: () => undefined,
  assetAt: () => undefined,
};
const styles = styleBundleOf([{ surface: 'site', css: '.a{}' }]);
const scripts = [{ url: '/_x/assets/page-boot/3c3c3c3c.js', code: 'boot', bytes: 4 }];
const surface = { root, buildId: 'b1', environment: 'staging', islands, styles, scripts };
const PREFIX = retainedPrefix('app', 'staging');
const request = (path: string): UltimateRequest => {
  const url = new URL(`http://app.test${path}`);
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  return new UltimateRequest(
    new Request(url),
    requestContext({ url, method: 'GET', role: 'web', config }),
  );
};

const retaining = defineConfig({ name: 'app', assets: { retain: { disk: 'assets', builds: 2 } } });

describe('retainBuildAssets', () => {
  test('undeclared: nothing is published and there is no reader', async () => {
    const disk = memoryStorageDriver();
    const storage = defineStorage({ disks: { assets: disk } });
    expect(
      await retainBuildAssets({ ...surface, config: defineConfig({ name: 'app' }), storage }),
    ).toBe(undefined);
    expect(disk.objects().size).toBe(0);
  });

  test('undeclared outside development and test: one coded warning naming the edit', async () => {
    const storage = defineStorage({ disks: { assets: memoryStorageDriver() } });
    const config = defineConfig({ name: 'app' });
    const warned = async (environment: string, built = surface) => {
      const lines: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
      const log = {
        warn: (message: string, fields: Readonly<Record<string, unknown>>) =>
          void lines.push({ message, fields }),
        error: () => undefined,
      };
      await retainBuildAssets({ ...built, environment, config, storage, log });
      return lines;
    };
    const [line, ...rest] = await warned('production');
    expect(rest).toEqual([]);
    expect(line?.fields['code']).toBe('X_ASSET_RETAIN_UNDECLARED');
    expect(line?.message).toContain('assets: { retain: { disk: "assets", builds: 3 } }');
    expect(await warned('staging')).toHaveLength(1);
    // A laptop and a test boot have no rolling deploy; a build serving no hashed file has nothing
    // a page could name.
    expect(await warned('development')).toEqual([]);
    expect(await warned('test')).toEqual([]);
    const bare = mkdtempSync(join(tmpdir(), 'x-retained-bare-'));
    try {
      const nothing = {
        ...surface,
        root: bare,
        islands: { ...islands, chunks: [], shared: [] },
        styles: styleBundleOf([]),
        scripts: [],
      };
      expect(await warned('production', nothing)).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('a disk the app did not declare is X_CONFIG_INVALID naming the ones it did', async () => {
    const storage = defineStorage({ disks: { uploads: memoryStorageDriver() } });
    let caught: unknown;
    try {
      await retainBuildAssets({ ...surface, config: retaining, storage });
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) && caught.code).toBe('X_CONFIG_INVALID');
    expect(isUltimateError(caught) && caught.cause).toContain('uploads');
  });

  test('declared: every hashed file is published under its URL, and the routes can read it', async () => {
    const disk = memoryStorageDriver();
    const storage = defineStorage({ disks: { assets: disk } });

    const retained = await retainBuildAssets({ ...surface, config: retaining, storage });

    expect(retained?.report.outcome).toBe('published');
    const urls = buildAssetsOf(surface).map((asset) => asset.url);
    expect(urls).toEqual([
      styles.chunks[0]?.url ?? '',
      '/islands/a-1a1a1a1a.js',
      '/islands/chunk-2b2b2b2b.js',
      '/_x/assets/page-boot/3c3c3c3c.js',
      expect.stringMatching(/^\/assets\/logo\.[0-9a-f]{8}\.svg$/),
    ]);
    for (const url of urls) expect(await disk.exists(retainedFileKey(PREFIX, url))).toBe(true);
    expect(await disk.exists(manifestKey(PREFIX, 'b1'))).toBe(true);
    const reader = retained?.reader;
    expect((await reader?.read(request('/islands/chunk-2b2b2b2b.js')))?.status).toBe(200);
    const logo = await reader?.read(request(urls[4] ?? ''));
    expect(logo?.headers.get('content-type')).toBe('image/svg+xml');
  });
});
