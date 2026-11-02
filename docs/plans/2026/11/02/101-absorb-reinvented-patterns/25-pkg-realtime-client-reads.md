# 25 — Client reads: `useQuery({ everyMs })`, no pointless hold

> Part of [`overview.md`](overview.md). Depends on: [`23-ui-live-refresh.md`](23-ui-live-refresh.md) (`visibleInterval`, session loss). Tier: 3 (`realtime`), 5 (`cli`).

## Why
**Polling.** Channels are at-most-once by declaration, so live lists keep a safety read. Three adopters built one by hand: one 75 lines used by four islands and a feed, one 115 lines plus five raw timers, one 106 lines. [`23`](23-ui-live-refresh.md) ships the timer and the session flag; this is the `useQuery` spelling of it.
**Hold.** `useQuery` hides its island until mount, up to 3,000 ms (`packages/render/src/island-hold.ts:16`), because any name outside the follow list reads as `restores` (`packages/cli/src/island-realtime-state.ts:73-79`). It never asks whether anything can be restored. Three adopters declare zero `persist: true` entities. One measured 22–90 ms of blank list on localhost and pins a test so that no shared module imports `useQuery`. Across three adopters, `useQuery` is in 2 of 131 islands.

## Files to change
- `packages/realtime/src/use-query.ts:53` — `QueryOptions.everyMs`.
- `packages/cli/src/island-realtime-state.ts:73` — `followsOnly` takes whether the app persists any record.
- `packages/cli/src/island-realtime.ts:60` — pass it, read from `recordProjection(entity).persist` (`packages/entity/src/entity.ts:421`).
- `wiki/Client-Data.md` (one-idiom table), `wiki/Queries-And-Live-Queries.md`, `wiki/Realtime.md`, `packages/realtime/README.md`, `packages/realtime/CLAUDE.md`.
- `examples/dummy` — one island takes `everyMs`; regenerate `x.manifest.json`, `verify --only manifest,budgets`.

## Steps
1. `useQuery(ref, input, { everyMs })` on a non-live read runs `refetch` through `visibleInterval` from `@ultimat3/core/page`, released with the accessor. Hidden tab, catch-up, session loss and the screen on `ms` are `visibleInterval`'s. Refused on a live ref by a type: a live read has its socket.
2. Classification: with no persisted entity in the app, `useQuery` and `useRecord` count as `follows`. `useMutation` stays `restores`, since the outbox rebuilds overlays. An entity set that cannot be read at build keeps today's answer, the safe direction.
3. Measure island bytes before and after; raise any budget by the measured figure, stating the reason (`bun run budget-raises`).

Keeps the safety read in the app's hands: nothing here turns channels into replay. `catchUp` and `replay-gap` already exist.

## Error codes
None new. A non-finite `everyMs` is `finiteOption`'s assertion, inside `visibleInterval`.

## Tests
- `packages/realtime/src/use-query.test.ts`: `everyMs` refetches; `release` stops it; a lost session stops it, through the real `visibleInterval`.
- `packages/cli/src/island-realtime-state.test.ts`: `useQuery` with no persisted entity is `follows`; with one, `restores`; `useMutation` always `restores`.
- `packages/cli/e2e`: a served page of a no-persist app carries no `data-x-hold` on a `useQuery` island; the reference app, which persists, still does.
- `bun test packages/cli/src/island-realtime-state.test.ts`

## Semver
Minor. Observable: a no-persist app's `useQuery` islands paint earlier. No Upgrading row.

## Done when
- An adopter's interval helper reduces to `{ everyMs }`.
- The two e2e answers hold, and `bun run scripts/reference-app-gate.ts` is green.
