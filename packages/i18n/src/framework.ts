/**
 * The framework's own strings, flattened once at import.
 * Register these before app catalogs so an app can override any framework key.
 */

import { type Catalog, loadCatalog } from './catalog';
import en from './catalogs/en.json';
import { registerCatalog } from './context';
import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * `errors.*`, `auth.*`, `pagination.*`, `admin.*`, `validation.*`, `common.*`, `time.*`, `ui.*`.
 *
 * `ui.*` is `@ultimat3/ui`'s `UI_KEYS` — the strings the design system needs and cannot receive as
 * a prop. They live here rather than in that package because a catalog is one flat file per locale
 * and a second one would be a second place a translator has to find.
 */
export const FRAMEWORK_CATALOG: Catalog = loadCatalog(en);

export const FRAMEWORK_CATALOG_LOCALE: Locale = DEFAULT_LOCALE;

/** Called by the HTTP layer at boot. Idempotent. */
export function registerFrameworkCatalog(locale: Locale = FRAMEWORK_CATALOG_LOCALE): void {
  registerCatalog(locale, FRAMEWORK_CATALOG);
}
