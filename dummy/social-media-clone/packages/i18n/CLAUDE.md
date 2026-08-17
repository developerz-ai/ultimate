# @social-media-clone/i18n — CLAUDE.md

Flat catalogs with loud misses.

- Gate: `x verify` from the repo root — this package has no gate of its own.
- Exports: `src/index.ts`, named exports only, no `export *`. `catalogs` is the whole surface;
  importing the module is what registers it.
- Imports: `@ultimat3/*` and this app's own `@social-media-clone/*` packages, never a sibling app.
- One flat file per locale under `catalogs/`. Never a directory per locale, never a file per feature.
- **`t()` from `@ultimat3/i18n` is the one translator.** A second, typed entry point (`useT()`)
  shipped here with zero callers until 2026-08 and checked nothing; the key check is
  `src/index.test.ts` — every literal `t('key')` in `apps/**` and `packages/**` must exist here.
  A key built from a variable or a `${}` template is outside it by construction.
