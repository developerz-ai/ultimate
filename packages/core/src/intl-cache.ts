// One bounded cache, on one canonical key, for every `Intl` formatter the framework builds.
// A locale and a zone both arrive from a request header, so an unbounded `Map` keyed on the
// caller's spelling is memory the client chooses — 31 MB and 55.1 MB, measured `As of 2026-08` and
// written up in the README. The bound and the canonical key are two halves of ONE rule.

/**
 * Above the full canonical IANA set (445 zones as of tzdata 2025) so a correct app never evicts,
 * and small enough that the worst case is a few megabytes rather than a leak. A miss costs one
 * `Intl` construction, never a wrong answer — which is what makes a bound safe here at all.
 */
export const MAX_CACHED_FORMATTERS = 512;

/** FIFO — a `Map` iterates in insertion order, so the first key inserted is the first evicted. */
export function cachedFormatter<T>(cache: Map<string, T>, key: string, build: () => T): T {
  // Membership decides, never truthiness: `T` is the caller's, so a stored `undefined` is a hit.
  // The cast is sound because `has` just proved the key is present, which `get`'s signature cannot.
  if (cache.has(key)) return cache.get(key) as T;
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
