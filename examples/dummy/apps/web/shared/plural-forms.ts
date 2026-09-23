/**
 * The server half of `plural-text.ts`: each CLDR form of one catalog key, read raw through the
 * app's translator in the request's locale. `t.raw` is the translator's own door to a template —
 * the catalog is still where every word comes from, and `useT()` is still the one way in.
 */

import type { useT } from '@postly/i18n';
import type { PluralForms } from './plural-text';

type AppTranslator = ReturnType<typeof useT>;

/** `pluralFormsOf(t, 'app.post.likes')` → the forms `app.post.likes_<category>` defines. */
export function pluralFormsOf(t: AppTranslator, key: string): PluralForms {
  const locale = t.locale;
  const forms: Record<string, string> = {};
  for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
    const template = t.raw(`${key}_${category}`);
    if (template !== undefined) forms[category] = template;
  }
  return { locale, forms };
}
