# ⚡ @ultimat3/realtime

Three tiers, one ladder, one protocol. Climbing a rung is a config change, never a rewrite.

## The ladder

| Tier | What it gives you | What it costs you |
|---|---|---|
| **1 — channels** | `publish`/`subscribe` on typed topics, presence, cursors, typing indicators | ~0. One filtered `send` per subscribed socket — no DB, no replication slot. **At most once**: a frame backpressure drops is counted, never replayed |
| **2 — live queries** | the list updates when someone else edits; your own click feels instant | one change feed + a matcher per query id + a bounded change window |
| **3 — local-first** | writes that survive being offline | a durable outbox, client-side migrations, a conflict story per mutator (plan 101 slice 12) |

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
  // Convergent, not incremental: `local` replays on every server update, so applying it N times has to
  // equal applying it once — `likedByMe` is what makes the second application a no-op.
  local(tx, { postId }) {
    tx.posts.update(postId, (p) =>
      p.likedByMe ? {} : { likedByMe: true, likeCount: p.likeCount + 1 });
  },
  async server(ctx, { postId }) { return ctx.posts.like(postId); },
  conflict: 'server-wins', // | 'last-write-wins' | { kind: 'custom', merge(local, server) }
});
```

A write is always HTTP: `useMutation(likePost)` runs `local` into the page store's optimistic
overlay, then POSTs the mutator's action with an idempotency key. The socket is **read-only** —
subscriptions go up, snapshots, patches and presence come down (protocol 3, 21.0.0).

`local` must be pure and convergent — no I/O, no `Date.now()`, no `Math.random()`, and applying it
over its own result changes nothing — because the overlay REPLAYS it over every server update.

## Two entries, and which one an island may import

`@ultimat3/realtime` is the **client** half — the hooks, the page's record store, the offline outbox,
the wire and the reconnect vocabulary. `@ultimat3/realtime/server` is the bus, the Postgres replication
path and the sync node. A name lives in exactly one of them; the `Entry` column below says which.

The split is not cosmetic. `nats` `require()`s `stream/web`, so one barrel carrying `openNatsClient`
beside the client hooks made the browser island this package promises **unbuildable** —
`Browser build cannot require() Node.js builtin: "stream/web"`. `packages/cli/src/realtime-browser-barrel.test.ts`
bundles a client-only entry for `target: 'browser'` and fails the build if either
half reaches the other; `barrel-split.test.ts` fails if one name is exported from both.

Migrating from 7.x: an import of a **server** name changes its specifier and nothing else.

```
- import { ChannelHub, createSyncNode, LiveQueryRegistry } from '@ultimat3/realtime';
+ import { ChannelHub, createSyncNode, LiveQueryRegistry } from '@ultimat3/realtime/server';
```

Client names — the hooks, `RecordStore`, `OfflineQueue`, `encode`/`decode`, every `X_*` error
class — stay on `.`.

## Public API

| Concern | Entry | Export |
|---|---|---|
| tier 1 | `./server` | `ChannelHub`, `PresenceRegistry`, `SyncSocket`, `SocketRegistry` |
| tier 2 | `./server` | `LiveQueryRegistry`, `InMemoryChangeFeed`, `PgLogicalReplicationFeed`, `selectChangeFeed`, `createReplicator`, `PgAdvisoryLock`, `matcherFor` |
| replication | `./server` | `parsePgUrl`, `bunPgStream`, `PgOutputDecoder`, `entityRow`, `changeLsn`, `commitPositionOf` |
| the in-process change source | `./server` | `startLiveReplicator` — a repository's own writes as `ChangeEvent`s, for the embedded database `x dev` runs on (PGlite has no walsender). Moved from `@ultimat3/testing`, which no longer re-exports it |
| fanout | `./server` | `Transport`, `InProcessTransport`, `NatsTransport`, `selectTransport`, `subjectMatches` |
| the bus, behind `NatsTransport` | `./server` | the port — `NatsClient`, `NatsMessage`, `NatsSubscription`, `NatsConnect`, `NatsTarget`, `parseNatsUrl` — plus `openNatsClient` (the `nats` adapter), `NatsKvSet`, `ensureKvBucket`, `kvGet`/`kvLast`/`kvWrite`, `assertBucket`, `encodeToken`/`decodeToken`, and `FakeNatsBroker`/`fakeNatsConnect` for tests |
| reconnect | both | `LiveCursor`, `resumeFrom`, `shouldResnapshot`, `defaultReconnectBudget`, `Scheduler`, `timeoutScheduler` on `.`; `RingChangeBuffer`, `drainPlan`, `AcceptBudget`, `reconnectFrame` on `./server` — the node's half of the reconnect is the node's |
| the page's record store | `.` | `RecordStore` — one record per `type:key`, synced truth plus the optimistic overlay — `recordKey`, `LocalTx`, `RowWindows`, `applyPatches`/`orderAfterPatches` |
| the outbox | `.` | `OfflineQueue`, `MemoryQueueStore` — replayed over HTTP from plan 101 slice 12. The conflict vocabulary is `ConflictPolicy` from `@ultimat3/core`; realtime declares none |
| wire | `.` | `PROTOCOL_VERSION` (3), `encode`, `decode`, `Frame` |
| the node | `./server` | `createSyncNode` / `listenSyncNode` (`sync` role) |
| a socket's identity | `./server` | `SyncAuthenticator`, `SyncGrant`, `GrantBook`, `sweepGrants`, `DEFAULT_REAUTH_INTERVAL_MS` |
| hooks | `.` | `useQuery`, `useRecord`, `useMutation`, `useMutationQueue`, `useConnection`, `useChannel`, `usePresence`, `hasPageSocket`, `installRealtime` |
| channels | `.` | `channel`, `channelRef`, `ChannelHandle`, `topic`, `readPresence`, the channel frame types |
| offline | `.` | `pageOutbox`, `recordPersister`, `persistedTypes`, `openLocalStore`, `pageLocalStore`, `MemoryLocalStore` |
| the socket's worker | `./sync-worker` | the SharedWorker entry — no exports |

## `channelRef` — a channel an island can hold

A channel has two halves, and they live in two files so a browser chunk never bundles an entity or
a policy. `channelRef(name, { params, catchUp })` is the **client** half: the name, the ordered
params and the catch-up read — nothing else. The server declares the records and who may join on
**the same ref** with `channel(ref, { … })`, so the name and the params are written once.

```ts
// app/posts/channel-ref.ts — imported by islands
import { channelRef } from '@ultimat3/realtime';

