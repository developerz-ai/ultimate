/**
 * The precache manifest, built from the route table. Entries are URL + revision, so a
 * byte-identical asset across deploys is not re-downloaded; the revision is the content
 * hash, never the build id, or every deploy would re-fetch everything.
 */

// One formatter, in `@ultimat3/core`: the copy that lived here stopped at `mb`, and the route
// budget message on the other side of the build stopped at `kb`, for the same byte count.
import { finiteCount, formatBytes } from '@ultimat3/core';
import type { PwaRoute } from './strategies';

export interface PrecacheAsset {
  readonly url: string;
  /** Content hash. Same bytes → same revision → no re-download. */
  readonly revision: string;
  readonly bytes: number;
}

export interface PrecacheEntry {
  readonly url: string;
  readonly revision: string;
  readonly bytes: number;
  readonly reason: 'shell' | 'route' | 'route-data' | 'asset' | 'fallback';
}

export interface PrecacheManifest {
  readonly buildId: string;
  readonly entries: readonly PrecacheEntry[];
  readonly totalBytes: number;
  readonly warnings: readonly string[];
}

export interface PrecacheInput {
  readonly buildId: string;
  readonly routes: readonly PwaRoute[];
  readonly assets?: readonly PrecacheAsset[];
  /**
   * A single document precached for every route, whatever its render mode — an app shell.
   *
   * **Nothing in the framework's build path sets this trio.** It said "precached for every `spa`
   * route" until `As of 2026-09`, and `spa` was deleted from `RENDER_MODES` — so the sentence
   * named a mode that cannot be declared, over a branch no caller reaches. Today the only way to
   * a `reason: 'shell'` entry is a hand-built `generateServiceWorker` call: `x build`'s composer
   * (`packages/cli/src/sw-artifacts.ts`) passes routes and assets and never a shell. Kept because
   * deleting a public field is a major; a candidate for the next one's declared-and-never-wired
   * sweep, with `PwaRoute.dataUrl`.
   */
  readonly shellUrl?: string;
  /** Defaults to `buildId`, which re-downloads the shell on every deploy. */
  readonly shellRevision?: string;
  readonly shellBytes?: number;
  /** The mandatory offline document. */
  readonly offlineFallbackUrl?: string;
  /**
   * Content hash of the built offline document. Absent, the entry is stamped with `buildId` and
   * every deploy re-downloads the one page an offline navigation depends on — the rule this file's
   * header states for every other entry, which this one had no field to obey.
   */
  readonly offlineFallbackRevision?: string;
  /** Byte size of the same document. Absent, it counts as 0 against `warnBytes`. */
  readonly offlineFallbackBytes?: number;
  /** Warn past this total. Default 5 MB: past that, install stalls on a bad connection. */
  readonly warnBytes?: number;
}

export const DEFAULT_PRECACHE_WARN_BYTES = 5 * 1024 * 1024;

/**
 * Deterministic: entries are sorted by URL and every field is derived from the input, so
 * two builds of the same commit emit byte-identical manifests.
 */
export function buildPrecacheManifest(input: PrecacheInput): PrecacheManifest {
  const entries = new Map<string, PrecacheEntry>();
  const add = (entry: PrecacheEntry): void => {
    // Screened per entry, not on the total: `totalBytes > warnBytes` is false when either side is
    // `NaN`, so ONE asset whose byte count did not arrive as a number takes down the budget
    // warning for every other entry — silently, in a function whose output is otherwise
    // byte-identical per commit. This runs at build time, where a refusal is the right answer.
    finiteCount('buildPrecacheManifest', `bytes for ${entry.url}`, entry.bytes);
    if (!entries.has(entry.url)) entries.set(entry.url, entry);
  };

  if (input.shellUrl !== undefined) {
    add({
      url: input.shellUrl,
      revision: input.shellRevision ?? input.buildId,
      bytes: input.shellBytes ?? 0,
      reason: 'shell',
    });
  }

  if (input.offlineFallbackUrl !== undefined) {
    add({
      url: input.offlineFallbackUrl,
      revision: input.offlineFallbackRevision ?? input.buildId,
      bytes: input.offlineFallbackBytes ?? 0,
      reason: 'fallback',
    });
  }

  for (const route of input.routes) {
    if (route.offline !== 'precache') continue;
    // A dynamic route has no single URL to precache; its instances are runtime-cached.
    if (route.dynamic === true) continue;
    add({
      url: route.path,
      revision: route.revision ?? input.buildId,
      bytes: route.bytes ?? 0,
      reason: 'route',
    });
    if (route.dataUrl !== undefined) {
      add({
        url: route.dataUrl,
        revision: route.revision ?? input.buildId,
        bytes: 0,
        reason: 'route-data',
      });
    }
  }

  for (const asset of input.assets ?? []) {
    add({ url: asset.url, revision: asset.revision, bytes: asset.bytes, reason: 'asset' });
  }

  // CODE UNITS, never `localeCompare`: these entries are emitted into `sw.js`, whose header
  // promises byte-identical output for identical input, and `localeCompare` with no locale
  // argument answers from the runtime's ICU default and collation version — two machines, two
  // orders, one no-op deploy that fires the SW update check. Same rule as `service-worker.ts`'s
  // rule tie-break and `@ultimat3/jobs`' `job.ts`.
  const sorted = [...entries.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const totalBytes = sorted.reduce((sum, entry) => sum + entry.bytes, 0);
  const warnBytes = finiteCount(
    'buildPrecacheManifest',
    'warnBytes',
    input.warnBytes ?? DEFAULT_PRECACHE_WARN_BYTES,
  );

  const warnings: string[] = [];
  if (totalBytes > warnBytes) {
    warnings.push(
      `precache is ${formatBytes(totalBytes)} (over ${formatBytes(warnBytes)}): install ` +
        "will stall on a slow connection — move rarely-visited routes to offline: 'runtime'",
    );
  }
  const dynamicPrecache = input.routes.filter(
    (r) => r.offline === 'precache' && r.dynamic === true,
  );
  for (const route of dynamicPrecache) {
    warnings.push(
      `${route.path} is dynamic and cannot be precached as one URL; its instances are ` +
        'runtime-cached instead',
    );
  }

  return { buildId: input.buildId, entries: sorted, totalBytes, warnings };
}

/** The manifest as it is embedded in `sw.js`; stable key order for determinism. */
export function serializePrecacheManifest(manifest: PrecacheManifest): string {
  const rows = manifest.entries.map(
    (entry) => `{"url":${JSON.stringify(entry.url)},"revision":${JSON.stringify(entry.revision)}}`,
  );
  return `[${rows.join(',')}]`;
}
