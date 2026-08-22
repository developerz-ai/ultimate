// The app's catalog, registered once and typed against English. Every surface resolves strings
// through this module, and an unknown key is a compile error via useT() — never a runtime miss
// nobody notices until production.

import {
  defineCatalogs,
  type TranslationKey as KeyOf,
  type Translator,
  useI18n,
} from '@ultimat3/i18n';
import en from '../catalogs/en.json';
import es from '../catalogs/es.json';

export const catalogs = defineCatalogs({ default: 'en', locales: { en, es } });

/**
 * English is the source of truth for the key space — a second locale must match it exactly, or
 * `x verify` fails.
 */
export type AppCatalog = typeof en;

/** Every key this app's catalog defines — dot-paths, plus the stem of each plural family. */
export type TranslationKey = KeyOf<AppCatalog>;

/**
 * The app's ONE way to read a string. Never `useI18n()` directly and never `t` from
 * `@ultimat3/i18n`, for two independent reasons:
 *
 * 1. the type parameter makes an unknown key a compile error instead of a `⟦key⟧` someone
 *    notices in production;
 * 2. importing THIS module is what registers the catalogs — `defineCatalogs()` above runs on
 *    import and nowhere else. A page that reached past it rendered every string as `⟦key⟧`
 *    with `x verify` green, because nothing in the app depended on the module that registers
 *    (issue #249). `x i18n check` now refuses that app; this import is why it never happens.
 */
export const useT = (): Translator<AppCatalog> => useI18n<AppCatalog>();
