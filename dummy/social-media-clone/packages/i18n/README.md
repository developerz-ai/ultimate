# @social-media-clone/i18n

Flat catalogs with loud misses. Part of the social-media-clone monorepo — see the root README for how it fits.

Importing this module **is** the registration: `defineCatalogs()` runs on the way through, and
every surface then resolves strings through `@ultimat3/i18n`'s ambient `t()`. There is no second
translator to import.

A typed `useT()` lived here until 2026-08 — `Translator<AppCatalog>`, so an unknown key would have
been a compile error. It had **zero callers** while 25 files used `t()`, so no key was ever checked.
It is gone, and `src/index.test.ts` is the replacement: it reads every literal key the app passes
to `t()` and fails on one this catalog does not define. That covers the files a second entry point
would have had to be adopted into one at a time.
