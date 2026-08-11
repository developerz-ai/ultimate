// The one renderer for a generated `packages/i18n/catalogs/<locale>.json`. Every generator that
// contributes keys goes through it, so no template hand-writes catalog JSON and none of them can
// emit the flat dot-key form `@ultimat3/i18n` refuses.

import { nestCatalog } from '@ultimat3/i18n';

/**
 * `{ 'site.home.title': 'Home' }` → the nested JSON a catalog file actually holds.
 *
 * Load-bearing, not cosmetic: `parseNestedCatalog` validates every key segment against
 * `/^[A-Za-z0-9_-]+$/`, so a dot inside a key is `X_CATALOG_INVALID` and a catalog written flat
 * fails `defineCatalogs` at boot — the app never starts. Templates author in the flat form because
 * that is how a key reads at the `t('site.home.title')` call site; `nestCatalog` is the framework's
 * own inverse of the flatten every read does, so the two forms cannot drift.
 */
export const catalogJson = (entries: Readonly<Record<string, string>>): string =>
  `${JSON.stringify(nestCatalog(entries), null, 2)}\n`;
