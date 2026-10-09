// A slice of a catalog that can cross into an island. A translator is a function and cannot be an
// island's prop, so the server resolves the raw templates the island will read — plural variants
// included — and the island builds a full translator over them: the same lookup, interpolation
// and loud `⟦key⟧` miss as the server's. Its own entry (`@ultimat3/i18n/subset`): the barrel
// installs the framework catalog at import, and an island chunk must not carry it.

import type { Catalog } from './catalog';
import { pluralVariantsOf } from './interpolate';
import type { Locale } from './locales';
import { catalogTranslator, type Translator } from './translator';

/**
 * What an island receives: plain JSON — its locale and the templates it may render. A type alias,
 * not an interface, so it is assignable to the JSON an island's props are checked against.
 */
export type CatalogSubset = {
  readonly locale: Locale;
  readonly catalog: Readonly<Record<string, string>>;
};

/** The two members of a translator a subset is read through — any app's typed `t` has them. */
export interface RawTranslator {
  raw(key: string): string | undefined;
  readonly locale: Locale;
}

/**
 * The templates `keys` name in `t`'s locale, each with every plural variant the catalog holds, so
 * `t(key, { count })` in the island picks the form the server would. A key the catalog lacks is
 * left out, and renders `⟦key⟧` in the island exactly as it would on the server.
 */
export function catalogSubset(t: RawTranslator, keys: readonly string[]): CatalogSubset {
  const catalog: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    for (const name of [key, ...pluralVariantsOf(key)]) {
      const template = t.raw(name);
      if (template !== undefined) catalog[name] = template;
    }
  }
  return { locale: t.locale, catalog };
}

/** The island half: a translator over the subset the server sent. */
export function subsetTranslator(subset: CatalogSubset): Translator {
  // Null-prototyped again: the subset arrived as parsed JSON, where `__proto__` is an own key.
  const catalog: Catalog = Object.assign(Object.create(null) as Catalog, subset.catalog);
  return catalogTranslator(catalog, subset.locale);
}
