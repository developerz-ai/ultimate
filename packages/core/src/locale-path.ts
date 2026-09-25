// A locale in a URL, as pure path arithmetic over an explicit locale list: the default locale is
// the UNPREFIXED path, every other one is `/<locale>/…`. Tier 0 for `locale-direction.ts`' reason:
// `@ultimat3/ui`'s `LocaleSwitcher` spells its links with it, and reaching the i18n barrel for one
// function puts the whole framework catalog into every browser chunk (issue #490). i18n wraps these
// with the app's configured locales (`localizedPath`, `splitLocalePrefix`), so apps call those.

/** The segment a locale is written as in a URL: lowercase, so `pt-BR` is `/pt-br/`. */
export function localeSegment(locale: string): string {
  return locale.toLowerCase();
}

export interface LocalePathSplit {
  /** The spelling the locale list carries. */
  readonly locale: string;
  /** The pathname with the segment removed — `/` for `/en` and `/en/`. */
  readonly path: string;
  /** The segment named the default locale: a duplicate URL, answered with a redirect. */
  readonly isDefault: boolean;
}

/**
 * `/en/precios` → `{ locale: 'en', path: '/precios' }`; `undefined` when the first segment names no
 * listed locale. Exact lowercase match only: `/EN/x` is not a second spelling of `/en/x`, because
 * two URLs for one document is the duplicate-content bug the default's redirect exists to prevent.
 */
export function splitLocalePath(
  pathname: string,
  locales: readonly string[],
  defaultLocale: string,
): LocalePathSplit | undefined {
  if (!pathname.startsWith('/')) return undefined;
  const end = pathname.indexOf('/', 1);
  const segment = end === -1 ? pathname.slice(1) : pathname.slice(1, end);
  if (segment === '') return undefined;
  const locale = locales.find((candidate) => localeSegment(candidate) === segment);
  if (locale === undefined) return undefined;
  const rest = end === -1 ? '' : pathname.slice(end);
  return {
    locale,
    path: rest === '' ? '/' : rest,
    isDefault: localeSegment(locale) === localeSegment(defaultLocale),
  };
}

/**
 * `path` as `locale` spells it: `/precios` + `en` → `/en/precios`, the default locale → `/precios`,
 * and the root → `/en/` (the directory a static host serves `en/index.html` from without a
 * redirect). A path already carrying a listed prefix is re-spelled, never doubled, so a language
 * switcher can hand in the page it is on. A query or fragment is kept as written.
 */
export function localizePath(
  path: string,
  locale: string,
  locales: readonly string[],
  defaultLocale: string,
): string {
  const cut = path.search(/[?#]/);
  const pathname = cut === -1 ? path : path.slice(0, cut);
  const suffix = cut === -1 ? '' : path.slice(cut);
  const bare = splitLocalePath(pathname, locales, defaultLocale)?.path ?? pathname;
  const rooted = bare.startsWith('/') ? bare : `/${bare}`;
  if (localeSegment(locale) === localeSegment(defaultLocale)) return `${rooted}${suffix}`;
  const prefix = `/${localeSegment(locale)}`;
  return `${rooted === '/' ? `${prefix}/` : `${prefix}${rooted}`}${suffix}`;
}
