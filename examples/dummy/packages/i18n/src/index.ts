/**
 * The app's catalogs, registered once and typed against English. Every surface — site, app,
 * admin, and the digest email in the worker — resolves strings through this module.
 */

import { defineCatalogs, type Translator, useI18n } from '@ultimat3/i18n';
import en from '../catalogs/en.json';
import es from '../catalogs/es.json';

export const catalogs = defineCatalogs({
  default: 'en',
  locales: { en, es },
});

/** English is the source of truth for the key space; `es` must match it or `x verify` fails. */
export type AppCatalog = typeof en;

export type TranslationKey = keyof Translator<AppCatalog>['keys'];

/**
 * Use this, never `useI18n()` directly — the type parameter is what makes an unknown key a
 * compile error instead of a `⟦key⟧` someone notices in production.
 */
export const useT = (): Translator<AppCatalog> => useI18n<AppCatalog>();
