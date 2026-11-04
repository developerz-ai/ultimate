// The read half over the REAL asset routes: a URL a retained manifest names is answered by the
// route that missed it — the page runtime chunk included, which no restated URL shape admitted —
// as an object (etag, 304, Range) the browser will run; a URL no manifest names never reads its
// object; and a build published after this pod booted becomes readable within the refresh.

import { afterAll, describe, expect, test } from 'bun:test';
// why: a scratch app root; Bun ships no temp-dir or recursive-delete primitive.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: Bun exposes no tmpdir().
import { join } from 'node:path'; // why: Bun ships no path join.
import type { FrozenClock } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import type { ListOptions, StorageDriver } from '@ultimat3/storage';
import { memoryStorageDriver } from '@ultimat3/storage';
import type { IslandBundle } from './island-bundle';
import { islandRoutes } from './island-routes';
import type { BuildAsset } from './retained-assets';
import { publishBuildAssets } from './retained-assets';
import { retainedFileKey, retainedPrefix } from './retained-assets-layout';
import { retainedAssets, withRetainedAssets } from './retained-assets-read';
import { siteAssetRoutes } from './site-asset-routes';
import { createSiteAssetTable } from './site-assets';
import { styleBundleOf } from './style-bundle';
import { styleRoutes } from './style-routes';
import { pageBootRoutes, syncWorkerRoutes } from './worker-bundle';

