# 23-ui-data-table — A table that survives live rows and the framework's own pages

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 4 (`ui`), 5 (`cli` templates).

## Why
No adopter renders `DataTable` on a real list. Four wrote a table or a table kit (505 LOC at one, plus 377, 350, 252 of URL state at three). One recorded why, after a side-by-side: among look complaints, "a Previous keyset paging can never enable". Three reproduced defects underneath:
- Live rows, real Solid in Chrome, row `b` the same object across the update: `same-tr-for-unchanged-row=false`, `focus-before=btn-b`, `focus-after=BODY`. `rowKey` is required (`DataTable.tsx:61`) and only writes `data-row` (`:197`); `props.rows.map` (`:196`) rebuilds every row on every tick, and an open "more" `<details>` closes with it.
- The framework's page, `pageOf(rows, null)`: `tsc` says `TS2322 string | null is not assignable to string | undefined` on `nextCursor={page.nextCursor}`, the very line `wiki/UI-Components.md` shows. Cast past it: last page renders `<a href="/l?after=null" rel="next">`.
- `Page` has no previous cursor (`core/src/cursor-page.ts:22`), so on every framework list `Pagination` draws a disabled Previous forever (`Pagination.tsx:111`). Two adopters each wrote "First page / Next page" instead.

## Decisions
| Question | Answer |
|---|---|
| Keying | a per-key cell in `DataTable`: `Map<key, { signal, node }>`. Same object: same node, nothing runs. New object: same `<tr>`, cells redraw. Uses `solid()`'s `createSignal`; no `For`, `solid-js` stays type-only. Inert on a server: one pass |
| Previous | drawn only when `prevCursor` is given or numbered mode. The layout reason at `Pagination.tsx:90` is met in SCSS: Next keeps `margin-inline-start: auto` |
| Back to the start | `firstHref` in link mode, `onFirst` in callback mode. Keyset has no back |
| Where URL state goes | `ui`, pure, beside `sort-state.ts`: the hrefs feed `DataTable`'s `hrefFor`/`sortHrefFor`, and a page and an island share it. No new subpath: the barrel is the one import |
| Param names | default `sort`, `dir`, `after`, `limit`, `q`; `ns` prefixes all (`runs.after`) for two lists on a page, as two adopters do |
| Client-side `pushState` namespaces | not here: one adopter. `navigate(href, { replace })` exists |
| Rows, type, numerals, card frame | a look. `density` and `defineTheme` are the seams; nothing added |
| Virtualising | not here: one adopter, a transcript rather than a table |

## Files to change
- `packages/ui/src/components/DataTable.tsx:196` — keyed rows; `:213` hand `firstHref`/`onFirst` to the pager; `:61` doc states what `rowKey` promises.
- `packages/ui/src/components/data-table-rows.ts` (new) — the keyed cell's rule, pure over an injected runtime.
- `packages/ui/src/components/Pagination.tsx:18,70,90` — `nextCursor`/`prevCursor` take `string | null | undefined`; `null` and `undefined` are one state (`== null`); Previous rule; `firstHref`, `onFirst`, `labelFirst`.
- `packages/ui/src/components/Pagination.module.scss` — Next pinned to the end.
- `packages/ui/src/components/sparkline-view.ts:17,32`, `Sparkline.tsx:15` — same family, one row: `value: number | null`, one `M` per run, as `lineLayout`. Probe: `[5, null, 5]` draws `M4,4 L300,68 L596,4`, unknown as a dive to zero, though `LineChart` holds `null` is a gap. `sparkline-view.test.ts`: two runs, no point at the baseline; fails today.
- `packages/ui/src/list-url.ts` (new), `index.ts:240` — `listUrl`.
- `packages/ui/src/i18n-keys.ts:18`, `packages/i18n/src/catalogs/en.json` — `ui.first`.
- `packages/cli/src/templates/resource-page.ts:115` — generated list reads `listUrl`, renders `DataTable` in link mode; `:89` comment goes.
- `dummy/social-media-clone/apps/web/app/dashboard/page.tsx:146` — link-mode sort and pager, the deployed use.
- `wiki/UI-Components.md`, `wiki/Interface-Rules.md`, `packages/ui/README.md`, `packages/ui/CLAUDE.md`, `packages/ui/CATALOG.md` (`bun run --filter @ultimat3/ui catalog`).

## Steps
1. Pagination first: the type and the `null` rule, so `nextCursor={page.nextCursor}` compiles and the doc's line is true.
2. Keyed rows. A vanished key drops its cell. A duplicate key throws `X_UI_INVALID_VALUE`: two rows under one key cannot both keep a node.
3. `listUrl(url, { sorts, ns? })` returns `{ sort, cursor, limit, q, href(change), hrefFor, sortHrefFor, firstHref }`. Parsing never throws: an unknown sort or dir is the default. `href` keeps every other param and drops the list's cursor; `hrefFor` is the one that sets it; with `ns`, any non-cursor change drops every cursor on the page, since a cursor is bound to its filter and sort (`X_CURSOR_INVALID`).
4. Template and demo. Run `x g resource` on a scaffold; its list pages and sorts with no island.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_UI_INVALID_VALUE` (existing) | two rows answer one `rowKey` | make `rowKey` unique; the cause names the key |

## Tests
- `packages/ui/src/components/data-table-rows.test.ts` (unit, real Solid as `Form.test.ts`): same object keeps node; new object keeps `<tr>`, new cell; removal releases; duplicate throws.
- `packages/ui/src/components/Pagination.test.ts`: `null` renders no anchor and no `after=null`; `Page` assigned in a `type-pins` line; Previous absent with no `prevCursor`; `firstHref` renders a link.
- `packages/ui/src/list-url.test.ts`: hostile params default; cursor dropped on change; `ns` isolation.
- `packages/cli/e2e/data-table-live.e2e.test.ts` (browser): focus in an unchanged row, then a live update; `document.activeElement` is the same button.
- `packages/cli/src/templates/emitted-routes.test.ts`: generated list route registers. Command `bun test packages/ui/src/components/data-table-rows.test.ts`.
- `scripts/ui-barrel-bytes.test.ts`: `listUrl` adds nothing to a component-only island.

## Semver
breaking; lands in v32.
**Breaking, two rows.** `UI_KEYS` gains `first`, so the exported `UiKey` union widens: a `Record<UiKey, string>` in an app stops compiling. A duplicate `rowKey`, which rendered before, now throws.
Upgrading: "Add `ui.first` to any `Record<UiKey, string>`. Two rows answering one `rowKey` are `X_UI_INVALID_VALUE`: make the key unique. A cursor-mode `Pagination` with no `prevCursor` no longer draws a disabled Previous." Prop widenings, `Sparkline`'s `null` and `listUrl` are additive.

## Done when
- A live update leaves an unchanged row's DOM node and focus in place, in Chrome.
- `nextCursor={page.nextCursor}` compiles and the last page has no Next link.
- A scaffolded resource list sorts and pages with scripting off.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green; scaffold smoke green twice per shape.
