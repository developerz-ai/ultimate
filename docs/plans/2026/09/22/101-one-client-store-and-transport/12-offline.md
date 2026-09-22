# 12 — Offline: persisted records, one outbox

> Part of [`overview.md`](overview.md). Depends on: 03, 04, 06, 08. Tier: 3 (realtime), 4 (pwa).

## Files to change
- `packages/realtime/src/local-store.ts:63,236` — delete the OPFS variant that throws `NotImplemented`; add `IndexedDbLocalStore` (IndexedDB is the portable browser store; `MemoryLocalStore` stays for tests/SSR). Rows keyed `accountScope:recordType:recordKey` — the account/user scope in the key so one principal's cache never restores into another's.
- `packages/realtime/src/record-persister.ts` (new) — snapshots entities whose `recordProjection.persist === true` (slice 04); debounced write, flush on `pagehide`/`visibilitychange:hidden`; restore on boot BEFORE the socket connects, through a `restore` path distinct from `adopt` (restored rows are stale-until-confirmed; the first server row wins).
- `packages/realtime/src/offline-queue.ts:64` — becomes persistent over the same IndexedDB DB; it is the ONE outbox. Replays on reconnect in order **over HTTP** through `clientTransport` (slice 08 — the socket carries no writes), each with its idempotency key so a replay after a lost response is answered from `action`'s idempotency store (`action/src/idempotency-postgres.ts`), never applied twice.
- `packages/pwa/src/background-sync.ts:38,77` — `/_x/outbox/flush` is mounted by nothing. Delete it and have the SW's sync event post a message to open clients to drain the realtime queue — one outbox, not two. If no client is open, the queue drains on next load (documented, not faked).
- `packages/realtime/src/errors.ts` — `X_LOCAL_STORE_UNAVAILABLE` (IndexedDB blocked / private mode) → falls back to memory with one warning, never breaks the page.

## Steps
1. IndexedDB store + tests with a fake IDB (no new dependency; write a minimal in-repo fake under `realtime/src/idb-fake.ts` if Bun lacks one).
2. Persister; wire from the page client install (slice 06).
3. Queue persistence + replay; delete pwa's flush route and update `docs/idea/08-pwa-offline.md:49,125`.
4. Sign-out/scope change: wipe that scope's rows + queue via the scope fence (slice 03) — the fence is the one signal; this slice only registers the wipe.

## Tests
- `local-store-idb.test.ts`: write/read/wipe by scope; blocked IDB → memory + `X_LOCAL_STORE_UNAVAILABLE` warning.
- `record-persister.test.ts`: `persist: false` entities never written; restore then server row → server row wins.
- `offline-queue.test.ts`: queued mutation survives a simulated reload; replays once; ack drops it; failure rolls back overlay.
- e2e in slice 16 covers the real browser.

## Done when
- `wiki/Known-Gaps.md:49` (`persist: true` accepted by nothing) deleted as closed.
- `bun test packages/realtime packages/pwa` green.
