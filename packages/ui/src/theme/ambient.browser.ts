// What a browser bundler gets in place of `ambient.ts` — `package.json`'s `browser` field maps
// one file to the other. A browser has no request context: `useUi()` in a DOM reads the Solid
// context a `UiProvider` filled, and throws (`solid()`, X_UI_RUNTIME_MISSING) before it could ever
// fall back to an ambient reader. So nothing is registered here, and the same export answers the
// package defaults — which is exactly what the server's reader answers outside a request.

import { defaultUiContext, type UiContextValue } from './context';

export function ambientUiContext(): UiContextValue {
  return defaultUiContext();
}
