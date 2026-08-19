/**
 * Lookup + interpolation delegation, nothing else. Never throws, never falls back to
 * another locale, never returns the key bare: a miss renders `⟦key⟧` so gaps are
 * visible in dev and in review screenshots instead of invisible in production.
 */

import type { Catalog } from './catalog';
import { type InterpolationVars, interpolate, selectPluralKey } from './interpolate';
import { DEFAULT_LOCALE, type Locale } from './locales';

export interface TranslateVars extends InterpolationVars {
  /** Present ⇒ plural selection runs against the locale's CLDR categories. */
  count?: number;
}

/** Suffixes `selectPluralKey` probes: the CLDR categories plus the two-form shortcut. */
type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other' | 'plural';

/** `items_one` → `items`. A leaf with no plural suffix contributes nothing. */
type PluralStem<TKey extends string> = TKey extends `${infer TStem}_${PluralSuffix}`
  ? TStem
  : never;

/** Recursion budget — an unresolved generic catalog would otherwise never bottom out. */
type Depth = [never, 0, 1, 2, 3, 4, 5, 6, 7];

/** Depth-first dot-paths of an authoring object — the type-level twin of `flattenCatalog`. */
type CatalogPaths<TCatalog, TDepth extends number = 8> = [Depth[TDepth]] extends [never]
  ? never
  : {
      [TKey in keyof TCatalog & string]: TCatalog[TKey] extends string
        ? TKey | PluralStem<TKey>
        : `${TKey}.${CatalogPaths<TCatalog[TKey], Depth[TDepth]> & string}`;
    }[keyof TCatalog & string];

/**
 * Dot-path keys of a nested catalog, plus the stem of every plural family — `items_one`
 * also admits `items`, because `t('items', { count })` is how plural selection is called.
 * An index-signature catalog (the untyped default) degrades to `string`.
 */
export type TranslationKey<TCatalog> = string extends keyof TCatalog
  ? string
  : CatalogPaths<TCatalog>;

export interface Translator<TCatalog = Catalog> {
  (key: TranslationKey<TCatalog>, vars?: TranslateVars): string;
  /** Whether the key (or any of its plural variants) can be rendered. */
  has(key: string): boolean;
  /** The raw template, for tooling that needs the placeholders. */
  raw(key: string): string | undefined;
  keys(): string[];
  readonly locale: Locale;
}

export function createTranslator(catalog: Catalog, locale: Locale = DEFAULT_LOCALE): Translator {
  const hasExact = (key: string): boolean => Object.hasOwn(catalog, key);

  const resolveKey = (key: string, vars?: TranslateVars): string => {
    const count = vars?.count;
    if (typeof count === 'number' && Number.isFinite(count)) {
      return selectPluralKey(key, count, locale, hasExact);
    }
    return key;
  };

  const translate = (key: string, vars?: TranslateVars): string => {
    // Through `hasExact`, never a raw index: a key travels as data (`t(row.labelKey)`), and on a
    // `{}`-prototyped catalog `catalog['valueOf']` resolves to the INHERITED function instead of
    // reading as absent — so `interpolate` threw on a non-string, `t('constructor')` returned a
    // function through a signature typed `string`, and `isMiss(t('__proto__'))` threw on an object.
    // Catalogs are null-prototyped now; this guard is what makes that true of any catalog.
    const resolved = resolveKey(key, vars);
    const template = hasExact(resolved) ? catalog[resolved] : undefined;
    if (template === undefined) return `⟦${key}⟧`;
    return vars === undefined ? template : interpolate(template, vars);
  };

  return Object.assign(translate, {
    has: (key: string): boolean =>
      hasExact(key) ||
      hasExact(`${key}_other`) ||
      hasExact(`${key}_plural`) ||
      hasExact(`${key}_one`),
    raw: (key: string): string | undefined => (hasExact(key) ? catalog[key] : undefined),
    keys: (): string[] => Object.keys(catalog).sort(),
    locale,
  });
}

/** True when a rendered string is a loud miss — assert on this in tests, never on `''`. */
export function isMiss(rendered: string): boolean {
  return rendered.startsWith('⟦') && rendered.endsWith('⟧');
}
