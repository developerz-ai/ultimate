import { describe, expect, test } from 'bun:test';
import { buildPrecacheManifest, serializePrecacheManifest } from './precache';
import type { PwaRoute } from './strategies';

const routes: readonly PwaRoute[] = [
  {
    path: '/',
    surface: 'site',
    mode: 'static',
    offline: 'precache',
    revision: 'r1',
    bytes: 2_048,
  },
  {
    path: '/pricing',
    surface: 'site',
    mode: 'static',
    offline: 'precache',
    revision: 'r2',
    bytes: 4_096,
    dataUrl: '/_x/data/pricing.json',
  },
  { path: '/blog/:slug', surface: 'site', mode: 'isr', offline: 'precache', dynamic: true },
  { path: '/dashboard', surface: 'app', mode: 'stream', offline: 'runtime' },
  { path: '/legal', surface: 'site', mode: 'static', offline: 'network-only' },
];

describe('buildPrecacheManifest', () => {
  test('contains exactly the precache routes, their data, the shell and the fallback', () => {
    const manifest = buildPrecacheManifest({
      buildId: 'b1',
      routes,
      shellUrl: '/_x/shell.html',
      shellRevision: 's1',
      offlineFallbackUrl: '/offline',
    });

    expect(manifest.entries.map((e) => e.url)).toEqual([
      '/',
      '/_x/data/pricing.json',
      '/_x/shell.html',
      '/offline',
      '/pricing',
    ]);
    // runtime and network-only routes are never precached
    expect(manifest.entries.some((e) => e.url === '/dashboard')).toBe(false);
    expect(manifest.entries.some((e) => e.url === '/legal')).toBe(false);
  });

  test('a dynamic route cannot be precached as one URL and says so', () => {
    const manifest = buildPrecacheManifest({ buildId: 'b1', routes });
    expect(manifest.entries.some((e) => e.url === '/blog/:slug')).toBe(false);
    expect(manifest.warnings.some((w) => w.includes('/blog/:slug'))).toBe(true);
  });

  test('warns past the size threshold', () => {
    const heavy = buildPrecacheManifest({
      buildId: 'b1',
      routes,
      assets: [{ url: '/app.js', revision: 'a1', bytes: 6 * 1024 * 1024 }],
    });
    expect(heavy.warnings[0]).toContain('precache is 6mb');
    expect(heavy.totalBytes).toBe(6 * 1024 * 1024 + 2_048 + 4_096);
  });

  /**
   * The warning is read by a human deciding what to move to `offline: 'runtime'`, and this package
   * had its own `formatBytes` that stopped at `mb` — so a precache that grew past a gigabyte
   * reported a four-digit `mb`. One formatter, in `@ultimat3/core`, shared with the route budget
   * message that reports the same bytes on the other side of the build.
   */
  test('past a gigabyte the warning reads in gb, not in four-digit mb', () => {
    const enormous = buildPrecacheManifest({
      buildId: 'b1',
      routes: [],
      assets: [{ url: '/everything.js', revision: 'a1', bytes: 3 * 1024 * 1024 * 1024 }],
    });
    expect(enormous.warnings[0]).toContain('precache is 3gb');
    // The threshold beside it is still `5mb` — only the total crossed into gb.
    expect(enormous.warnings[0]).not.toContain('3072mb');
  });

  // `PrecacheAsset` carried a `critical?: boolean` whose comment read "critical assets (the shell
  // CSS, the LCP font) are precached even if large" — a promise kept by nothing, because there is
  // no size filter anywhere in this file and never was. Every declared asset is precached whatever
  // it weighs; `warnBytes` warns on the TOTAL and excludes nothing. The field was deleted rather
  // than implemented: a filter added now would silently drop assets an app precaches today, and a
  // precache manifest quietly missing an entry is an app that 404s offline. This is the assertion
  // that would have caught the lie, and the one that fails if a filter is ever added in silence.
  test('nothing is excluded for being large — a size filter does not exist', () => {
    const huge = buildPrecacheManifest({
      buildId: 'b1',
      routes: [],
      assets: [
        { url: '/tiny.css', revision: 'a1', bytes: 10 },
        { url: '/huge.js', revision: 'a2', bytes: 500 * 1024 * 1024 },
      ],
      warnBytes: 1,
    });
    expect(huge.entries.map((entry) => entry.url)).toEqual(['/huge.js', '/tiny.css']);
    // Warned about, and still precached: the warning is the whole of the size behaviour.
    expect(huge.warnings).toHaveLength(1);
  });

  test('the revision is the content hash, so unchanged assets survive a deploy', () => {
    const first = buildPrecacheManifest({ buildId: 'b1', routes });
    const second = buildPrecacheManifest({ buildId: 'b2', routes });
    const revisionOf = (url: string, entries: readonly { url: string; revision: string }[]) =>
      entries.find((e) => e.url === url)?.revision;

    expect(revisionOf('/pricing', first.entries)).toBe('r2');
    expect(revisionOf('/pricing', second.entries)).toBe('r2');
    expect(serializePrecacheManifest(first)).toBe(serializePrecacheManifest(second));
  });
});
