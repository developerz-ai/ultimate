# 23-ui-live-refresh — A server-rendered page that stays true

> Part of [`overview.md`](overview.md). Depends on: none. [`25-pkg-realtime-client-reads.md`](25-pkg-realtime-client-reads.md) builds on `visibleInterval`. Tier: 0 (`core`), 4 (`render`), 5 (`cli` templates).

## Why
Five adopters keep a page fresh: the channel says when, the server says what. Three re-render the server's page, through `refresh()` or a swap of their own; two re-read inside an island. Four of the five carry 213, 262, 439 and 445 LOC of timers, gates and focus repair. One adopter's code says it outright: the router focuses `<main>` after a swap, a live tick must not move the visitor.
Probe, the real router on the repo's fixtures, one `refresh()`:
`focus before INPUT#q` · `focus after MAIN` · announcer text `"A"` (the title, re-read on every tick) · click on `/slow` then `refresh()`: `calls [GET /slow, GET /a]`, location stays `/a` (the visitor's click is lost) · open modal: `calls [GET /m, GET /a, GET /m]` (the page and the modal are both fetched again under a reader).
Five adopters also poll by hand. A background tab keeps asking; a tab past its session asks for a 401 forever (one adopter measured it in production: a hidden tab, two reads a minute, for hours). One still has a bare `setInterval` with no visibility check.

## Decisions
| Question | Answer |
|---|---|
| `refresh()` itself or a new option | itself. Same page, same visitor: the focus and title rules are bugs of `refresh`, not a mode |
| Scheduling | `scheduleRefresh()`, a separate export: "a channel event arrived" is not "re-read now" |
| Interval home | `@ultimat3/core/page`. Reaching `@ultimat3/realtime` ships the page runtime (54.6 kB, adopter-measured); three adopters kept their timers framework-free for this reason |
| Second way to read a list? | no. `useQuery` live stays the idiom for rows. `visibleInterval` is for what has no changefeed, and for the safety re-read of an at-most-once channel |
| Retention of "first 401" | on the `pageClient` handle (`core/src/record-sink.ts:46`): every island chunk has its own copy of core |
| Sign-in UI | the app's. Framework says "lost", once; no toast, no redirect, no copy (axiom 8) |
| Pause toggle, flash on change, live dot | app's: one adopter each, and a look |

## Files to change
- `packages/render/src/navigation.ts:461` — `refresh()` passes `{ history: 'none', refresh: true }`; `:194` a refresh never aborts `inflight`: resolve and do nothing, that navigation fetches fresh anyway.
- `packages/render/src/navigation.ts:283,317,318` — on refresh: no view transition, `focusMain` only when the marked control is gone, no announcer write.
- `packages/render/src/navigation-dom.ts:165` — `markFocus(doc)` / `restoreFocus(doc, mark)`: by `id`, else `name` in the same form, else row (`[data-row]`) + tag + nth, then `focusMain`. Pure beside `focusMain`.
- `packages/render/src/refresh-idle.ts` (new) — `scheduleRefresh()`; state on `window` under `Symbol.for('ultimate.refresh-idle')`, one per page across chunks.
- `packages/render/src/client.ts:14`, `index.ts` — export `scheduleRefresh`.
- `packages/core/src/visible-interval.ts` (new), `packages/core/src/session-lost.ts` (new), `packages/core/src/page.ts:16` — export `visibleInterval`, `onSessionLost`, `sessionIsLost`.
- `packages/core/src/record-sink.ts:46` — `sessionLost` cell on the handle.
- `packages/core/src/client-dispatch.ts:121` — after `problemError`: code `X_UNAUTHENTICATED` / `X_SESSION_EXPIRED` on a page whose `scope.principal` is a string marks the loss. An anonymous page's 401 is a wrong password, not a loss.
- `packages/core/src/client-scope.ts` — `rescope()` clears the flag.
- `packages/cli/src/templates/guard-raw-interval.ts` (new), `scaffold-guards.ts:53` — refuses `setInterval(` in `*.island.tsx`.
- `wiki/Client-Navigation.md:401`, `wiki/Client-Data.md:26` ("never poll" gains its exception, one row), `wiki/Realtime.md:129`, `wiki/Interface-Rules.md`, `packages/render/README.md:165`, `packages/core/README.md`, both `CLAUDE.md`, `docs/architecture/guards.md` (generated).

## Steps
1. `visibleInterval(run, ms, { maxMs? }): () => void`. Hidden tab: no call, no read; one make-up call when shown. `maxMs` doubles the wait from `ms` up to it (fallback poll, jitter from `backoffDelay`). `sessionIsLost()` at start returns a no-op disposer; a loss disposes. Idempotent disposer releases timer and both listeners. `ms` through `finiteOption`.
2. `onSessionLost(fn): () => void`; fires once per page, late subscribers immediately. Set in dispatch per the table.
3. `refresh()` per Files. Mark focus before the swap, restore after `runScripts`, so an island's mounted control is there.
4. `scheduleRefresh()`: coalesces. One running, one owed. Hidden: owed, paid on show. Held while `dialog[open]`, `[popover]:popover-open`, focus in `input, textarea, [contenteditable]`, a non-collapsed selection, `data-x-navigating`, or within `QUIET_MS` (1 s) of scroll, wheel, key or press; a press unreleased after 10 s stops holding. `sessionIsLost()`: nothing, ever. No router: does nothing rather than reload a page under a reader (the difference from `refresh`).
5. Guard, app-owned, code from `guardCode('raw-interval')`; a `// why:` on the line admits it.
6. The idiom, channel event to `scheduleRefresh()`, as one section in `wiki/Realtime.md`. `examples/dummy` unchanged: a helper, not a primitive.

## Error codes
None new. A non-finite `ms` is `finiteOption`'s assertion (`core/src/finite-option.ts:21`). The guard's code is the app's, named for the file.

## Tests
- `packages/render/src/navigation-refresh.test.ts` (unit, fixtures): the probe's four lines become assertions; each failed before the change.
- `packages/render/src/refresh-idle.test.ts` (unit, injected clock and doc): owed while hidden, held under an open dialog, one trailing run, two chunk copies share one state.
- `packages/core/src/visible-interval.test.ts`, `session-lost.test.ts` (unit): hidden makes no call and pays once; disposer leaves zero listeners; 401 on a scoped page fires once, on an anonymous page never; `rescope` resets.
- `packages/render/src/client-bundle.test.ts`, `packages/core` page-entry bytes: `visibleInterval` alone under a ceiling measured when written (axiom 9).
- `packages/cli/e2e/client-navigation-refresh.e2e.test.ts` (browser): focus stays on a control with an `id` across a refresh. Command `bun test packages/render/src/navigation-refresh.test.ts`.

## Semver
minor; behaviour fix to `refresh()`. Upgrading note only for an app relying on focus landing on `<main>` after `refresh()`, or on `refresh()` cancelling a navigation.

## Done when
- A `refresh()` from a focused input leaves focus on that input's successor and writes nothing to the announcer.
- A click in flight survives a `refresh()`.
- A tab with an expired session stops every `visibleInterval` after one 401.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
