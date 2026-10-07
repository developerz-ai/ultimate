// The ONE reader of an app's declared locales: its catalog module's `defineCatalogs()`, imported
// and read back. The CLI (manifest, worker, prerender, `x shot`, `x g`, `x i18n`) and the e2e
// preload each kept a copy, and the copies disagreed. Server-only, so its own entry
// (`@ultimat3/i18n/app-catalogs`): `index.ts` is in every island.

// why: Bun exposes no path-join primitive; the catalog module is joined to the app root.
import { join } from 'node:path';
import { DEFAULT_LOCALE } from '@ultimat3/core';
import { localeConfig, routedLocales } from './context';
import type { CatalogSet, CatalogSources } from './define-catalogs';
import { catalogDeclarationCount, isDeclaredCatalogSet } from './define-catalogs';

/** Where an app declares its catalogs — `x new` writes it, and its `defineCatalogs()` runs there. */
export const APP_CATALOGS_PATH = 'packages/i18n/src/index.ts';

export interface AppLocaleSet {
  /** Every locale the app routes, its default first. */
  readonly locales: readonly string[];
  readonly defaultLocale: string;
}

/**
 * `root`'s declared locales, or `undefined` when no declaration ran: no catalog module, or one
 * that calls no `defineCatalogs()`. Never `localeConfig()` read blind — it ALWAYS answers a
 * fallback, so a module declaring nothing would inherit whatever an earlier import declared, and a
 * caller would pin a language no visitor sees. Declared means this import ran the call, or the
 * module exports the set one returned (a cached module evaluates once: the boot scan imported it).
 *
 * A module that will not import throws its own error: each caller decides whether that is a
 * refusal or "nothing declared".
 */
export async function loadAppCatalogs(root: string): Promise<AppLocaleSet | undefined> {
  const path = join(root, APP_CATALOGS_PATH);
  if (!(await Bun.file(path).exists())) return undefined;
  const before = catalogDeclarationCount();
  const module = (await import(path)) as Readonly<Record<string, unknown>>;
  const ran = catalogDeclarationCount() !== before;
  // The exported set FIRST: it is the declaration itself, where the locale config is shared,
  // process-wide state a later `configureLocales()` or a reset may have moved since the module ran
  // — and a cached module never runs its `defineCatalogs()` again to put it back.
  const exported = Object.values(module).find(isDeclaredCatalogSet) as DeclaredSet | undefined;
  if (exported !== undefined) return setOf(exported.default, exported.locales);
  if (!ran) return undefined;
  // Declared by this very import and not exported: the config is what that call just wrote.
  const defaultLocale = localeConfig().fallback;
  if (defaultLocale === '') return undefined;
  return { locales: [...routedLocales()], defaultLocale };
}

/** What `isDeclaredCatalogSet` vouches for: a `CatalogSet` some `defineCatalogs()` returned. */
type DeclaredSet = Pick<CatalogSet<CatalogSources>, 'default' | 'locales'>;

/** Default first, as `routedLocales()` orders them — every consumer enumerates in this order. */
const setOf = (defaultLocale: string, locales: readonly string[]): AppLocaleSet => ({
  locales: [defaultLocale, ...locales.filter((locale) => locale !== defaultLocale)],
  defaultLocale,
});

/**
 * The answer for an app that declares no catalogs: the framework default, alone. ONE value, so the
 * PWA manifest, the service worker, the prerender and every `x` command name the same language for
 * such an app — before it, the manifest said `en` off its own literal while the worker and the
 * prerender read `localeConfig()` blind and could inherit an earlier import's declaration.
 */
export const UNDECLARED_LOCALES: AppLocaleSet = Object.freeze({
  locales: Object.freeze([DEFAULT_LOCALE]),
  defaultLocale: DEFAULT_LOCALE,
});

/**
 * `root`'s locales whether it declared any or not: `loadAppCatalogs`, else `UNDECLARED_LOCALES`.
 * The caller that must tell the two apart (`x g`, which writes no catalog for an app without one)
 * asks `loadAppCatalogs`; every other caller asks this. A module that will not import still throws.
 */
export async function appLocaleSet(root: string): Promise<AppLocaleSet> {
  return (await loadAppCatalogs(root)) ?? UNDECLARED_LOCALES;
}
