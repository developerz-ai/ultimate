/**
 * Resolve the request locale once, then read it from the ALS context.
 * No call site passes a locale by hand — `t()` here is the ambient translator.
 */

import { tryUseContext } from '@ultimat3/core';
import { type Catalog, mergeCatalogs } from './catalog';
import {
  DEFAULT_LOCALE,
  type Direction,
  directionOf,
  type Locale,
  negotiateLocale,
  normalizeLocale,
  SUPPORTED_LOCALES,
} from './locales';
import { createTranslator, type TranslateVars, type Translator } from './translator';

/** The cookie an explicit language switcher writes. */
export const LOCALE_COOKIE = 'x_locale';

/**
 * Every source is `string | null | undefined`. Not decoration: `exactOptionalPropertyTypes` is on,
 * so `?: string | null` refuses an EXPLICIT `undefined` — and `localeCookieOf`, this file's own
 * cookie reader, answers `string | undefined`, so `resolveLocale({ cookie: localeCookieOf(h) })`
 * (the composition the package exists to offer) did not typecheck. `resolveLocale` has skipped
 * `undefined` since it was written; only the declaration disagreed.
 */
export interface LocaleSources {
  /** Raw `Accept-Language` header value. */
  header?: string | null | undefined;
  /** Value of the `x_locale` cookie, already URL-decoded. */
  cookie?: string | null | undefined;
  /** `user.locale` from the authenticated user record. */
  user?: string | null | undefined;
  /** `?locale=es` — mobile and email preview links pass it per request. */
  query?: string | null | undefined;
}

export type LocaleSourceName = keyof LocaleSources;

export interface LocaleResolution {
  locale: Locale;
  direction: Direction;
  /** Which source won — surfaced in the request log so a wrong locale is debuggable. */
  source: LocaleSourceName | 'default';
}

export interface LocaleConfig {
  supported: readonly Locale[];
  fallback: Locale;
  /** Precedence, highest first. */
  order: readonly LocaleSourceName[];
}

/**
 * Explicit before inferred, always. `Accept-Language` is what the browser was installed as; the
 * query, the cookie and the user row are what a person *chose*. Ranking the header first meant a
 * language switcher wrote a cookie that never won again — and `@ultimat3/http`'s negotiator, which
 * takes the explicit value ahead of the header, disagreed with this one about the same request.
 */
const DEFAULT_ORDER: readonly LocaleSourceName[] = ['query', 'cookie', 'user', 'header'];

/** Hoisted so `resetLocaleConfig` has one value to name, rather than a second literal to drift. */
const DEFAULT_LOCALE_CONFIG: LocaleConfig = {
  supported: SUPPORTED_LOCALES,
  fallback: DEFAULT_LOCALE,
  order: DEFAULT_ORDER,
};

/**
 * A fresh object AND fresh arrays, every time. Handing out `DEFAULT_LOCALE_CONFIG` itself made the
 * live config the shipped default, so one caller writing through `localeConfig()` corrupted the
 * value `resetLocaleConfig()` restores FROM — and the reset replayed the corruption for the rest of
 * the process. `readonly` in the type stops a compiler, not a caller, and this seam exists because
 * callers do what the types did not expect.
 */
function freshDefaultConfig(): LocaleConfig {
  return {
    supported: [...DEFAULT_LOCALE_CONFIG.supported],
    fallback: DEFAULT_LOCALE_CONFIG.fallback,
    order: [...DEFAULT_LOCALE_CONFIG.order],
  };
}

let config: LocaleConfig = freshDefaultConfig();

/** Called once at boot from `app.config.ts`. */
export function configureLocales(partial: Partial<LocaleConfig>): LocaleConfig {
  config = { ...config, ...partial };
  return config;
}

export function localeConfig(): LocaleConfig {
  return config;
}

/**
 * Query → cookie → user record → header → default, per `config.order`.
 * An unsupported tag is skipped rather than thrown: a stale cookie must not 500 a page.
 */
export function resolveLocale(
  sources: LocaleSources,
  overrides: Partial<LocaleConfig> = {},
): LocaleResolution {
  const { supported, fallback, order } = { ...config, ...overrides };
  for (const name of order) {
    const raw = sources[name];
    if (raw === undefined || raw === null || raw === '') continue;
    const candidate =
      name === 'header' ? negotiateLocale(raw, supported, '') : normalizeLocale(raw, supported, '');
    if (candidate !== '') {
      return { locale: candidate, direction: directionOf(candidate), source: name };
    }
  }
  return { locale: fallback, direction: directionOf(fallback), source: 'default' };
}

