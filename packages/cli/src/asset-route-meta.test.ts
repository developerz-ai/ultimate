// Every asset route spends the `assets` bucket, proven over the reference app's REAL route table:
// a new asset route that hand-writes its meta (and so forgets the bucket) fails here, not in an
// office behind one NAT whose fifth chunk answered 429.

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { DEFAULT_RATE_LIMIT } from '@ultimat3/http';
import { ASSET_RATE_LIMIT_BUCKET, ASSET_ROUTE_TAG, assetRouteMeta } from './asset-route-meta';

const DUMMY = join(import.meta.dir, '..', '..', '..', 'examples', 'dummy');
const here = (file: string): string => JSON.stringify(join(import.meta.dir, file));
// Resolved from THIS package: the reference app's own install is not the CLI's.
const STORAGE = JSON.stringify(Bun.resolveSync('@ultimat3/storage', import.meta.dir));

/**
 * `examples/dummy` loaded and its table composed as `x dev` composes it (the container composes
 * the same factories), in a child process: loading the app fills every process-global registry,
 * and this file must not leave them dirty for the next.
 */
const BOOT = `
  import { defineStorage, localDriver } from ${STORAGE};
  import { loadApp } from ${here('app-load.ts')};
  import { devRouteTable } from ${here('dev-route-table.ts')};
  import { islandBundle } from ${here('island-bundle.ts')};
  await loadApp(process.cwd());
  const { routes } = await devRouteTable({
    root: process.cwd(),
    env: {},
    buildId: 'asset-route-meta',
    storage: defineStorage({ disks: { local: localDriver({ root: '.x/asset-route-meta' }) } }),
    // Only its routes are built; nothing asks the dashboard or the disk a question.
    dashboard: { root: process.cwd(), runtime: { mail: { name: 'unused' }, db: {} }, status: () => ({}) },
    islands: () => islandBundle([]),
    realtime: { enabled: true },
  });
  console.log(JSON.stringify(routes.map((route) => route.meta)));
  process.exit(0);`;

interface MetaSeen {
  readonly name: string;
  readonly tags?: readonly string[];
  readonly rateLimit?: string;
}

const dummyRouteMetas = async (): Promise<readonly MetaSeen[]> => {
  const child = Bun.spawn(['bun', '-e', BOOT], { cwd: DUMMY, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) expect.unreachable(err);
  const parsed: unknown = JSON.parse(out.trim().split('\n').at(-1) ?? '[]');
  if (!Array.isArray(parsed)) expect.unreachable(`not a route list: ${out}`);
  return parsed as readonly MetaSeen[];
};

/**
 * Asset routes deliberately left on `default`, each with why. `/media` is authenticated and reads
 * the app's storage per request — every tenant's uploads, never a content-hashed build file — so
 * the static chunks' allowance would be a 16x looser ceiling on a disk read per call.
 */
const ON_DEFAULT: Readonly<Record<string, string>> = {
  'assets.media': 'an authenticated storage read per request, not a built chunk',
};

const isAsset = (meta: MetaSeen): boolean =>
  meta.name.startsWith('assets.') || (meta.tags ?? []).includes(ASSET_ROUTE_TAG);

describe('unit · assetRouteMeta', () => {
  test('writes the tag and the bucket, and keeps what the route declared', () => {
    expect(assetRouteMeta({ name: 'assets.x', auth: 'public' })).toEqual({
      name: 'assets.x',
      auth: 'public',
      tags: ['assets'],
      rateLimit: 'assets',
    });
  });

  test('the bucket it names ships in the default table, so it never falls through to default', () => {
    expect(Object.hasOwn(DEFAULT_RATE_LIMIT.buckets, ASSET_RATE_LIMIT_BUCKET)).toBe(true);
  });
});

describe('unit · the reference app’s asset routes', () => {
  test('every asset route is tagged `assets` and spends the `assets` bucket, but the listed few', async () => {
    const assets = (await dummyRouteMetas()).filter(isAsset);
    const names = assets.map((meta) => meta.name);
    // Not vacuous: every factory that mounts an asset route is in the walk.
    for (const expected of [
      'assets.island',
      'assets.style',
      'assets.site',
      'assets.favicon',
      'assets.media',
      'assets.manifest',
      'assets.sync-worker',
      'assets.page-boot',
      'assets.navigation',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names.some((name) => name.startsWith('assets.icon.'))).toBe(true);
    // The exclusion is pinned both ways: media stays tagged and stays on `default`.
    const media = assets.find((meta) => meta.name === 'assets.media');
    expect(media?.tags).toContain(ASSET_ROUTE_TAG);
    expect(media?.rateLimit).toBeUndefined();
    const wrong = assets
      .filter((meta) => !Object.hasOwn(ON_DEFAULT, meta.name))
      .filter(
        (meta) =>
          meta.rateLimit !== ASSET_RATE_LIMIT_BUCKET ||
          !(meta.tags ?? []).includes(ASSET_ROUTE_TAG),
      )
      .map((meta) => `${meta.name} → ${meta.rateLimit ?? '(default)'}`);
    expect(wrong).toEqual([]);
  }, 120_000);
});
