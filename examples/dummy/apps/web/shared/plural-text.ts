/**
 * A count phrased in the browser from forms the SERVER translated. An island's props cross as JSON,
 * so `t()` cannot travel — but a record the store moves (a like from another tab) can reach a count
 * no pre-rendered string covers. So the server sends each plural FORM of one key for its locale,
 * and this picks the form with the platform's own CLDR rules and fills `{count}`: the catalog stays
 * the one translator, and `Intl` — already in every browser, zero bytes — decides the category.
 */

/** Every CLDR plural form the catalog has for one key, and the locale they are in. */
// A type alias, not an interface: an island prop must be JSON, and only an object TYPE is
// assignable to the index signature `JsonValue` checks it against.
export type PluralForms = {
  readonly locale: string;
  /** `one` → `'{count} like'`, `other` → `'{count} likes'` — whichever forms the locale defines. */
  readonly forms: Readonly<Record<string, string>>;
};

export function pluralText(plural: PluralForms, count: number): string {
  const category = new Intl.PluralRules(plural.locale).select(count);
  const template = Object.hasOwn(plural.forms, category)
    ? plural.forms[category]
    : plural.forms['other'];
  const shown = new Intl.NumberFormat(plural.locale).format(count);
  return (template ?? shown).replaceAll('{count}', shown);
}
