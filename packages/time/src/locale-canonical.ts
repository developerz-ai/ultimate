/**
 * One locale, one key. `Intl` accepts `EN-us`, `en-US` and `en-latn-us` as the same locale, so a
 * cache keyed on the caller's spelling holds three formatters where one would do — and the caller
 * is `Accept-Language`. The twin of `zone-canonical.ts`, for the other header-supplied string.
 */

/**
 * The canonical BCP 47 spelling, or `undefined` when the tag is not structurally valid at all
 * (`en_US`, `''`, `not a locale`). Well-formed but unknown to ICU (`zz`) is a locale — `Intl`
 * falls back for it, and refusing here would be stricter than the formatters this feeds.
 *
 * Deliberately **not** memoised: this is string work, and a `Map` keyed on a header value is the
 * unbounded cache the whole `intl-cache.ts` bound exists to prevent.
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
