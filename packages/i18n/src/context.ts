/**
 * Resolve the request locale once, then read it from the ALS context.
 * No call site passes a locale by hand — `t()` here is the ambient translator.
 */

import { assertLocale, cachedFormatter, canonicalLocale, tryUseContext } from '@ultimat3/core';
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

/**
 * Called once at boot from `app.config.ts`.
 *
 * Screened before it is stored, and this is the ONE screen the locale path needs: `resolveLocale`
 * can only ever answer with a member of `supported` or the fallback — every other candidate
 * normalises away — so a tag the APP declares is the only route by which a string `Intl` cannot
 * parse reaches `ctx.locale`, and from there `formatDate`, `formatMoney` and `Intl.PluralRules`
 * one request at a time, several frames from the config line that caused it. Refused whole: a
 * rejected call leaves the previous config in place rather than half of a new one.
 */
export function configureLocales(partial: Partial<LocaleConfig>): LocaleConfig {
  for (const tag of partial.supported ?? []) assertLocale(tag);
  if (partial.fallback !== undefined) assertLocale(partial.fallback);
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
  // is a plain string core never validates, so this is the step that keeps a request's own
  // spelling out of the catalog lookup entirely. `translators` and `interpolate`'s `rulesCache`
  // are bounded now and no longer grow with it — but a bound EVICTS, and an ambient locale an app
  // never registered would still answer every key with a loud miss.
  return normalizeLocale(locale, config.supported, config.fallback);
}

export function currentDirection(): Direction {
  return directionOf(currentLocale());
}

const registry = new Map<Locale, Catalog>();
const translators = new Map<string, Translator>();

/**
 * The one key every unregistered tag that is not a locale at all shares. A `Symbol` cannot be a
 * `Map<string, …>` key and a NUL cannot appear in a structurally valid tag, so nothing a caller
 * sends can collide with it.
 */
const INVALID_LOCALE_KEY = '\u0000invalid';

/**
 * The one key `translatorFor` caches under and every registration evicts by.
 *
 * `translatorFor` is exported raw and `packages/mail/src/render.ts` hands it a value nothing
 * normalised, so this map was keyed on whatever spelling a request carried — permanently, and
 * `en-us` and `en-US` bought two `Translator`s for one locale. Canonicalising is what makes
 * `cachedFormatter`'s bound a bound on LOCALES rather than on spellings; lowercasing is what keeps
 * the key equal to the one an app registered (`zh-hant`, never ICU's `zh-Hant`), so a later
 * `registerCatalog` still drops the entry a request built.
 *
 * A tag `canonicalLocale` refuses (`en_US`, `''`, `not a locale`) is not a spelling of anything, so
 * it collapses onto ONE key rather than keying on itself: a bound that a request value can key into
 * counts junk against the cap and evicts locales that are real. Registered spellings are the
 * exception and key on themselves — an app that registered a tag ICU will not canonicalise must
 * still be handed its own catalog, and `registerCatalog` stores before it evicts, so both sides of
 * that decision read the same registry.
 */
function translatorKey(locale: Locale): string {
  const canonical = canonicalLocale(locale);
  if (canonical !== undefined) return canonical.toLowerCase();
  return registry.has(locale) ? locale.toLowerCase() : INVALID_LOCALE_KEY;
}

/**
 * The registered spelling `key` stands for, or `undefined` when no catalog was registered for it.
 *
 * The caller's own spelling wins when it was registered, so an app that registered `en` keeps
 * answering `en`. Otherwise the registry is read through the SAME canonical key the cache is
 * keyed by: `registerCatalog('en-US', …)` followed by `translatorFor('en-us')` matched neither
 * `registry.has(locale)` nor `catalogFor(key)`, so it cached an EMPTY translator under `en-us` —
 * and the later `translatorFor('en-US')` was served that same empty translator from the cache.
 * Which of the two spellings a request carried first decided whether the app's strings rendered.
 */
function registeredUnder(locale: Locale, key: string): Locale | undefined {
  if (registry.has(locale)) return locale;
  for (const registered of registry.keys()) {
    if (translatorKey(registered) === key) return registered;
  }
  return undefined;
}

/**
 * The layer under every app catalog: strings this framework ships and no app can be asked to
 * register. `framework.ts` installs its own at module scope, so importing `@ultimat3/i18n` at all
 * is what puts `errors.*`, `auth.*` and `ui.*` in the registry — an app that never reaches
 * `defineCatalogs()` still renders a 404 page in words, not in `⟦errors.notFound.title⟧`.
 * Kept apart from `registry` for one reason: `resetCatalogs()` must be able to drop everything an
 * app registered WITHOUT dropping strings the framework itself renders.
 */
const base = new Map<Locale, Catalog>();

/**
 * Install a base layer. **Framework packages only** — a package whose own templates render strings
 * an app never registers (`@ultimat3/mail`'s `mail.*`) calls this at module scope, so importing it
 * is what installs them. An app has exactly one registration call, `defineCatalogs`, and this is
 * not a second one: everything installed here loses to `registerCatalog` on the same key, so the
 * strongest thing an app could achieve by calling it is strings that its own catalog overrides.
 *
 * More than one framework contributor is merged into the base itself rather than fighting over the
 * locale, so a package whose strings arrive later cannot displace `framework.ts`'s.
 */
export function registerBaseCatalog(locale: Locale, catalog: Catalog): void {
  const existing = base.get(locale);
  base.set(locale, existing === undefined ? catalog : mergeCatalogs(existing, catalog));
  installBase();
}

/**
 * Base UNDER app, never over it — `mergeCatalogs` takes the later argument, so the registered
 * catalog goes second and an app's override of `errors.notFound.title` survives every install.
 * Merging rather than skipping an occupied locale is what makes this order-independent: a base
 * registered after an app's `defineCatalogs()` still lands, and a repeat is a no-op because the
 * app's value already won the same key.
 */
function installBase(): void {
  for (const [locale, catalog] of base) {
    const existing = registry.get(locale);
    registry.set(locale, existing === undefined ? catalog : mergeCatalogs(catalog, existing));
    translators.delete(translatorKey(locale));
  }
}

/**
 * Register a locale's catalog. App strings arrive here and override the base layer for the same
 * key, because the merge takes the argument last.
 */
export function registerCatalog(locale: Locale, catalog: Catalog): void {
  const existing = registry.get(locale);
  registry.set(locale, existing === undefined ? catalog : mergeCatalogs(existing, catalog));
  translators.delete(translatorKey(locale));
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
  const key = translatorKey(locale);
  // Resolved BEFORE the memo, so what lands under `key` is the catalog that key stands for and
  // not whichever spelling asked first. The caller's own tag reaches `createTranslator` either
  // way — the catalog is chosen by locale, the formatting by what the caller actually sent.
  const translator = cachedFormatter(translators, key, () =>
    createTranslator(catalogFor(registeredUnder(locale, key) ?? locale), locale),
  );
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

/**
 * Test/CLI seam: drop every catalog an APP registered, and put the base layer back.
 *
 * Not a full clear: the framework's own strings are installed by importing this package, once per
 * process, so a clear that took them out could never restore them — every test after the first
 * reset rendered `⟦errors.notFound.title⟧` for a string no app owns.
 */
export function resetCatalogs(): void {
  registry.clear();
  translators.clear();
  installBase();
}
