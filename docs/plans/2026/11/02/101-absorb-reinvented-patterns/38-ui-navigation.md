# 38-ui-navigation — The mobile frame and the ways around an app

> Part of [`overview.md`](overview.md). Depends on: [`39-testing-render-nodes.md`](39-testing-render-nodes.md) (`renderNodes`, replacing `jsx-probe`); [`23-ui-live-refresh.md`](23-ui-live-refresh.md) gives `PullToRefresh` its usual callback. Tier: 4 (`ui`), 5 (`cli` templates).

## Why
A phone-first dashboard needs a thumb-reach destination bar, a sidebar with groups and a current page, tabs that are URLs, and sheets that behave like sheets. `AppShell` takes any JSX as `sidebar` (`AppShell.tsx:24`), so each app draws its own list and its current state; the scaffold writes one (`scaffold-shell.ts:102`). No `safe-area` token exists: `rg safe-area packages/ui/src` finds nothing, so a bottom bar sits under the home indicator. `Tabs` is callback-only (`Tabs.tsx:23`), so a server-rendered page cannot use it without an island, and three adopters wrote link tabs or nav strips. `Stepper` is missing: one adopter's form steps and one wizard total 400+ LOC. `Drawer` already has `block-end` (`Drawer.tsx:14`) with no grabber, no drag and no safe area.

