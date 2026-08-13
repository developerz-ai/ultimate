/**
 * `{var}` substitution and CLDR plural-form selection.
 * Pure string work: it never reads a catalog and never resolves a locale.
 */

export type InterpolationValue = string | number | boolean;
export type InterpolationVars = Record<string, InterpolationValue>;

/** CLDR plural categories, in the order we probe catalog suffixes. */
export const PLURAL_CATEGORIES: readonly Intl.LDMLPluralRule[] = [
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
];

const PLACEHOLDER = /\{\{|\}\}|\{([^{}\s]+)\}/g;

/**
 * Replace `{name}` with `vars.name`. `{{` and `}}` escape a literal brace.
 * An unknown variable renders loudly as `⟦name⟧` for the same reason a missing key
 * does: a silently blank slot ships to production, a bracketed one does not.
 *
 * Only an OWN property of `vars` is a variable. A plain object inherits `constructor`,
 * `toString` and the rest, so `{constructor}` would have rendered a function's source into a
 * page — the same prototype walk `catalog.ts` avoids by nesting into null-prototype nodes.
 *
 * The fast path tests both braces because `}}` un-escapes without a `{` in sight: skipping on
 * `{` alone left `'a}}b'` unchanged while `'{{a}}b'` collapsed, which is one escape with two
 * meanings.
 */
export function interpolate(template: string, vars?: InterpolationVars): string {
  if (!template.includes('{') && !template.includes('}')) return template;
  return template.replace(PLACEHOLDER, (match, name: string | undefined) => {
    if (match === '{{') return '{';
    if (match === '}}') return '}';
    if (name === undefined) return match;
    const value = vars !== undefined && Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (value === undefined) return `⟦${name}⟧`;
    return String(value);
  });
}

/** Variable names a template expects — used by the extractor to flag arity drift. */
export function placeholdersOf(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

/**
 * Pick the plural category for `count` in `locale` via `Intl.PluralRules` — CLDR
 * categories, never an English `n === 1` check. `pl` has one/few/many/other, `ar`
 * adds zero/two: a two-branch translator is wrong in both.
 */
export function pluralCategory(count: number, locale: string): Intl.LDMLPluralRule {
  return pluralRulesFor(locale).select(count);
}

/**
 * Candidate keys for a plural lookup, most specific first.
 *
 * `items` + count 3 in `pl` → `items_many`, `items_plural`, `items_other`, `items`.
 * `items` + count 1 in `pl` → `items_one`, `items`.
 * `_plural` is the two-form authoring shortcut from the house style; the `_<category>`
 * suffixes are what a 3+ form locale needs.
 */
export function pluralKeyCandidates(key: string, count: number, locale: string): string[] {
  const category = pluralCategory(count, locale);
  if (category === 'one') return [`${key}_one`, key];
  return [`${key}_${category}`, `${key}_plural`, `${key}_other`, key];
}

/** First candidate that exists, per the caller's `has` predicate; falls back to `key`. */
export function selectPluralKey(
  key: string,
  count: number,
  locale: string,
  has: (candidate: string) => boolean,
): string {
  for (const candidate of pluralKeyCandidates(key, count, locale)) {
    if (has(candidate)) return candidate;
  }
  return key;
}

/** All suffixed variants of `key` a locale could legitimately define. */
export function pluralVariantsOf(key: string): string[] {
  return [`${key}_plural`, ...PLURAL_CATEGORIES.map((category) => `${key}_${category}`)];
}

const rulesCache = new Map<string, Intl.PluralRules>();

function pluralRulesFor(locale: string): Intl.PluralRules {
  const cached = rulesCache.get(locale);
  if (cached !== undefined) return cached;
  // An unknown tag would throw inside Intl; degrade to `en` rather than break a render.
  let rules: Intl.PluralRules;
  try {
    rules = new Intl.PluralRules(locale);
  } catch {
    rules = new Intl.PluralRules('en');
  }
  rulesCache.set(locale, rules);
  return rules;
}
