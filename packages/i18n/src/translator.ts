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

export interface Translator {
  (key: string, vars?: TranslateVars): string;
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
    const template = catalog[resolveKey(key, vars)];
    if (template === undefined) return `⟦${key}⟧`;
    return vars === undefined ? template : interpolate(template, vars);
  };

  return Object.assign(translate, {
    has: (key: string): boolean =>
      hasExact(key) ||
      hasExact(`${key}_other`) ||
      hasExact(`${key}_plural`) ||
      hasExact(`${key}_one`),
    raw: (key: string): string | undefined => catalog[key],
    keys: (): string[] => Object.keys(catalog).sort(),
    locale,
  });
}

/** True when a rendered string is a loud miss — assert on this in tests, never on `''`. */
export function isMiss(rendered: string): boolean {
  return rendered.startsWith('⟦') && rendered.endsWith('⟧');
}
