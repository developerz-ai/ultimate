// The app's catalog, registered once. Importing this module IS the registration — every surface
// then resolves strings through `@ultimat3/i18n`'s ambient `t()`, which is the one translator the
// framework and this app share.
//
// It exported a `useT()` until 2026-08, typed against `AppCatalog` so an unknown key would be a
// compile error. It had zero callers while 25 files used `t()`, so no key was ever checked and the
// claim in this header was false. The check is `index.test.ts` now: it reads every literal key the
// app passes to `t()` and fails on one this catalog does not define — which covers the 25 files a
// second, typed entry point would have had to be adopted into one by one.

import { defineCatalogs } from '@ultimat3/i18n';
import en from '../catalogs/en.json';

export const catalogs = defineCatalogs({ default: 'en', locales: { en } });
