// A slice of a catalog that can cross into an island. A translator is a function and cannot be an
// island's prop, so the server resolves the raw templates the island will read — plural variants
// included — and the island builds a full translator over them: the same lookup, interpolation and
// loud `⟦key⟧` miss as the server's.
//
// Its own entry (`@ultimat3/i18n/subset`): the barrel installs the framework catalog at import, and
// an island chunk must not carry it.

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
  /**
   * Every key of the catalog. A `select` family's values are an open set, so its members can only
   * be found by listing: a translator without `keys()` yields a subset with no families.
   */
  keys?(): string[];
  readonly locale: Locale;
}

/** The infix of a family member: `<key>_select_<value>`, `<key>_ordinal_<category>`. */
const FAMILY = /_(?:select|ordinal)_/g;

/**
 * Each translator's family members by stem, listed once: a subset is cut per island per request,
 * and scanning a 4,000-key catalog each time cost 0.78 ms where the lookups cost 0.006. A
 * translator's catalog is fixed for its life (a reload builds a new one), so the index never stales.
 */
const families = new WeakMap<RawTranslator, ReadonlyMap<string, readonly string[]>>();

function familiesOf(t: RawTranslator): ReadonlyMap<string, readonly string[]> {
  const known = families.get(t);
  if (known !== undefined) return known;
  const index = new Map<string, string[]>();
  for (const name of t.keys?.() ?? []) {
    // Every infix, never only the first: a named key may itself spell `_select_`.
    for (const infix of name.matchAll(FAMILY)) {
      const stem = name.slice(0, infix.index);
      // In place: a copy per member made one family of n members cost n²/2.
      const members = index.get(stem);
      if (members === undefined) index.set(stem, [name]);
      else members.push(name);
    }
  }
  families.set(t, index);
  return index;
}

/**
 * The templates `keys` name in `t`'s locale, each with every plural variant and every `select` and
 * `ordinal` family member the catalog holds, so `t(key, { count, select, ordinal })` in the island
 * picks the form the server would. A key the catalog lacks is left out, and renders `⟦key⟧` in the
 * island exactly as it would on the server.
 */
export function catalogSubset(t: RawTranslator, keys: readonly string[]): CatalogSubset {
  const catalog: Record<string, string> = Object.create(null) as Record<string, string>;
  const copy = (name: string): void => {
    const template = t.raw(name);
    if (template !== undefined) catalog[name] = template;
  };
  for (const key of keys) {
    for (const name of [key, ...pluralVariantsOf(key)]) copy(name);
  }
  const index = familiesOf(t);
  for (const key of keys) {
    for (const name of index.get(key) ?? []) copy(name);
  }
  return { locale: t.locale, catalog };
}

/** The island half: a translator over the subset the server sent. */
export function subsetTranslator(subset: CatalogSubset): Translator {
  // Null-prototyped again: the subset arrived as parsed JSON, where `__proto__` is an own key.
  const catalog: Catalog = Object.assign(Object.create(null) as Catalog, subset.catalog);
  return catalogTranslator(catalog, subset.locale);
}
