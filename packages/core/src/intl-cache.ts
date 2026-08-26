// One bounded cache, on one canonical key, and one screen, for every `Intl` formatter the
// framework builds.
// A locale and a zone both arrive from a request header, so an unbounded `Map` keyed on the
// caller's spelling is memory the client chooses — 31 MB and 55.1 MB, measured `As of 2026-08` and
// written up in the README. The bound and the canonical key are two halves of ONE rule.

import { UltimateError } from './errors';

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

/**
 * A tag `Intl` cannot parse. Distinct from `@ultimat3/i18n`'s `X_LOCALE_UNSUPPORTED`, which is a
 * well-formed tag outside the app's supported set — this one is not a tag at all, and a raw
 * `RangeError` out of a formatter says nothing about which caller supplied it.
 */
export function localeInvalid(locale: string): UltimateError {
  return new UltimateError({
    code: 'X_LOCALE_INVALID',
    cause: `"${locale}" is not a well-formed BCP 47 language tag`,
    fix: "pass a tag like 'en', 'en-GB' or 'de-DE' — screen a header-supplied value with Intl.DateTimeFormat.supportedLocalesOf([tag]) before it reaches a formatter",
  });
}

/**
 * The canonical spelling of a well-formed tag, or `X_LOCALE_INVALID`. The ONE screen a
 * caller-supplied BCP 47 tag passes before it reaches an `Intl` constructor.
 *
 * Validating and keying are one step, which is why this lives beside the cache rather than in
 * either caller: `getCanonicalLocales` runs exactly the structural check
 * `Intl.DateTimeFormat.supportedLocalesOf` throws on — what the `fix:` above tells the caller to
 * run — and unlike it hands back the spelling every formatter cache keys on, so `EN-us` and
 * `en-US` cannot mint two entries for one locale.
 *
 * It is tier 0 for the reason `cachedFormatter` is: `@ultimat3/time` and `@ultimat3/money` both
 * need it and `money -> time` is a sideways import `bun run boundaries` refuses. Money was the
 * last package still letting the tag through — a `RangeError` off an `Accept-Language` header —
 * on the argument that this seam "decides a cache key, never whether a locale is acceptable",
 * which is true of the cache and was never an argument for passing the tag on.
 *
 * Well-formed but unknown to this runtime's ICU (`zz`) is NOT refused: `Intl` falls back for
 * those, and a user carrying a locale the runtime has no data for must still get a rendered page.
 */
export function assertLocale(locale: string): string {
  const tag = canonicalLocale(locale);
  if (tag === undefined) throw localeInvalid(locale);
  return tag;
}