/** Read `x_locale` out of a raw `Cookie` header. */
export function localeCookieOf(cookieHeader?: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(';')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() !== LOCALE_COOKIE) continue;
    const raw = pair.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A cookie is client-authored: `x_locale=%` is a `URIError` out of a per-request path, and
      // a 500 for a malformed locale is worse than the raw value, which `resolveLocale` then
      // fails to normalise and skips. Same guard as `@ultimat3/auth`'s `decodeCookieValue`.
      return raw;
    }
  }
  return undefined;
}

/**
 * Ambient locale for the in-flight request; the configured fallback outside one.
 *
 * The store is **`Ctx.locale`**, core's own declared field, so `createContext({ locale })` and
 * `withChildContext({ locale })` are the only writers and this package publishes no second one.
 * `@ultimat3/time`'s `currentTimeZone()` is the same shape over `Ctx.tz`, deliberately.
 */
export function currentLocale(): Locale {
  const locale = tryUseContext()?.locale;
  if (locale === undefined || locale === '') return config.fallback;
  // Normalised HERE, the same call `resolveLocale` makes for every source it reads. `Ctx.locale`
  // is a plain string core never validates, and every distinct one it holds bought a PERMANENT
  // `Translator` in `translators` plus a permanent `Intl.PluralRules` in `interpolate`'s
  // `rulesCache` — two unbounded module-level maps keyed by whatever a request carried.
  return normalizeLocale(locale, config.supported, config.fallback);
}

export function currentDirection(): Direction {
  return directionOf(currentLocale());
}

const registry = new Map<Locale, Catalog>();
const translators = new Map<Locale, Translator>();

/**
 * Register a locale's catalog. Called with the framework catalog first and the app
 * catalog second so app strings override framework strings for the same key.
 */
export function registerCatalog(locale: Locale, catalog: Catalog): void {
  const existing = registry.get(locale);
  registry.set(locale, existing === undefined ? catalog : mergeCatalogs(existing, catalog));
  translators.delete(locale);
}

/**
 * Whether this locale has a catalog at all. Distinct from `catalogFor`, which answers `{}` for
 * "registered but empty" and for "never registered" alike — `registerFrameworkCatalog` needs to
 * tell those apart to stay idempotent.
 */
export function hasCatalog(locale: Locale): boolean {
  return registry.has(locale);
}

export function registeredLocales(): Locale[] {
  return [...registry.keys()].sort();
}

export function catalogFor(locale: Locale): Catalog {
  return registry.get(locale) ?? {};
}

/**
 * Memoized per locale — building a translator per render is pure waste.
 * `TCatalog` narrows the key type only; the runtime catalog is whatever is registered.
 */
export function translatorFor<TCatalog = Catalog>(locale: Locale): Translator<TCatalog> {
  let translator = translators.get(locale);
  if (translator === undefined) {
    translator = createTranslator(catalogFor(locale), locale);
    translators.set(locale, translator);
  }
  // One cast, one place. `TCatalog` narrows the key parameter and nothing else, so the memoized
  // object already is the right value — the registry cannot be keyed by an app's catalog type.
  return translator as unknown as Translator<TCatalog>;
}

/** The ambient translator for the in-flight request. Pass the app's catalog type to get typed keys. */
export function useI18n<TCatalog = Catalog>(): Translator<TCatalog> {
  return translatorFor<TCatalog>(currentLocale());
}

/** The ambient `t` — what framework and app code calls. Never takes a locale. */
export function t(key: string, vars?: TranslateVars): string {
  return useI18n()(key, vars);
}

/**
 * Test/CLI seam: back to the shipped supported set, fallback and precedence.
 *
 * `defineCatalogs()` calls `configureLocales()` at an APP's module scope, and a module evaluates
 * once per `bun test` process — so one file that loads an app narrows `supported` for every file
 * after it, and `Accept-Language: de-DE` negotiates `en` in a file that never mentioned locales.
 * `configureLocales` MERGES, so no partial call can widen the set back; only a value the framework
 * owns can, which is why this is a reset and not a documented "remember to restore it".
 */
export function resetLocaleConfig(): void {
  config = freshDefaultConfig();
}

/** Test/CLI seam: drop every registered catalog. */
export function resetCatalogs(): void {
  registry.clear();
  translators.clear();
}
