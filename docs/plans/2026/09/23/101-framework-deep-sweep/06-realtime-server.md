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
