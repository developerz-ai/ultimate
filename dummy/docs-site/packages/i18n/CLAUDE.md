# @docs-site/i18n — CLAUDE.md

Flat catalogs with loud misses.

- Gate: `x verify` from the repo root — this package has no gate of its own.
- Exports: `src/index.ts`, named exports only, no `export *`.
- Imports: `@ultimat3/*` and this app's own `@docs-site/*` packages, never a sibling app.
