/**
 * A locale in the URL, against the APP's configured locales: how a leading `/<locale>/` segment is
 * split off a pathname, and how a path is spelled in a locale. The arithmetic is core's
 * (`locale-path.ts`, tier 0 so a browser chunk can spell a link without this barrel); this file
 * supplies the routed locales and the default, so `@ultimat3/http` routes, `@ultimat3/render` hands
 * `meta` and the prerender writes files from one answer.
 */

import { type LocalePathSplit, localeSegment, localizePath, splitLocalePath } from '@ultimat3/core';
import { localeConfig, routedLocales } from './context';
import type { Locale } from './locales';

export { localeSegment };
export type LocalePrefix = LocalePathSplit;

/** `/en/precios` → `{ locale: 'en', path: '/precios', isDefault: false }`, or `undefined`. */
export function splitLocalePrefix(
  pathname: string,
  locales: readonly Locale[] = routedLocales(),
  fallback: Locale = localeConfig().fallback,
): LocalePrefix | undefined {
  return splitLocalePath(pathname, locales, fallback);
}

/** `path` as `locale` spells it — unprefixed for the default locale, `/en/…` otherwise. */
export function localizedPath(
  path: string,
  locale: Locale,
  fallback: Locale = localeConfig().fallback,
): string {
  return localizePath(path, locale, routedLocales(), fallback);
}

/** The pathname with any routed locale prefix removed — the path the route table matches. */
export function unlocalizedPath(pathname: string): string {
  return splitLocalePrefix(pathname)?.path ?? pathname;
}
