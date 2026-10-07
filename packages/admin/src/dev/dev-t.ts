// The `/_x` translator: the framework catalog in the framework's own locale, whatever the app's
// default is. Every `/_x` string is registered under `DEFAULT_LOCALE` only, so the
// AMBIENT locale — an `es-co` app's — answered `⟦dev.panel.mail.title⟧` for every tab.

import { DEFAULT_LOCALE } from '@ultimat3/core';
import { type TranslateVars, translatorFor } from '@ultimat3/i18n';

export const t = (key: string, vars?: TranslateVars): string =>
  translatorFor(DEFAULT_LOCALE)(key, vars);
