/**
 * The framework's own strings, flattened once at import.
 * Register these before app catalogs so an app can override any framework key.
 */

import { type Catalog, loadCatalog } from './catalog';
import en from './catalogs/en.json';
import { hasCatalog, registerCatalog } from './context';
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

/**
 * Register the framework's own strings under the ONE locale they are written in.
 *
 * **No locale parameter, and that is the fix**: this catalog is English, so registering it under
 * `es` was a fallback chain with no name. An app shipping only `es` served `Page not found` and
 * English `ui.*` chrome with `isMiss` reading FALSE, so nothing downstream could see the gap —
 * the one thing `⟦key⟧` exists to make impossible. A locale argument is now a compile error.
 *
 * **Idempotent by construction, not by comment**: a locale that already has a catalog is left
 * alone. `registerCatalog` merges the existing entry FIRST and its argument second, so a second
 * call after an app registered put the English string back on top of every framework key that app
 * had overridden — silently, and only for the keys it cared enough to translate.
 *
 * `defineCatalogs` is the only production caller; the export exists for boot code that cannot
 * know whether an app has registered yet, which is exactly the call this guard makes safe.
 */
export function registerFrameworkCatalog(): void {
  if (hasCatalog(FRAMEWORK_CATALOG_LOCALE)) return;
  registerCatalog(FRAMEWORK_CATALOG_LOCALE, FRAMEWORK_CATALOG);
}
