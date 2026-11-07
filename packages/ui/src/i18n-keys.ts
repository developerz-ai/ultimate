// `UI_KEYS`: every string the design system resolves through the context translator, so an app
// localises the whole system with one catalog namespace (a miss is loud, ⟦key⟧). A NAMESPACE over
// `ui-keys.ts`, never an object literal: `UI_KEYS.x` is then a static member read a bundler turns
// into one string, so an island keeps only the keys it reads (`i18n-keys-shake.test.ts`).

import * as UI_KEYS from './ui-keys';

export { UI_KEYS };

export type UiKey = (typeof UI_KEYS)[keyof typeof UI_KEYS];
