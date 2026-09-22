# 07 — On by default: island bootstrap, mutate wiring, scaffold

> Part of [`overview.md`](overview.md). Depends on: 03, 04, 05, 06. Tier: 5.

## Files to change
- `packages/cli/src/island-bundle.ts:71,84` — every island entry is wrapped with a tiny bootstrap that installs the page client (`pageClient()` from core; store installed lazily by realtime hooks). App code never calls `connect()` / `setLiveClient()`.
  - Measure first: per-island duplicated realtime runtime vs `splitting: true` with ONE shared runtime chunk. Pick by `island-bytes.test.ts` numbers; write the numbers into the file header. Either way the `globalThis` handle (slice 01) keeps state single.
- `packages/cli/src/dev-sync.ts:190-205` and `packages/cli/src/serve.ts` — pass `onMutate` to `createSyncNode`: resolve the mutator's action from the registry and run it server-authoritatively (policy + input schema + transaction), answer `ack`/`rebase`. Today every `mutate` frame answers `X_NOT_IMPLEMENTED` (`realtime/src/sync-frames.ts:143-160`).
- `packages/cli/src/templates/resource-form-island.ts:87` — generated island uses the action's typed `.client()`, not `fetch`; `x new` + every generator in `GENERATORS` emits zero raw fetch (the `scaffold-smoke` CI job runs them).
- `packages/cli/src/live-routes.ts` (`X_LIVE_ROUTE_NO_ISLAND`, `LIVE_HOOKS`) — add `useRecord`, `useChannel` to `LIVE_HOOKS`.
- `x new` scaffold: delete the template's `shared/live-socket.ts` / `sync-url.ts` equivalents if emitted.

## Steps
1. `onMutate` wiring first (it is a live bug independent of the rest); add `packages/cli/src/dev-sync.test.ts` case.
2. Bootstrap wrapper; measure; decide splitting.
3. Template + generators.

## Tests
- `dev-sync.test.ts`: a `mutate` frame for a registered mutator → `ack` and a record frame to other subscribers; unknown mutator → its registered code, not `X_NOT_IMPLEMENTED`.
- `island-bundle.test.ts`: two islands on one page, bootstrap runs twice, one handle.
- `serve.live.test.ts`: same mutate round-trip under `serve.ts`.
- `bun test packages/cli/src/dev-sync.test.ts`.

## Done when
- A freshly scaffolded app (`bun run x -- new /tmp/…`) runs `x verify` green with the default client and no app wiring.
