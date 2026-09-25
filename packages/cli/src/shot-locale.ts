// Which locale a picture is of. `x shot` pins `Accept-Language` on every capture — to `--locale`
// when one is asked for and to the app's DEFAULT locale otherwise — so a screenshot never depends
// on the language of the machine's Chrome. A non-default locale is also a URL prefix (`/en/…`),
// because on a `site/` route the unprefixed path is always the default locale whatever the header.

import { join } from 'node:path'; // why: Bun ships no path join.
import { APP_CONFIG_EXPORT } from './app-auth';
import { APP_CONFIG_FILE } from './app-root';
import { BadFlagError } from './errors';

export interface ShotLocales {
  readonly locales: readonly string[];
  readonly defaultLocale: string;
}

/** An app that declares nothing is `en` only — the framework's own default. */
export const FALLBACK_SHOT_LOCALES: ShotLocales = { locales: ['en'], defaultLocale: 'en' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** `app.config.ts`'s `locales` and `defaultLocale`, read the way `loadThemeMode` reads `theme`. */
export async function loadShotLocales(root: string): Promise<ShotLocales> {
  const configPath = join(root, APP_CONFIG_FILE);
  if (!(await Bun.file(configPath).exists())) return FALLBACK_SHOT_LOCALES;
  const module = (await import(configPath)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  if (!isRecord(config)) return FALLBACK_SHOT_LOCALES;
  const declared = config['locales'];
  const locales = Array.isArray(declared)
    ? declared.filter((locale): locale is string => typeof locale === 'string')
    : [];
  const fallback = config['defaultLocale'];
  const defaultLocale =
    typeof fallback === 'string' && fallback !== '' ? fallback : (locales[0] ?? 'en');
  return {
    locales: locales.length === 0 ? [defaultLocale] : locales,
    defaultLocale,
  };
}

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
