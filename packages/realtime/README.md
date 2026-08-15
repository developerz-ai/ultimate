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
| tier 2 | `LiveQueryRegistry`, `InMemoryChangeFeed`, `PgLogicalReplicationFeed`, `selectChangeFeed`, `createReplicator`, `PgAdvisoryLock`, `matcherFor` |
| replication | `parsePgUrl`, `bunPgStream`, `PgOutputDecoder`, `entityRow`, `changeLsn`, `commitPositionOf` |
| fanout | `Transport`, `InProcessTransport`, `NatsTransport`, `selectTransport`, `subjectMatches` |
| the bus, behind `NatsTransport` | the port — `NatsClient`, `NatsMessage`, `NatsSubscription`, `NatsConnect`, `NatsTarget`, `parseNatsUrl` — plus `openNatsClient` (the `nats` adapter), `NatsKvSet`, `ensureKvBucket`, `kvGet`/`kvLast`/`kvWrite`, `assertBucket`, `encodeToken`/`decodeToken`, and `FakeNatsBroker`/`fakeNatsConnect` for tests |
| reconnect | `LiveCursor`, `resumeFrom`, `shouldResnapshot`, `defaultReconnectBudget`, `RingChangeBuffer`, `backoffDelay`, `Scheduler`, `timeoutScheduler`, `drainPlan`, `AcceptBudget` |
| tier 3 | `MemoryLocalStore`, `createOpfsLocalStore`, `OfflineQueue`, `RebaseLog`, `reconcile`, `custom` |
| wire | `PROTOCOL_VERSION`, `encode`, `decode`, `Frame` |
| halves | `LiveClient` (client), `createSyncNode` / `listenSyncNode` (`sync` role) |
| hooks | `setLiveClient`, `useLive`, `useConnection`, `useMutation`, `useMutationQueue` |
| the typed projection | `liveHookFor` — one query bound to one named hook |

## The four hooks

Register the client once, in the app entry. Every hook reads it from there — no hook takes a client
argument, and one that runs before the registration is `X_LIVE_CLIENT_MISSING`, never a default.

```ts
setLiveClient(new LiveClient({ signal: createSignal, connect, buildId, store, queue }));

const feed = useLive(liveFeed, () => ({ orgId: actor.orgId })); // feed(), feed.state(), feed.unsubscribe()
const connection = useConnection();                             // .offline .online .reconnectAt .updateAvailable
const like = useMutation(likePost);                             // await like(input); like.pending
const queue = useMutationQueue();                               // .pending .failed .drain()
```

| Rule | Why |
|---|---|
| **No `solid-js` import.** Reactivity is the `SignalFactory` the client was built with | one reactive runtime per app, and a tier-3 package that installs and tests with none |
| Every member is a **getter**, every result set an **accessor** | a value snapshotted at hook time never re-renders |
| A thunk `input` is read **once**, at subscribe time | nothing here re-runs it; changing input is a new subscription |
| The caller owns `unsubscribe` | this layer does not know what a mount is |
| Every subscription handle (`useLive`'s return, `client.subscribe(topic, …)`'s return) is `Disposable` | `using feed = useLive(liveFeed, () => input)` unsubscribes on scope exit — the same call as `unsubscribe()`, never a second teardown path |
| `pending` / `failed` are read off the queue, through an invalidation signal refreshed on each `mutate` and `drain` | the count is never a second copy of the queue, and `OfflineQueue` holds arrays, not signals |

Tier 2 has no queue, so `pending` is `0` there — stated, not guessed.

### The typed one: `liveHookFor`

`useLive(query, input)` takes any object carrying a `name`, so it cannot type either side.
`liveHookFor` binds one declared `query({ live: true })` to one named hook and carries both types
through — the query's `input` in, its row type out. It is not a second subscribe path: it *is*
`useLive`, with the name and the types already bound.

```ts
export const useLiveFeed = liveHookFor(liveFeed); // app/feed/hooks.ts — one line, no codegen

const feed = useLiveFeed({ orgId: actor.orgId }); // feed()[0].title typechecks
useLiveFeed({ orgIdd: actor.orgId });             // does not compile
```

The query's name is read **per call**, never at bind time: `registerQueries()` stamps it at boot,
after a module-level binding has already run. Binding a query with no `live: true` is
`X_QUERY_NOT_SUBSCRIBABLE`, thrown where the binding is written — a read that never patches has no
subscription to hold, and the non-live read from a component is `query.client({ baseUrl })`.
`type-pins.ts` fails the build if the hook ever widens either type.

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

