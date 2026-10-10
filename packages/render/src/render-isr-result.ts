/**
 * An `isr` entry as a response: its status, and the headers that tell a shared cache how long it
 * may keep the document and which keys purge it. Split from `render-isr.ts`, the controller.
 */

import { surrogateKeys } from '@ultimat3/cache';
import { logger } from '@ultimat3/core';
import { isRenderStatus } from './finite-status';
import type { IsrPolicy } from './render-isr-routes';
import type { IsrEntry } from './render-isr-store';
import { staticHeaders } from './render-static';
import type { RenderResult } from './route';

/** Tag-only routes have no clock of their own; a tag bust reaches the CDN through the fanout. */
const TAG_ONLY_S_MAX_AGE_SECONDS = 60;

/** What a shared cache may serve stale for when the route bounds nothing — a day, as before. */
const DEFAULT_STALE_WHILE_REVALIDATE_SECONDS = 86_400;

/**
 * `IsrStore` is a driver seam, so an entry can come back from an app's own store — one backed by
 * Redis round-trips it through JSON, where a `ttlMs` that was never written reads back as
 * `undefined` and `entry.ttlMs === null` is then false. Two failures follow from that one value
 * and neither raises: `now - generatedAt < NaN` is false, so the page is NEVER fresh and every
 * request regenerates it, and the CDN is handed `s-maxage=NaN` — an unparseable directive a
 * conforming cache IGNORES, dropping the page to heuristic caching rather than to the declared
 * age. Read on the request path, so it is TOTAL rather than a throw: a ttl that is not a positive
 * finite number of milliseconds is the tag-only `null` `parseTtlMs` would have answered for it.
 */
export function entryTtlMs(entry: IsrEntry): number | null {
  const ttlMs = entry.ttlMs;
  if (ttlMs === null || (Number.isFinite(ttlMs) && ttlMs > 0)) return ttlMs;
  logger.warn('isr.entry_ttl_invalid', { path: entry.path, ttlMs: String(ttlMs) });
  return null;
}

/**
 * The declared TTL is the route's own contract with the CDN: a shared cache must not hold the
 * page longer than the app said it stays true. A flat `s-maxage=60` made `revalidate: { ttl:
 * '5m' }` a lie in one direction and `ttl: '30s'` a lie in the other.
 *
 * `stale-while-revalidate` is the same contract for the copy PAST its age, so it follows the
 * route's own bound: none at all under `onInvalidate: 'purge'` (a document that must come down may
 * not be answered stale by the edge for a day after the origin deleted it), `maxStale` when one is
 * declared, a day otherwise.
 */
function cacheControl(ttlMs: number | null, policy: IsrPolicy): string {
  const sMaxAge = ttlMs === null ? TAG_ONLY_S_MAX_AGE_SECONDS : Math.round(ttlMs / 1_000);
  const base = `public, max-age=0, s-maxage=${sMaxAge}`;
  if (policy.onInvalidate === 'purge') return base;
  const stale =
    policy.maxStaleMs === null
      ? DEFAULT_STALE_WHILE_REVALIDATE_SECONDS
      : Math.round(policy.maxStaleMs / 1_000);
  return `${base}, stale-while-revalidate=${stale}`;
}

/**
 * `entryTtlMs`'s reason, one field over: a store may hand back an entry with no `status`, or one
 * that JSON turned into something else, on the request path. Absent is 200 — the only value any
 * entry carried before the field existed — and anything the range refuses is 200 with a warning,
 * because a stored number must not 500 the page for its whole TTL.
 */
function entryStatus(entry: IsrEntry): number {
  const status = entry.status;
  if (status === undefined) return 200;
  if (isRenderStatus(status)) return status;
  logger.warn('isr.entry_status_invalid', { path: entry.path, status: String(status) });
  return 200;
}

export interface IsrResultOptions {
  readonly buildId: string;
  readonly policy: IsrPolicy;
  readonly servedStale?: boolean;
  /**
   * False for a render the store did not keep — a 5xx, one whose `load` said `noStore()`, or one
   * invalidated while it rendered. It is then `private, no-store` with no purge key: an answer
   * nothing here kept must not be kept by the edge either, or one upstream blip is a 503 — and one
   * purge raced by a render is the withdrawn page — for the route's whole `s-maxage`.
   */
  readonly cacheable?: boolean;
}

export function isrResult(entry: IsrEntry, options: IsrResultOptions): RenderResult {
  const { buildId, policy } = options;
  // The store keys on the locale; a shared cache in front of it has to as well, or the CDN
  // repeats the bug this entry was split to fix. `ssrHeaders`' own line, for the same reason.
  // The rest of the shared key — the cookie, the zone — is added by `@ultimat3/http`'s
  // `cache-headers` stage, which sees the actor this function cannot.
  const vary = 'accept-language';
  if (options.cacheable === false) {
    const { etag: _etag, ...rest } = staticHeaders(entry.hash, buildId);
    return {
      status: entryStatus(entry),
      headers: { ...rest, 'cache-control': 'private, no-store', vary },
      body: entry.html,
    };
  }
  const headers: Record<string, string> = {
    ...staticHeaders(entry.hash, buildId),
    'cache-control': cacheControl(entryTtlMs(entry), policy),
    vary,
  };
  // The keys an edge purges this document by — `@ultimat3/cache`'s list, never a second one, so
  // what a bust sends and what the page carries cannot drift. Absent, an `invalidates` cleared
  // every tier but the CDN, which held the document for its whole `s-maxage`. The tags were
  // screened when the route registered (`registry.ts`), so this cannot refuse on the request path.
  const keys = surrogateKeys(policy.tags, 'isr');
  if (keys.length > 0) {
    headers['surrogate-key'] = keys.join(' ');
    headers['cache-tag'] = keys.join(',');
  }
  if (options.servedStale === true) headers['x-ultimate-isr'] = 'stale';
  return { status: entryStatus(entry), headers, body: entry.html };
}
