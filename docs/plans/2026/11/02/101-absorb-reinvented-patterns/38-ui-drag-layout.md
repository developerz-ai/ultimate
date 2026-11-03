# 38-ui-drag-layout — Reordering, boards and panes

> Part of [`overview.md`](overview.md). Depends on: [`23-ui-data-table.md`](23-ui-data-table.md) (keyed-node rule). Tier: 4 (`ui`).

## Why
Task boards, priority lists, editor and inspector panes: the three interactions a team reaches for a drag library to get, which the dependency bar refuses (`docs/idea/18-build-vs-wrap.md`). The kit has no drag gesture: `pointerdown` appears only for outside-click in `Menu` and `Popover` (`Menu.tsx:67`), and `Dropzone` takes file drops. An agent's first attempt is HTML5 drag events, which do not fire on touch and have no keyboard form. One adopter's board is 253 LOC, with Alt+arrows and a drop translated to a next step; the same adopter's pane splitter is `role="separator"` with a value, arrows, pointer capture, Escape restoring. The shape is known.

## Decisions
| Question | Answer |
|---|---|
| Gesture base | Pointer Events with capture, one module. Never HTML5 drag events |
| Touch vs scroll | drag starts from a handle with `touch-action: none`; the row body still scrolls. No long-press guesswork |
| What a drop does | calls `onMove({ id, fromGroup, toGroup, toIndex })`. The caller's action decides; the list reverts on rejection. A drop is a request, never local truth |
| Optimistic order | caller's. `useMutation`-side optimism is the framework's existing path; the component holds only drag preview |
| Without script | handle hidden; each row carries Move up and Move down, or a target `Select` for a board, as real form buttons in a `<form method="post">`. The move is an action in any case |
| Keyboard | handle is a button. Space lifts, arrows move, Space drops, Esc restores. Alt+arrow as a direct move on a focused card. Every step through `announce()` |
| Kanban a primitive? | `Board` = columns of `SortableList` groups, one module sharing the gesture. No card look: `Card` and `renderItem` are the caller's. Column set, limits, swimlanes: business |
| WIP limits, columns from a status enum | app's. `canDrop(item, group)` is the one seam |
| Auto-scroll | near the edges while dragging, per axis; speed capped. Under reduced motion stepwise |
| Virtualised sortable | no: lists a person reorders by hand are short |
| `SplitPane` | two panes, `role="separator"`, value as a percentage; stacks below `md` to one column, no gesture on a phone. N-pane grids and docking are killed: an IDE shell, not a kit member |
| Persisting a split | `onResize(percent)` + `value`. Storage is the caller's, never ambient |
| Hold still | live-tick rows beneath a drag keep their nodes (keyed rule); a dropped row's server echo does not jump |

## Components
| Component | Base | Keyboard | No script | Mobile | `examples/dummy` |
|---|---|---|---|---|---|
| `SortableList` | `<ul>` + handle buttons | Space, arrows, Esc | up and down form buttons | handle at `--touch-target`, page still scrolls | through `Board`, same page |
| `Board` | groups of `SortableList`, `role="group"` per column | arrows across columns | target `Select` per card | columns snap-scroll sideways, one column wide below `sm` | new `posts/board/page.tsx`, by `POST_STATUSES`, through the existing `actions/move-post-status.ts` |
| `SplitPane` | grid + `role="separator"` | arrows 5%, Home, End, Esc while dragging | fixed at `defaultValue`, CSS | one column below `md` | `runs/` log beside detail |

## Files to change
- `packages/ui/src/drag/pointer-drag.ts` (new) — capture, threshold, cancel, auto-scroll. Clock and geometry injected.
- `packages/ui/src/drag/sort-view.ts` (new) — pure: target index from pointer and rects, keyboard steps across groups, `canDrop`, announcements' params.
- `packages/ui/src/components/SortableList.tsx`, `.module.scss` (new).
- `packages/ui/src/components/Board.tsx`, `.module.scss`, `board-view.ts` (new).
- `packages/ui/src/components/SplitPane.tsx`, `.module.scss`, `split-pane-view.ts` (new) — clamp, keyboard step, `dir` sign.
- `packages/ui/src/index.ts`, `i18n-keys.ts`, `packages/i18n/src/catalogs/en.json` — exports; `ui.sort.lift`, `ui.sort.moved`, `ui.sort.dropped`, `ui.sort.cancelled`, `ui.sort.up`, `ui.sort.down`, `ui.pane.resize`. Existing `ui.sort.ascending` stays; `sort` is a branch already.
- `packages/ui/src/tokens/_z.scss` — a `drag` rung only if `t.z()` has no fitting one.
- `examples/dummy/apps/web/app/posts/board/page.tsx` plus its island and states, `runs/page.tsx`, `examples/dummy/x.manifest.json`, the app's catalog.
- `scripts/ui-barrel-bytes.test.ts`; `packages/ui/README.md`, `packages/ui/CLAUDE.md`, `packages/ui/CATALOG.md`, `wiki/Interface-Rules.md`, `wiki/UI-Components.md`.

## Steps
1. `sort-view.ts` and `split-pane-view.ts`, every rule pure and tested under `dir="rtl"`.
2. `pointer-drag.ts`. `pointercancel`, blur and a lost capture restore; no stuck drag.
3. `SortableList({ items, itemKey, renderItem, label, onMove, canDrop?, action? })`. `action` is the form URL for the no-script buttons; `Button loading`-style refusal: an `onMove` rejecting restores and announces.
4. `Board({ groups, itemKey, renderItem, onMove, canDrop? })`.
5. `SplitPane({ start, end, value?, defaultValue, min?, max?, onResize?, label })`.
6. Bench 200 rows, one dragged: frame time stated in the diff. Measure each island; no static cost beyond markup. Raise budgets with `measured:` and `why:`.

Reduced motion: the dragged row follows the pointer since that is input, not animation; settle and reorder transitions use token durations, which reduced motion collapses (`_motion.scss:19`).

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_UI_INVALID_VALUE` (existing) | two items share an `itemKey` across groups; `min` over `max`; a `value` outside them | cause names the id or the value |

## Tests
- Unit: `sort-view.test.ts` (indices across groups; `canDrop` false keeps origin), `split-pane-view.test.ts`, `pointer-drag.test.ts` (cancel restores; threshold ignores a tap).
- `packages/ui/src/components/interaction.test.ts`: lift, move, drop by keyboard calls `onMove` once with the right index; Esc calls nothing; each step announced; a rejected move restores the order.
- `packages/cli/e2e/ui-drag.e2e.test.ts` (browser, pointer and touch): drag across columns; scrolling from a card body does not lift; scripting off, form buttons post; a live update during a drag keeps the lifted row; `dir="rtl"`; 390 px. Command `bun test packages/ui/src/drag/sort-view.test.ts`.
- `scripts/ui-barrel-bytes.test.ts`: `SplitPane` retains no `sort-view` module; `Dropzone` no `drag/` module.

## Semver
breaking; lands in v32.
**Breaking, one row.** `UI_KEYS` gains keys. Upgrading: "Add `ui.sort.lift` and siblings, `ui.pane.resize`, to any `Record<UiKey, string>`." The rest is additive.

## Done when
- A card moves between columns by mouse, by touch, by keyboard only, and with scripting off, through one action.
- Dragging on a phone never blocks page scroll from a card's body.
- `SplitPane` is one column on a phone and restores on Esc on a desktop.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
