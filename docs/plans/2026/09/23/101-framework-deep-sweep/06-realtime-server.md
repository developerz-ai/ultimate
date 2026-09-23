# 06 — realtime, server side

> Part of [`overview.md`](overview.md). Depends on: 03 (entity `decodeRow`), 05. Tier: 3.

Rule: a data-carrying channel has a policy, as an action and a query already must. A live window
never shows a partial read as whole. A frame counted as dropped was actually dropped.

## Files to change

| # | Defect | File:line | Change | Semver |
|---|---|---|---|---|
| a | a channel with no `policy` lets any socket, anonymous included, join with any param and receive every committed row. This contradicts the package `CLAUDE.md` ("No guard = `X_TOPIC_FORBIDDEN`") and `README.md:551` | `packages/realtime/src/channel-authz.ts:20-21`, `channel-decl.ts:38,49`, `channel-records.ts:47` | Make `policy` required in the `channel()` type, with an explicit `policy: allow()` for a public channel (the `action`/`query` shape, `action.ts:90`, `query.ts:73`). A runtime refusal `X_CHANNEL_DECLARATION_INVALID` (exists, `channel-registry.ts`) covers JS callers | **major**, listed in 18 |
| b | the `index` on a live patch is a position in the **shared** window, sent unchanged to a policy-filtered subscriber. The row lands out of order, and the count of hidden rows ahead of it leaks | `packages/realtime/src/subscriber-gate.ts:133-163` | Recompute `index` against the subscriber's visible ids (`cursor.held`) in `patch()` | patch |
| c | the first read of a new window is discarded if any change was fanned out into it mid-read (`result.lsn >= entry.lsn` is false). The CLI wires no `lsn` (`dev-sync.ts:168`), so every later unforced read is discarded too. Result: permanently partial windows | `packages/realtime/src/query-window.ts:144`, `live-fanout.ts:46-51`, `packages/cli/src/dev-sync.ts:168` | `fanoutChange` does not patch a window with `applied === 0`: it marks it `stale` instead, and `fillWindow` applies the read whenever `applied === 0`. Separately, wire `lsn` in `dev-sync.ts` from the replicator's confirmed LSN | patch |
| d | `live-definition` reads the rows, then the LSN, so a commit in between is claimed but missing | `packages/realtime/src/live-definition.ts:145` | Read `lsn()` before `window.read()` | patch |
| e | `SyncSocket.send` counts Bun's `-1` (queued under backpressure; the frame **is** delivered) as a drop. That triggers spurious `replay-gap` frames and out-of-sync marks, and closes a healthy socket after 33 lifetime "drops" | `packages/realtime/src/socket.ts:219-232` | Treat only `0` as a drop. Make `droppedFrames` a sliding window (the `AcceptBudget` shape) rather than a lifetime count | patch |
| f | `TRUNCATE` is decoded and dropped. With the recommended `FOR ALL TABLES` publication, every window and client keeps the truncated rows | `packages/realtime/src/pg-replication.ts:340-342`, `pgoutput.ts:265` | Emit an invalidation for each selected relation (`registry.invalidate()` path), or a `truncate` `ChangeOp` | patch (minor if it adds an op) |
| g | a channel frame is re-encoded per subscriber: 70.7 ms vs 3.3 ms for 10k sockets. The NATS bridge decodes, then re-encodes | `packages/realtime/src/socket.ts:425,447`, `sync-protocol.ts:176`, `channel.ts:352` | `SyncSocket.sendEncoded(text)`, encode once per `deliver`, and forward the validated payload string from NATS | patch |
| h | live fan-out is O(subscribers × window) per change: `new Set(cursor.ids)` per subscriber, and `rows.find` per patch. 54.6 ms vs 0.7 ms at 1000×500 | `packages/realtime/src/live-fanout.ts:87`, `subscriber-gate.ts:150` | One id→row `Map` per fan-out, passed to the gate. `cursor.ids` kept as a `Set` | patch |
| i | `pg-entity-row.ts` guesses money columns from `_minor`/`_currency` suffixes instead of the entity. A nullable money column diverges from the repository shape, and two plain columns named that way get folded | `packages/realtime/src/pg-entity-row.ts:35-40,117` | Resolve the entity by table and call `decodeRow` (`entity/src/pg-row.ts:171`). Delete `foldMoney`, `camel` and `pg-entity-row-parity.test.ts` | patch |
| j | channel row loaders and live windows run with no ambient actor, so `actorTenant()` is `undefined` and `verifyScope` accepts any org predicate (suspected; harmless today) | `packages/realtime/src/channel.ts:103,140`, `packages/cli/src/dev-sync.ts:166` | Run loaders under `runWithContext` with the subscribing actor. Write a test proving a row loader's `repo` read is tenant-scoped | patch |
| k | NATS KV reads stop at one 1,000-message batch (`kvLast`), so presence past 1,000 members is truncated. `sweep()` then sends spurious `leave`s, because it differences the full set (`presence.ts:153`) | `packages/realtime/src/nats-jetstream.ts:191-205`, `nats-kv.ts:112` | Page on the last sequence until a short batch; any status other than end-of-batch is an error. Parity test with 1,500 members against `InProcessTransport` | patch |
| l | the replication reader re-copies its whole buffer per chunk: 5.2 s of blocked event loop for one 32 MB CopyData message | `packages/realtime/src/pg-wire.ts:68-77` | Read the 5-byte header, allocate `length+1` once, fill it | patch |
| m | the dev row observer emits on repository return, not on commit: a rolled-back `withTransaction` write is fanned out under `x dev`, and each serialization retry re-emits. The WAL feed delivers only commits, so dev and production disagree | `packages/testing/src/live-replicator.ts:95-122` (moves to realtime in 12 a), `packages/entity/src/row-observer.ts:186-197` | While `currentTx()` is set, buffer changes on the transaction; flush on commit, drop on rollback | patch |
| n | **split-role topology fails silently**: a `sync` pod on an external DB reports `feed: 'replication'` with no replicator reachable, and with `NATS_URL` unset a replicator in another pod publishes into its own in-process bus. Live queries are then dead with no error; the deployed demo is in exactly this state (slice 19) | `packages/cli/src/dev-live-feed.ts:47-50`, `dev-roles.ts` | When role `sync` runs with an external DB, an in-process transport and no in-process replicator, refuse at boot with `X_REALTIME_TOPOLOGY`, fix `set NATS_URL for every realtime role, or run ROLE=sync with the replicator in one process`. Readiness stays 503 until the feed has delivered once | patch |
| o | the sync listener uses `drainGraceMs: 0` in production too; the comment's reasoning is about `x dev` Ctrl-C. A sync pod drops every socket at once on SIGTERM | `packages/cli/src/dev-sync.ts:260` | Grace 0 only under `x dev`. The container uses `DEFAULT_DRAIN_GRACE_MS` | patch |
| p | `pg-preflight`'s fixes say `ALTER SYSTEM SET wal_level` (disabled on managed/operator Postgres) and `CREATE PUBLICATION … FOR ALL TABLES` (needs superuser), and never name the `REPLICATION` role attribute | `packages/realtime/src/pg-preflight.ts:48,58` | Fixes: per-table `create publication … for table …` (generated from the live entities), `alter role <r> replication`, and "set wal_level=logical in the server config" | patch |

## Steps
1. a lands in 22.0.0 (slice 18). Here, write its failing test and the type change behind a branch, and ship b–j as patches first.
2. c: first write `live-query.test.ts` "cold subscribe with a gated snapshot while `deliver` runs": both subscribers must see 3 rows.
3. e: a real `Bun.serve` test sends 40×150 kB frames, and every frame reported dropped must be absent client-side.
4. g and h: rerun `scripts/bench/restart-bench-seq.ts` at 10k and commit the results under `scripts/bench/results/`. Update the realtime numbers in `CLAUDE.md` only if the run is comparable, per the existing note about bench comparability.

## Tests
- `bun test packages/realtime/src`
- `bun run scripts/bench/restart-bench-seq.ts` (g, h), with results committed.

## Done when
- No policy-less channel type-checks (22.0.0).
- A cold subscribe racing a write returns every row.
- `channel_frames_dropped_total` counts only frames that never left.
- A TRUNCATE empties subscribed windows.