The client dials itself back. A closed socket arms one timer — the node's delay when a `reconnect`
frame assigned one, otherwise `backoffDelay()` — and that timer calls `connect()`, which re-sends
`hello` with every cursor and re-subscribes every registration. `reconnectAt` is what a component
renders while it waits; `close()` cancels it, and `connect()` starts over. The timer comes from an
injected `Scheduler`, so a test fires it by hand instead of sleeping.

### Limits, stated plainly

- **The change window is per node.** A client that reconnects to a *different* `sync` node has no
  window there and takes a snapshot. Making the window shared (replicator-side, request/reply) is
  gated on the milestone-6 reconnect benchmark — 50k sockets, forced restart, measure
  time-to-consistent — because that number decides the topology.
- **A delta resume leaves the digest unverified** (`DIGEST_UNVERIFIED`). Only a snapshot re-establishes
  it. `verifyDigest()` is how a client detects drift and asks for a fresh one.
- **Backpressure drops patch frames.** That is safe *only* because a re-snapshot is cheap: the drop
  is recorded on the socket (`desynced`) and the next flush re-snapshots rather than diverging.
- **Deliveries are serialized per query id, not per node.** A change is fanned out inside that
  query's own FIFO lane, so two changes off the bus cannot interleave: the window one of them
  writes is the window every subscriber's gate reads, and patch frames leave in lsn order. Every
  lane is entered before any is awaited, so one slow policy pass never sets the node's pace, and
  across query ids there is no ordering and none is wanted — a qid pins both the query and its
  input. A lane that fails costs one query id: its own subscribers are desynced and re-snapshotted
  on the next flush, every other query id still sees the change, and the failure still reaches the
  caller.
- **A cold subscribe reads once per query id.** Subscribers arriving during a read join it and each
  runs its own policy pass over the result. A read that resolves behind a change already fanned out
  is discarded rather than written back: the window only ever moves forwards.
- **A denial drops a row; a gate that could not decide does not.** A policy answer (`X_FORBIDDEN`,
  `X_UNAUTHENTICATED`) is a decision and costs the row, counted as `rowsDenied`. Anything else a
  gate throws — a rule whose lookup timed out, a predicate with a typo — is counted as
  `gateFailures` and reported through `onGateFailed`, never as a denial: it raises out of
  `subscribe`, desyncs exactly the one subscriber it happened to during a delivery, and leaves a
  subscription standing at `reauthorize`. Reading a timeout as "you may no longer see this" is an
  outage published as a permission change.
- **A patch is authorized against the whole row or it is not authorized.** An update patch carries
  the changed columns only, so a rule reading a column the change did not touch would read
  `undefined` and answer as if the row had said so. A patch whose row the shared window does not
  hold is withheld — the window *is* the result set — and a subscriber holding that row gets the
  one `delete` that says so. It counts as neither a denial nor a gate failure: nothing decided.
- **`PgLogicalReplicationFeed` decodes `pgoutput` off a real slot** — its own Postgres v3 client
  (SCRAM-SHA-256, in-band TLS, CopyBoth), no driver dependency. It preflights `wal_level`, the
  publication and the slot, creates the slot when there is none, and confirms the slot as it goes so
  the WAL does not grow without bound. `InMemoryChangeFeed` + `InProcessTransport` remain the
  defaults for `x dev` and every test.
- **`selectChangeFeed(env, { entities })` decides which feed a boot installs** — same law
  `selectMailDriver` follows: an unset variable means the embedded default. It returns `{ feed,
  mode, detail, slot, lock }`: `mode` is `'embedded' | 'external'`, `detail` is the env key that
  selected it and never a credential, and `lock` is the `AdvisoryLock` for that feed — built here
  rather than by the caller, because constructing one needs the URL and the URL carries a password.
  Neither `DATABASE_URL` nor `REPLICATION_URL` set → `InMemoryChangeFeed`,
  `mode: 'embedded'`. `REPLICATION_URL` wins when both are set, but naming a different host, port or
  database than `DATABASE_URL` is refused at boot with `X_CONFIG_INVALID` — a feed streaming the
  wrong database's WAL would be silently wrong forever. `REPLICATION_SLOT` (default `x_replicator`)
  and `REPLICATION_PUBLICATION` (default `x_changes`) name the slot and publication, both checked
  against `[a-z_][a-z0-9_]*` before they reach a replication command.
