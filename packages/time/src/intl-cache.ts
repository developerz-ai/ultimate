/**
 * One bounded cache for every `Intl` formatter this package builds.
 * A locale and a zone both arrive from a request header, so an unbounded `Map` keyed on that
 * string is memory the client chooses: 4,096 case-variants of one zone name retained 31 MB,
 * ~7.7 KB per `Intl.DateTimeFormat`, and 600 zones times 2^12 casings has no ceiling at all.
 */

/**
 * Above the full canonical IANA set (445 zones as of tzdata 2025) so a correct app never evicts,
 * and small enough that the worst case is a few megabytes rather than a leak. A miss costs one
 * `Intl` construction, never a wrong answer — which is what makes a bound safe here at all.
 */
export const MAX_CACHED_FORMATTERS = 512;

/** FIFO — a `Map` iterates in insertion order, so the first key inserted is the first evicted. */
export function cachedFormatter<T>(cache: Map<string, T>, key: string, build: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const formatter = build();
  if (cache.size >= MAX_CACHED_FORMATTERS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, formatter);
  return formatter;
}
