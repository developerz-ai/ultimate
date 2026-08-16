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
| the client store | `IdentityMap` — one row value per `(entity, id)` — plus `RowWindows`, `rowKey`, `privateScope`, `applyPatches`/`orderAfterPatches` |
| tier 3 | `MemoryLocalStore`, `createOpfsLocalStore`, `OfflineQueue`, `RebaseLog`, `reconcile`, `custom` |
| wire | `PROTOCOL_VERSION`, `encode`, `decode`, `Frame` |
| halves | `LiveClient` (client), `createSyncNode` / `listenSyncNode` (`sync` role) |
| a socket's identity | `SyncAuthenticator`, `SyncGrant`, `GrantBook`, `sweepGrants`, `DEFAULT_REAUTH_INTERVAL_MS` |
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

## Who a socket is

`createSyncNode({ authenticate })` is the one place a websocket gets an identity. It runs on the
upgrade **before** `server.upgrade`, so a refused credential never costs a socket, and the actor it
resolves is what every policy downstream decides against — the topic guard, `authorize`, `visible`,
the per-tenant subscription cap.

```ts
createSyncNode({
  // From @ultimat3/auth, or anywhere else: `sync` imports no authenticator, exactly as it owns no
  // mutation logic. `refresh` is yours too, so the framework retains no credential of its own.
  authenticate: async (request) => {
    const session = await sessionFrom(request);
    return session === null
      ? null
      : { actor: session.actor, expiresAt: session.expiresAt, refresh: () => renew(session.token) };
  },
});
```

| The answer | What the node does |
|---|---|
| a `SyncGrant` | upgrades, and the socket carries `grant.actor` |
| `null` | **401** `X_SOCKET_UNAUTHENTICATED` — a decision, and the client's own condition |
| a throw | **503** `X_SOCKET_AUTH_UNAVAILABLE` — a failure, reported, and the client is told to retry |
| the option is absent | upgrades **anonymous**, and `start()` warns: every policy on that node is being asked about `null` |

`expiresAt` is the half a long-lived socket needs: the node re-decides an expired grant on an
interval (`reauthenticateIntervalMs`, 30s), calling `refresh` and then `hub.onActorChange` +
`registry.reauthorize` — so a revoked role drops the topics and subscriptions it no longer covers,
and survivors are re-snapshotted under the new authority. No `refresh`, and an expired grant closes
the socket with `1008`; the client re-dials with a fresh credential. A `refresh` that *raises* keeps
the socket and retries next pass — a token service timing out is not a revocation.

**Without `authenticate` this node is single-tenant.** Every actor is `null`, so
`hub.guard('org.*.feed', ({ actor }) => actor?.orgId === …)` denies everyone and the only guard that
lets anything through is one that reads no actor at all.

Authz goes through `@ultimat3/query`'s `guard`, which is the only contact with `@ultimat3/policy`.
One authz system, never two: `policy` is evaluated **once per subscriber**, never once per query.
Two actors on one live query get two different result sets, and a row that leaves an actor's policy
is delivered to them as a `delete` — never as silence.

## What one socket may cost

Every ceiling on this node, and the option that moves it. Each one is a default, not a policy: an
app narrows or widens it where the object is constructed, and none of them can be raised from the
wire.

