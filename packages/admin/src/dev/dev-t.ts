// The `/_x` translator: the framework catalog in the framework's own locale, whatever the app's
// default is. Every `/_x` string is registered under `FRAMEWORK_CATALOG_LOCALE` only, so the
// AMBIENT locale — an `es-co` app's — answered `⟦dev.panel.mail.title⟧` for every tab.

import { FRAMEWORK_CATALOG_LOCALE, type TranslateVars, translatorFor } from '@ultimat3/i18n';

export const t = (key: string, vars?: TranslateVars): string =>
  translatorFor(FRAMEWORK_CATALOG_LOCALE)(key, vars);
