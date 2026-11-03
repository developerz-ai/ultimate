# 38-ui-commands — Confirmations, hotkeys and a palette that works by itself

> Part of [`overview.md`](overview.md). Depends on: [`23-ui-searchable-select.md`](23-ui-searchable-select.md) (`rankOptions`). Tier: 4 (`ui`), 5 (`cli` templates).

## Why
Destructive confirmation is the commonest place an agent writes the wrong thing: `window.confirm`, an OK button holding focus, a backdrop click that dismisses. Three adopters wrote it (358 + 273, 317 and 425 LOC), and one added a guard against `confirm(`. `Dialog` has `dismissOnBackdrop` (`Dialog.tsx:24`) and no safe default, no native post, no refusal path. Hotkeys: three adopters (207, 112 + sheet, 79 LOC), all with the same rules: never while typing, never with a modifier, chord window, legend from one table. `CommandPalette` is shipped but presentational: the caller writes the open flag, `⌘K`, focus and filter wiring (`CommandPalette.tsx:27`), and items have no groups (`command-palette-view.ts:5`); one adopter wrote 175 + 92 LOC rather than use it.
Earlier kills read "three designs" and "a look". Re-judged: an arm-twice button is an app's wrapper. The mechanism (safe focus, real post, busy, refusal) is one design under any look.

## Decisions
| Question | Answer |
|---|---|
| `ConfirmDialog` beside `Dialog` | a composite over `Dialog`, as `Toaster` over `Toast`. `Dialog` stays the general modal |
| Without script | `<button commandfor command="show-modal">` opens it; the dialog holds a real `<form method="post">`. A fallback for an engine without invoker commands fills the gap in an effect |
| Focus | Cancel holds `autofocus`. Enter on a dialog that just opened destroys nothing |
| Dismiss | Esc closes; backdrop never. Not an option: an option here is a bug waiting |
| Refusal | stays open, `Form error` inside, focused; caller's `onConfirm` returns a promise, `busy` refuses a second submit |
| Type to confirm, reason, TOTP | `children` slot with native constraints. The words and what they gate are business |
| Hotkey API | `useHotkeys(table)` over pure `hotkeyAction(event, state, table)`; `HotkeyTable = { keys: string[], label, run }[]`. One table feeds behaviour and `ShortcutSheet`: they cannot drift. Tables merge in the page's one slot, so the sheet lists every island's |
| `⌘K` and `?` | both are rows in that table: `useCommandPalette` registers `mod+k` through `useHotkeys`, `ShortcutSheet` registers `?`. A `mod+` key matches only with that modifier and fires in an editable field; a bare key keeps the typing and modifier rules. So `?` shows exactly the bindings, itself and the palette included |
| What is reserved | caller's table only. No shipped bindings; `/` or `g r` is an app's |
| Palette | keep `CommandPalette` presentational, add `useCommandPalette({ items, onRun, hotkey? })`, the shell every caller rewrites. Groups on the item, `keywords` for match. `filterItems` composes `rankOptions`: one ranker |
| Async palette items | `onQuery` debounced; `AsyncRegion`-free: `loading` prop and `ui.loading` |
| Tooltip positioning, hover card, context menu | no. `Tooltip`, `Popover`, `Menu` shipped; a right-click menu has no mobile or keyboard form |
| Native-confirm build error | `guard-native-confirm.ts`, app-owned, refuses `window.confirm(` and bare `confirm(` in `*.island.tsx` and `apps/web`. A `// why:` admits it (axiom 3) |

## Components
| Component | Base | Keyboard | No script | Mobile | `examples/dummy` |
|---|---|---|---|---|---|
| `ConfirmDialog` | native `<dialog>`, `Form`, `Button` | Esc, Tab trapped by the platform, Cancel focused | posts natively | full width, actions stacked with primary last in reach | `posts/[id]/page.tsx` through `actions/withdraw-post.ts` |
| `useHotkeys` | document `keydown`, one per page | chords with 1 s window, skip in editable fields and on modifiers, Esc allowed | inert | inert, nothing shown | `layout.tsx` |
| `ShortcutSheet` | `Dialog` + `Kbd` list, opened by `?` | Esc | hidden | not offered on `(hover: none)` | `layout.tsx` |
| `useCommandPalette` | `CommandPalette` | `⌘K`/`Ctrl K`, arrows, Enter, Esc; focus returns to the opener | palette inert, its destinations are links elsewhere | opens full width, top-anchored above the keyboard | `layout.tsx` |

