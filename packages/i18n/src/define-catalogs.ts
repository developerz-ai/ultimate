/**
 * The one call an app makes to declare its catalogs: validate and flatten every locale,
 * register it under the framework's own strings, and configure the supported set.
 * Boot-time only — nothing here runs per request.
 */

import { type Catalog, catalogKeys, loadCatalog, mergeCatalogs } from './catalog';
import { configureLocales, registerCatalog } from './context';
import { localeUnsupported } from './errors';
import { registerFrameworkCatalog } from './framework';

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

export function defineCatalogs<TLocales extends CatalogSources>(
  input: DefineCatalogsInput<TLocales>,
): CatalogSet<TLocales> {
  const locales = Object.keys(input.locales) as (keyof TLocales & string)[];
  if (!locales.includes(input.default)) throw localeUnsupported(input.default, locales);

  // Load everything before registering anything: a malformed catalog must fail the boot
  // whole, not leave half the locales live and the other half missing.
  const loaded = locales.map((locale) => [locale, loadCatalog(input.locales[locale])] as const);

  // Framework first, app second. `registerCatalog` merges and the later call wins, which is how an
  // app overrides `errors.notFound.title` without forking the framework catalog. ONCE, not once
  // per locale: the framework catalog is English, and registering it under every locale filled
  // `es` with English for every key the app had not translated — `isMiss` false, gap invisible,
  // the exact fallback chain `⟦key⟧` exists to refuse.
  registerFrameworkCatalog();
  for (const [locale, catalog] of loaded) {
    registerCatalog(locale, catalog);
  }
  configureLocales({ supported: locales, fallback: input.default });

  const catalogs = Object.fromEntries(loaded) as Readonly<Record<keyof TLocales & string, Catalog>>;
  return {
    default: input.default,
    locales,
    catalogs,
    keys: () => catalogKeys(mergeCatalogs(...loaded.map(([, catalog]) => catalog))),
  };
}
