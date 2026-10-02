/**
 * The one call an app makes to declare its catalogs: validate and flatten every locale,
 * register it under the framework's own strings, and configure the supported set.
 * Boot-time only — nothing here runs per request.
 */

import { assertLocale } from '@ultimat3/core';
import { type Catalog, catalogKeys, loadCatalog, mergeCatalogs } from './catalog';
import { configureLocales, registerCatalog } from './context';
import { localeUnsupported } from './errors';

/** Locale tag → the catalog file's parsed contents, nested exactly as authored. */
export type CatalogSources = Readonly<Record<string, unknown>>;

export interface DefineCatalogsInput<TLocales extends CatalogSources> {
  /** The locale an unresolved request falls back to. Must be a key of `locales`. */
  readonly default: keyof TLocales & string;
  /** One entry per shipped locale — `{ en, es }` after importing the JSON files. */
  readonly locales: TLocales;
}

export interface CatalogSet<TLocales extends CatalogSources> {
  readonly default: keyof TLocales & string;
  readonly locales: readonly (keyof TLocales & string)[];
  /** Flattened app strings only. Framework strings are registered, never copied in here. */
  readonly catalogs: Readonly<Record<keyof TLocales & string, Catalog>>;
  /** Every dot-key across every locale, sorted — the app's key space. */
  keys(): string[];
}

let declarations = 0;

/**
 * How many times `defineCatalogs()` has run in this process. `@ultimat3/testing` reads it across a
 * test file: an app's catalog module imported lazily in a test body configures the worker's
 * locales once for good (the module is cached), while a test that calls `configureLocales()` by
 * hand is a change to undo — this count is what tells the two apart.
 */
export const catalogDeclarationCount = (): number => declarations;

export function defineCatalogs<TLocales extends CatalogSources>(
  input: DefineCatalogsInput<TLocales>,
): CatalogSet<TLocales> {
  const locales = Object.keys(input.locales) as (keyof TLocales & string)[];
  if (!locales.includes(input.default)) throw localeUnsupported(input.default, locales);
  // Every tag, before anything is registered. `configureLocales` below runs the same screen, but
  // after the register loop — so its `X_LOCALE_INVALID` arrived with the malformed tag already in
  // `registeredLocales()` and the well-formed locales' strings already live.
  for (const locale of locales) assertLocale(locale);

  // Load everything before registering anything: a malformed catalog must fail the boot
  // whole, not leave half the locales live and the other half missing.
  const loaded = locales.map((locale) => [locale, loadCatalog(input.locales[locale])] as const);

  // No framework-catalog call here, and that is deliberate: `framework.ts` installs it as the base
  // layer at package import, so it is already under this app's strings whether or not THIS module
  // ever runs. `registerCatalog` merges its argument last, so app strings still win the same keys.
  for (const [locale, catalog] of loaded) {
    registerCatalog(locale, catalog);
  }
  configureLocales({ supported: locales, fallback: input.default });
  declarations += 1;

  const catalogs = Object.fromEntries(loaded) as Readonly<Record<keyof TLocales & string, Catalog>>;
  return {
    default: input.default,
    locales,
    catalogs,
    keys: () => catalogKeys(mergeCatalogs(...loaded.map(([, catalog]) => catalog))),
  };
}