## Files to change
- `packages/ui/src/components/ConfirmDialog.tsx`, `.module.scss`, `confirm-dialog-view.ts` (new) — the state machine: idle, busy, refused.
- `packages/ui/src/hotkeys-view.ts`, `use-hotkeys.ts` (new) — pure decision, Solid shell; one listener per page via a `Symbol.for` slot, as `refresh-idle.ts`: each island chunk has its own copy.
- `packages/ui/src/components/ShortcutSheet.tsx`, `.module.scss` (new).
- `packages/ui/src/components/use-command-palette.ts` (new) — open, query, active, restore focus; `filterItems`, `settleActive`, `stepActive`, `keyAction` reused.
- `packages/ui/src/components/command-palette-view.ts:5` — `group?`, `keywords?`; `filterItems` over `rankOptions` (`cafe` finds `Café`; today's `toLowerCase` does not).
- `packages/ui/src/components/CommandPalette.tsx`, `.module.scss` — group headers, `role="group"`, `loading`.
- `packages/ui/src/index.ts`, `i18n-keys.ts`, `packages/i18n/src/catalogs/en.json` — exports; `ui.shortcuts`, `ui.confirm.*`.
- `packages/cli/src/templates/guard-native-confirm.ts` (new), `scaffold-guards.ts:53`.
- `packages/cli/src/templates/scaffold-shell.ts` — palette island with nav items, behind `--example`; the only always-on island stays the toggle unless measured and stated.
- `examples/dummy/apps/web/app/layout.tsx`, `posts/[id]/page.tsx`, `examples/dummy/x.manifest.json`.
- `scripts/ui-barrel-bytes.test.ts`; `packages/ui/README.md:563`, `packages/ui/CLAUDE.md`, `packages/ui/CATALOG.md`, `wiki/Interface-Rules.md`, `wiki/UI-Components.md`, `docs/architecture/guards.md` (generated).

## Steps
1. `ConfirmDialog({ title, consequence, confirmLabel, tone, trigger, action?, onConfirm?, error?, children? })`. A union: `action` for a native post, `onConfirm` for an island. Verb label required, no `ui.confirm` default ("Delete post", never "OK").
2. Guard. Shipped copy, listed by `x doctor`.
3. `hotkeyAction` pure, then `useHotkeys`. Editable means `input, textarea, select, [contenteditable]`. IME composition skipped (`isComposing`).
4. `ShortcutSheet`, reads the same table.
5. `useCommandPalette`, its `mod+k` row through `useHotkeys`, groups, match. `CommandPalette` props without groups render as today.
6. Measure: baseline `CommandPalette` 27,535 B, `Dialog` 29,470 B, this probe. `ConfirmDialog` in a static route is 0 B plus the invoker-gap script only if the route declares its island.

Motion: token durations through the `Dialog` sheet; nothing added.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_UI_INVALID_VALUE` (existing) | a hotkey bound twice; a chord over two keys; an empty `confirmLabel` | cause names the keys |
| guard's own, `guardCode('native-confirm')` | `confirm(` in app code | use `ConfirmDialog`; `// why:` on the line admits it |

## Tests
- Unit: `confirm-dialog-view.test.ts`, `hotkeys-view.test.ts` (a bare key ignored while typing, with a modifier, past the window, under composition; `mod+k` fires while typing), `command-palette-view.test.ts` (groups kept in order after a filter; accent-folded).
- `packages/ui/src/components/interaction.test.ts` (fake DOM): Cancel focused on open; a refused `onConfirm` stays open with focus on the summary; double submit one call; two chunk copies of `useHotkeys` bind once; the sheet lists `mod+k` and `?`, and removing a row from the table removes both the binding and the line.
- `packages/cli/src/templates/guard-native-confirm.test.ts`: planted `confirm(` fails, a comment does not.
- `packages/cli/e2e/ui-confirm.e2e.test.ts` (browser): scripting off posts; Enter straight after open does not post; backdrop click stays open; focus returns to the trigger; 390 px. Command `bun test packages/ui/src/hotkeys-view.test.ts`.

## Semver
breaking; lands in v32.
**Breaking, one row.** `UI_KEYS` gains keys. Upgrading: "Add `ui.shortcuts`, `ui.confirm.*` to any `Record<UiKey, string>`. `x doctor` lists `guard-native-confirm` as missing; `x g guard native-confirm` adopts it." Palette matching folds accents: a behaviour widening, in the same note.

## Done when
- Withdrawing a post in `examples/dummy` asks through `ConfirmDialog`, posts with scripting off, and cannot be confirmed by a stray Enter or dismissed by a stray click.
- `?` shows exactly the bindings that work.
- `⌘K` on a dummy page needs under ten lines of caller code.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green; scaffold smoke green twice per shape.