| Ceiling | Default | Option | Refused with |
|---|---|---|---|
| concurrent sockets on this node | 250,000 | `createSyncNode({ maxConnections })` | `503` + `retry-after-ms`, the same shed as the accept budget |
| inbound bytes per frame | 256 KiB | `createSyncNode({ maxFrameBytes })` | the socket, by `Bun.serve`'s `maxPayloadLength` |
| inbound frames per socket | 64/s, burst 256 | `createSyncNode({ maxFramesPerSecond, frameBurst })` | `X_FRAME_RATE_LIMIT` |
| live subscriptions per socket | 128 | `new LiveQueryRegistry({ maxPerSocket })` | `X_SUBSCRIPTION_LIMIT` |
| live subscriptions per tenant | unset | `new LiveQueryRegistry({ maxPerTenant, tenantOf })` — **both**, or it arms nothing | `X_SUBSCRIPTION_LIMIT` |
| distinct `(query, input)` pairs per node | 10,000 | `new LiveQueryRegistry({ maxEntries })` | `X_SUBSCRIPTION_LIMIT` |
| channel topics per socket | 64 | `new ChannelHub({ maxTopicsPerSocket })` | `X_SUBSCRIPTION_LIMIT` |
| distinct channel topics per node | 10,000 | `new ChannelHub({ maxTopicsPerNode })` | `X_SUBSCRIPTION_LIMIT` |
| retained patch bytes per node | 64 MiB | `new RingChangeBuffer({ maxBytes, maxBytesPerQuery })` | eviction, then a re-snapshot on resume |
| array lengths and `input` nesting in a frame | `FRAME_LIMITS` | none — a hard ceiling | `X_PROTOCOL_VERSION` |

The accept budget bounds the accept **rate**; `maxConnections` bounds the **count**, and they are
two different attacks — 500 accepts/s held open with one keepalive each is 1.8M sockets an hour.
The frame budget is per socket and checked at the top of the frame router, before anything a frame
can reach: a subscribe frame is a database read, a presence write and a fleet-wide publish, and one
authenticated socket is the cheapest foothold there is.

`FRAME_LIMITS` is the wire's own hard ceiling — array lengths (`cursor.ids`, `resume`, `patches`,
`rows`, `members`) plus the depth and node count of a client-supplied `input`. It is not an option:
`input` reaches `canonicalJson`, which recurses, so an unbounded one is a stack overflow in the
process rather than a slow query.

## One row per `(entity, id)`

Two components subscribing to two live queries that both return post #7 hold **one** row, not two
copies of it. That is the client's whole store: a `LiveClient` owns one `IdentityMap`, every live
window is an ordered list of ids over it, and the tier-3 local store's tables are membership over
the same map. A write through any of them is the same row for all of them.

```ts
const feed = useLive(liveFeed, () => ({ orgId }));   // holds p1, p2, p7
const pinned = useLive(livePinned, () => ({ orgId })); // holds p7

await like({ postId: 'p7' });  // one optimistic write...
feed()[2] === pinned()[0];     // ...and both views are looking at it
```

Nothing is declared to get this. There is no normalization schema, no cache key, no selector — an
app writes `useLive` and `useMutation` exactly as before.

| Rule | Why |
|---|---|
| Identity is `(entity, id)`, never `id` alone | two entities may spell one id the same way; `posts/7` and `users/7` are two rows |
| The entity comes **from the server**, on the `snapshot` frame | the shape is compiled server-side out of `sql`; a browser cannot derive it, and a scope an app declares by hand is a second place for it to be wrong |
| A subscription the server named no entity for keeps its rows in a scope private to itself | no sharing is a stale view; wrong sharing is two entities merged into one row |
| A value is **replaced, never mutated** — every write is a new object | a mutated row is a render that never happens |
| A write **merges** columns; it never drops one | two queries may project different columns of one row, and the narrower one must not blank what the wider one renders |
| A row is dropped when the last window and the last table let go of it | an infinite scroll must not retain every row it ever saw |
| A rebase rolls back through the same map | the optimistic write, the server's truth and the replay are one row's history, not a second copy's |

`entity` on a `snapshot` frame is **additive**: an older node omits it and the client falls back to
the private scope, a newer node sends it and an older client ignores it. Both skews are safe in
both directions, which is why it carries no `PROTOCOL_VERSION` bump.

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

- **The change window is per node, and a `qid` window can only be.** A client that reconnects to a
  *different* `sync` node has no ring there and takes the snapshot path. It is not a placement bug:
  a patch is query-scoped, and the replicator is entity-scoped — it holds no compiled shape, no
  matcher and no window, so it cannot produce one. What the snapshot path costs is one **shared**
  read per (query, node), not one per client. A cross-node delta needs an *entity*-keyed window each
  node fills from the change stream it already subscribes to, which is a `ResumeSource` shape change.