- **`PgAdvisoryLock` is the production `AdvisoryLock`** — `SELECT
  pg_try_advisory_lock(hashtext('x:replicator:<slot>'))` on its own session. Session-scoped, so a
  crashed replicator releases it automatically: no lease renewal, no fencing token, no split brain.
  `InMemoryAdvisoryLock` remains the single-process default for `x dev` and tests.
- **`selectTransport(env)` decides which transport a boot fans out on** — the same law again, and
  the only place that reads `NATS_URL`. It returns `{ transport, mode, detail, bucket,
  presenceTtlMs, connect }`: unset → `InProcessTransport` and `mode: 'embedded'`, set → a
  `NatsTransport` on the KV bucket `NATS_KV_BUCKET` names (default `x_presence`, so two apps on one
  cluster do not share one presence namespace), validated here rather than on first connect.
  `presenceTtlMs` comes back with it because the bucket's whole-stream age limit was derived from
  it — a `PresenceRegistry` given a different number would report members leaving that never left.
  Selection is pure; `connect()` is the dial, so an unreachable bus fails at boot.
- **`NatsTransport` runs on the official `nats` client** — `nats@2.29.3`, pinned exact, admitted at
  this transport seam and nowhere else
  ([`docs/idea/18-build-vs-wrap.md`](../../docs/idea/18-build-vs-wrap.md)). The package reaches it
  through one port, `NatsClient`, and exactly one file imports the library to implement it, so a
  test injects a client rather than a socket. Fanout is core NATS. `shared` is a JetStream KV bucket the transport creates on
  first connect, one key per presence member, expired by the **server's** per-message TTL so a node
  that dies needs nobody to notice — that bucket and its direct reads stay the framework's, because
  the library's own KV abstraction expresses neither a per-message TTL nor a batch direct get.
  Reconnect and re-subscription are the library's: a lost connection is re-established underneath
  the caller, which is what makes `sync` stateless, and the jitter that spreads a restart herd is
  handed to it as its reconnect delay rather than re-implemented above it. The bucket needs
  nats-server ≥ 2.11 (batch direct get, per-message TTL); an older one is `X_TRANSPORT_PROTOCOL` on
  the first dial, never a retry loop, because no amount of reconnecting makes a server newer.
- **The lsn is `<commit position><row position in the transaction>`, 24 hex characters.** Neither
  half works alone: every row of one transaction shares a commit lsn, and logical decoding emits
  *transactions* in commit order, so per-record WAL positions are not monotonic across them. The
  pair sorts in delivery order and is byte-identical on replay, which is what turns at-least-once
  redelivery into a drop instead of a duplicate.
- **A live query needs `REPLICA IDENTITY FULL`.** Deciding whether a row *left* a result set needs
  the old values; with the default identity a delete replicates only the key columns.
- Tier 3's OPFS SQLite store is browser-only and throws until the browser entry ships; `MemoryLocalStore`
  implements the full journal/rollback/replay semantics today.

## Errors

`X_TOPIC_FORBIDDEN` · `X_SUBSCRIPTION_LIMIT` · `X_PROTOCOL_VERSION` · `X_CURSOR_STALE` ·
`X_REBASE_CONFLICT` · `X_TRANSPORT_UNAVAILABLE` · `X_TRANSPORT_PROTOCOL` ·
`X_REPLICATION_FAILED` · `X_REPLICATION_PROTOCOL` · `X_REPLICATOR_SLOT_HELD` ·
`X_LIVE_CLIENT_MISSING` · `X_LIVE_QUERY_UNKNOWN` · `X_NOT_IMPLEMENTED`

Topics deny by default: a topic with no matching guard is forbidden. An authz hole is not a config
option someone forgot to set.

A `subscribe` frame naming a query this node never registered is `X_LIVE_QUERY_UNKNOWN`, not
`X_PROTOCOL_VERSION`: the frame parsed and the version matched, so "rebuild and redeploy the
client" is the one instruction that cannot help — a rebuilt client spells the name the same way.
The fix is `x queries list --json`, and the name the client sent is echoed back while the registry
never is.

`As of 2026-07`: tiers 1–2 target v1, tier 3 targets v2.
