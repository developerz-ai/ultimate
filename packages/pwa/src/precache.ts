/**
 * The precache manifest, built from the route table. Entries are URL + revision, so a
 * byte-identical asset across deploys is not re-downloaded; the revision is the content
 * hash, never the build id, or every deploy would re-fetch everything.
 */

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
  /** The app shell URL, precached for every `spa` route. */
  readonly shellUrl?: string;
  readonly shellRevision?: string;
  readonly shellBytes?: number;
  /** The mandatory offline document. */
  readonly offlineFallbackUrl?: string;
  readonly offlineFallbackRevision?: string;
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
      bytes: 0,
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

  const sorted = [...entries.values()].sort((a, b) => a.url.localeCompare(b.url));
  const totalBytes = sorted.reduce((sum, entry) => sum + entry.bytes, 0);
  const warnBytes = input.warnBytes ?? DEFAULT_PRECACHE_WARN_BYTES;

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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10}kb`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10}mb`;
}

/** The manifest as it is embedded in `sw.js`; stable key order for determinism. */
export function serializePrecacheManifest(manifest: PrecacheManifest): string {
  const rows = manifest.entries.map(
    (entry) => `{"url":${JSON.stringify(entry.url)},"revision":${JSON.stringify(entry.revision)}}`,
  );
  return `[${rows.join(',')}]`;
}
