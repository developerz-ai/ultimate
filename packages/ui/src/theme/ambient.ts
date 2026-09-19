// The presentation context of a SERVER render, read from the request the framework already
// resolved — and the one module of the theme directory that reaches `@ultimat3/i18n` and
// `@ultimat3/time` for a value. `index.ts` imports it bare, so every server that imports the
// barrel has the reader registered before the first `useUi()`; `package.json`'s `browser` field
// maps this file to `ambient.browser.ts` for a browser bundler, which is what keeps the i18n
// barrel — and the framework catalog it installs at import — out of an island chunk (issue #490).

import { currentDirection, currentLocale, useI18n } from '@ultimat3/i18n';
import { currentTimeZone } from '@ultimat3/time';
import { setAmbientUiReader } from './ambient-slot';
import { UI_DEFAULT_CURRENCY, type UiContextValue } from './context';

/**
 * `currentLocale()` and `currentTimeZone()` are the ambient answers `@ultimat3/i18n` and
 * `@ultimat3/time` keep on the request context, and `useI18n()` is the translator built from the
 * registered catalogs. No second ambient store, and no process-wide default — outside a request
 * each of them returns its own configured fallback, which is where `defaultUiContext()`'s values
 * come from in the first place.
 *
 * `theme` and `currency` have no ambient source and are not given one. The server cannot know the
 * theme — `data-theme` is decided in the browser by the anti-flash script — and a default display
 * currency is business convention: a `Money` carries its own, and an app that wants another for
 * bare minor units wraps `<Money currency="EUR">` once (axiom 8).
 */
export function ambientUiContext(): UiContextValue {
  return {
    theme: 'light',
    locale: currentLocale(),
    timeZone: currentTimeZone(),
    currency: UI_DEFAULT_CURRENCY,
    dir: currentDirection(),
    t: useI18n(),
  };
}

// At module scope, and that is the point: registration an importer can forget is not registration.
setAmbientUiReader(ambientUiContext);
