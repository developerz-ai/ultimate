# 06 — RecordStore and one socket per page

> Part of [`overview.md`](overview.md). Depends on: 01, 04. Tier: 3.

## Files to change
- `packages/realtime/src/identity-map.ts:24,35` → `record-store.ts` (rename; delete the old file) — key is ALWAYS `recordType:recordKey` from slice 04; `privateScope(query)` deleted. Keeps retain/release + batched notify. Implements core's `RecordSink` (`adopt`, `remove`). Rows validated by the entity schema on adopt; a row failing it → `X_RECORD_REJECTED` (realtime `errors.ts`), dropped, logged — never partially merged.
- Merge rule: a patch that omits a field never clears it; a server-authoritative row replaces the synced layer; optimistic writes live in an overlay (existing `rebase.ts:50,97,176`) and never touch the synced layer.
- `packages/realtime/src/live-rows.ts:31` — live query windows hold ordered ids only; rows come from the store. Same for plain `query.client()` list results adopted in slice 05.
- `packages/realtime/src/client.ts:60,133,156` — `LiveClient` constructs its own socket (`new WebSocket` moves from the app's `shared/live-socket.ts:19` into a new `realtime/src/browser-socket.ts`, the ONE construction site). URL from the page handle (`/_x/sync`, port rule from `examples/dummy/apps/web/shared/sync-url.ts` moves into framework config). `connect()` idempotent per page.
- `packages/realtime/src/hooks.ts:23,26` — module singleton `setLiveClient` deleted; hooks read `pageClient()` (core, slice 01). New `useRecord(entity, id)` → accessor of the one record; `useRecords(entity, ids)`. `useLive` is replaced by `useQuery` in slice 07.
- `packages/realtime/src/client-contract.ts:19` — `ClientSocket` injection removed from the public surface (test harness keeps an internal seam: `client-harness-fixture.ts`).
- `packages/realtime/src/index.ts` — named exports; `sideEffects` stays `["./src/errors.ts"]` (never `false`, see root `CLAUDE.md` `side-effects` row).

## Steps
1. Rename + rekey the map; update `hooks-identity.test.ts`, `identity-map.test.ts` (→ `record-store.test.ts`).
2. Install the store into `pageClient()` on first hook use; the socket module loads via dynamic `import()` from the first live/channel/mutation hook, so a `useRecord`-only island does not ship the socket.
3. Delete `setLiveClient`, `hasLiveClient` users get `pageClient().socket !== undefined`.
4. Two islands in one page: both hooks observe the same record object — the acceptance test.

## Tests
- `record-store.test.ts`: `adopt` from HTTP then a socket patch → one record, both observers notified once per batch; omitted field not cleared; overlay rollback restores synced value; schema-invalid row → `X_RECORD_REJECTED`.
- `page-client.test.ts`: two independently evaluated copies of the realtime module (two bundles) share one store and open ONE socket (count constructions on a fake `WebSocket`).
- `hooks.test.ts`: `useRecord` on an id not yet loaded → `undefined`, then the record after adopt; release on cleanup evicts when refcount hits zero.
- Bundle: `useRecord`-only chunk ≤ today's `useLive`-only 8.4 kB baseline (record the figure).

## Done when
- `bun test packages/realtime` green; `rg 'new WebSocket' packages/*/src examples dummy --glob '!*.test.*'` → only `realtime/src/browser-socket.ts`.
