# ⚡ @ultimat3/realtime

Three tiers, one ladder, one protocol. Climbing a rung is a config change, never a rewrite.

## The ladder

| Tier | What it gives you | What it costs you |
|---|---|---|
| **1 — channels** | `publish`/`subscribe` on typed topics, presence, cursors, typing indicators | ~0. Pub/sub over Bun's native WS. No DB, no replication slot |
| **2 — live queries** | the list updates when someone else edits; your own click feels instant | one change feed + a matcher per query id + a bounded change window |
| **3 — local-first** | writes that survive being offline | a durable local store, a rebase log, client-side migrations, a conflict story per mutator |

Tier 2 covers ~90% of "make it realtime". Tier 3 buys exactly one extra property — offline writes — and charges a client database for it. Do not buy it by accident.

## Same mutator at every rung

```ts
// query
export const liveFeed = query({
  input: t.object({ orgId: t.uuid }),
  policy: can('feed:read'),
  live: true,
  sql: ({ orgId }) => db.posts.where({ orgId }).orderBy('createdAt').limit(50),
});

// mutator (action + optimistic local twin)
export const likePost = mutator({
  // Convergent, not incremental: `local` replays on every rebase, so applying it N times has to
  // equal applying it once — `likedByMe` is what makes the second application a no-op.
  local(tx, { postId }) {
    tx.posts.update(postId, (p) =>
      p.likedByMe ? {} : { likedByMe: true, likeCount: p.likeCount + 1 });
  },
  async server(ctx, { postId }) { return ctx.posts.like(postId); },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
```

`persist: true` on the query moves that route from tier 2 to tier 3. Same mutator, same authz, same
frames — `local` starts writing to a durable store and the mutation queue starts surviving reloads.
**One protocol serves all three tiers**: a channel message, a live-query patch and an offline
mutation drain are frames in the same discriminated union (`src/sync-protocol.ts`), so the client's
frame handler is unchanged between rungs.

`local` must be pure — no I/O, no `Date.now()`, no `Math.random()` — because rebase replays it.

## Public API

| Concern | Export |
|---|---|
| tier 1 | `topic`, `ChannelHub`, `PresenceRegistry`, `SyncSocket`, `SocketRegistry` |
| tier 2 | `LiveQueryRegistry`, `InMemoryChangeFeed`, `PgLogicalReplicationFeed`, `createReplicator`, `matcherFor` |
| fanout | `Transport`, `InProcessTransport`, `NatsTransport`, `subjectMatches` |
| reconnect | `LiveCursor`, `resumeFrom`, `shouldResnapshot`, `defaultReconnectBudget`, `RingChangeBuffer`, `backoffDelay`, `drainPlan`, `AcceptBudget` |
| tier 3 | `MemoryLocalStore`, `createOpfsLocalStore`, `OfflineQueue`, `RebaseLog`, `reconcile`, `custom` |
| wire | `PROTOCOL_VERSION`, `encode`, `decode`, `Frame` |
| halves | `LiveClient` (client), `createSyncNode` / `listenSyncNode` (`sync` role) |

Authz goes through `@ultimat3/query`'s `guard`, which is the only contact with `@ultimat3/policy`.
One authz system, never two: `policy` is evaluated **once per subscriber**, never once per query.
Two actors on one live query get two different result sets, and a row that leaves an actor's policy
is delivered to them as a `delete` — never as silence.

## Reconnect is the hard part

A deploy drops N sockets at once and every one asks "what changed since X?". If that answer needs
arbitrary WAL replay or a re-run of every query, a rolling restart becomes a self-inflicted outage
that outlasts the deploy. The design confronts it with exactly two paths and no third:

| Path | When | Cost |
|---|---|---|
| **delta** | the cursor's gap is inside the retained window and inside the budget | one buffer read, zero DB work |
| **snapshot** | out of window, past `maxLagMs`, or past `reconnectBudget` | one bounded indexed query |

A `LiveCursor` is `lsn` + result-set `digest` + last-seen `ids` + `count`. The digest is
order-sensitive, so a re-sort is detected; the ids let a delta be re-filtered per subscriber, because
the retained window stores **pre-policy** patches. `resumeFrom()` picks the path,
`shouldResnapshot()` explains it, and the budget is a cost model in patch-equivalents
(`snapshotCost: 250` = "replaying 250 patches costs a snapshot") so the expensive path is *chosen*,
never stumbled into.

On drain, `drainPlan()` gives every client its own jittered slot in a spread window and the node
sends a `reconnect` frame carrying that delay — clients redistribute instead of stampeding.
`AcceptBudget` is the receiving node's token bucket, and a refusal always carries a retry delay,
because refusing without one just moves the herd next door.

### Limits, stated plainly

- **The change window is per node.** A client that reconnects to a *different* `sync` node has no
  window there and takes a snapshot. Making the window shared (replicator-side, request/reply) is
  gated on the milestone-6 reconnect benchmark — 50k sockets, forced restart, measure
  time-to-consistent — because that number decides the topology.
- **A delta resume leaves the digest unverified** (`DIGEST_UNVERIFIED`). Only a snapshot re-establishes
  it. `verifyDigest()` is how a client detects drift and asks for a fresh one.
- **Backpressure drops patch frames.** That is safe *only* because a re-snapshot is cheap: the drop
  is recorded on the socket (`desynced`) and the next flush re-snapshots rather than diverging.
- `PgLogicalReplicationFeed` and `NatsTransport` are interface-complete and throw
  `X_NOT_IMPLEMENTED` with a `fix:` line. `InMemoryChangeFeed` + `InProcessTransport` are the working
  defaults used by `x dev` and every test.
- Tier 3's OPFS SQLite store is browser-only and throws until the browser entry ships; `MemoryLocalStore`
  implements the full journal/rollback/replay semantics today.

## Errors

`X_TOPIC_FORBIDDEN` · `X_SUBSCRIPTION_LIMIT` · `X_PROTOCOL_VERSION` · `X_CURSOR_STALE` ·
`X_REBASE_CONFLICT` · `X_TRANSPORT_UNAVAILABLE` · `X_NOT_IMPLEMENTED`

Topics deny by default: a topic with no matching guard is forbidden. An authz hole is not a config
option someone forgot to set.

`As of 2026-07`: tiers 1–2 target v1, tier 3 targets v2.
