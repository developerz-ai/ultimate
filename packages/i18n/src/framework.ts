/**
 * The framework's own strings, flattened once at import.
 * Register these before app catalogs so an app can override any framework key.
 */

import { type Catalog, loadCatalog } from './catalog';
import en from './catalogs/en.json';
import { registerCatalog } from './context';
import { DEFAULT_LOCALE, type Locale } from './locales';

/** `errors.*`, `auth.*`, `pagination.*`, `admin.*`, `validation.*`, `common.*`, `time.*`. */
export const FRAMEWORK_CATALOG: Catalog = loadCatalog(en);

export const FRAMEWORK_CATALOG_LOCALE: Locale = DEFAULT_LOCALE;

/** Called by the HTTP layer at boot. Idempotent. */
export function registerFrameworkCatalog(locale: Locale = FRAMEWORK_CATALOG_LOCALE): void {
  registerCatalog(locale, FRAMEWORK_CATALOG);
}
