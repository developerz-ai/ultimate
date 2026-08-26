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
 * The cap on the tag an `X_LOCALE_INVALID` cause quotes back, in code points.
 *
 * 35 is RFC 5646 §4.4.1's own number — Figure 7 derives it as the longest tag the registry can
 * form (language 8 + script 5 + region 4 + two variants 9+9), and the same section says a protocol
 * with a fixed buffer "MUST allow for language tags of at least 35 characters". So every tag a
 * caller could legitimately have meant fits, and nothing longer is a tag being debugged.
 */
export const MAX_LOCALE_EXCERPT = 35;

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
    cause: `${localeExcerpt(locale)} is not a well-formed BCP 47 language tag`,
    fix: "pass a tag like 'en', 'en-GB' or 'de-DE' — screen a header-supplied value with Intl.DateTimeFormat.supportedLocalesOf([tag]) before it reaches a formatter",
    // The raw tag, under a NAME. A `cause` is copied into the 400 body and into the log line by
    // `@ultimat3/http`'s `toProblem`, and a logger redacts by key — so a caller's value spliced
    // into prose has no key left to redact, which is the whole argument `describeValue` rests on.
    // `meta` is the key, and it is machine-read, so it carries the value WHOLE: an excerpt here
    // would be a value a redactor or a bug report reads as complete when it is not.
    meta: { locale },
  });
}

/**
 * The tag as a reader can act on it: the first `MAX_LOCALE_EXCERPT` code points, quoted, and SAID
 * to be cut when there were more.
 *
 * `describeValue` is the usual answer for a caller-supplied value in a `cause` and it is the wrong
 * one here — it renders `en_US` as "a 5-character string", deleting the only actionable content in
 * a sentence whose entire job is to say WHICH tag was refused. Bounding it keeps the diagnostic and
 * removes the part a stranger chooses: without a cap the whole of an `Accept-Language` value —
 * megabytes, at the caller's option — became the error's `message`, its 400 body and its log line.
 *
 * Code points, never `slice`: cutting between a surrogate pair leaves a lone surrogate, which is
 * not text and survives no encoder between here and the log index. The string iterator is lazy, so
 * a megabyte tag costs 35 steps rather than a megabyte-long array.
 *
 * No escaping here: `UltimateError`'s constructor runs `singleLine` over every line-bearing field
 * exactly once, which is what keeps a newline in a tag from writing a second line an operator reads
 * as a genuine framework message. A second pass at this call site would be a second place that has
 * to be right.
 */
function localeExcerpt(locale: string): string {
  let head = '';
  let taken = 0;
  for (const char of locale) {
    if (taken === MAX_LOCALE_EXCERPT) return `"${head}" (truncated at ${taken} characters)`;
    head += char;
    taken += 1;
  }
  return `"${head}"`;
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
