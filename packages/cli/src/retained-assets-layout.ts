// Where `assets.retain` keeps things on its disk, and the reads every half shares: the key of a
// file and of a manifest, one app-and-environment prefix, and the manifests as written. The
// publish, the sweep and the read each import this; none imports another's file for it.

import { isUltimateError } from '@ultimat3/core';
import type { StorageDriver, StorageListEntry, StorageRead } from '@ultimat3/storage';

/** Outside `org/`, so `/_storage` and `/media` refuse it (`assertReadableKey`): served only here. */
export const RETAINED_ASSET_PREFIX = 'x-build-assets';
/** Disk calls in flight at once: a boot over S3 is round trips, not bytes. */
const CONCURRENCY = 8;

/**
 * One app in one environment on the disk: `x-build-assets/<app>/<environment>`. Staging and
 * production sharing a bucket must neither sweep nor serve each other's builds.
 */
export interface RetainedScope {
  readonly disk: StorageDriver;
  readonly prefix: string;
}

/** `config.name` is already a slug (`defineConfig`); the environment is one of `ENVIRONMENTS`. */
export const retainedPrefix = (app: string, environment: string): string =>
  `${RETAINED_ASSET_PREFIX}/${encodeURIComponent(app)}/${encodeURIComponent(environment)}`;

/** `/styles/ab12cd34.css` → `<prefix>/files/styles/ab12cd34.css`. Content-addressed: shared. */
export const retainedFileKey = (prefix: string, url: string): string => `${prefix}/files${url}`;

/** The listing prefix every file of the scope sits under. */
export const filesPrefix = (prefix: string): string => `${prefix}/files/`;

/** The listing prefix every manifest of the scope sits under. */
export const manifestsPrefix = (prefix: string): string => `${prefix}/builds/`;

/** Where a build says it is complete — written after its files. */
export const manifestKey = (prefix: string, buildId: string): string =>
  `${manifestsPrefix(prefix)}${encodeURIComponent(buildId)}.json`;

/** What a manifest holds: the build, when it last went live, and every URL it serves. */
export interface BuildManifest {
  readonly buildId: string;
  readonly publishedAt: number;
  readonly urls: readonly string[];
}

export async function inBatches<T>(
  items: readonly T[],
  each: (item: T) => Promise<void>,
): Promise<void> {
  for (let at = 0; at < items.length; at += CONCURRENCY) {
    await Promise.all(items.slice(at, at + CONCURRENCY).map(each));
  }
}

export async function listAll(
  disk: StorageDriver,
  prefix: string,
): Promise<readonly StorageListEntry[]> {
  const all: StorageListEntry[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await disk.list({ prefix, cursor });
    all.push(...page.rows);
    if (!page.hasMore) return all;
    cursor = page.nextCursor;
  }
}

function parseManifest(bytes: Uint8Array): BuildManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { buildId, publishedAt, urls } = parsed as Record<string, unknown>;
  if (typeof buildId !== 'string' || typeof publishedAt !== 'number') return undefined;
  if (!Array.isArray(urls) || !urls.every((url) => typeof url === 'string')) return undefined;
  return { buildId, publishedAt, urls };
}

export interface StoredManifest {
  readonly key: string;
  readonly manifest: BuildManifest;
}

/**
 * Every manifest of the scope, or `undefined` when one does not parse: what it names is unknown,
 * so a caller deciding what to delete or to serve must not guess.
 */
export async function readManifests(
  scope: RetainedScope,
): Promise<readonly StoredManifest[] | undefined> {
  const manifests: StoredManifest[] = [];
  for (const entry of await listAll(scope.disk, manifestsPrefix(scope.prefix))) {
    let read: StorageRead;
    try {
      read = await scope.disk.get(entry.key);
    } catch (error) {
      // Deleted by another pod's sweep between the listing and the read: no longer a manifest.
      if (isUltimateError(error) && error.code === 'X_STORAGE_NOT_FOUND') continue;
      throw error;
    }
    const manifest = parseManifest(read.bytes);
    if (manifest === undefined) return undefined;
    manifests.push({ key: entry.key, manifest });
  }
  return manifests;
}