## Decisions
| Question | Answer |
|---|---|
| `Sheet` component | no: `Drawer side="block-end"` is the sheet (axiom 1). It gains `grabber`, drag to dismiss, `dvh` caps, safe area |
| `BottomNav` state | none. Links with `aria-current`, no script, server-rendered. Five items at most, more is `X_UI_INVALID_VALUE`: thumb reach, and a type error's cheap cousin |
| Where it mounts | `AppShell bottomNav`: visible below `md`, reserves space so content never hides under it; the menu button stays for the rest |
| `NavList` vs `Menu` | `Menu` runs commands; `NavList` goes places, links only. Groups, icon, badge, `current` by one `currentHref` and position rule (`Breadcrumb`'s), collapsible groups as `<details>` |
| Tabs as links | a union on `Tabs`, as `Pagination`: `hrefFor` + no `onChange`; link mode renders `<nav>` + `aria-current`, not `role="tab"`, since ARIA tabs promise panels on this page |
| Segmented control | not a component: `Radio appearance="segmented"` (native radios, form value kept) in [`38-ui-pickers.md`](38-ui-pickers.md) |
| `PullToRefresh` | re-judged: earlier kill was "a look". It is a gesture, needed where the browser has none (installed apps). No refresh of its own: `onRefresh: () => Promise<void>`, so `ui` never imports `render`. Scroll position stays. Off for `(pointer: fine)` |
| Skip a visible alternative? | no: every pull has a real button in the caller's `Toolbar`; documented, with `aria-busy` and `announce()` |
| Look of the bar | tokens; `glow-edge` is the app's to place. The `scifi` preset already styles it |

## Components
| Component | Base | Keyboard | No script | Mobile | `examples/dummy` |
|---|---|---|---|---|---|
| `BottomNav` | `<nav>` of `<a>` | native Tab | full | `--touch-target`, safe area, label under icon, 320 px holds five | `layout.tsx` |
| `NavList` | `<nav>`, `<ul>`, `<details>` | native | full | fits the `AppShell` popover panel | `layout.tsx` |
| `Tabs` link mode | `<nav>` of `<a>` | native | full | scrolls sideways in its own box, current scrolled into view | `settings/page.tsx` |
| `Stepper` | `<ol>`, `aria-current="step"` | passed steps are links or buttons | full in link mode | collapses to "Step 2 of 4: name" below `sm` | `posts/new` |
| `Drawer` sheet | native `<dialog>` | Esc; drag has no keyboard form, close button stays | as today | grabber, swipe from the grabber only, snaps `half`/`full` | `posts/[id]` comment sheet |
| `PullToRefresh` | wrapper, `overscroll-behavior-y: contain` | none, button is the way | inert | threshold, one resistance curve; reduced motion drops the follow | `feed/page.tsx` |

## Files to change
- `packages/ui/src/tokens/_touch.scss` — `safe-area-inset($edge)`, `safe-area-padding`; a value built from `env()`, token-guard-clean.
- `packages/ui/src/components/BottomNav.tsx`, `.module.scss`, `bottom-nav-view.ts` (new).
- `packages/ui/src/components/NavList.tsx`, `.module.scss`, `nav-list-view.ts` (new) — `currentOf(items, href)`: longest prefix wins, exactly one.
- `packages/ui/src/components/Stepper.tsx`, `.module.scss`, `stepper-view.ts` (new).
- `packages/ui/src/components/PullToRefresh.tsx`, `.module.scss`, `pull-refresh-view.ts` (new) — pure curve and state machine.
- `packages/ui/src/components/AppShell.tsx:19`, `AppShell.module.scss`, `app-shell-view.ts` — `bottomNav`.
- `packages/ui/src/components/Tabs.tsx:19`, `Tabs.module.scss` — link-mode union; `catalog/parse-component.ts` already merges modes.
- `packages/ui/src/components/Drawer.tsx:16`, `Drawer.module.scss:43`, `drawer-gesture-view.ts` (new) — `grabber`, `snap`.
- `packages/ui/src/index.ts`, `i18n-keys.ts`, `packages/i18n/src/catalogs/en.json` — exports; `ui.step`, `ui.refresh.*`.
- `packages/cli/src/templates/scaffold-shell.ts:102` — the frame uses `NavList` and `BottomNav`; `scaffold-shell.test.ts`.
- `examples/dummy/apps/web/app/layout.tsx`, `settings/page.tsx`, `posts/new/`, `posts/[id]/page.tsx`, `feed/page.tsx`, `examples/dummy/x.manifest.json`, `packages/i18n/catalogs/en.json` in the app.
- `scripts/ui-barrel-bytes.test.ts`; `packages/ui/README.md:175`, `packages/ui/CLAUDE.md:29`, `packages/ui/CATALOG.md`, `wiki/UI-Components.md`, `wiki/Interface-Rules.md`.

## Steps
1. Safe-area mixin; `AppShell bottomNav`. No space reserved at `md` and up.
2. `NavList`, `BottomNav`, with `currentOf`. Scaffold moves onto them: the shipped frame is the example an agent copies.
3. `Tabs` link mode. A button-mode `Tabs` renders byte-identically.
4. `Stepper`: `steps: { id, label, href?, state }`, one current by position.
5. `Drawer`: pointer events on the grabber only so the body scrolls; `touch-action: none` there; focus handling untouched.
6. `PullToRefresh`: only at `scrollTop === 0`, only `pointerType: touch`. A second pull during a refresh does nothing.
7. Measure islands; static stays 0 B. Baseline `Tabs` 28,709 B, this probe. Raise with `measured:` and `why:`.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_UI_INVALID_VALUE` (existing) | `BottomNav` over five items; two `Stepper` items `current`; link `Tabs` with a non-string href | cause names the count or the id |

## Tests
- Unit: `bottom-nav-view.test.ts`, `nav-list-view.test.ts` (`/runs/7` marks `/runs`, not `/`), `stepper-view.test.ts`, `pull-refresh-view.test.ts`, `drawer-gesture-view.test.ts`.
- `packages/ui/src/components/interaction.test.ts`: refresh rejecting ends the busy state; a double pull calls once.
- `packages/ui/src/components/Tabs.test.ts` (`renderNodes`): link mode has no `role="tab"`, one `aria-current`.
- `packages/cli/e2e/ui-mobile-frame.e2e.test.ts` (browser, 390×844, touch): last row reachable above the bar; `scrollWidth <= innerWidth`; drag a `block-end` drawer past half closes it and focus returns; `dir="rtl"`.
- `packages/cli/src/templates/scaffold-shell.test.ts`: frame renders with one current item. Command `bun test packages/ui/src/components/nav-list-view.test.ts`.

## Semver
breaking; lands in v30.
**Breaking, one row.** `UI_KEYS` gains keys. Upgrading: "Add `ui.step`, `ui.refresh.*` to any `Record<UiKey, string>`." `TabsProps` becomes a union: additive for callers, a reader typing `TabsProps['onChange']` as required gets `| undefined`, in the same note.

## Done when
- A scaffolded app has a current-marked sidebar and, on a phone, a bottom bar clear of the home indicator, with scripting off.
- A pull at the top of `feed` refreshes; a pull mid-list scrolls.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green; scaffold smoke green twice per shape.
