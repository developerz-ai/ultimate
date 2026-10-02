// A locale as the two vocabularies a crawler reads spell it. An app registers `es-co` (lowercase is
// the catalog and URL form); `hreflang` wants BCP 47 with its region uppercased, `es-CO`, and Open
// Graph wants the underscore form, `es_CO`. One conversion, so the sitemap and the head agree.

/**
 * `es-co` → `es-CO`, `zh-hant-tw` → `zh-Hant-TW`, `en` → `en`. `Intl`'s own canonical form, which
 * is BCP 47's; a tag `Intl` refuses is returned as written rather than thrown — this runs per
 * render, and the config screen (`configureLocales`) already refused anything unparseable.
 */
export function hreflangTag(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? locale;
  } catch {
    return locale;
  }
}

/**
 * `es-co` → `es_CO`, `zh-hant-tw` → `zh_TW`: Open Graph's `language_TERRITORY`, which has no slot
 * for a script, a variant or an extension. Replacing hyphens in the BCP 47 tag produced
 * `zh_Hant_TW`, a value no consumer recognises. Total, for `hreflangTag`'s reason.
 */
export function ogLocaleTag(locale: string): string {
  try {
    const { language, region } = new Intl.Locale(locale);
    return region === undefined ? language : `${language}_${region}`;
  } catch {
    return locale.replace(/-/g, '_');
  }
}

/** A page in one locale: the locale and the page's own path in it. */
export interface LocalizedPage {
  readonly locale: string;
  readonly path: string;
}

/** What `renderMeta` needs to emit a page's hreflang cluster and its `og:locale` pair. */
export interface MetaLocalization {
  /** The locale this document renders in. */
  readonly locale: string;
  /** The locale whose page `x-default` names. */
  readonly defaultLocale: string;
  /** This page in every locale it exists in, the current one included. */
  readonly alternates: readonly LocalizedPage[];
}