- **Fanout is at-most-once, and a gap is detected rather than assumed away.** The replicator stamps
  every published change with `producer` + `seq`; a `sync` node that sees a skipped sequence
  invalidates every window it holds and desyncs every subscriber, so the next change to each query
  re-reads and re-snapshots. Both fields are optional on the bus, so a publisher that does not
  sequence simply detects nothing. Durable replay (JetStream) is a separate decision — retention,
  storage and replay window — and is deliberately not this mechanism.
- **`desynced` has a reader.** A subscriber recorded as diverged — a dropped patch, a gate that
  failed, a window that lost its tail — is served a fresh snapshot out of the shared window on the
  next delivery, and only then is the mark cleared. A snapshot the socket refuses leaves it
  diverged, which is the state it is actually in.
- **A delta resume leaves the digest unverified** (`DIGEST_UNVERIFIED`). Only a snapshot re-establishes
  it. `verifyDigest()` is how a client detects drift and asks for a fresh one.
- **Backpressure drops patch frames.** That is safe *only* because a re-snapshot is cheap: the drop
  is recorded on the socket (`desynced`) and the next delivery re-snapshots rather than diverging.
- **A full presence frame is capped** at `maxMembers` (256) and carries `total`, so a 5,000-person
  room renders "and 4,744 others" instead of shipping 5,000 members to every joiner. The set itself
  is never capped — the sweep differences it — and one node per topic runs that sweep, elected
  through the shared store, rather than every node re-reading every room it has ever seen.
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
  implements the full journal/rollback/replay semantics today. It holds membership and the journal;
  the row values are the client's one `IdentityMap`, which is what a browser store has to inherit
  rather than re-implement.
- The identity map is **per client**, in memory, and it is not a query cache: it answers "what is
  row X now", never "have I run this query before". Nothing evicts by time or size — a row lives
  exactly as long as a window or a table holds it.

## Errors

`X_TOPIC_FORBIDDEN` · `X_SUBSCRIPTION_LIMIT` · `X_SUBSCRIPTION_ID_TAKEN` ·
`X_PROTOCOL_VERSION` · `X_CURSOR_STALE` ·
`X_REBASE_CONFLICT` · `X_TRANSPORT_UNAVAILABLE` · `X_TRANSPORT_PROTOCOL` ·
`X_REPLICATION_FAILED` · `X_REPLICATION_PROTOCOL` · `X_REPLICATOR_SLOT_HELD` ·
`X_LIVE_CLIENT_MISSING` · `X_LIVE_QUERY_UNKNOWN` · `X_SOCKET_UNAUTHENTICATED` ·
`X_SOCKET_AUTH_UNAVAILABLE` · `X_NOT_IMPLEMENTED`

Topics deny by default: a topic with no matching guard is forbidden. An authz hole is not a config
option someone forgot to set.

An upgrade `authenticate` refuses is `X_SOCKET_UNAUTHENTICATED` (401) and one it *could not decide*
is `X_SOCKET_AUTH_UNAVAILABLE` (503). Two codes, because the two have opposite instructions: the
first is the client's credential and pages nobody, the second is this node's dependency and pages
someone. Both are rendered as the error contract in the response body — there is no frame to carry
one, because the client never got a socket.

A `sid` belongs to the socket that chose it. A subscription is keyed by `(socket, sid)`, a drop
frame is scoped to the socket that sent it, and reusing a sid the same socket already holds is
`X_SUBSCRIPTION_ID_TAKEN` — one client can neither take over nor end another's live stream.

A `subscribe` frame naming a query this node never registered is `X_LIVE_QUERY_UNKNOWN`, not
`X_PROTOCOL_VERSION`: the frame parsed and the version matched, so "rebuild and redeploy the
client" is the one instruction that cannot help — a rebuilt client spells the name the same way.
The fix is `x queries list --json`, and the name the client sent is echoed back while the registry
never is.

`As of 2026-07`: tiers 1–2 target v1, tier 3 targets v2.