export const ORG_POSTS = channelRef('org-posts', {
  params: ['orgId'],
  catchUp: { name: 'orgPosts' },   // the query a client re-runs on `replay-gap` or a new epoch
});

// The one topic spelling both halves use.
ORG_POSTS.topic({ orgId: 'org_1' });   // 'org-posts.org_1'
```

The server half, in its own file, names the entity and the policy on the same ref —
`channel(ORG_POSTS, { records: [posts], policy: feedRead })` — and an island subscribes with
`useChannel(ORG_POSTS, { orgId })`.

`ref.topic(params)` is the one spelling of the topic both halves use (`org-posts.<orgId>`), and
`bun run channel-literals` refuses a hand-built topic anywhere else. A bad name or a repeated param
is `X_CHANNEL_DECLARATION_INVALID` at declaration. `catchUp` is read on every access, so a query
whose name `registerQueries()` stamps at boot is picked up. The reference app's
[`app/posts/channel-ref.ts`](../../examples/dummy/apps/web/app/posts/channel-ref.ts) is the idiom.

## The hooks

One record store and one socket per **page**, on `globalThis`: every island is its own bundle, so a
module-level singleton would be one per island. The island bootstrap `x build` prepends installs
realtime for its bundle — `installRealtime({ signal: createSignal, sync: { url, buildId } })` — and
an island never constructs a client or a socket. The socket opens on the first live hook; an island
that only reads records or writes ships none of it.

```ts
import {
  type ChannelRef,
  type MutatorLike,
  useChannel,
  useConnection,
  useMutation,
  useMutationQueue,
  usePresence,
  useQuery,
  useRecord,
} from '@ultimat3/realtime';

declare const orgId: string;
declare const postId: string;
declare const LIKE_POST: MutatorLike; // name + local twin + conflict — never the mutator VALUE
declare const orgFeed: ChannelRef<'orgId'>; // a `channel('org-feed', { params: ['orgId'], … })`
declare function onEvent(event: Readonly<Record<string, unknown>>): void;

