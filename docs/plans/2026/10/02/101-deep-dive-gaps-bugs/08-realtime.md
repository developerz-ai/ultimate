# 08 — realtime

> Part of [`overview.md`](overview.md). Depends on: 01, 06 (comparator). Tier: 3. Path-disjoint from 06, 07.
> All paths under `packages/realtime/src/` unless prefixed.

## Files to change
| Where | Change | Row |
|---|---|---|
| `changefeed.ts:50-56`, `pg-replication.ts:252-268`, `replicator.ts:189-190,227` | `ChangeFeed.start` takes `onEnd(reason)`; `createReplicator` clears `running`, releases the lock, re-enters its takeover loop through `retryDelayMs`. `PgAdvisoryLock` drops its connection reference on close | `s2-con #2`, `s2-rt #3` (REPRODUCED in `s3-be`) |
| `replicator.ts:142`, `:253-285` (`parseEnvelope`) | revive through the entity's decoder (`entityForTable` + column `$parse`, as `pg-entity-row.ts:54`) | `s2-rt #1` |
| `pgoutput.ts:90-94`, `pg-entity-row.ts:54`, `pg-replication.ts:389-390`, `live-fanout.ts` | omitted TOAST column names carried on the event; an add patch lacking a projected column marks the entry `stale` | `s2-rt #2` |
| `change-buffer.ts:98` | a ring carries a floor at birth — `evictedThrough` from the window's lsn at the first read | `s2-con #3` |
| `subscriber-gate.ts:214-224`, `cursor.ts:166-173` | visible and `!holds` → an `insert` with the whole row through `narrowRow` | `s1-t23 #2` |
| `live-query.ts:245-248`, `:226-242` | after `#attach`, `entry.lsn !== fresh.lsn` → `markDesynced` | `s2-rt #6` |
| `live-definition.ts:198-204`, `errors.ts:311-312` | numeric ids normalised as the WAL path does (`pg-replication.ts:485-486`) | `s1-t23 #12` |
| `channel.ts:294-306`, `channel-authz.ts:25-29`, `errors.ts:59-62` | a non-denial guard failure stops delivery for the topic until a pass succeeds; a `null` actor is a denial before the loader runs | `s1-sec H2`, `s3-be` New 1 |
| `sync-node.ts:154-155`, `live-query.ts:320-323` | `refuseSubscription(socket, sid, error)` per dropped sid | `s2-rt #5` |
| `sync-origin.ts:25` | full origins against `selfOrigin` + `allowedOrigins` | `s1-sec M7` |
| `page-outbox.ts:116-122,154-157`, `offline-queue.ts:305-342` | the pass captures its scope; rescope bumps `#epoch` (`:309`) | `s2-rt #4`, `s2-con #12` |
| `sync-auth.ts:103-119`, `sync-node.ts:231` | the sweep is memoised (as `replicator.ts:189`); `grants.get(id) === grant` re-checked after the await | `s2-rt #7`, `s2-con #10` |
| `sync-node.ts:194-212`, `nats-transport.ts:199`, `replicator.ts:304-312` | `onReconnect` surfaced → `registry.invalidate()`; a new producer after a known one is a gap | `s2-con #6` |
| `presence.ts:187-222` | a non-leader records the live ids it sees | `s2-con #7` |
| `client-channels.ts:110,161,208`, `channel-logs.ts:115,127-133` | the node answers an up-to-date resume; `event()` sets `live` | `s2-rt #8` |
| `sync-node.ts:103-110`, `channel.ts:180-183` | teardown `presence.leave` only for `events: true` channels | `s2-rt #9` |
| `sync-frames.ts:103-115` | `channelTopics` keyed by topic; sid length capped in `decode` | `s2-rt #10` (REPRODUCED) |
| `pg-preflight.ts:58-72`, `channel-records.ts:27-28,41` | warn when a params channel's `records` table lacks FULL identity; count skipped removals | `s2-rt #11` (REPRODUCED) |
| `channel.ts:265` | `#join` uses the `#attachUnlessGone` shape (`live-query.ts:429`) | `s2-con` low |
| `offline-queue.ts:170-182`, `:329,345` | re-check `find` after the await; clear `error` / count `sent` only when `inflight` | `s2-rt` low |
| `nats-client.ts:97,107` | the cause names the env key, never the URL | `s2-rt` low |
| `wire-channel.ts:90-99` | `Object.create(null)` maps | `s2-rt` low |
| `client-heartbeat.ts:13`, `presence.ts:104` | beat at ttl/3; `heartbeat` wired or deleted | `s2-rt` low |
| `pg-connection.ts:222,228`, `pg-tls.ts:41` | cleartext / MD5 auth refused on a non-TLS session unless opted in | `s2-sec L2` |
| `use-mutation.ts:167-169`, `offline-queue.ts:104-107` | comment matches slice 06's rule | `s1-con #2` |

## Steps
1. Supervision first. Unit: `createReplicator` over `feedOver(FakeWalsender)` (`pg-replication-fixture.ts`), push `copyDone()` → `running === false`, lock released, a second dial. Then the same with one rejected `transport.publish`. The `cli` half — a `replicator` readiness check — is slice 12.
2. Bus revival: the test must cross `parseEnvelope`; `live-replicator.ts` hands objects over directly, which is why the in-process suites are green. Add a case to `pg-live-parity.test.ts` that serialises.
3. Ring floor: two registries, one cursor minted on the other — the resume must answer a re-snapshot.
4. Channel re-auth: treat `X_TENANCY_*` and a `null` actor as denials. `channel-concurrency.test.ts:381` pins keep-on-failure — that assertion changes; say so in the commit.
5. Origin check is BREAKING for an app whose page and sync socket differ by port: `allowedOrigins` is the opt-in. CHANGELOG + `wiki/Upgrading.md`.
6. Replica identity: `packages/cli/src/db-subscribes.ts:1-3` grants FULL to live-query tables only — extend it to params-channel `records` tables (cli is slice 12; flag it there) and correct `wiki/Known-Gaps.md:42`, `packages/realtime/README.md:625`.

## Tests
- `replicator.test.ts`, `pg-replication.test.ts`, `pgoutput.test.ts`, `live-fanout.test.ts`, `change-buffer.test.ts`, `live-query.test.ts`, `subscriber-gate.test.ts`, `channel-concurrency.test.ts`, `sync-node-auth.test.ts`, `sync-upgrade-origin.test.ts`, `page-outbox.test.ts`, `presence.test.ts`, `client-channels.test.ts`, `sync-presence.test.ts`, `sync-node.test.ts`, `offline-queue.test.ts`.
- `live`: `pg-replication.live.test.ts` (terminate the walsender), `nats-transport.live.test.ts`, `presence.live.test.ts`.
- `bun test packages/realtime`

## Owned elsewhere
- `matcher-bridge.ts:41` (a row whose org changes) — low confidence, `assertRowTenant` normally refuses; not planned.
- `channel()` as a ninth primitive (`s2-arch M2`), the Postgres wire client's placement (`s2-arch L8`) — slice 15.

## Done when
- A dead stream restarts or fails readiness; one rejected publish does not end replication.
- A timestamp-ordered window keeps its order across the bus. A large untouched column survives an update.
- A removed or signed-out member stops receiving channel frames on the next sweep.
- A queued write is never sent under another principal.
