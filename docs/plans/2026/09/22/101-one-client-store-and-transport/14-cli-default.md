# 14 — On by default: island bootstrap, scaffold

> Part of [`overview.md`](overview.md). Depends on: 05, 06, 07, 08, 09, 11, 12. Tier: 5.

## Files to change
- `packages/cli/src/island-bundle.ts:71,84` — every island entry is wrapped with a tiny bootstrap that installs the page client (`pageClient()`, slice 01; store installed lazily by realtime hooks). App code never calls `connect()` / `setLiveClient()`.
  - **Decided: `splitting: false` stays for 21.0.0.** Budgets are per island chunk and measured today (`examples/dummy/apps/web/island-bytes.test.ts`); the `globalThis` handle makes STATE single even with duplicated CODE. A shared runtime chunk is a bytes optimisation with its own budget semantics — out of scope, named in `docs/architecture/21-client-data-layer.md` as the next lever. Record the per-island bytes before/after in the file header.
- `packages/cli/src/dev-sync.ts:190-205`, `packages/cli/src/serve.ts` — no `onMutate` wiring: slice 08 deletes socket writes, which is what fixes `X_NOT_IMPLEMENTED` on every `useMutation`. This slice deletes whatever `mutate` plumbing remains in the hosts.
- `packages/cli/src/templates/resource-form-island.ts:87` — generated island uses the action's typed `.client()` / `useMutation`, never `fetch`; `x new` + every generator in `GENERATORS` emits zero raw fetch (the `scaffold-smoke` CI job runs them).
- `packages/cli/src/live-routes.ts` (`X_LIVE_ROUTE_NO_ISLAND`, `LIVE_HOOKS`) — `LIVE_HOOKS` becomes `useQuery` (live queries only), `useRecord`, `useChannel`; `useLive` removed (slice 07).
- `x new` scaffold: emit no app-owned socket or sync-URL module; the sync URL comes from framework config.

## Steps
1. Bootstrap wrapper; measure; header figures.
2. Template + generators; host cleanup.

## Tests
- `island-bundle.test.ts`: two islands on one page, bootstrap runs twice, one handle.
- `dev-sync.test.ts` / `serve.live.test.ts`: a legacy `mutate` frame is refused with the protocol-mismatch close, not `X_NOT_IMPLEMENTED`.
- Scaffold: `bun run x -- new <scratch dir>` then its `x verify` green.

## Done when
- A freshly scaffolded app runs `x verify` green with the default client and no app wiring.
