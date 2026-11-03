# 38-ui-lists — Long lists, trees, timelines and facts

> Part of [`overview.md`](overview.md). Depends on: [`23-ui-data-table.md`](23-ui-data-table.md) (the keyed-node rule), [`39-testing-render-nodes.md`](39-testing-render-nodes.md) (`renderNodes`, replacing `jsx-probe`). Tier: 4 (`ui`).

## Why
Four shapes every app of size draws, none in the kit. `Table` and `DataTable` are tabular; `InfiniteScroll` owns only the foot (`InfiniteScroll.tsx`: "never the list").
| Shape | Evidence |
|---|---|
| Virtual list | 558 LOC at one adopter, 112 at another; one DOM capped by hand at 2,000 log lines. Earlier kill was "one adopter"; a transcript, a log and a long feed all need it. `23-ui-data-table.md` keeps it out of tables, and so does this |
| Tree | 13 files, 730 LOC at one adopter (twice nested links), 285 + nodes at another. Files, org charts, folders, plans |
| Timeline | 476 and 450 LOC at two adopters, 208, 754 and 563 LOC for activity feeds at three. Same anatomy: when, who, what, a marker, a tone |
| Facts list | 56 LOC at one adopter, restated across detail pages at most. `Table` for two columns of label and value is the wrong landmark and stacks badly |

## Decisions
| Question | Answer |
|---|---|
| Activity feed a component? | no. `Timeline` + `InfiniteScroll` + `RelativeTime` (axiom 1); recipe in the README |
| Virtual without script | every row renders: the document carries the whole list, as a real `<ul>`. Server output stays complete and a caller bounds it by paging |
| Row height | measured per row with one `ResizeObserver`, `estimate` for the unseen. Fixed-height mode is not a second API: it is a right estimate |
| Stick to end | `follow` option: follows while at the end; a reader who scrolled up is left alone and offered one "back to the end" button. Prepended rows keep the reading position |
| Find in page | known cost: unrendered rows are not found. Stated in the docs; `LogViewer` adds its own filter |
| Keyboard | `role="list"` by default with natural Tab through the rendered rows, because a virtual `listbox` lies about what is there. `aria-setsize`, `aria-posinset` hold the true count |
| Reduced motion | `scrollTo` with `behavior: 'auto'` when `prefers-reduced-motion`; no smooth default anywhere |
| Tree state | server-renderable as nested `<details>` plus links: open and close are the platform's. `role="tree"` only in an island with `onSelect`, roving per APG. Two renderings of one node list, one component |
| Lazy tree nodes | `onExpand(id)` returns children, `loading` per node; island only |
| Checkbox tree | `Checkbox indeterminate` shipped; the composition is the caller's |
| Timeline grouping | day headers via `groupBy(item)`, labels already formatted: zone is the caller's by the date rule |
| Status vocabulary | `tone: Tone` + `icon`. No status map: words and tones are business (axiom 8) |

## Components
| Component | Base | Keyboard | No script | Mobile | `examples/dummy` |
|---|---|---|---|---|---|
| `VirtualList` | `<ul>` in a scroll box, spacers | natural Tab; End and Home via buttons | every row | momentum scroll kept, `overflow-anchor: none`; `content-visibility` not relied on | `feed/feed.island.tsx` |
| `Tree` | nested `<ul>` + `<details>`; island: `role="tree"` | arrows, left/right open and close per `dir`, Home, End, type-ahead | full, links | indent caps, rows at `--touch-target`, long names wrap | `runs/page.tsx`: connections by provider, link mode |
| `Timeline` | `<ol>`, `<time>` slot, marker | content's own | full | marker column stays, content wraps | `runs/run-view.tsx` |
| `DescriptionList` | `<dl>` with `<div>` groups | content's own | full | stacks below `sm`, by `@container` | `posts/[id]/page.tsx`, `runs/` |

