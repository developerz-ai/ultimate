# 10 — realtime: a deploy that subscribers do not feel

> Part of [`overview.md`](overview.md). Depends on: [`01`](01-hotfix-patch.md) (the parsed-input window key and the cold-window fix ship there). Tier: 3.

The demo rolled 11 times in 12 h; each roll restarted the replicator, and each restart re-snapshotted every live window on every sync node.

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| R1 | P2 | confirmed | `packages/realtime/src/replicator.ts:285` (a new `producer` per run); `replicator-envelope.ts:127-152` ("a NEW producer after a known one IS a gap"); `sync-bus-handlers.ts:106-116` | Every replicator restart makes every sync node `invalidate()` every live window and records channel: one re-read per window per node and a snapshot frame per subscriber, even after a clean `stop()` that published everything | gap detection by an **lsn chain** that survives a restart: each envelope carries `prev` (the lsn of the previous change this run published); a run's first envelope carries the slot position it resumed `from`. A node raises a gap only when `prev > lastLsnSeen`. A clean handover chains; a crash still gaps, because the new run's `from` lies below changes the node never saw |
| R2 | P3 | plausible | `pg-replication.ts:169-178`; `pg-connection.ts:290-300` | `stop()` sends `CopyDone`, then `close()` writes `Terminate` and closes without reading the walsender's reply. Unread bytes at close → the kernel sends RST: the `Connection reset by peer` logged on every deploy (9 in 13.7 h) | after `endCopy()`, drain until `ReadyForQuery`, bounded at 1 s; then `Terminate` and close |
| R3 | P3 | confirmed | `live-entries.ts:63-70` | `targets()` walks every entry on the node per change: 0.23 ms at 10k entries, ~1.2 ms at 50k, a ceiling near 800 changes/s | an `#owing` set maintained where `stale`/`applied` change (a setter on `QueryEntry`), unioned with `readersOf(table)` |
| R4 | P3 | gap; 4 adopters hand-rolled a safety re-read (two near-identical 115-line copies) | `packages/realtime/src/query-poll.ts:17` (`pollEvery()` exists) | Not discovered. The `raw-interval` guard does not name it | the guard's fix text names `pollEvery`; back-off default in [`02`](02-schema-core.md) C7; discovery in [`19`](19-agent-tooling-dx.md) |
| R5 | — | owner decision OD4 | — | No duplex byte stream to a browser (one adopter serves a terminal by long-poll action) | decide in [`90`](90-owner-decisions.md): a duplex channel kind, or documented out of scope. Not planned until decided |
| R7 | P2 | confirmed (code) | `reactivity.ts:9-26` (`RealtimeInstall`: `signal`, `sync`, no cleanup); doc comments at `use-channel.ts:11`, `use-record.ts:16`, `use-connection.ts:9` ("the caller owns it") | A hook's subscription is released only if the island author writes `onCleanup(() => handle.release())`. Nothing enforces it (`X_ISLAND_DISPOSER_MISSING` checks the mount's disposer only). A forgotten release holds a socket subscription and a cap slot across every client navigation, until `X_SUBSCRIPTION_LIMIT` | `cleanup?: (fn) => void` on `RealtimeInstall`; the island bootstrap (`packages/cli/src/island-realtime.ts`) passes Solid's `onCleanup`; every `use*` hook registers its own release through it. Explicit `release()` stays for use outside a component |
| R8 | — | measured out, **not planned** | `sync-node.ts:375-380` (no `perMessageDeflate`) | Frames are sent uncompressed | leave: per-socket zlib memory at 50k sockets outweighs small matcher patches, and per-socket deflate gives up encode-once. Recorded so the next audit does not rediscover it |
| R9 | P2 | plausible | `packages/realtime/src/use-mutation.ts:195-221` | Online writes are not ordered: only writes behind a non-empty outbox queue. Two online calls (like, then unlike) are POSTed concurrently and may commit in either order, so the final state can contradict the last overlay the user saw | reproduce first (two replicas, a delayed first POST). Then one serial lane per mutator name (or per record key a twin touches) in `PageWrites`: the next POST starts when the previous settles |
| R10 | P3 | partial (catalogue) | `packages/realtime/src/sync-upgrade.ts:162` (a global cap only); `device-socket.ts:48` has a per-actor cap | The sync socket has no per-actor connection cap | `maxSocketsPerActor` on the sync node, the device socket's rule |
| R6 | P3 | confirmed | `nats-transport-redial.test.ts:137-260`, `nats-transport-background.test.ts:84`, `presence.live.test.ts:86`; 72 real-clock sleeps in the package | ordering and negative claims rest on real waits | [`17`](17-test-determinism.md) |

