# 08 — One write path: HTTP; the socket is read-only

> Part of [`overview.md`](overview.md). Depends on: 02, 05, 06. Tier: 3.

**Decided:** every client write — plain action or mutator — goes over HTTP through `clientTransport`. The socket carries subscriptions and server→client frames only.

| Why HTTP wins | Evidence |
|---|---|
| already has authz, input schema, idempotency store, OpenAPI, contract tests | `packages/action/src/client.ts`, `action/src/idempotency-postgres.ts` |
| the socket write path never worked: no host wires `onMutate`, every `mutate` frame answers `X_NOT_IMPLEMENTED` | `packages/cli/src/dev-sync.ts:190-205`, `packages/realtime/src/sync-frames.ts:143-160` |
| one retry/offline story: the outbox replays HTTP with idempotency keys (slice 12) | — |
| other clients still see the write live: the server publishes the resulting records on the entity's channels (slice 09) | — |

## Files to change
- `packages/realtime/src/hooks.ts:182-220` — `useMutation(mutator)`: (1) run `mutator.local` into the store **overlay** (never the synced layer), (2) dispatch the mutator's action via its typed client with an idempotency key, (3) adopt the response's records, (4) drop the overlay, (5) on failure roll back the overlay and return the registered error. Offline → enqueue (slice 12) and keep the overlay.
- `packages/realtime/src/client-mutations.ts:40,94` — socket sender deleted; `recordMutation` becomes the overlay step above.
- `packages/realtime/src/client-frames.ts:127,142` — `ack` / `rebase` frame handling deleted; rebase now runs when a server record arrives (HTTP response OR channel frame) on top of pending overlays, using `ConflictPolicy` (slice 02).
- `packages/realtime/src/sync-frames.ts:143-160` + server `onMutate` option on `createSyncNode` — deleted; `mutate` frame refused with the protocol-mismatch close.
- `realtime` can call the action's client without importing `@ultimat3/action`: `MutatorLike` (`hooks.ts:182`) carries the typed client function the mutator already projects — confirm it; if it does not, `action`'s mutator projection adds `.client` (action is where the mutator is declared).

## Steps
1. Rewrite `useMutation`; delete socket write path server + client.
2. `BREAKING —` entries: `onMutate` option removed; `mutate`/`ack`/`rebase` frames removed; sync protocol version (bumped once, shared with slice 09).

## Tests
- `use-mutation.test.ts`: overlay visible synchronously in every `useRecord` of that row; success → server record replaces overlay, no flicker (adopt before drop); failure → overlay rolled back, error code surfaced; two pending overlays on one row replay in order over a server update.
- `sync-frames.test.ts`: `mutate` frame → mismatch close.
- `bun test packages/realtime`.

## Done when
- `rg "onMutate|'mutate'" packages/*/src --glob '!*.test.ts'` empty; a like in `examples/dummy` persists (slice 16 e2e).