const PREFIX = retainedPrefix('app', 'production');
const root = mkdtempSync(join(tmpdir(), 'x-retained-read-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A build with nothing in it: every asset route of this process misses. */
const empty: IslandBundle = {
  chunks: [],
  shared: [],
  resolverFor: () => (src: string) => src,
  realtime: new Map(),
  chunkAt: () => undefined,
  assetAt: () => undefined,
};
const ROUTES: readonly Route[] = [
  ...styleRoutes(() => styleBundleOf([])),
  ...islandRoutes(() => empty),
  ...siteAssetRoutes(createSiteAssetTable(root)),
  ...syncWorkerRoutes(() => undefined),
  ...pageBootRoutes(() => undefined),
];

const asset = (url: string, contentType: string): BuildAsset => ({
  url,
  contentType,
  body: new TextEncoder().encode(`bytes of ${url}`),
});
const EARLIER: readonly BuildAsset[] = [
  asset('/styles/0a0a0a0a.css', 'text/css; charset=utf-8'),
  asset('/islands/counter-1a2b3c4d.js', 'text/javascript'),
  asset('/islands/page-runtime.9z8y7x6w.js', 'text/javascript'),
  asset('/assets/logo.0123abcd.svg', 'image/svg+xml'),
  asset('/_x/assets/page-boot/3c3c3c3c.js', 'text/javascript'),
];

/** A disk counting reads of FILE keys — the manifests' own listing and reads are not counted. */
const counting = (
  disk: StorageDriver,
): { disk: StorageDriver; files: string[]; lists: string[] } => {
  const files: string[] = [];
  const lists: string[] = [];
  return {
    files,
    lists,
    disk: {
      ...disk,
      stat: (key: string) => {
        files.push(key);
        return disk.stat(key);
      },
      list: (options?: ListOptions) => {
        lists.push(options?.prefix ?? '');
        return disk.list(options);
      },
    },
  };
};

const publish = (
  disk: StorageDriver,
  clock: FrozenClock,
  id: string,
  assets: readonly BuildAsset[],
) =>
  publishBuildAssets({
    disk,
    prefix: PREFIX,
    diskName: 'assets',
    buildId: id,
    builds: 3,
    assets,
    clock,
  });

const serve = (disk: StorageDriver, clock: FrozenClock) =>
  httpServer({
    routes: withRetainedAssets(ROUTES, retainedAssets({ disk, prefix: PREFIX, clock })),
    role: 'web',
    config: defineHttpConfig({ dev: true, rateLimit: { scope: 'process' } }),
  });

const get = (server: ReturnType<typeof serve>, path: string, headers: HeadersInit = {}) =>
  server.fetch(new Request(`http://dev.test${path}`, { headers }));

describe('an earlier build, read through the routes that missed it', () => {
  test('every asset route answers a named file: 200, immutable, its type, never an attachment', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    await publish(memory, clock, 'earlier', EARLIER);
    const server = serve(memory, clock);

    for (const { url, contentType } of EARLIER) {
      const answer = await get(server, url);
      expect({ url, status: answer.status }).toEqual({ url, status: 200 });
      expect(answer.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(answer.headers.get('content-type')).toBe(contentType);
      expect(answer.headers.get('content-disposition')).toBeNull();
      expect(await answer.text()).toBe(`bytes of ${url}`);
    }
  });

  test('the page runtime chunk a stale realtime tab imports is served', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    await publish(memory, clock, 'earlier', EARLIER);

    const runtime = await get(serve(memory, clock), '/islands/page-runtime.9z8y7x6w.js');

    expect(runtime.status).toBe(200);
  });

  test('an object, so a validator revalidates to 304 and a range is a 206', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    await publish(memory, clock, 'earlier', EARLIER);
    const server = serve(memory, clock);
    const url = '/islands/counter-1a2b3c4d.js';

    const etag = (await get(server, url)).headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    expect((await get(server, url, { 'if-none-match': etag })).status).toBe(304);
    const part = await get(server, url, { range: 'bytes=0-4' });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('bytes');
  });

  test('a URL no retained manifest names is the route’s own 404, and its object is never read', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    await publish(memory, clock, 'earlier', EARLIER);
    // A file on the disk that no manifest names: present, and still not served.
    await memory.put(
      retainedFileKey(PREFIX, '/styles/0b0b0b0b.css'),
      new TextEncoder().encode('x'),
    );
    const counted = counting(memory);

    const miss = await get(serve(counted.disk, clock), '/styles/0b0b0b0b.css');

    expect(miss.status).toBe(404);
    expect(miss.headers.get('cache-control')).toContain('no-store');
    expect(counted.files).toEqual([]);
  });

  test('a build published after this pod booted is read once the refresh allows, not per request', async () => {
    const clock = frozenClock('2026-11-03T00:00:00Z');
    const memory = memoryStorageDriver({ clock });
    const counted = counting(memory);
    const server = serve(counted.disk, clock);
    const later = asset('/styles/0c0c0c0c.css', 'text/css; charset=utf-8');

    expect((await get(server, later.url)).status).toBe(404);
    await publish(memory, clock, 'later', [later]);
    const listed = counted.lists.length;
    expect((await get(server, later.url)).status).toBe(404);
    expect((await get(server, '/styles/0d0d0d0d.css')).status).toBe(404);
    expect(counted.lists.length).toBe(listed);

    clock.advance(5_000);
    expect((await get(server, later.url)).status).toBe(200);
  });
});

describe('withRetainedAssets', () => {
  test('no window: the very same routes; a route not tagged assets is never wrapped', () => {
    const plain: Route = {
      method: 'GET',
      path: '/x',
      meta: { name: 'x', auth: 'public' },
      handler: () => new Response(null, { status: 404 }),
    };
    expect(withRetainedAssets(ROUTES, undefined)).toBe(ROUTES);
    const reader = retainedAssets({ disk: memoryStorageDriver(), prefix: PREFIX });
    expect(withRetainedAssets([plain], reader)[0]).toBe(plain);
  });
});

describe('retainedAssets refreshMs', () => {
  test.each([Number.NaN, -1, 2.5])(
    '%p is refused: a NaN window refreshed on no request',
    (refreshMs) => {
      expect(() =>
        retainedAssets({ disk: memoryStorageDriver(), prefix: PREFIX, refreshMs }),
      ).toThrow('X_INVARIANT');
    },
  );
});
