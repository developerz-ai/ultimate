// Which locale a picture is of. `x shot` pins `Accept-Language` on every capture — to `--locale`
// when one is asked for and to the app's DEFAULT locale otherwise — so a screenshot never depends
// on the language of the machine's Chrome. A non-default locale is also a URL prefix (`/en/…`),
// because on a `site/` route the unprefixed path is always the default locale whatever the header.

import type { AppLocaleSet } from '@ultimat3/i18n/app-catalogs';
import { BadFlagError } from './errors';

/**
 * `@ultimat3/i18n/app-catalogs`'s `appLocaleSet(root)` — the one reader, and its one answer for an
 * app that declares nothing (`UNDECLARED_LOCALES`, the framework default alone).
 */
export type ShotLocales = AppLocaleSet;

/** `--locale <l>`, refused by name when the app does not declare it — a typo costs no browser. */
export function readLocaleFlag(value: string | undefined, app: ShotLocales): string | undefined {
  if (value === undefined) return undefined;
  if (app.locales.includes(value)) return value;
  throw new BadFlagError({
    flag: 'locale',
    command: 'shot',
    reason: `"${value}" is not one of the app's locales (${app.locales.join(', ')})`,
    fix: `x shot / --locale ${app.defaultLocale} --json`,
  });
}

/**
 * The path a visitor in `locale` opens: unchanged for the default locale, `/<locale>/…` for any
 * other. The root keeps its trailing slash (`/en/`), which is the directory a static export writes
 * the prefixed home page to.
 */
export function localizedShotPath(route: string, locale: string, defaultLocale: string): string {
  if (locale === defaultLocale) return route;
  return route === '/' ? `/${locale}/` : `/${locale}${route}`;
}

/** The header every capture sends. One key, lower-case, as CDP forwards it verbatim. */
export const acceptLanguageHeaders = (locale: string): Readonly<Record<string, string>> => ({
  'accept-language': locale,
});