const feed = useQuery({ name: 'liveFeed', live: true }, { orgId }); // AsyncState<readonly Row[]>
const posts = useQuery({ name: 'listPosts', entity: 'posts' }, {}); // one HTTP read, rows as records
const post = useRecord('posts', postId);                            // AsyncState<Row | undefined>
const like = useMutation(LIKE_POST);                                // await like(input); like.pending
const connection = useConnection();                                 // .offline .online .reconnectAt .updateAvailable
const writes = useMutationQueue();                                  // .pending .failed
const feedChannel = useChannel(orgFeed, { orgId }, { onEvent });   // records → the store; events → onEvent
const room = usePresence(orgFeed, { orgId });                      // the channel's roster
```

**One socket per origin and principal**: the page's socket lives in a `SharedWorker`
(`@ultimat3/realtime/sync-worker`, bundled by `x build`) shared by every tab; with no worker the
same engine runs in-page. Writes that find no network go to the page's outbox — overlay kept — and
replay over HTTP, under their original idempotency keys, when the socket comes back. The outbox is
the page boot's (`@ultimat3/realtime/boot`): an island only reads it off the page. On a page the
CLI renders no boot for (no scope tag, so nothing on it persists) such a write is refused like any
other — rejected, overlay taken back — never held in memory a reload would silently lose.

`<AsyncRegion state={feed()} …/>` takes the answer as-is: `AsyncState` is `@ultimat3/core`'s, the
same type `@ultimat3/ui` renders.

| Rule | Why |
|---|---|
| A query ref is `{ name, live?, entity? }`, never the query VALUE | importing a `query()` drags its read path into the island (698,801 B measured) |
| Lists hold keys; rows are the store's | a record updated by any answer or frame re-renders every list showing it, with no refetch |
| Every write is HTTP through core's `clientTransport` | one write path: the action's authz, idempotency and contract; the socket carries none |
| The answer's records are adopted before the overlay goes | a convergent twin never flickers back to the pre-write value |
| **No `solid-js` import.** Each bundle installs its own `SignalFactory` | every island carries its own solid-js; a signal from another bundle is invisible to its effects |
| Every member is a **getter**, every result an **accessor** | a value snapshotted at hook time never re-renders |
| `input` is read **once** | nothing here re-runs it; a changed input is a new `useQuery` |
| The caller owns `release()` / `using` | this layer does not know what a mount is |

**A server render** (no install, no DOM) answers `pending`, reports online and creates no page
state; a `useMutation` call refuses with `X_LIVE_SERVER_RENDER`. With a DOM and no install, every
hook is `X_REALTIME_UNINSTALLED`. `hasPageSocket()` is the guard a component with a static fallback
asks.

## Who a socket is

`createSyncNode({ authenticate })` is the one place a websocket gets an identity. It runs on the
upgrade **before** `server.upgrade`, so a refused credential never costs a socket, and the actor it
resolves is what every policy downstream decides against — the topic guard, `authorize`, `visible`,
the per-tenant subscription cap.

```ts
import type { Actor } from '@ultimat3/core';
import type { SyncGrant, SyncNodeOptions } from '@ultimat3/realtime/server';

declare function sessionFrom(
  request: Request,
): Promise<{ actor: Actor; expiresAt: number; token: string } | null>;
declare function renew(token: string): Promise<SyncGrant | null>;

// The one option this section is about; `createSyncNode({ …, authenticate })` takes it.
const options: Pick<SyncNodeOptions, 'authenticate'> = {
  // From @ultimat3/auth, or anywhere else: `sync` imports no authenticator, exactly as it owns no
  // business logic. `refresh` is yours too, so the framework retains no credential of its own.
  authenticate: async (request) => {
    const session = await sessionFrom(request);
    return session === null
      ? null
      : { actor: session.actor, expiresAt: session.expiresAt, refresh: () => renew(session.token) };
  },
};
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
| how long one entry's SHARED snapshot read may hold its slot | 30s | `new LiveQueryRegistry({ readDeadlineMs })` | `X_TIMEOUT`, to that read's caller AND every subscriber joined to it |
| channel topics per socket | 64 | `new ChannelHub({ maxTopicsPerSocket })` | `X_SUBSCRIPTION_LIMIT` |
| distinct channel topics per node | 10,000 | `new ChannelHub({ maxTopicsPerNode })` | `X_SUBSCRIPTION_LIMIT` |
| outbound bytes buffered on one socket | 1 MiB | `createSyncNode({ maxBufferedBytes })` | the frame is dropped and `send` answers `false` |
| dropped frames before that socket is closed | 32 | `createSyncNode({ maxDroppedFrames })` | close `1013` (`overloaded`), reason `backpressure` |
| time one socket may route no frame | 120s | `createSyncNode({ idleTimeoutMs })` | close `4001` (`idle`), reason `idle timeout` |
| retained patch bytes per node | 64 MiB | `new RingChangeBuffer({ maxBytes, maxBytesPerQuery })` | eviction, then a re-snapshot on resume |
| array lengths and `input` nesting in a frame | `FRAME_LIMITS` | none — a hard ceiling | `X_PROTOCOL_VERSION` |

**Every one of those is taken as a reservation, not checked.** A subscribe holds nothing until three
awaits later, so `SubscriptionBook.reserve(socket, sid)` and `ChannelHub`'s bridge reservation decide
the sid claim and all four subscription caps **synchronously, before the first `await`**, against a
count that already includes the subscribes still in flight. One WebSocket write carrying N subscribe
frames used to pass every cap N times — the ordinary case, no attacker required. The slot is given
back in a `finally`, and releasing twice is a no-op.

