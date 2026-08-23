// Single responsibility: the one place a caller-supplied BCP 47 tag is screened before it reaches
// an `Intl` constructor. One question, one answer (axiom 1) — `cron-describe.ts` refused a
// malformed tag from the start while seven sibling formatters handed the raw string to `Intl` and
// let a bare, uncoded `RangeError` escape several frames from the header it came out of.

import { canonicalLocale } from '@ultimat3/core';
import { localeInvalid } from './errors';

/**
 * The canonical spelling of a well-formed tag, or `X_LOCALE_INVALID`.
 *
 * Validating and keying are one step: `Intl.getCanonicalLocales` runs exactly the structural check
 * `Intl.DateTimeFormat.supportedLocalesOf` throws on — which is what `localeInvalid`'s `fix:` tells
 * the caller to run — and unlike it hands back the spelling every formatter cache keys on, so
 * `EN-us` and `en-US` cannot mint two entries for one locale.
 *
 * Well-formed but unknown to this runtime's ICU (`zz`) is NOT refused: `Intl` falls back for those,
 * and a user carrying a locale the runtime has no data for must still get a rendered page.
 */
export function assertLocale(locale: string): string {
  const tag = canonicalLocale(locale);
  if (tag === undefined) throw localeInvalid(locale);
  return tag;
}
