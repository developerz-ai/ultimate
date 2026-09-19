// Text direction of a locale — a fact about the locale's script, and nothing about catalogs or
// requests, which is why it is tier 0 rather than `@ultimat3/i18n`'s: `@ultimat3/ui`'s provider
// reflects `dir` onto `<html>` from the locale it was handed, and reaching the i18n barrel for
// that one function put the whole framework catalog into every browser chunk with a `UiProvider`
// in it (issue #490). i18n re-exports these under the same names, so no caller moved.

export type Direction = 'ltr' | 'rtl';

/**
 * Right-to-left scripts, by primary subtag. A static CLDR-derived set rather than
 * `Intl.Locale.prototype.getTextInfo` so direction is deterministic across runtimes.
 */
const RTL_LOCALES: ReadonlySet<string> = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'ks',
  'ku',
  'nqo',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);

export function isRtl(locale: string): boolean {
  const primary = locale.split('-')[0]?.toLowerCase() ?? '';
  return RTL_LOCALES.has(primary);
}

export function directionOf(locale: string): Direction {
  return isRtl(locale) ? 'rtl' : 'ltr';
}
