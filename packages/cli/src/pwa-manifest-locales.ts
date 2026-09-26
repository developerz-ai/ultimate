// The manifest members an app declares beyond `name` and `colors`, spelled for ONE locale: its
// `lang`, its `start_url`, its text and its shortcut URLs. `pwa-artifacts.ts` builds one manifest per
// routed locale from this; the `pwa` block is read structurally, for `colorsOf`'s reason there.

import { localeSegment, localizePath } from '@ultimat3/core';
import type {
  ManifestIcon,
  ManifestScreenshot,
  ManifestShortcut,
  WebManifestInput,
} from '@ultimat3/pwa';

/** The app's locales as `app.config.ts` declares them, default first. */
export interface AppLocales {
  readonly routed: readonly string[];
  readonly fallback: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * `locales` and `defaultLocale`, read off the config object. The manifest's `lang` was the
 * generator's hardcoded `'en'` for an `es-co` app (notificado.co, 22.3.2). An untyped config with
 * neither is core's own default, `en`.
 */
export function appLocales(config: Record<string, unknown>): AppLocales {
  const declared = strings(config['locales']);
  const named = config['defaultLocale'];
  const fallback = typeof named === 'string' && named !== '' ? named : (declared[0] ?? 'en');
  const others = declared.filter((locale) => localeSegment(locale) !== localeSegment(fallback));
  return { routed: [fallback, ...others], fallback };
}

/** `path` as `locale` spells it — `/en/panel` — by core's one arithmetic, the one `http` routes. */
export const spellIn = (path: string, locale: string, locales: AppLocales): string =>
  localizePath(path, locale, locales.routed, locales.fallback);

/**
 * `PwaText`: a string is every locale's; a record answers `locale`, then the default locale. A
 * value that is neither — or a record naming neither — is absent, never `'undefined'`.
 */
function textIn(value: unknown, locale: string, locales: AppLocales): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (!isRecord(value)) return undefined;
  for (const key of [locale, locales.fallback]) {
    const entry = value[key];
    if (typeof entry === 'string' && entry.trim() !== '') return entry;
  }
  return undefined;
}

const PURPOSES = new Set(['any', 'maskable', 'monochrome']);

function iconsOf(value: unknown): readonly ManifestIcon[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((icon): readonly ManifestIcon[] => {
    if (!isRecord(icon)) return [];
    const { src, sizes, type, purpose } = icon;
    if (typeof src !== 'string' || typeof sizes !== 'string' || typeof type !== 'string') return [];
    return [
      {
        src,
        sizes,
        type,
        ...(typeof purpose === 'string' && PURPOSES.has(purpose)
          ? { purpose: purpose as NonNullable<ManifestIcon['purpose']> }
          : {}),
      },
    ];
  });
}

function shortcutsIn(value: unknown, locale: string, locales: AppLocales): ManifestShortcut[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((shortcut): ManifestShortcut[] => {
    if (!isRecord(shortcut) || typeof shortcut['url'] !== 'string') return [];
    const name = textIn(shortcut['name'], locale, locales);
    if (name === undefined) return [];
    const shortName = textIn(shortcut['shortName'], locale, locales);
    const description = textIn(shortcut['description'], locale, locales);
    const icons = iconsOf(shortcut['icons']);
    return [
      {
        name,
        ...(shortName === undefined ? {} : { short_name: shortName }),
        ...(description === undefined ? {} : { description }),
        url: spellIn(shortcut['url'], locale, locales),
        ...(icons.length === 0 ? {} : { icons }),
      },
    ];
  });
}

function screenshotsIn(value: unknown, locale: string, locales: AppLocales): ManifestScreenshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((shot): ManifestScreenshot[] => {
    if (!isRecord(shot)) return [];
    const src = textIn(shot['src'], locale, locales);
    const { sizes, type, formFactor } = shot;
    if (src === undefined || typeof sizes !== 'string' || typeof type !== 'string') return [];
    const label = textIn(shot['label'], locale, locales);
    return [
      {
        src,
        sizes,
        type,
        ...(formFactor === 'narrow' || formFactor === 'wide' ? { form_factor: formFactor } : {}),
        ...(label === undefined ? {} : { label }),
      },
    ];
  });
}

type LocaleMembers = Pick<
  WebManifestInput,
  'lang' | 'id' | 'startUrl' | 'description' | 'categories' | 'shortcuts' | 'screenshots'
>;

/**
 * Everything one locale's manifest says beyond name, colours and icons. `id` is the SAME in every
 * locale — the scope unless the app names one — so a browser sees one app installed from either
 * language rather than two; `start_url` is that locale's home.
 */
export function localeMembers(
  pwa: Record<string, unknown>,
  locale: string,
  locales: AppLocales,
): LocaleMembers {
  const description = textIn(pwa['description'], locale, locales);
  const categories = strings(pwa['categories']);
  const shortcuts = shortcutsIn(pwa['shortcuts'], locale, locales);
  const screenshots = screenshotsIn(pwa['screenshots'], locale, locales);
  const id = pwa['id'];
  return {
    lang: locale,
    id: typeof id === 'string' && id.startsWith('/') ? id : '/',
    startUrl: spellIn('/', locale, locales),
    ...(description === undefined ? {} : { description }),
    ...(categories.length === 0 ? {} : { categories }),
    ...(shortcuts.length === 0 ? {} : { shortcuts }),
    ...(screenshots.length === 0 ? {} : { screenshots }),
  };
}
