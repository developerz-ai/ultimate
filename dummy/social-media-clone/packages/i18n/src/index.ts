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

export const catalogs = defineCatalogs({ default: 'en', locales: { en } });

/**
 * English is the source of truth for the key space — a second locale must match it exactly, or
 * `x verify` fails.
 */
export type AppCatalog = typeof en;

/** Every key this app's catalog defines — dot-paths, plus the stem of each plural family. */
export type TranslationKey = KeyOf<AppCatalog>;

/**
 * Use this, never `useI18n()` directly — the type parameter is what makes an unknown key a
 * compile error instead of a `⟦key⟧` someone notices in production.
 */
export const useT = (): Translator<AppCatalog> => useI18n<AppCatalog>();
