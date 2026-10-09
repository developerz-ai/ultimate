// The design system's own strings, ready to cross into an island. `@ultimat3/ui` resolves every
// `ui.*` key through the provider's translator, and a translator cannot be an island's prop — so
// the server resolves all of them once (`uiCatalog(t)`) and the island hands
// `<UiProvider t={subsetTranslator(props.ui)}>` a translator over them (`@ultimat3/i18n/subset`:
// only an island that imports it pays for the lookup). The whole namespace, never a per-component pick: which keys a
// component reads is the design system's business, and an app that listed them guessed.

import type { CatalogSubset, RawTranslator } from '@ultimat3/i18n/subset';
import { catalogSubset } from '@ultimat3/i18n/subset';
import { UI_KEYS } from './i18n-keys';

/** Every `ui.*` template in the request's locale, as JSON an island's props can carry. */
export const uiCatalog = (t: RawTranslator): CatalogSubset =>
  catalogSubset(t, Object.values(UI_KEYS));
