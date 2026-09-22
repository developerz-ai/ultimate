# 07 — `useQuery`: one read hook, lists hold ids

> Part of [`overview.md`](overview.md). Depends on: 02, 05, 06. Tier: 3.

Live-ness is a property of the query declaration, not of the hook an island picks. One read hook; a list is an id window over the store.

## Files to change
- `packages/realtime/src/use-query.ts` (new) — `useQuery(query, input)` → accessor of `AsyncState<readonly Row[]>` (core, slice 02). Non-live query: one `query.client()` dispatch through `clientTransport`, records adopted (slice 05), window = the ids in response order. Live query: subscribe over the page socket (`live-rows.ts:31` window). Either way rows are resolved from the `RecordStore`, so an update to a record re-renders every list containing it without refetching the list.
- `packages/realtime/src/hooks.ts:105,117` — `useLive` / `LiveRows` deleted.
- `packages/realtime/src/query-hook.ts` (`liveHookFor`) — deleted: a value import cost 698,801 B (`examples/dummy/apps/web/app/feed/live.ts:4-8`), so no island could use it. Also its references in `realtime/src/index.ts`, `type-pins.ts`, `errors.ts`, `packages/cli/src/live-routes.ts`.
- `useQuery` accepts a query **ref** (name + input schema type), never the query value — the same rule `app/feed/live.ts` works around by hand today; enforce with a type that has no server fields.
- Pagination: the window carries the server cursor; `more()` appends ids. Refetch keeps previous data (`refreshing`), matching `AsyncState`'s contract.

## Steps
1. Hook; delete `useLive`, `liveHookFor`; `BREAKING —` entries for both.
2. Island budget check: a `useQuery`-only island ≤ today's `useLive` island bytes.

## Tests
- `use-query.test.ts`: non-live → `pending` then `ready`; adopt of an updated record changes the rendered row without a second dispatch; live → frame updates; `refreshing` carries previous data; ids of a removed record drop out of the window.
- `bun test packages/realtime/src/use-query.test.ts`.

## Done when
- `rg "useLive|liveHookFor" packages examples --glob '!CHANGELOG.md'` empty.
