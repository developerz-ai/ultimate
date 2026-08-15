// Tier 3: the CDN. Ultimate does not read from the CDN (it sits in front of us), so this
// tier's job is the other two thirds of caching: emitting the headers that let the CDN hold
// the response, and purging by surrogate key when a tag changes. Surrogate keys ARE the
// tags — same strings, so a CDN purge cannot drift from an app-level invalidation.

import { dependentsOfKind } from './graph';
import type { CacheTag } from './tags';
import { serializeTags } from './tags';
import type { CacheEntry, CacheSetOptions, CacheTier, TierInvalidation } from './tiers';

export interface CacheHeaderOptions {
  /** Browser freshness, seconds. */
  readonly maxAge?: number;
  /** Shared (CDN) freshness, seconds. */
  readonly sMaxAge?: number;
  /** Serve stale for N seconds while revalidating behind the request. */
  readonly staleWhileRevalidate?: number;
  readonly staleIfError?: number;
  /** Per-user responses: never shared, no surrogate keys. */
  readonly visibility?: 'public' | 'private';
  readonly immutable?: boolean;
  readonly tags?: readonly CacheTag[];
}

/** `Cache-Control` + `Surrogate-Key`, ready to spread into a `Headers` init. */
export function cacheHeaders(options: CacheHeaderOptions = {}): Record<string, string> {
  const visibility = options.visibility ?? 'public';
  const parts: string[] = [visibility];

  if (visibility === 'private') {
    parts.push('no-store');
    return { 'Cache-Control': parts.join(', ') };
  }

  parts.push(`max-age=${options.maxAge ?? 0}`);
  if (options.sMaxAge !== undefined) parts.push(`s-maxage=${options.sMaxAge}`);
  if (options.staleWhileRevalidate !== undefined) {
    parts.push(`stale-while-revalidate=${options.staleWhileRevalidate}`);
  }
  if (options.staleIfError !== undefined) parts.push(`stale-if-error=${options.staleIfError}`);
  if (options.immutable === true) parts.push('immutable');

  const headers: Record<string, string> = { 'Cache-Control': parts.join(', ') };
  const keys = serializeTags(options.tags ?? []);
  if (keys.length > 0) headers['Surrogate-Key'] = keys.join(' ');
  return headers;
}

export interface PurgeDriver {
  readonly name: string;
  /** Purge by surrogate key. Returns the keys the provider accepted. */
  purge(keys: readonly string[]): Promise<readonly string[]>;
  purgeAll(): Promise<void>;
}

/** Default: the CDN is optional infrastructure, so its absence must not fail a write. */
export function noopPurgeDriver(): PurgeDriver {
  return {
    name: 'noop',
    purge(keys) {
      return Promise.resolve(keys);
    },
    purgeAll() {
      return Promise.resolve();
    },
  };
}

export interface CdnTierOptions {
  readonly purge?: PurgeDriver;
  /**
   * Maps a cache key to the CDN path(s) it renders, for key-level purges. Those paths are
   * purged **as surrogate keys** — `PurgeDriver.purge` has one currency and this is it — so a
   * host using this must tag those responses with their own path.
   */
  readonly pathsForKey?: (key: string) => readonly string[];
}

export function createCdnTier(options: CdnTierOptions = {}): CacheTier {
  const driver = options.purge ?? noopPurgeDriver();

  return {
    name: 'cdn',

    get<T>(): Promise<CacheEntry<T> | undefined> {
      // The CDN is upstream of the origin; a read here would be a round trip to ourselves.
      return Promise.resolve(undefined);
    },

    set<T>(_key: string, _value: T, _options?: CacheSetOptions): Promise<void> {
      // Population happens by responding with `cacheHeaders()`, never by pushing.
      return Promise.resolve();
    },

    async del(key: string): Promise<void> {
      const paths = options.pathsForKey?.(key) ?? [];
      if (paths.length > 0) await driver.purge(paths);
    },

    /**
     * The tags themselves plus every `cdn-path` the graph hangs off them — one purge, one list.
     *
     * Those paths were computed by `invalidate.ts` and reported as busted while nothing ever
     * purged them, so `x cache bust --json` named a path the edge still held for its whole
     * `s-maxage`: a partial bust reading as a clean one, which is the one failure the report
     * exists to prevent. They go out **as surrogate keys**, the single currency `PurgeDriver`
     * has — the same convention `pathsForKey` already documents, so a host registering a
     * `cdn-path` dependent must tag that response with its own path.
     */
    async invalidateTags(tags: readonly CacheTag[]): Promise<TierInvalidation> {
      const keys = [...new Set([...serializeTags(tags), ...dependentsOfKind(tags, 'cdn-path')])];
      if (keys.length === 0) return { tier: 'cdn', keys: [] };
      const accepted = await driver.purge(keys);
      return { tier: 'cdn', keys: accepted };
    },
  };
}
