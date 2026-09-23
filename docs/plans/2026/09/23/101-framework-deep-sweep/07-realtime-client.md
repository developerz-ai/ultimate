# 07 — realtime, client side (plan 101/2026-09-22 follow-ups)

> Part of [`overview.md`](overview.md). Depends on: 06. Tier: 3.

Rule: a write the UI showed as queued is sent, once, in order, from any tab. A tab never ends up
connected to nothing without knowing it.

## Files to change

| # | Defect | File:line | Change | Semver |
|---|---|---|---|---|
| a | a write saved to IndexedDB as `inflight` is never resent after a reload, and later writes overtake it. `requeueInflight` has no caller since the socket write path was deleted | `packages/realtime/src/offline-queue.ts:270`, `page-outbox.ts:79` | In `OfflineQueue.open`, reset `inflight` → `pending`. The HTTP replay carries its idempotency key | patch |
| b | two tabs of one user overwrite each other's outbox: each keeps an in-memory copy and saves it whole, so the last save wins | `packages/realtime/src/page-outbox.ts:167-173`, `offline-queue.ts:85,148`, `local-store-idb.ts:125-129` | One IndexedDB record per mutation key (the shape of the records store, `local-store-idb.ts:130-140`). `replay()` under `navigator.locks.request('ultimate-outbox:<user>')` so one tab drains at a time | patch |
| c | `use-mutation` sends a new write over HTTP even while older writes wait in the outbox, so a like/unlike pair can land swapped | `packages/realtime/src/use-mutation.ts:141` | When `peekOutbox()?.size > 0`, enqueue and trigger a replay | patch |
| d | a reaped port, or `bye` on `pagehide` followed by a bfcache restore, leaves a tab's realtime dead until reload: `#detach` closes the port silently, `hostOver` never re-creates it, and a virtual socket waiting for `open` has no timeout | `packages/realtime/src/socket-engine.ts:158-164,288-298`, `socket-host.ts:62-75`, `page-socket.ts:53-54`, `client.ts:142-157` | The engine posts `{t:'close'}` before reaping. `page-socket` re-hosts (the `:47-51` shape) on `pageshow` with `persisted`, and when `open` is unanswered for 2 heartbeats. `bye` only when `!event.persisted` | patch |
| e | the SharedWorker keeps the first tab's build ID for its whole life, so a new-build tab shows "update available" for itself | `packages/realtime/src/socket-engine.ts:110,306-314`, `socket-host.ts:36` | Put the build ID in `workerName` so two builds never share an engine | patch |
| f | a `replay-gap` arriving during a catch-up read is ignored (`buffered !== null` returns early), and `#drain` discards frames from a newer epoch held during the read | `packages/realtime/src/client-channels.ts:229-233,252` | Set an `again` flag and re-run the catch-up in `#drain`, the `coalesceReloads` shape (`packages/cli/src/dev-reload.ts`). Keep newer-epoch frames for the rerun | patch |
| g | a failed catch-up marks the channel `live` and never retries | `packages/realtime/src/client-channels.ts:239-245,258` | Stay `catching-up`, retry on `backoffDelay` (core) or the next `onOpen`, and expose `failed` to the UI's `AsyncState` | patch |
| h | `done(tx)` settles only on `oncomplete`/`onerror`. A quota abort fires only `abort`, so `write`, `saveQueue`, `flush` and `enqueue` hang | `packages/realtime/src/local-store-idb.ts:286-295`, `idb-types.ts:23-28`, `idb-fake.ts` | Add `onabort` to the type and reject in `done()`. Teach the fake to fire `onabort` | patch |
| i | `use-query` sets `after` before the generation check, so a superseded `more()` page overwrites the cursor | `packages/realtime/src/use-query.ts:176-177,188` | Assign `after` only when `mine === generation` | patch |

## Steps
1. a, b and h first: silent loss of a queued write. Each test drives two `createOutbox` instances or a reload over one `MemoryLocalStore` / `idb-fake`.
2. d needs a browser-shaped test with `FakeSocket` and a fake `pageshow`. Where a real-browser claim cannot be tested in Bun, record it as a manual check in the PR (Chrome hidden-tab throttling, bfcache eligibility).
3. Close #506 and #507 in the same PR if the fixes cover them. Otherwise reference them.

## Tests
- `bun test packages/realtime/src`
- `bun run scripts/reference-app-gate.ts`: the e2e step exercises offline likes.

## Done when
- Two tabs, both offline, queue two writes and a reload sends both, in order.
- A reaped tab reconnects without a reload.
- Two gaps during one catch-up produce two reads.