The accept budget bounds the accept **rate**; `maxConnections` bounds the **count**, and they are
two different attacks — 500 accepts/s held open with one keepalive each is 1.8M sockets an hour.
Both the count and `/readyz` are re-asked **after** `authenticate` resolves and immediately before
`server.upgrade`: awaiting app code is awaiting a token service, and a restart storm parks every
client of a dead node in there at once, each having passed a cap the node has since filled.
The frame budget is per socket and checked at the top of the frame router, before anything a frame
can reach: a subscribe frame is a database read, a presence write and a fleet-wide publish, and one
authenticated socket is the cheapest foothold there is.

`FRAME_LIMITS` is the wire's own hard ceiling — array lengths (`cursor.ids`, `patches`, `rows`,
`members`) plus the depth and node count of a client-supplied `input`. It is not an option:
`input` reaches `canonicalJson`, which recurses, so an unbounded one is a stack overflow in the
process rather than a slow query.

## One record per `type:key`, per page

Two islands showing post #7 hold **one** record, not two copies. The page's `RecordStore` is the
whole client store: every live window, every `useQuery` list and every `useRecord` is a projection
over it, and an HTTP answer's records, a socket patch and an optimistic write all land in it.

| Rule | Why |
|---|---|
| Identity is `type:key` — the entity's NAME and the key the SERVER computed | two entities may spell one key the same way, and the browser has no entity schema to derive a key from |
| The live path names the type server-side (`recordTypeForTable`) | a changefeed speaks tables; the store speaks entities |
| Two layers: synced truth and the optimistic overlay | a refused write drops its overlay and shows exactly what the server said — never a stale before-image |
| The overlay is REPLAYED over every server update | two pending writes on one row land in order on top of someone else's change |
| A value is **replaced, never mutated**; a write **merges** columns | a mutated row is a render that never happens; a narrower projection must not blank a wider one |
| A structurally bad row is `X_RECORD_REJECTED`, dropped and reported | never partially merged — a keyless row would overwrite another record |
| The last holder leaving evicts the record | an infinite scroll must not retain every row it ever saw |
| A principal change clears the store | nothing of the previous principal survives in memory |

## Reconnect is the hard part

A deploy drops N sockets at once and every one asks "what changed since X?". If that answer needs
arbitrary WAL replay or a re-run of every query, a rolling restart becomes a self-inflicted outage
that outlasts the deploy. The design confronts it with exactly two paths and no third:

| Path | When | Cost |
|---|---|---|
| **delta** | the cursor's gap is inside the retained window and inside the budget | one buffer read, zero DB work |
| **snapshot** | out of window, past `maxLagMs`, or past `reconnectBudget` | one bounded indexed query |

A `LiveCursor` is `qid` + `lsn` + last-seen `ids` + `at`, and nothing else. The ids let a delta be
re-filtered per subscriber, because the retained window stores **pre-policy** patches. It carried a
result-set `digest` and a `count` until 2026-08-24; both were written by every snapshot and read by
nobody, and the digest cost a canonical serialize plus a hash over every row of every snapshot —
paid once per live query per reconnecting socket. `resumeFrom()` picks the path,
`shouldResnapshot()` explains it, and the budget is a cost model in patch-equivalents
(`snapshotCost: 250` = "replaying 250 patches costs a snapshot") so the expensive path is *chosen*,
never stumbled into.

On drain, `drainPlan()` gives every client its own jittered slot in a spread window and the node
sends a `reconnect` frame carrying that delay — clients redistribute instead of stampeding.
`AcceptBudget` is the receiving node's token bucket, and a refusal always carries a retry delay,
because refusing without one just moves the herd next door.

The client dials itself back. A closed socket arms one timer — the node's delay when a `reconnect`
frame assigned one, otherwise `@ultimat3/core`'s `backoffDelay()` on the client's `BackoffPolicy` — and that timer calls `connect()`, which re-subscribes
every registration **and re-announces every topic**. Topic membership is state on the node's socket
and `hello` carries none of it, so without that half a channel goes silent from the first reconnect
onwards while its handler is still installed — and its presence membership is swept, because
subscribing to a topic *is* joining the room. `reconnectAt` is what a component renders while it
waits; `close()` cancels it, and `connect()` starts over. The timer comes from an injected
`Scheduler`, so a test fires it by hand instead of sleeping.

A browser's curve is `browserBackoff` — the same core curve, `equal` jitter, capped at
`BROWSER_RECONNECT_MAX_MS` (4s) where the server-side `defaultBackoff` caps at 30s: a node that
comes back is reached within seconds, and so is the `update-available` it carries. The socket
engine (one per origin, in the `SharedWorker`) keeps none of it across pages: a page arriving while
the node is down dials at once on a fresh curve, and the last page leaving forgets the target, so
the next build's page never dials with the old build id.

