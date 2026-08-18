/**
 * One bounded cache, on one canonical key, for every `Intl` formatter the framework builds.
 * A locale and a zone both arrive from a request header, so an unbounded `Map` keyed on the
 * caller's spelling is memory the client chooses: 4,096 case-variants of one zone name retained
 * 31 MB, and 20,000 valid `en-US-x-*` tags through `formatMoney` retained 55 MB of RSS.
 * The bound and the canonical key are two halves of ONE rule and neither is sufficient alone.
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

/**
 * The canonical BCP 47 spelling, or `undefined` when the tag is not structurally valid at all
 * (`en_US`, `''`, `not a locale`). Well-formed but unknown to ICU (`zz`) is a locale — `Intl`
 * falls back for it, and refusing here would be stricter than the formatters this feeds.
 *
 * Deliberately **not** memoised: this is string work, and a `Map` keyed on a header value is the
 * unbounded cache the bound above exists to prevent.
 */
export function canonicalLocale(locale: string): string | undefined {
  try {
    // `getCanonicalLocales` runs the same IsStructurallyValidLanguageTag check that
    // `supportedLocalesOf` throws on, and unlike it, hands back the canonical spelling.
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}
