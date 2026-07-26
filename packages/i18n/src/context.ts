/**
 * Resolve the request locale once, then read it from the ALS context.
 * No call site passes a locale by hand — `t()` here is the ambient translator.
 */

import { type Ctx, useContext } from '@ultimat3/core';
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

/** Field name on the ALS context. Core owns `Ctx`; it stays a plain string there. */
const CTX_LOCALE = 'locale';

export interface LocaleSources {
  /** Raw `Accept-Language` header value. */
  header?: string | null;
  /** Value of the `x_locale` cookie, already URL-decoded. */
  cookie?: string | null;
  /** `user.locale` from the authenticated user record. */
  user?: string | null;
  /** `?locale=es` — mobile and email preview links pass it per request. */
  query?: string | null;
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

const DEFAULT_ORDER: readonly LocaleSourceName[] = ['header', 'cookie', 'user', 'query'];

let config: LocaleConfig = {
  supported: SUPPORTED_LOCALES,
  fallback: DEFAULT_LOCALE,
  order: DEFAULT_ORDER,
};

/** Called once at boot from `app.config.ts`. */
export function configureLocales(partial: Partial<LocaleConfig>): LocaleConfig {
  config = { ...config, ...partial };
  return config;
}

export function localeConfig(): LocaleConfig {
  return config;
}

/**
 * Header → cookie → user record → query → default, per `config.order`.
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
    return decodeURIComponent(pair.slice(index + 1).trim());
  }
  return undefined;
}

/** The HTTP layer calls this once per request, before any render. */
export function attachLocale(ctx: Ctx, locale: Locale): Locale {
  writeContextField(ctx, CTX_LOCALE, locale);
  return locale;
}

export function localeOf(ctx: Ctx): Locale {
  return readField(ctx, CTX_LOCALE) ?? config.fallback;
}

/** Ambient locale for the in-flight request; the configured fallback outside one. */
export function currentLocale(): Locale {
  const ctx = tryContext();
  return (ctx === undefined ? undefined : readField(ctx, CTX_LOCALE)) ?? config.fallback;
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

export function registeredLocales(): Locale[] {
  return [...registry.keys()].sort();
}

export function catalogFor(locale: Locale): Catalog {
  return registry.get(locale) ?? {};
}

/** Memoized per locale — building a translator per render is pure waste. */
export function translatorFor(locale: Locale): Translator {
  const cached = translators.get(locale);
  if (cached !== undefined) return cached;
  const translator = createTranslator(catalogFor(locale), locale);
  translators.set(locale, translator);
  return translator;
}

export function currentTranslator(): Translator {
  return translatorFor(currentLocale());
}

/** The ambient `t` — what framework and app code calls. Never takes a locale. */
export function t(key: string, vars?: TranslateVars): string {
  return currentTranslator()(key, vars);
}

/** Test/CLI seam: drop every registered catalog. */
export function resetCatalogs(): void {
  registry.clear();
  translators.clear();
}

function tryContext(): Ctx | undefined {
  try {
    return useContext();
  } catch {
    // Outside a request scope (boot, a CLI command, a worker tick) — no ambient locale.
    return undefined;
  }
}

/**
 * `Ctx` is owned by core (tier 0) and cannot reference i18n's `Locale`, so the field is
 * read structurally. One place, one cast, validated on the way out.
 */
function readField(ctx: Ctx, field: string): string | undefined {
  const value = (ctx as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function writeContextField(ctx: Ctx, field: string, value: string): void {
  (ctx as unknown as Record<string, unknown>)[field] = value;
}