### Liveness: `heartbeatMs`

A half-open socket — the TCP connection is dead and no `close` ever fires — is invisible to the
browser. The client is the only thing that can end one, and the page socket beats at the default
below (`heartbeatMs` on the internal `LiveClient`; `0` disables the pass).

| Property | Behaviour |
|---|---|
| Default | `DEFAULT_HEARTBEAT_MS`, 15s. The client's own number and the only one: `realtime.heartbeatMs` in `app.config.ts` was deleted 2026-08-19 because nothing read it |
| One beat | a `hello` — which carries no cursors at all; `HelloFrame` has no resume list, so a beat and an opening frame are byte-identical — plus one subscribe frame per topic held |
| Why the topics | on the node, repeating the subscribe frame **is** the presence heartbeat; presence has no frame of its own in either direction |
| Not a deploy check | `update-available` answers a skew between the build the client claims — the `hello`'s `buildId`, or `?build=` on the dial; every hello is read and the latest one is the record — and the node's own. A client says the same build on every beat and the node's never moves while the socket is open, so every `hello` on one socket answers the same forever. A client hears about a deploy on the socket it opens against the **new** node |
| Silence | nothing received for **two** intervals ⇒ close `4000` (a private-use code, so it is distinguishable in a log) and arm the reconnect. Judged from the last frame of any kind, since the point is that bytes still cross |
| Not an interval | one armed tick, re-armed by itself, on the same injected `Scheduler` the reconnect uses — a client is either beating on a live socket or backing off toward a new one, never both |

