# Sweep 2 — realtime (files sweep 1 left unread)
> Re-checked in [`sweep-3-verify-backend.md`](sweep-3-verify-backend.md) — where it narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only hunt at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: `packages/realtime/src` outside sweep 1's list — Postgres wire and replication, live
> queries, node and sockets, channels and presence, client, store and outbox, the bus.
> All paths below are under `packages/realtime/src/` unless prefixed.
> CONFIRMED = a probe ran. PLAUSIBLE = from reading. Nothing ran against real Postgres or NATS.

## High

| # | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 1 | `replicator.ts:142` (publish), `:253-285` (`parseEnvelope`), `sync-node.ts:194-208` | the replicator → sync bus hop is `JSON.stringify` → `JSON.parse` with no revival — every `Date` the decoder built reaches the matcher as an ISO string | any UPDATE on a row in a window ordered by a timestamp, on any real deployment → `compareRows` returns `-1` for the same instant; the row "jumps to the top of every feed" — the defect `pg-values.ts:5-11` and `pg-connection.ts:83-89` say is closed. A `Uint8Array` arrives as `{"0":1,"1":2}`. `live-replicator.ts` hands objects over directly, so in-process tests cannot see it | CONFIRMED | revive in `parseEnvelope` through the entity's decoder (`entityForTable` + column `$parse`, as `pg-entity-row.ts:54`), or tag values as `packages/query/src/cursor-value.ts:44-63` does | `replicator.test.ts` (envelope round trip); a `pg-live-parity.test.ts` case through `parseEnvelope` |
| 2 | `pgoutput.ts:90-94` → `pg-entity-row.ts:54` → `pg-replication.ts:389-390` | an unchanged TOASTed column (`'u'`) is omitted from `after`; the event is published as if `after` were the whole row | `UPDATE posts SET status='published', rank=5` on a row whose `body` is over ~2 kB and untouched → the insert patch and the window row have no `body`; every later snapshot serves it without the column; channel `records` adopt the partial row | CONFIRMED (decoder → `match` → `toBridgeResult` → `applyToWindow`) | carry the omitted column names on the event; the fanout marks the entry `stale` (re-read) when an add patch lacks a projected column; under REPLICA IDENTITY FULL fill from `before` | `pgoutput.test.ts`, `pg-replication.test.ts`, `live-fanout.test.ts` |
| 3 | `pg-replication.ts:252-268` (`#die`), `replicator.ts:189-190` | a dead replication stream is recorded in `stats().failure`, which nothing reads; `running` stays `true`. Same defect as [`sweep-2-concurrency.md`](sweep-2-concurrency.md) row 2, with one more trigger: a single rejected `onChange` (one `transport.publish` refusal during a NATS reconnect reaches `#drain`'s catch, `:309-310`) | the process holds the advisory lock, replicates nothing; the replicator role has no `/readyz` (`docs/ops/01-kubernetes.md:50`) | CONFIRMED (reading + grep) | `ChangeFeed.start` takes `onEnd(reason)`; `createReplicator` clears `running`, releases the lock, re-enters its takeover loop | `replicator.test.ts`, `pg-replication.test.ts` |
| 4 | `page-outbox.ts:116-122` (`onRescope`) vs `:154-157`, `offline-queue.ts:305-342` | a principal change during a drain wipes the disk queue but not the running pass. Upgrades [`sweep-2-concurrency.md`](sweep-2-concurrency.md) row 12 from PLAUSIBLE | three queued writes for one principal, `rescope` to another while the first is in flight → the second and third are sent under the new session. Header (`page-outbox.ts:6`) promises otherwise | CONFIRMED (probe) | capture `scope` at pass start, check in `deliver` before each send — or bump the queue's `#epoch` (`offline-queue.ts:309`) from the rescope handler | `page-outbox.test.ts` |

## Medium

| # | Where | Defect | Failing input → wrong output | Verdict | Test |
|---|---|---|---|---|---|
| 5 | `sync-node.ts:154-155`, `live-query.ts:320-323` | a re-auth denial unsubscribes the live query and sends nothing — both `dropped` return values discarded | grant refresh returns an actor whose `authorize` throws `X_FORBIDDEN` → the client keeps the rows on screen in state `live`. Fix: `refuseSubscription(socket, sid, error)` per dropped sid, as `#reseat` (`live-query.ts:362`) | CONFIRMED | `sync-node-auth.test.ts` |
| 6 | `live-query.ts:245-248`, `:226-242` | the subscriber is attached after its per-row policy pass, outside the lane — a change folded in between reaches neither its snapshot nor its patch stream | A receives `snap, patch:p2, patch:p3`; B receives `snap(p1)@1, patch:p3`. Open under `live-replicator.ts` (microtask delivery); closed in practice over NATS. Fix: after `#attach`, `if (entry.lsn !== fresh.lsn) socket.markDesynced(sid)` | CONFIRMED (async `visible`) | `live-query.test.ts` |
| 7 | `sync-auth.ts:119` | `sweepGrants` re-inserts a refreshed grant for a socket that closed during the sweep (same root as [`sweep-2-concurrency.md`](sweep-2-concurrency.md) row 10) | `grants.size` stays 2 with one socket closed; refreshed against the token service forever | CONFIRMED | `sync-node-auth.test.ts` |
| 8 | `client-channels.ts:110,161,208`, `channel-logs.ts:115,127-133` | a channel becomes `live` only on a `records` frame or a catch-up; the node sends neither for (a) an `events: true` channel with no records, (b) a reconnect whose `since` is current | `useChannel()` reads `joining` indefinitely | CONFIRMED | `client-channels.test.ts`, `use-channel.test.ts` |
| 9 | `sync-node.ts:103-110`, `channel.ts:180-183` | socket teardown calls `presence.leave` for every topic, including channels declared without `events`; `emit` has no guard | the other socket on an `events: false` channel receives a presence `leave` event; a KV read + write per topic per close. The explicit drop path guards this (`sync-frames.ts:109-111`) | CONFIRMED | `sync-presence.test.ts` |
| 10 | `sync-frames.ts:103-115` | `channelTopics` is a per-socket `Map` keyed by the client-chosen `sid`, no cap; a repeat `add` is legal | unbounded retained memory on one socket; two sids alias one membership — dropping one unsubscribes the other. Fix: key by topic; cap sid length in `decode` | PLAUSIBLE | `sync-node.test.ts` |
| 11 | `pg-preflight.ts:58-72,80-83` vs `channel-records.ts:27-28,41` | preflight does not warn for DEFAULT replica identity, but a channel with params needs them in `before` | a DELETE under default identity → `before` is `{id}`, `paramsOf` returns `null`, no `remove` sent; members keep the deleted record; nothing logged | PLAUSIBLE | `pg-preflight.test.ts`, `channel-records.test.ts` |

## Low

| Where | Defect | Verdict |
|---|---|---|
| `offline-queue.ts:329,345` | after `send` resolves the pass sets `mutation.error = null`, erasing the error `fail()` just recorded (what `page-outbox.ts:100` does) — `{status:'failed', error:null}` on disk, `sent: 1` for a refused write | CONFIRMED |
| `offline-queue.ts:170-182` | `enqueue` awaits `store.load()` between `find` and `push` — two concurrent enqueues of one key give `size 2`, both `seq 1` | CONFIRMED |
| `nats-client.ts:97,107` | a URL that fails `new URL` is echoed whole in the cause, credentials included; `:113-114` and `pg-socket.ts:61-63` say the URL is never echoed | CONFIRMED |
| `wire-channel.ts:90-99` | `adoptOf` builds plain objects keyed by wire data — a record keyed with a prototype name is dropped and becomes the map's prototype; the encoder guards this (`channel-render.ts:14-16`). Fix: `Object.create(null)` | CONFIRMED |
| `client-heartbeat.ts:13` vs `presence.ts:33,85-88`, `transport-env.ts:34` | client beats every 15 s against a 30 s TTL; both server files say ttl/3 "so one lost beat is never a false leave" | PLAUSIBLE |
| `presence.ts:104` (`heartbeat`) | no caller; `sync-frames.ts:49-55` runs a full `join` per beat — a KV put, a fleet-wide `join` event, a roster read per member per 15 s | PLAUSIBLE |
| `pg-replication.ts:176-177` | `messages 'true'` is a Postgres 14+ pgoutput option; `pgoutput.ts:1` claims "Postgres >= 12" | low confidence |
| `sync-protocol.ts:267-279` | `toWireError` sends `renderThrowable` of any uncoded internal throw to the client, labelled `X_PROTOCOL_VERSION` | low confidence |

## Gaps

- LSN / ack logic, `Nats-TTL`, an empty `orgId` producing subject `x.change.<t>.` — checked by reading only.
- `RecordStore` settle / `ServerWait`: an eviction via `release` counts as "server reached this row" (`record-store.ts:153`, `:279`) — read, not probed.
- Test files not read; one heuristic scan found only `transport-env.test.ts:135-137` (no `expect`, can still fail by rejecting).

## Not a bug (do not re-open)

- LSN arithmetic and acknowledgement; serialised status writes.
- `MessageReader` framing (split length prefix, 64 MB cap); `ChunkQueue` single-waiter rule.
- Truncate, relation re-send, logical-message decode.
- `WebSocket.send` in CONNECTING — unreachable from a page (`VirtualSocket`, engine gates on `#up`).
- NATS reconnect budget exhaustion — documented decision (`nats-transport.ts:285-290`).
- `sweepGrants` keeping an expired grant when `refresh` throws — documented fail-open.
- A terminal server refusal not stopping the outbox pass — deliberate (`page-outbox.ts:98-101`).
- Hub bridge `decode` throwing — contained by `NatsTransport.subscribe`.
- Cross-sid / cross-socket collisions, subscribe caps, bridge refcounts.

## Still not read

- `errors`, `realtime-error`, `replication-errors`, `page-errors`, `server`, `nats-open`, `nats-fake`, `idb-fake`, `policy-fake`, `channel-describe`, the fixtures, every `*.test.ts`.
