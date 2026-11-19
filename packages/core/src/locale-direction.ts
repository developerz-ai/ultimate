// Text direction of a locale — a fact about the locale's script, and nothing about catalogs or
// requests. Import it from `@ultimat3/core`: i18n's re-export was deleted in 25.0.0.
//
// Tier 0 rather than `@ultimat3/i18n`'s because `@ultimat3/ui`'s provider reflects `dir` onto
// `<html>` from the locale it was handed, and reaching the i18n barrel for that one function put
// the whole framework catalog into every browser chunk with a `UiProvider` in it (issue #490).

export type Direction = 'ltr' | 'rtl';

/**
 * Languages whose usual script is right-to-left, by primary subtag: what a tag naming no script
 * falls back to. A static CLDR-derived set rather than `Intl.Locale.prototype.getTextInfo` so
 * direction is deterministic across runtimes. No `ku`: CLDR's likely script for it is Latin
 * (Kurmanji); Sorani is `ckb`, and Kurdish in Arabic script says so (`ku-Arab`).
 */
const RTL_LOCALES: ReadonlySet<string> = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'ks',
  'nqo',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);

/** ISO 15924 right-to-left scripts in living use, lower-cased. */
const RTL_SCRIPTS: ReadonlySet<string> = new Set([
  'adlm',
  'arab',
  'hebr',
  'mand',
  'nkoo',
  'rohg',
  'samr',
  'syrc',
  'thaa',
]);

/**
 * A script subtag is four letters in second place (BCP 47), and when a tag names one it decides:
 * `az-Arab` is rtl and `ks-Deva` ltr, whatever the language usually writes.
 */
export function isRtl(locale: string): boolean {
  const [primary = '', second = ''] = locale.toLowerCase().split('-');
  return /^[a-z]{4}$/.test(second) ? RTL_SCRIPTS.has(second) : RTL_LOCALES.has(primary);
}

export function directionOf(locale: string): Direction {
  return isRtl(locale) ? 'rtl' : 'ltr';
}
