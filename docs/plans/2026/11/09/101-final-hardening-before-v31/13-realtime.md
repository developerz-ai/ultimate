# 13 — realtime: fan-out that scales, a replicator that notices death

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3 (`realtime`); also owns `dummy/social-media-clone/apps/web/app/notifications/` for R9. Transport union is [`21`](21-adapter-wiring.md).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| R1 | **High (perf)** | `realtime/src/live-deliver.ts:11` (fed by `live-query.ts:336`) | every change enters the lane of every query entry on the node, whatever its table (entries = queries × orgs). 10k entries 9.96 ms/change ≈ 100 changes/s ceiling; 50k 59.7 ms (17/s) | index entries by `shape.entities` in `LiveQueryRegistry`, maintained on add/forget; deliver to that table's entries plus `stale` ones (`live-fanout.ts:46`). Output identical |
| R2 | **High** | `realtime/src/pg-replication.ts:300-334` (`#drain`), `:445` (`#confirmOnTimer`), `:485` (`replyRequested=0`) | dead only when a write fails; no read deadline, never asks for a reply. Half-open socket (failover moving the IP, NAT drop, partition): nothing replicates ~15 min (`tcp_retries2`), `stats().failure` null, `/readyz` green. A write parked on a `drain` that never fires is invisible too. Fits prod: 13 slot restarts and "terminating walsender … replication timeout" in 32 h | `replyRequested=1`; record last CopyData time; `#die` when older than `MAX_CONFIRM_FAILURES × interval`; time out a confirm that never settles (pattern: `jobs/src/worker-fleet-slots.ts:184`) |
| R3 | Med | `realtime/src/pg-preflight.ts:43-48` | a missing slot is recreated silently: changes between the old confirm and the new slot are lost; quiet tables stay stale until their next change. An invalidated slot (`wal_status=lost`) fails every restart generically | resume position present + slot absent → log `X_REPLICATION_SLOT_RECREATED` and force resync now (`reconnectHandler`, `sync-bus-handlers.ts:119-129`); invalidated slot → its own code and fix |
| R4 | Med | `realtime/src/pg-advisory-lock.ts:99` | the replicator lock session idles with no keepalive; a holder lost without FIN keeps the lock until OS keepalive (~2 h 11 m); standby never takes over | `SET tcp_keepalives_idle=10, tcp_keepalives_interval=5, tcp_keepalives_count=3` on the lock and walsender sessions |
| R5 | Med | `realtime/src/window-lock.ts:12-17`, `sync-bus-handlers.ts:114` | lanes uncapped; one slow row policy queues every change closure: memory grows, subscribers fall behind | cap lane depth (1,024); past it mark the entry `stale`, drop queued changes (stale path re-reads, the documented gap recovery); count drops in a metric |
| R6 | Low–Med (perf) | `realtime/src/live-fanout.ts` | each subscriber's frame encoded separately even when the gate returns the same `patches` array; `windowIndex(entry.rows)` rebuilt per change | encode once when `allowed === result.patches` (`sendEncoded` exists); keep the index across changes |
| R7 | Low | `realtime/src/record-store.ts:264-267`; `offline-queue.ts` (`find`, `pending`) | `includes` in a filter (O(t²)); linear `find` per enqueue/ack; sort per `pending()`; no size cap offline | `Set`; `Map` by key, insert in seq order; optional cap that refuses, never drops |
| R8 | Low (latent) | `realtime/src/local-store-idb.ts:270-277` | `onversionchange` never closes; `onblocked` is a hard failure → on any IDB schema bump new tabs fall back to memory and lose offline mutations | `db.onversionchange = () => db.close()`; on `blocked`, wait for success with a bounded timeout |
| R9 | **High (demo) + framework guard** | `dummy/social-media-clone/apps/web/app/notifications/queries/inbox.ts:13-15`; `realtime/src/channel-decl.ts` | the `inbox` channel checks `ownInbox`; its `catchUp` query checks only `notification:read` yet filters on input `userId`, served at `GET /_x/query/inbox`: any member reads any user's notifications and crawls the social graph. Proved | app: filter on `ctx.actor.id`, drop `userId` from input, policy = `ownInbox`. Framework: `channel()` refuses a `catchUp` whose policy is not the channel's own — new code `X_CHANNEL_CATCHUP_POLICY_MISMATCH` |

## Files to change
- `packages/realtime/src/live-deliver.ts`, `live-query.ts` (registry index), `live-fanout.ts`, `window-lock.ts`, `sync-bus-handlers.ts` — R1, R5, R6.
- `packages/realtime/src/pg-replication.ts`, `pg-preflight.ts`, `pg-advisory-lock.ts`, `pg-connection.ts` (session SETs) — R2–R4; `errors.ts` + `wiki/Error-Codes.md` (generator) for R3, R9.
- `packages/realtime/src/record-store.ts`, `offline-queue.ts`, `local-store-idb.ts` — R7, R8.
- `packages/realtime/src/channel-decl.ts` — R9 guard.
- `dummy/social-media-clone/apps/web/app/notifications/queries/inbox.ts`, `topics.ts`, `notifications/policy.ts`, their tests — R9 app.

## Tests
- `live-deliver.test.ts`: 10k entries on other tables, one change → zero `lock.run`.
- `pg-replication.test.ts`: `FakeWalsender` that accepts writes and never answers, `statusIntervalMs: 1` → `stats().failure` set within a bound.
- `pg-preflight.test.ts`: no slot + `from` set → coded warning + immediate invalidate.
- `pg-advisory-lock.test.ts`: the three `SET`s issued; live `SHOW tcp_keepalives_idle` = 10.
- `window-lock.test.ts`: 5k changes behind a blocked policy → ≤ 1,024 closures, entry stale, then resnapshot.
- `live-fanout.test.ts`: shared-encode vs per-subscriber frames byte-equal.
- `local-store-idb.test.ts`: fake IDB `blocked` then `success` → IDB store.
- `channel-decl.test.ts`: mismatched `catchUp` policy refused; app test: member asking another `userId` → 403.
- `bun test packages/realtime dummy/social-media-clone/apps/web/app/notifications`

## Done when
- A node with 10k live windows sustains ≥ 2,000 changes/s on unrelated tables (bench added to `scripts/bench`, see [`22`](22-scale.md)).
- Killing the replicator's network path (fake) is reported within 30 s.
