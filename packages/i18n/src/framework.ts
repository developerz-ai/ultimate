/**
 * The framework's own strings, flattened and installed as the base layer at import.
 * Under every app catalog, so an app overrides any framework key and forgets none.
 */

import { type Catalog, loadCatalog } from './catalog';
import en from './catalogs/en.json';
import { registerBaseCatalog } from './context';
import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * `errors.*`, `auth.*`, `pagination.*`, `admin.*`, `validation.*`, `common.*`, `time.*`, `ui.*`.
 *
 * `ui.*` is `@ultimat3/ui`'s `UI_KEYS` — the strings the design system needs and cannot receive as
 * a prop. They live here rather than in that package because a catalog is one flat file per locale
 * and a second one would be a second place a translator has to find.
 */
export const FRAMEWORK_CATALOG: Catalog = loadCatalog(en);

/**
 * The ONE locale this catalog is written in.
 *
 * Registering it under every locale was a fallback chain with no name: an app shipping only `es`
 * served `Page not found` and English `ui.*` chrome with `isMiss` reading FALSE, so nothing
 * downstream could see the gap — the one thing `⟦key⟧` exists to make impossible. A non-`en` app
 * translates the framework keys it renders into its own catalog.
 */
export const FRAMEWORK_CATALOG_LOCALE: Locale = DEFAULT_LOCALE;

// At module scope, and that is the whole point: `index.ts` re-exports this file, so anything that
// can call `t()` has already imported the module that installs these strings. It was a function
// (`registerFrameworkCatalog`) that only `defineCatalogs` called until 5.1.0 — so an app whose
// catalog module nothing imported rendered `⟦errors.notFound.title⟧` on its 404 page, `⟦ui.*⟧` in
// every design-system control, and had no way to notice (issue #249). Registration that an app
// can forget is not registration; the framework's half of it is now unforgettable by construction.
registerBaseCatalog(FRAMEWORK_CATALOG_LOCALE, FRAMEWORK_CATALOG);