## Files to change
- `packages/ui/src/components/VirtualList.tsx`, `.module.scss`, `virtual-list-view.ts` (new) — offsets, visible range with overscan, anchor correction, `atEnd`, all pure over numbers.
- `packages/ui/src/components/virtual-list-observer.ts` (new) — the one `ResizeObserver`, splits the file by the 200-line target.
- `packages/ui/src/components/Tree.tsx`, `TreeNode.tsx`, `.module.scss`, `tree-view.ts` (new) — flatten, visible order, next focus, level, `aria-*`.
- `packages/ui/src/components/Timeline.tsx`, `.module.scss`, `timeline-view.ts` (new).
- `packages/ui/src/components/DescriptionList.tsx`, `.module.scss` (new).
- `packages/ui/src/roving.ts` — `TREE_ITEM_SELECTOR`.
- `packages/ui/src/index.ts`, `i18n-keys.ts`, `packages/i18n/src/catalogs/en.json` — exports; `ui.list.toEnd`, `ui.tree.loading`.
- `examples/dummy/apps/web/app/feed/feed.island.tsx`, `runs/run-view.tsx`, `posts/[id]/page.tsx`, `runs/page.tsx`, `examples/dummy/x.manifest.json`.
- `scripts/ui-barrel-bytes.test.ts`; `packages/ui/README.md:193`, `packages/ui/CLAUDE.md`, `packages/ui/CATALOG.md`, `wiki/Interface-Rules.md`, `wiki/UI-Components.md`.

## Steps
1. `DescriptionList({ items: { term, detail: JSX }[], layout? })`, `Timeline({ items, groupBy?, label })`: server-only, no signals.
2. `virtual-list-view.ts`: tested over number arrays before any DOM. Item list keyed by `itemKey`, the `data-table-rows.ts` rule, so a visible row keeps its node across a live prepend.
3. `VirtualList({ items, itemKey, renderItem, estimate?, overscan?, follow?, label, class })`. Height comes from the caller's box: a token-sized container or `AppShell`'s main. A zero-height box renders everything, never nothing.
4. `Tree({ nodes, selected?, hrefFor?, onSelect?, onExpand?, label })`, a union on link and select modes.
5. Doc recipe: activity feed. Interface-Rules row: which list when.
6. Measure islands, bench 10,000 rows on the Solid chunk: mount time and memory stated in the diff. Static `Tree`, `Timeline`, `DescriptionList`: 0 B.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_UI_INVALID_VALUE` (existing) | two rows answer one `itemKey`; a tree id repeats; a node is its own ancestor | cause names the id |
A non-finite `estimate` or `overscan` is `finiteOption`'s assertion (`core/src/finite-option.ts:21`).

## Tests
- Unit: `virtual-list-view.test.ts` (a row above resizes: offset compensated; prepend keeps the first visible row; `atEnd` hysteresis), `tree-view.test.ts` (closed subtree skipped by arrows; `dir` flips left and right; cycle throws), `timeline-view.test.ts`.
- `packages/ui/src/components/interaction.test.ts`: `Tree` one tab stop in select mode, none added in link mode; `DescriptionList` markup by `renderNodes`.
- `packages/cli/e2e/ui-virtual-list.e2e.test.ts` (browser): 10,000 rows, under 100 `<li>` in the DOM; focus a row, prepend, focus and scroll position held; scrolled up, no jump on append; 390 px touch. Command `bun test packages/ui/src/components/virtual-list-view.test.ts`.
- `scripts/ui-barrel-bytes.test.ts`: `Timeline` retains no observer module.

## Semver
breaking; lands in v30.
**Breaking, one row.** `UI_KEYS` gains keys. Upgrading: "Add `ui.list.toEnd`, `ui.tree.loading` to any `Record<UiKey, string>`." The rest is additive.

## Done when
- A 10,000-row island feed scrolls on a phone with fewer than 100 rows mounted, and a live prepend moves nothing being read.
- A `Tree` of links is 0 B of script and works by keyboard through `<details>`.
- `Timeline` and `DescriptionList` replace the hand-rolled markup in the dummy's run and post pages.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