`realtime.heartbeatMs` in `app.config.ts` is **gone** `As of 2026-08-19` — it was read by nothing,
and an app that still sets it fails `x verify`'s typecheck step with TS2353 (`'heartbeatMs' does not
exist in type 'Input<RealtimeConfig>'`). Delete the line; this option is the only knob that changes
behaviour, and the node's presence beat is derived from its TTL rather than configured.

### A `send` that returned is not an acknowledgement

`WebSocket.send` on a CLOSING socket discards the frame and returns normally, so a drained mutation
is `inflight` — never `acked` — until the server settles it with an `ack`/`fail` frame, or a lost
connection returns it to `pending`. Only `pending` entries are sendable, so nothing is put on the
wire twice by a reconnect that raced an ack.

| Rule | Consequence |
|---|---|
| `drain()` is **one pass at a time**, chained rather than joined | two overlapping passes read the same entry as sendable and put one key on the wire twice; a later pass could also overtake the one in front of it, which is the ordering guarantee gone. A caller that enqueued mid-pass gets a pass *behind* it, not that pass's promise |
| A pass stops at the first refusal | continuing past a failure is how a sync engine reorders a user's intent |
| Backpressure **declines**, it does not fail | over `MAX_BUFFERED_BYTES` (1 MiB, the node's `backpressureLimit` at the other end of the same socket) the sender throws `X_TRANSPORT_UNAVAILABLE`, the mutation stays pending and the next drain resumes there. `ClientSocket.bufferedAmount` is optional; a socket that does not report it is treated as never backed up |
| Delivery is therefore at least once | every mutation carries an idempotency key — the `key` argument, or `<mutator>:<uuid>` — and the resend carries the same one |
| A lost connection **cancels the pass it interrupted** | the lane orders passes against each other, but a socket death is not a pass and cannot reach one parked inside `send`. `requeueInflight()` bumps a connection epoch; a pass whose epoch went stale returns and leaves the rest `pending`. Without it the parked pass resumed and marked everything behind it `inflight` for a dead socket — never re-sent (`inflight` is not sendable) and never acked |
| The store is handed **snapshots, by key**, never the live entries or the whole queue | `QueueStore.write` is a durable write and may await before it reads; given an entry itself it persists a status that was never true when it was called. By key, because two tabs of one user share the store and a whole-queue save let the last tab erase the other's write |
| One tab drains at a time, and drains what every tab queued | the outbox's replay runs under the Web Lock `ultimate-outbox:<principal>` and re-reads the queue first, so a write another tab queued is sent, in order, and a stored `inflight` from a closed page goes back to `pending` |

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
- **The client's cursor advances on every patch, not only on a snapshot.** Left behind, `cursor.at`
  froze at the last snapshot and `shouldResnapshot`'s lag check answered "re-snapshot" for every
  client connected longer than `maxLagMs` — the delta resume the retained window exists for, dead
  exactly during the deploy storm it was built for.
- **The socket carries no writes (protocol 3, 21.0.0).** A write is HTTP; an `ack` is only ever a
  refusal, naming the subscription it refused (that window renders `failed`) or the socket for a
  frame the node could not read — including a `mutate` from a client one major behind.
- **Nothing on the client detects drift, and nothing ever did.** `verifyDigest()` claimed to and had
  no caller (deleted 2026-08-23); the `digest` it read went with it (2026-08-24), along with the
  `count` beside it. What detects drift is the server's `desynced` mark and the re-snapshot it
  triggers. Removing the two fields moved `PROTOCOL_VERSION` to **2** — `cursor()` decodes through
  readers that throw on an absent field, unlike the `list()` that made `hello.resume`'s removal free.
- **Backpressure drops patch frames.** That is safe *only* because a re-snapshot is cheap: the drop
  is recorded on the socket (`desynced`) and the next delivery re-snapshots rather than diverging.
- **A dropped CHANNEL frame is not safe, and is not repaired.** A topic has no cursor, no mark and
  no re-snapshot, so tier 1 is **at most once**. Every refusal is counted — the series
  `channel_frames_dropped_total` (no labels: a topic is client-chosen, so a per-topic label is
  unbounded series one socket can mint), the log line `channel.frames_dropped` at `warn` carrying
  `{ topic, dropped, total }`, and `node.sockets.droppedChannelFrames` for a test or a benchmark
  that cannot scrape. Node-wide and cumulative, because a socket past `maxDroppedFrames` is closed
  and removed — a per-socket count leaves exactly when loss is worst. Distinct from
  `SyncSocket.droppedFrames`, which counts every kind of frame one connection lost and dies with it.
  Repair would need a per-topic sequence on the wire: a channel's `lsn` is the publishing hub's own
  per-node counter, so a client cannot tell a gap from a message that arrived via another node.
  **Anything that must arrive belongs on a live query.**
- **Bun's native WS pub/sub is not used.** `subscribeTopic` does not call `ws.subscribe` and the
  websocket config declares no `publishToSelf`; every channel message is one filtered `send` per
  socket through `SocketRegistry.deliver`, reading a per-topic index rather than walking the socket
  table. A native publish cannot be refused per socket, cannot report the frame it dropped and
  cannot mark a subscriber desynced — which is to say it cannot do any of the three things above.
  `WsLike.subscribe`/`unsubscribe` stay **declared and unused**: the interface is structural and a
  tracked app implements it, so deleting the members breaks that app's typecheck.
- **Inbound frames are ordered per subscription, never per socket.** A
  global per-socket lane puts every frame behind the slowest one, and the slowest one is a
  subscribe's snapshot read — the round trip every reconnecting client pays in a restart storm.
  `subscribe` is one lane per sid, or per topic name; `hello` and
  the server-authored kinds are unlaned. A lane exists only while work is queued on it, because a
  lane keyed by a client-chosen sid that outlived its work is an unbounded map one socket can grow.
- **`qid` is `@ultimat3/query`'s `queryHash(name, input)`** — `<name>:<first 16 hex of
  SHA-256(canonicalJson(input))>`, 64 bits `As of 2026-08` where it was a 32-bit FNV-1a. It is a
  *sharing* key: a hit is answered with the existing entry and the seated window, both holding the
  first subscriber's input and rows, and input is client-chosen, so a collision is one client served
  out of another's window. This package derives none of its own — `qidOf` was a second spelling of
  `queryHash` while `@ultimat3/query`'s `planResume` compares a cursor's `queryHash` against the
  query's, so the two had to be one function or every resume decision and every window lookup would
  be keyed differently the first time either moved. A rolling deploy across the *hash* change costs
  one bounded snapshot per subscription — a cursor minted under the old format names a ring entry
  the new node never held, so the resume falls back correctly rather than silently; the `qidOf`
  removal itself costs nothing, because every qid a node computes comes from a decoded frame and
  `JSON.parse` produces none of the values the two spellings disagreed about.
- **A topic guard that *fails* keeps the topic.** On the re-auth pass, only a denial
  (`X_TOPIC_FORBIDDEN`, or a policy denial) unsubscribes; anything else increments `hub.guardFailures`
  and logs `channel.guard_failed`. `catch { unsubscribe }` reported a store that timed out as a
  revoked grant — every topic on every re-authenticated socket, silently, with the client never told
  to resubscribe. The initial `subscribe` is deliberately not split that way: there is no
  subscription to keep, so a guard that raises refuses that subscribe and the client hears about it.
- **An idle socket is swept, and the sweep is an APPLICATION budget, not Bun's.** Bun's own
  `idleTimeout` is renewed by its ping/pong, so a client whose frame loop is wedged answers pings
  and keeps its grant, its live subscriptions and its topic membership indefinitely. `start()`
  arms one `.unref()`ed pass every `idleTimeoutMs / 4` (floored at a second, derived rather than
  configured) and evicts anything past the budget the same way a close does — through the node's
  `teardown`, never `SocketRegistry.remove`. `SocketRegistry.idle()` is a *query* for that reason:
  the socket table is three of the five things a socket holds, and the other two are its live
  subscriptions and its presence membership on the shared set. `sweepIdle` — which closed and
  removed here, and had no caller at all — is gone. The budget is measured on `Clock.monotonic()`,
  so `SyncSocket.lastSeenMonotonicMs` is a duration's start and not an instant: an NTP step forward
  would otherwise evict every socket that is talking, and a step backward would spare every socket
  that is dead. `openedAt` stays on the wall clock — it is a value a human reads.
- **A `sync` node shuts down in two phases.** The `accept` phase calls `stopAccepting()`: `/readyz`
  answers 503 and a late upgrade is shed with `retry-after-ms`, while **every socket the node holds
  keeps its patch stream**. The `close` phase is `drain()` then `stop()`. Registered with no phase it
  all landed in `close`, and until that ran the node went on upgrading new websockets onto a process
  that was going away. Both hooks are unregistered by the listener's `stop()`.
- **`drain()` resolves once the presence leaves have LANDED**, not once they have been started —
  in bounded chunks of sockets, so a node holding tens of thousands does not open a write per topic
  per socket in one go. Started and not waited for, the process could exit with them still on the
  wire, and every other node would render every drained member for a full TTL: the rolling-restart
  double vision the leave exists to prevent.
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
  is discarded rather than written back: the window only ever moves forwards. Two reads are ordered
  by a monotonic **read generation** and never by lsn — a definition with no lsn provider answers
  `''` for every read, and `'' >= ''` let the older of two concurrent reads land on top of the
  newer one's gap repair, with `stale` already cleared and therefore nothing left to re-read.
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
- **A `delete` is withheld too, and `holds` is the whole decision** (`As of 2026-08`). It carries no
  row, so there is nothing to put in front of the rule — and it was forwarded unconditionally, so
  every subscriber learned the id and the instant of every *other* tenant's row as it was deleted,
  on a query whose `visible` rule had never let them see one. A subscriber that holds the row is
  told it is gone; one that does not gets nothing, counted as `rowsDenied`.
- **`PgLogicalReplicationFeed` decodes `pgoutput` off a real slot** — its own Postgres v3 client
  (SCRAM-SHA-256, in-band TLS, CopyBoth), no driver dependency. It preflights `wal_level`, the
  publication, every entity's replica identity and the slot — in that order, because the identity
  check is worthless once the slot exists — creates the slot when there is none, and confirms the
  slot as it goes so the WAL does not grow without bound. `InMemoryChangeFeed` + `InProcessTransport` remain the
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
- **`selectTransport(env, realtime)` decides which transport a boot fans out on** — and since
  22.0.0 the CONFIG decides it, not the environment: `realtime` is `app.config.ts`'s
  `{ transport, urlEnv }`. It returns `{ transport, mode, detail, bucket, presenceTtlMs, connect }`:
  `'memory'` → `InProcessTransport` and `mode: 'embedded'`; `'nats'` → a `NatsTransport` dialling
  the variable `urlEnv` names, on the KV bucket `NATS_KV_BUCKET` names (default `x_presence`, so
  two apps on one cluster do not share one presence namespace), validated here rather than on
  first connect. Both mismatches refuse with `X_CONFIG_INVALID`: `'nats'` with that variable unset,
  and `'memory'` with `NATS_URL` (or the named variable) set — an operator who set one expected
  fanout across nodes. Until 22.0.0 `NATS_URL` alone decided and both keys were read by nothing.
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
- **A live query needs `REPLICA IDENTITY FULL`, and the replicator now says so** (`As of
  2026-08-19`). Deciding whether a row *left* a result set needs the old values; with the default
  identity a delete replicates only the key columns, and `toRow` accepts that tuple because it only
  requires a text `id`. `preflight` asks `pg_class.relreplident` for every entity in the list — the
  fourth question it asks, and **before** `pg_create_logical_replication_slot`, since changing the
  identity after a slot exists does not reach the rows that slot will decode. It is a **coded
  warning**, `X_LIVE_REPLICA_IDENTITY`, whose `fix:` is the `ALTER TABLE <t> REPLICA IDENTITY FULL;`
  per named table — not a throw, because every app on the default identity would otherwise stop
  booting, which is worse than the partial rows. `ReplicationStreamStats.partialBefore` is the
  running half: one per change delivered off a relation that is not FULL, so the decisions it
  actually cost are countable rather than silent. A hard refusal at `x verify` time is the
  follow-up.
- The record store is **per page**, in memory, and it is not a query cache: it answers "what is
  record X now", never "have I run this query before". Nothing evicts by time or size — a record
  lives as long as something holds it. Persisting it (IndexedDB) is plan 101 slice 12.

## Errors

`X_TOPIC_FORBIDDEN` · `X_SUBSCRIPTION_LIMIT` · `X_SUBSCRIPTION_ID_TAKEN` ·
`X_PROTOCOL_VERSION` · `X_CURSOR_STALE` ·
`X_REBASE_CONFLICT` · `X_TRANSPORT_UNAVAILABLE` · `X_TRANSPORT_PROTOCOL` ·
`X_REPLICATION_FAILED` · `X_REPLICATION_PROTOCOL` · `X_REPLICATOR_SLOT_HELD` ·
`X_REALTIME_UNINSTALLED` · `X_SYNC_UNCONFIGURED` · `X_RECORD_REJECTED` ·
`X_LIVE_SERVER_RENDER` · `X_LIVE_QUERY_UNKNOWN` ·
`X_LIVE_REPLICA_IDENTITY` ·
`X_SOCKET_UNAUTHENTICATED` · `X_SOCKET_AUTH_UNAVAILABLE` · `X_NOT_IMPLEMENTED` ·
`X_TIMEOUT`

`X_NOT_IMPLEMENTED` and `X_TIMEOUT` are **borrowed** from `@ultimat3/core`, which owns and titles
them — `REALTIME_BORROWED_ERROR_CODES`. Everything else on that list is realtime's own.

Topics deny by default: a topic no `channel()` declares is forbidden, and a `channel()` with no
`policy` is refused at declaration (`X_CHANNEL_DECLARATION_INVALID`) — a public channel writes
`policy: allow('public')`. An authz hole is not a config option someone forgot to set.

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

### Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `CursorStaleError` (extends `RealtimeError`) | `X_CURSOR_STALE` | `src/page-errors.ts` |
| `FrameRateLimitError` (extends `RealtimeError`) | `X_FRAME_RATE_LIMIT` | `src/errors.ts` |
| `LiveQueryUnknownError` (extends `RealtimeError`) | `X_LIVE_QUERY_UNKNOWN` | `src/errors.ts` |
| `LiveRowUnidentifiedError` (extends `RealtimeError`) | `X_LIVE_ROW_UNIDENTIFIED` | `src/errors.ts` |
| `NotImplementedError` (extends `RealtimeError`) | `X_NOT_IMPLEMENTED` | `src/errors.ts` |
| `ProtocolVersionError` (extends `RealtimeError`) | `X_PROTOCOL_VERSION` | `src/page-errors.ts` |
| `RealtimeError` | any `RealtimeErrorCode` — `REALTIME_ERROR_CODES`; the base of every other class here, thrown directly for a code none of them covers | `src/realtime-error.ts` |
| `RealtimeUninstalledError` (extends `RealtimeError`) | `X_REALTIME_UNINSTALLED` | `src/page-errors.ts` |
| `RebaseConflictError` (extends `RealtimeError`) | `X_REBASE_CONFLICT` | `src/page-errors.ts` |
| `RecordRejectedError` (extends `RealtimeError`) | `X_RECORD_REJECTED` | `src/page-errors.ts` |
| `ReplicaIdentityError` (extends `RealtimeError`) | `X_LIVE_REPLICA_IDENTITY` | `src/replication-errors.ts` |
| `ReplicationFailedError` (extends `RealtimeError`) | `X_REPLICATION_FAILED` | `src/replication-errors.ts` |
| `ReplicationProtocolError` (extends `RealtimeError`) | `X_REPLICATION_PROTOCOL` | `src/replication-errors.ts` |
| `ReplicatorSlotHeldError` (extends `RealtimeError`) | `X_REPLICATOR_SLOT_HELD` | `src/replication-errors.ts` |
| `ServerRenderLiveError` (extends `RealtimeError`) | `X_LIVE_SERVER_RENDER` | `src/page-errors.ts` |
| `SubscriptionLimitError` (extends `RealtimeError`) | `X_SUBSCRIPTION_LIMIT` | `src/errors.ts` |
| `SyncUnconfiguredError` (extends `RealtimeError`) | `X_SYNC_UNCONFIGURED` | `src/page-errors.ts` |
| `TopicForbiddenError` (extends `RealtimeError`) | `X_TOPIC_FORBIDDEN` | `src/errors.ts` |
| `TransportProtocolError` (extends `RealtimeError`) | `X_TRANSPORT_PROTOCOL` | `src/errors.ts` |
| `TransportUnavailableError` (extends `RealtimeError`) | `X_TRANSPORT_UNAVAILABLE` | `src/errors.ts` |
| `WindowReadTimeoutError` (extends `RealtimeError`) | `X_TIMEOUT` | `src/errors.ts` |
