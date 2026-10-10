/**
 * The invariants of `revalidate`'s keys beyond "it has a trigger": `onInvalidate`, `maxStale` and
 * `query`, checked where `modes.ts` checks the trigger, and `tags` as purge keys, checked where
 * the registry knows the file. Each is a declaration the ISR controller acts on per request, so
 * one it cannot act on is refused up front, with the edit, rather than read as its permissive
 * default for the life of the process.
 */

import type { CacheTag } from '@ultimat3/cache';
import { serializeTag, surrogateKeys } from '@ultimat3/cache';
import { isUltimateError, renderCauseValue, renderFixLiteral } from '@ultimat3/core';
import { parseTtlMs } from './duration';
import { RouteModeInvalidError } from './errors';
import type { RevalidateConfig } from './route';
import { INVALIDATE_MODES } from './route';

/** The framework's own key dimensions ride in parameters spelled this way (`ISR_LOCALE_PARAM`). */
const RESERVED_QUERY_PREFIX = '__x_';

export function assertRevalidateShape(revalidate: RevalidateConfig): void {
  const { onInvalidate, maxStale, query } = revalidate;
  if (onInvalidate !== undefined && !INVALIDATE_MODES.includes(onInvalidate)) {
    throw new RouteModeInvalidError(
      `revalidate.onInvalidate: ${renderCauseValue(onInvalidate)} is not an invalidation mode`,
      `onInvalidate: '${INVALIDATE_MODES.join("' | '")}'`,
    );
  }
  if (onInvalidate === 'purge' && (revalidate.tags === undefined || revalidate.tags.length === 0)) {
    throw new RouteModeInvalidError(
      "revalidate.onInvalidate: 'purge' deletes a page when one of its tags is busted, but revalidate declares no tags",
      "revalidate: { tags: [tag.post], onInvalidate: 'purge' }   // or drop onInvalidate",
    );
  }
  if (maxStale !== undefined) {
    if (parseTtlMs(maxStale) === null) {
      throw new RouteModeInvalidError(
        `revalidate.maxStale: ${renderCauseValue(maxStale)} is not a duration`,
        "maxStale: '1h'   // '30s', '5m', '7d', or a positive number of milliseconds",
      );
    }
    // It is counted from the TTL's expiry, and a tag-only page has no clock to count from.
    if (parseTtlMs(revalidate.ttl) === null) {
      throw new RouteModeInvalidError(
        'revalidate.maxStale bounds how long past its ttl a page is served stale, but revalidate declares no ttl',
        "revalidate: { ttl: '10m', maxStale: '1h' }   // a tag-only page is bounded by onInvalidate: 'purge' instead",
      );
    }
  }
  if (query === undefined) return;
  if (!Array.isArray(query)) {
    throw new RouteModeInvalidError(
      `revalidate.query: ${renderCauseValue(query)} is not a list of parameter names`,
      "query: ['page']   // or [] for a page that varies on no parameter",
    );
  }
  for (const name of query) {
    if (typeof name !== 'string' || name === '') {
      throw new RouteModeInvalidError(
        `revalidate.query names ${renderCauseValue(name)}, which is not a query parameter name`,
        "query: ['page']   // each parameter the page varies on, as a non-empty string",
      );
    }
    if (name.startsWith(RESERVED_QUERY_PREFIX)) {
      throw new RouteModeInvalidError(
        `revalidate.query names ${renderCauseValue(name)}, and ${RESERVED_QUERY_PREFIX}* is the framework's own part of a stored page's key`,
        `query: ['page']   // rename it: a name starting with ${RESERVED_QUERY_PREFIX} is never the app's`,
      );
    }
  }
}

/**
 * A `revalidate.tags` entry goes out as a purge key on every response of the route
 * (`render-isr.ts`), so one a CDN would split is refused at registration, naming the file. Asked of
 * `@ultimat3/cache`'s own screen rather than restated: found at serve time it is a 500 on a
 * public page, found at purge time it is a document nothing can clear.
 */
export function assertPurgeableTags(file: string, tags: readonly CacheTag[] | undefined): void {
  for (const owned of tags ?? []) {
    try {
      surrogateKeys([owned], file);
    } catch (error) {
      if (!isUltimateError(error) || error.code !== 'X_CACHE_PURGE_FAILED') throw error;
      const wire = renderFixLiteral(serializeTag(owned), '<the tag>');
      throw new RouteModeInvalidError(
        `${file} declares revalidate tag ${wire}, which cannot be a CDN purge key — a key is split on whitespace and commas and capped at 1024 bytes, so every response of the route would carry one no purge can name`,
        `edit revalidate.tags in ${file}: replace ${wire} with a tag whose entity and id carry no whitespace or comma`,
      );
    }
  }
}
