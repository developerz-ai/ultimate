# @docs-site/docs-source — CLAUDE.md

The wiki reader. `wiki/*.md` in, the site's pieces out: one page per wiki file, one per error code,
one per upgrade major, every link rewritten to the piece that holds its target. Pure — the caller
reads the files and hands them in, so every rule here is a unit test over strings.

- Gate: `x verify` from the app root — this package has no gate of its own.
- Exports: `src/index.ts`, named exports only, no `export *`.
- Imports: `@ultimat3/*` and this app's own `@docs-site/*` packages, never a sibling app.
- A dead link, a code with no page, a page with no lead line, a piece past the renderer's size cap:
  each is a thrown `defineError` code (`src/errors.ts`), so the build stops and names the wiki file.
- `wiki/` is never edited here: it stays the one source, and the GitHub wiki its other projection.
