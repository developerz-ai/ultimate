# 10 — Docs and the major

> Part of [`overview.md`](overview.md). Depends on: 01–09. Tier: docs.

## Files to change
- `docs/architecture/21-client-data-layer.md` (new; next number after `20-flight-control.md`) — the three seams, data-flow diagram from `overview.md`, rules: one record per `entity:id`; lists hold ids, the store holds rows; optimistic = overlay, never synced layer; one frame one write; a patch omitting a field never clears it; channels are the only realtime subscription; persisted rows are keyed by principal scope. Add to `docs/architecture/README.md`.
- `docs/idea/00-thesis.md:39` — "Shipped As of 2026-08" was false (per-island, per-query key); restate `As of <release month>`.
- `docs/idea/03-realtime.md:9-15,61-63` — `persist: true` shipped; OPFS removed in favour of IndexedDB.
- `docs/idea/08-pwa-offline.md:49,125` — one outbox; flush route deleted.
- `wiki/Realtime.md:14,106,135-178,233-260` — delete the `connect()`→`setLiveClient()` recipe; `useRecord`/`useChannel` recipe.
- `wiki/Queries-And-Live-Queries.md:57-120` — clients adopt into the store.
- `wiki/Error-Codes.md` — every code from slices 01–08.
- `wiki/Known-Gaps.md:49` — delete.
- `packages/{core,entity,action,query,realtime,pwa,cli}/README.md` + `CLAUDE.md` — public API and the measured bundle figures.
- `CHANGELOG.md` `[Unreleased]` + `wiki/Upgrading.md` — one `BREAKING —` entry per removed surface, each naming its manual edit: `setLiveClient`/`connect()` in islands, string `subscribe(topic)`, client `publish`, `ClientSocket` injection, OPFS store, `/_x/outbox/flush`, `IdentityMap` rename. `bun run changelog-check`.
- `llms.txt` — client data layer line.

## Steps
1. Hand to `docs-author` agent with this file; every claim verified against code.

## Tests
- `bun run changelog-check`, `bun run scripts/doc-config-keys.ts`, `bun run gate-codes`, `bun run package-map-graph`.

## Done when
- `bun run verify` green, all 20 steps; `bun run scripts/reference-app-gate.ts` green.