Checked and fine, not planned: pgoutput decode (one null-prototype row per tuple, relation cache per connection), half-open walsender detection, NATS publish refusing while reconnecting, client reconnect jitter, slow-consumer eviction, serialise-once fan-out, the SIGTERM path (`packages/cli/src/hold.ts:97` → `role-start.ts:452-461` → `role-replicator.ts:199-204`).

Unread after four passes is listed in [`overview.md`](overview.md) *Risks*; the security and concurrency review passes of this sweep cover `channel-*` and `socket-engine.ts`.

## Files to change
- `packages/realtime/src/replicator-envelope.ts`, `replicator.ts`, `sync-bus-handlers.ts` — R1. The envelope gains a field: version it; a node that sees an envelope without `prev` keeps today's producer rule (mixed fleet during a roll).
- `packages/realtime/src/pg-connection.ts`, `pg-replication.ts` — R2.
- `packages/realtime/src/live-entries.ts`, `query-window.ts` — R3.
- `packages/realtime/src/use-mutation.ts`, `page-store.ts` — R9. `sync-upgrade.ts`, `sync-node-bounds.ts` — R10.
- `packages/realtime/src/reactivity.ts`, `use-query.ts`, `use-record.ts`, `use-channel.ts`, `use-connection.ts`, `use-outbox.ts`, `use-record-changes.ts`; `packages/cli/src/island-realtime.ts` — R7. Then delete the hand-written `onCleanup(release)` lines in `examples/dummy` islands (`feed.island.tsx:108`, `run-console.island.tsx:199`) in [`18`](18-tracked-apps.md).
- `packages/realtime/README.md`, `CLAUDE.md`; `wiki/` realtime page (rollout cost, stated).
- Coordinator only: changelog + `wiki/Upgrading.md` (envelope version; roll order: sync nodes before the replicator), `bun run manifest`.

## Steps
1. R1 first, one worker, with the mixed-version case written before the fix: old replicator + new node, new replicator + old node — both must fall back to "gap", never to "no gap".
2. R2 with a fake socket holding a pending server reply at stop.
3. R3 with a bench row in `scripts/bench/` at 50k entries; the claim is "per-change cost independent of the entry count".
4. After release: count slot restarts and `Connection reset by peer` over one day of rollouts through the infrastructure log path ([`30`](30-infra.md) I3).

## Tests
- `packages/realtime/src/replicator-envelope.test.ts` — restart after a clean stop: 0 invalidations; kill mid-stream: 1; envelope without `prev`: producer rule.
- `packages/realtime/src/pg-connection.test.ts` — `Terminate` written after `ReadyForQuery`; the drain gives up at 1 s.
- `packages/realtime/src/live-entries.test.ts` — `#owing` equals the walked set for a randomised sequence of stale/applied transitions (property test).
- `packages/realtime/src/use-hooks-cleanup.test.ts` — an island mounted then disposed with no explicit `release`: tracked sockets and subscription count unchanged from before the mount.
- `packages/realtime/src/use-mutation.test.ts` — two calls of one mutator: the second POST is not sent until the first resolves.
- `packages/realtime/src/replicator.live.test.ts` — stop + start against the local Postgres: subscribers receive no snapshot frame.
- Command: `bun test ./packages/realtime/src/<file>.test.ts`.

## Done when
- A rollout of the replicator after a clean stop causes zero window invalidations (live test), and a crash causes exactly one per window.
- No `Connection reset by peer` from the replicator's own shutdown in the database log.
- The 50k-entry bench row is flat.
