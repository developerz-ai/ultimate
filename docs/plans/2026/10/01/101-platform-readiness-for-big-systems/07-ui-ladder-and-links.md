# 07 — UI: the missing ladder helpers, link pager, button-link

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4.

Rule: every length, breakpoint and fluid size comes from `@ultimat3/ui/tokens`. An app that needs
`max-width` does not write its own mixin.

Evidence: the deployed demo wrote `rem()`, `fluid()`, `bp-down` and `bp-between`
(`dummy/social-media-clone/apps/web/shared/tokens.scss:24-76`). A downstream app wrote a link
pager (7 uses) and a link styled as a button (23 uses) because `Pagination` is callback-only
(`packages/ui/src/components/Pagination.tsx:15`) and `Button` has no `href`
(`packages/ui/src/components/Button.tsx:23`).

## Files to change
- `packages/ui/src/tokens/_mixins.scss:85-92` — beside `respond-to`: `respond-down($bp)`,
  `respond-between($from, $to)`.
- `packages/ui/src/tokens/_space.scss` or a new `_units.scss` — `rem()`, `fluid()`.
- `packages/ui/src/tokens/tokens.ts` + `tokens.test.ts:50-78` — the TS mirror stays equal.
- `packages/ui/src/components/Pagination.tsx` — `hrefFor?: (cursor, direction) => string`.
- `packages/ui/src/components/Link.tsx:10` — `appearance?: 'link' | 'button'` reusing `Button`'s
  variant classes.
- `dummy/social-media-clone/apps/web/shared/tokens.scss:24-76` — delete all four helpers and
  rename their call sites to the framework's names. Leaving `bp-between` beside
  `respond-between` would be two ways. The file's `motion`, `lift`, `gradient-text` and `card`
  mixins are the app's own look and stay.
- `packages/ui/CATALOG.md`, `packages/ui/README.md`, `packages/ui/CLAUDE.md`.

## Steps
1. Lift the demo's four helpers as written, including the 0.02px offset that keeps a `min` and a
   `max` arm from both matching at the rung. Keep each `@error` in the `X_TOKEN_*` voice the file
   already uses.
2. `respond-between` refuses `$from >= $to` with a Sass `@error` naming the fix.
3. `Pagination`: `hrefFor` renders anchors and needs no island. `onCursor` and `hrefFor` together
   is a type error — one mode per use.
4. `Link appearance="button"`: one set of button styles, two elements. Do not add `href` to
   `Button`; a button that navigates is a link.
5. Bytes: these add Sass functions (zero CSS until used) and two small props. If a route budget
   moves, raise it by the measured amount in the same diff (`bun run budget-raises`).

## Tests
- `packages/ui/src/tokens/mixins.test.ts`: compile each helper; assert the emitted media query and
  the `@error` text for an unknown rung and a wrong unit.
- `packages/ui/src/components/Pagination.test.ts`: `hrefFor` emits `<a href>`; no handler attached.
- Command: `bun test packages/ui/src/tokens/mixins.test.ts`.

## Done when
- The demo app compiles with no helper of its own; `bun run scripts/reference-app-gate.ts` green.
- `wiki/Theming.md:80` lists the three breakpoint mixins.
