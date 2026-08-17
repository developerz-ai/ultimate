# Realtime

Three tiers, one ladder. Same mutator shape at every rung — climbing is a config change, never a rewrite.

`As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)). Tiers 1–2 ship in v1. Tier 3 (local-first) ships in v2.

## The ladder

| Tier | Name | You write | Server owns | Client owns | Cost |
|---|---|---|---|---|---|
| 1 | **Channels** | `ctx.channel('org:1').publish(evt)` | truth + fanout | subscription | ~0 — pubsub over WS |
| 2 | **Live queries** | `query({ live: true, sql })` | truth + change detection | a reactive result set | one replication slot + a matcher |
| 3 | **Local-first** | the same `mutator` + `persist: true` on the query | truth + rebase | a durable local store, offline writes | IndexedDB store + rebase log |

Tier 1 for presence, typing indicators, toasts, cursors. Tier 2 for "the list updates when someone else edits". Tier 3 for offline-capable apps.

**Tier 1 is at-most-once, by construction.** A channel topic has no cursor and no re-snapshot, so a frame dropped under backpressure is not resent — it is counted and logged, never repaired ([below](#why-delivery-needs-its-own-counter)). That is the line between the tiers: state that must arrive belongs on a live query, ephemera belongs on a channel.

Tier 2 covers what people almost always mean by "make it realtime": the list updates without a refresh, and my own click feels instant. It delivers both with **no client database, no client schema versioning, no conflict-resolution UX, and no offline-write semantics to design**. Tier 3 buys exactly one additional property — writes that survive being offline — and costs a durable local store, a rebase log, client migrations, and a conflict story per mutator. Charging every app for that is how realtime frameworks become slow frameworks.

## Same mutator at every rung

```ts
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

| Tier | What `local` does | What `server` does |
|---|---|---|
| 1 | not called | runs, publishes an event |
| 2 | applies to the in-memory live result immediately, reverted on server echo | runs, DB change flows back through the live query |
| 3 | applies to the durable local store, queued while offline | runs on reconnect, result rebases the local log per `conflict` |

**A mutation the server *refuses* is rolled back, not retried.** The optimistic write goes, and so does every write made after it — undone newest first, then replayed without it, which is sound only because `local` is pure. The refused intent is dropped from the rebase log: a denial is a decision about that intent, and retrying it would put the write the server refused back on the screen. A refused key stays in the queue as `failed` for the UI to render, and re-issuing the same idempotency key is treated as a **new** intent with a new sequence at the back of the queue, not a collapse onto the denial.

`local` is a pure function of `(tx, input)`, therefore replayable. Hence the rule: **no I/O, no `Date.now()`, no `Math.random()` inside `local`.** Same input, same patch, every replay.

## The fluent surface

`interface Mutator extends Action` — a mutator **is** an action, so every action member is already on it (`likePost.tool()`, `.openapi()`, `.client({ baseUrl })`, `.job()`, `.contract()`, `.as()`, `.describe()`, `.named()`, and the lifted `.input` `.output` `.policy` `.mcp`). The three names it was authored with — `.local`, `.server`, `.conflict` — project unchanged, plus a brand and its own descriptor. Both halves are reached through the mutator itself, `likePost.local(tx, input)`, never a declaration object. A mutator has no `.def`.

| Member | Is | Rule |
|---|---|---|
| `.local(tx, input)` | the optimistic twin | runs against the local store, synchronously, no I/O, returns `void`. Takes **already-parsed** input — nothing re-parses on this half |
| `.server(ctx, input)` | the authoritative half | takes **raw** input, like the callable and `.as()`, because this is where parsing happens |
| `.conflict` | the rebase strategy, lifted | `'server-wins'` \| `'last-write-wins'` \| `custom(merge)` — the declared value verbatim, merge function included |
| `.isMutator` | the brand | always `true`; `isMutator(value)` is the guard |
| `.describeMutator()` | the manifest row | the action descriptor plus `kind: 'mutator'` and the **resolved** strategy name — `custom(merge)` describes as `'custom'` |
| `.describe()` | the action descriptor | still reports `kind: 'action'`, with `mutator: true` — that flag is what puts the `mutator` count in `x.manifest.json`. `describeMutator()` is the one that says `kind: 'mutator'`, plus the resolved strategy |

**`.server()` routes through the action's own callable, never the declared `server`.** It calls `base(input, { ctx })`, and that callable *is* `invoke` — so the authoritative half cannot skip the input parse, the policy or the output parse. Reaching the declaration from there would be a second execution path, which is the one thing `@ultimat3/action` exists to prevent. Hence the guarantee this page rests on: the offline/realtime half of a mutator gets exactly the same parse → policy → handle → parse core as an HTTP call, an MCP tool call and a job run, because it **is** that call. A denied `.server()` never reaches the declared half, and neither does one whose input fails the schema — `X_UNAUTHENTICATED`, `X_FORBIDDEN` and `X_INPUT_INVALID` come back from the same core that serves the HTTP route.

The parsed-vs-raw asymmetry between `.local()` and `.server()` is deliberate, not an inconsistency. `local` replays on every rebase and must stay a pure function of `(tx, input)` — no I/O, no clock, no randomness — so re-parsing on each replay would be wasted work on input that was already validated once.

`.local()` is the name. No alias: the old `.applyLocal` is gone, not deprecated.

`.named()` rewraps rather than dropping the twin — a renamed mutator keeps both halves, its `conflict`, and every inherited action member.

## Tier 2 → tier 3 is `persist: true`

```ts
// tier 2
export const liveFeed = query({ /* ... */ live: true });

// tier 3 — same query, durable client store + offline writes
export const liveFeed = query({ /* ... */ live: true, persist: true });
```

| Changed by `persist: true` | Unchanged |
|---|---|
| client result store: memory → IndexedDB | the mutators |
| mutator queue: ephemeral → durable | the authz (`policy` on the query) |
| reconnect: resubscribe → replay local log, then rebase | the server code |
| adds client-side store migrations | the `sql`, the tags, the MCP tool |

Teams adopt tier 2 in week one and can afford tier 3 in year two without a migration project. That is the whole promise of the ladder.

## Live query pipeline

```
Postgres (logical replication slot)
    │  WAL decode, per-table
    ▼
replicator role  ──► change feed (ordered, per-table, with LSN)
    │
    ▼
incremental matcher  ──► for each registered live query: does this row enter/leave/update the result?
    │                      (predicate + order + limit evaluated against the changed row only)
    ▼
NATS subject per query-hash + tenant  ──► fanout
    │
    ▼
sync role (stateless)  ──► WS frame: {qid, op: insert|update|delete, row, lsn}
    │
    ▼
Solid signal patch — fine-grained, no re-render of the list
```

| Stage | Owned by | Guarantee |
|---|---|---|
| WAL decode | `replicator` (1 per DB) | ordered by LSN, at-least-once |
| matcher | `replicator` | a change touching no registered query costs one predicate check |
| fanout | NATS | subject = hash(query, params, tenant); no per-socket state on the bus |
| socket | `sync` (stateless, no sticky sessions) | client re-subscribes anywhere; scales on connection count |
| authz | `policy` on the `query` | evaluated at subscribe **and** re-checked on row delivery — a row that fails the policy is dropped, never sent |

The matcher is why this is affordable: membership is decided from the changed row plus the query's predicate, order, and limit — never by re-running the query. Which is exactly why `live: true` requires a deterministic, bounded `sql` ([Queries and live queries](Queries-And-Live-Queries)).

## One row per `(entity, id)`

`As of 2026-08` the client holds an **identity map**: a row is one object, keyed by its entity and
its id, however many live queries returned it. A subscription is an ordered list of ids; the values
come from the map.

| Consequence | Why it matters |
|---|---|
| A patch on one live query is observed by every other holding that row | two components rendering post #7 cannot disagree about it |
| A mutator's optimistic twin lands in every window holding that row | before this, `local(tx, input)` wrote the local store and **no live query read it** — the twin was invisible until the server round-tripped |
| A `server-wins` rebase rolls the optimistic write back everywhere | one row, one rollback |
| A write **merges** columns rather than replacing the row | two queries may project different columns; a narrower snapshot must not blank what a wider one renders |
| A row lives exactly as long as a window or a table holds it | the last release drops it, so an infinite scroll is not a leak |

The scope is `(entity, id)`, not `id` — `posts/7` and `users/7` are two rows, and a slug primary key
makes that collision plausible rather than theoretical. The entity name rides on the snapshot frame,
sourced from the query's compiled shape; it is the same string `ChangeEvent.entity` and `tx.<table>`
already use. **A subscription the server names no entity for keeps its rows private**, colliding with
nothing — wrong sharing would merge two entities into one row, while no sharing only costs a stale
view.

Membership and identity are deliberately separate, which is Ember's own split between records and
record arrays. Sharing one `Map<table, Map<id, Row>>` instead would mean rolling back an optimistic
insert deletes a row the server had since sent to another window.

Nothing changes for an app author. The one convention that now *pays off* rather than merely being
tidy: a mutator's `tx.<table>` key and a query's `from('<table>', …)` must name the same entity —
they already had to, and disagreeing now costs the sharing instead of costing nothing.

## LSN cursors

Every frame carries an LSN. The client's last-seen LSN is what makes reconnect a **delta** instead of a refetch.

| Property | Behavior |
|---|---|
| Cursor | the highest LSN the client has applied, per subscription. It advances on **every patch**, not only on a snapshot — a cursor whose `at` freezes at the last snapshot fails the lag check, and every client connected longer than `maxLagMs` re-snapshots instead of resuming |
| Reconnect inside the change buffer window | delta replay from the `replicator`'s ring buffer — zero DB work |
| Reconnect outside the window | one bounded snapshot query at a current LSN. Never WAL history traversal |
| Cursor unusable and no snapshot path supplied | `X_CURSOR_STALE` |
| Ordering | LSN is monotonic per DB, so a client can never apply an older change over a newer one |

## Inbound frame order

A frame is routed as soon as it arrives, so two frames from one socket can be in flight at once. What is ordered is narrow and deliberate `As of 2026-08` — a lane per socket would put every frame behind the slowest one, and the slowest one is a subscribe's snapshot read.

| Frames | Ordered against | Why that unit |
|---|---|---|
| `mutate` | every other `mutate` on the same socket | they write the database, and the client numbered them |
| `subscribe` on a query | the same `sid` | `add` then `drop` for one sid, or the drop finds nothing and the add strands the subscription it was meant to end |
| `subscribe` on a topic | the same topic name | one membership, same add/drop pair |
| `hello`, everything else | nothing | they read state and write none |

**Ordering is not what bounds the caps.** N sequential subscribes still pass a check-then-act limit N times, so every refusal a subscribe can answer with — the sid claim, `maxPerSocket`, `maxPerTenant`, `maxTopicsPerSocket`, `maxTopicsPerNode` — is decided **synchronously, before the first `await`**, against a count that already includes the subscribes still in flight. One WebSocket write carrying N subscribe frames used to pass each cap N times.

## Staying connected

A dead TCP connection that was never closed fires no `close` event. Only the client can end one, so it beats.

| Property | Behaviour |
|---|---|
| Interval | `new LiveClient({ heartbeatMs })`, default **15s**. `0` disables it |
| One beat | a `hello`, plus one subscribe frame per topic held. A beat and an opening frame are **byte-identical** — `hello` carries no cursors — so a beat asks for nothing and resumes nothing |
| Silence | nothing received for **two** intervals ⇒ the socket is closed with code `4000` and the reconnect timer arms |
| Why re-sending topics | on the node, subscribing to a topic **is** joining its presence set, and repeating the frame is the presence heartbeat |
| Server-side key | `realtime.heartbeatMs` in `app.config.ts` is read by nothing `As of 2026-08` → [Known gaps](Known-Gaps). Set the client option |

**A reconnect re-announces everything, one frame at a time.** `hello`, then one `subscribe` per registration carrying that registration's cursor, then one per topic. `hello` itself carries **neither** cursors nor topic membership — resume is decided per subscription, by the frame that also names the query and its input, and topic membership is state on the node's socket. Without the topic half a channel stayed silent from the first reconnect onwards while its handler was still installed, and its presence membership was swept.

**A `send` that returned is not an acknowledgement.** A browser `WebSocket.send` on a closing socket discards the frame and returns normally, so a drained mutation stays `inflight` until the server answers `ack`/`fail` — a lost connection puts it back to `pending` and the next drain resends it. **A drain pass parked when the socket dies abandons the rest of its queue** rather than marking it `inflight` on a connection that cannot answer: losing the connection bumps a drain epoch, and the parked pass checks it before claiming each remaining mutation. Without that, everything queued behind the parked one was marked `inflight` on a dead socket, and nothing ever moved it back — the queue stalled until the tab was reloaded. Delivery is therefore **at least once**, and the idempotency key is what makes the resend safe: every mutation carries one — the `key` argument to `client.mutate`, or `<mutator>:<uuid>` when none is passed — and the resend carries the same one.

## The reconnect risk

**Reconnect is the expensive part of any sync engine, and it is where naive designs fall over.** A deploy or a network blip drops N sockets at once; each client then asks "what changed since LSN X?" If the answer requires replaying arbitrary WAL history or re-running every query, a rolling restart becomes a self-inflicted thundering herd that outlasts the deploy.

| # | Mitigation | Detail |
|---|---|---|
| 1 | **Prototype before locking topology** | the reconnect benchmark: 50k sockets, forced `sync` restart, recovery time and DB load. **Measured `As of 2026-08`** — the numbers are below, and both results are committed |
| 2 | **Bounded per-query change buffer** | the `replicator` keeps a ring buffer of recent changes per query-hash. Reconnect within the window = delta replay from the buffer, zero DB work |
| 3 | **Snapshot fallback, not WAL replay** | outside the window the client gets a fresh snapshot at a current LSN. Cost is one bounded query, never history traversal |
| 4 | **Jittered reconnect-with-backoff, server-directed** | draining `sync` nodes send a `reconnect` frame with a per-client delay so clients redistribute instead of stampeding. `LiveClient` arms **one** timer per closed socket — that delay when the node assigned one, otherwise its own `backoffDelay` — and the timer calls `connect()`. `useConnection().reconnectAt` renders the wait; `client.close()` cancels it |
| 5 | **Per-tenant subscription caps** | a registered-query explosion is a load-shedding decision, made with a limit and a typed `X_SUBSCRIPTION_LIMIT`, not by falling over. **Reachable, not yet wired** `As of 2026-08`: the boot passes no caps, and the per-tenant scope needs both `maxPerTenant` and `tenantOf`. The **per-socket** cap applies today at its default of 128 |
| 6 | **Consider wrapping an existing protocol** | if the benchmark says our matcher is the bottleneck, adopting Zero's protocol beats inventing one |

## The forced-restart benchmark

One harness, two runs, two questions. **Reachability**: how long until a killed node's clients are back and receiving. **Delivery**: how many patches were lost getting there. A first-delivery timer answers the first and is blind to the second, which is why there are two.

[`scripts/bench/restart-bench.ts`](https://github.com/developerz-ai/ultimate/blob/main/scripts/bench/restart-bench.ts) produced both, each with its own transcript beside it in [`scripts/bench/results/`](https://github.com/developerz-ai/ultimate/tree/main/scripts/bench/results).

```bash
# reachability, 50,000 clients — 2026-08-11
bun run scripts/bench/restart-bench.ts --clients 50000 \
  --out scripts/bench/results/50k-restart.json

# delivery, 10,000 clients, a probe every 200ms — 2026-08-17
bun run scripts/bench/restart-bench.ts --clients 10000 --probe-interval-ms 200 \
  --out scripts/bench/results/10k-restart-seq.json
```

| Setup | Value |
|---|---|
| Clients | real WebSocket connections, split across client-shard OS processes — 50,000 over 10, 10,000 over 8 |
| Server | **one** `sync` node (the shipped `createSyncNode`) in its own process, over `InProcessTransport` |
| Admission | the shipped `AcceptBudget` at its defaults — 500/s, burst 2000 |
| Kill | `SIGKILL`, no drain, **no `reconnect` frame** — recovery is driven only by each client's own `backoffDelay` |
| Readiness | read from the server's own socket count, never the load generator's self-report |
| Subscription under test | a **channel** topic. Neither run subscribes to a live query, so no cursor, snapshot or gap-repair path is exercised |

### Reachability — 50,000 clients

Per client, the **first channel patch received on the reconnected socket**: reconnect *and* resubscribe *and* one delivery. It is not a consistency metric, and cannot be one — see below.

| Restart-phase result | Value |
|---|---|
| Reconnected | **50,000 / 50,000** |
| Received a channel patch inside the window | **49,981** |
| Time to first patch, p50 | **54.0s** |
| Time to first patch, p90 | **105.5s** |
| Time to first patch, p99 | 127.8s |
| Time to first patch, max | **145.7s** |
| Connect attempts shed before any query path | **156,851** — the DB-load proxy: none of them reached a query or snapshot |
| New server accepting | 2.3s after the kill |

**The timings are unchanged and still stand.** Only the name was wrong: this metric was published as "time-to-consistent" until 2026-08, and it never measured consistency. The harness recorded each client's last-seen sequence number and read it nowhere, so a patch the node dropped was invisible to it by construction. Nothing here is retracted — a number that timed reachability is now called reachability.

### Delivery — 10,000 clients

Every client counts **observed sequence gaps** in the probe stream it received, per connection. An observed gap is a break between two frames one connection actually received — the publisher numbers every probe, so a missing number *between* two arrivals is a frame that was published to a subscriber and never came.

| Restart-phase result | Value |
|---|---|
| Reconnected | **10,000 / 10,000** |
| Patches received | **1,666,882** |
| Observed sequence gaps | **0** — 0 gap events, 0 missing frames, 0 duplicates, 0 publisher rewinds, 0 malformed |
| Clients that observed a gap | **0 / 10,000** |
| Time to first patch, p50 / p90 / max | 10.9s / 22.3s / 43.5s |
| Connect attempts shed before any query path | 33,424 |

**Zero observed gaps is a lower bound on loss, not a proof of zero loss.** The counter can only see a hole with a received frame on each side of it, so three losses are invisible to it by construction:

| Invisible to the counter | Why |
|---|---|
| frames lost before a connection's first arrival | there is no lower anchor to measure the gap from |
| frames lost after a connection's last arrival | there is no upper anchor, and the connection may simply have ended |
| every frame, on a connection that received nothing at all | no anchors, so the connection contributes no sequence to check |

So the honest claim is **"no client observed a lost channel frame"**, not "no channel frame was lost". Every other statement of this result on the wiki is shorthand for this paragraph.

**Not evidence about 50,000.** The 50,000-client run predates the counter and carries no delivery number; `As of 2026-08` the 10,000-client run is the only one with delivery accounting, and it does not extrapolate.

### Why delivery needs its own counter

A **channel** topic is the one subscription with no repair. `SyncSocket.send` drops a frame when the socket's buffer is over budget and returns `false`; there is no cursor behind a topic, no `desynced` mark and no re-snapshot, so that frame is gone. The live-query path repairs the same drop `As of 2026-08` — the subscriber is marked desynced, and the next change re-snapshots it out of the window that lane already holds, one frame and no DB read.

`SocketRegistry.deliver` counts every refusal `As of 2026-08`: the series `channel_frames_dropped_total`, the log line `channel.frames_dropped` at warn carrying `{ topic, dropped, total }`, and `node.sockets.droppedChannelFrames` for a test or a bench that cannot scrape. Visible, and still unrecoverable — repair would need a per-topic sequence in the protocol, because a channel's `lsn` is the publishing hub's own per-node counter and a client cannot tell a gap from a message that came via another node. Treat a channel as at-most-once and put anything that must arrive on a live query.

What it is **not**: a multi-node result — neither run crossed NATS, so this is **per-node recovery**, not fanout. Not a throughput figure either: no requests/sec, no message rate, no sustained-load number. Per-node socket capacity in the tables above this section is still a target derived from Bun's native WebSocket implementation, not a benchmark result. Long-running Bun processes are also less battle-proven than Node's; sustained-socket memory profiling is explicit roadmap work.

## `sync` drain

`sync` holds no durable state, so a restart is only dangerous in aggregate. Closing 50,000 sockets at once means 50,000 simultaneous reconnects, all resubscribing, all asking "what changed since my LSN?" — a self-inflicted DDoS landing during a deploy, when capacity is already reduced. Worse, it is fractal: surviving nodes overload, drop connections, and the herd re-forms.

So the drain is **server-directed**:

```json
{ "type": "reconnect", "afterMs": 1830, "resumeFrom": "0/1A2B3C4", "reason": "drain" }
```

| Property | Effect |
|---|---|
| Per-client `afterMs`, jittered over a window | reconnects arrive spread out, not as a spike |
| Server chooses the window from live connection count | 500 clients drain in a second; 500k spread over minutes |
| `resumeFrom` LSN | reconnect is a delta from the change buffer, not a resubscribe-and-refetch |
| Clients redistribute | the LB places them across remaining nodes; no sticky session to honour |
| Client-side backoff is a floor, not the mechanism | a client that loses the socket without a frame still backs off exponentially with jitter |
| Ordering in the drain sequence | `/readyz` → 503, stop new subscribes, send `reconnect` frames, close cleanly, flush spans, exit 0 |

Full drain sequence per role: [Deployment](Deployment).

## Build skew

A client on build `A` connecting to a `sync` node on build `B` is **accepted**, then sent an `update-available` frame carrying the node's `buildId`; the socket is not killed. Skew is decided **at the upgrade**, from `?build=` against the node's own build id, and it is a property of that socket for its lifetime — a client learns about a deploy on the socket it opens against the new node, never on one it is already holding. Every `hello` on that socket re-reports the same answer, the heartbeat's included. The client's `AppUpdateAvailable` signal flips and the app renders its own update affordance. See [PWA and offline](PWA-And-Offline).

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_TOPIC_FORBIDDEN` | actor may not subscribe to a tier-1 topic | `declare a guard for this topic: hub.guard('<topic>', ({ actor }) => ...)` |
| `X_SUBSCRIPTION_LIMIT` | a socket, tenant or node reached a cap; the error names which scope refused, and which knob | `raise maxPerSocket / maxPerTenant / maxEntries on the LiveQueryRegistry (per socket, default 128), or unsubscribe unused live queries` — a **channel topic** cap answers `maxTopicsPerSocket` (64) / `maxTopicsPerNode` (10,000) on the `ChannelHub`. All constructor options, none an `app.config.ts` field |
| `X_PROTOCOL_VERSION` | client and server disagree on the wire format, or a malformed frame | `x build && redeploy the client; the sync node sends 'update-available' before it drains` |
| `X_LIVE_QUERY_UNKNOWN` | a `subscribe` frame named a live query this node does not have | `x queries list --json` |
| `X_CURSOR_STALE` | resume cursor cannot be honoured and no snapshot path was supplied | `pass 'snapshot' to resumeFrom() so the fallback path can re-snapshot instead of failing` |
| `X_REBASE_CONFLICT` | `custom(merge)` returned nothing, or the base row vanished | `set conflict: 'server-wins' on the mutator, or return a row from custom(merge)` |
| `X_TRANSPORT_UNAVAILABLE` | the fanout bus is down | `x doctor — then check NATS_URL points at a reachable nats-server` |
| `X_TRANSPORT_PROTOCOL` | the bus answers in a protocol this build does not speak | `the bus must be nats-server >= 2.11 with JetStream enabled (nats-server -js)` |
| `X_BUILD_SKEW` | client build's contract is incompatible with the server's | reload the client; see the fix line on the error |
| `X_NOT_IMPLEMENTED` | interface-complete tier-3 infrastructure not wired in this build | the error carries the exact next step |

Verbatim shapes: [`packages/realtime/src/errors.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/realtime/src/errors.ts). Full index: [Error codes](Error-Codes).

## Rules

- Truth is always the server. A client is never the merge authority.
- One authz system — the `query`'s `policy`, re-evaluated per delivered row.
- `sync` is stateless. Any state that must survive a restart lives in Postgres or NATS.
- A live query must be deterministic and bounded (`orderBy` + `limit`), or `x verify` rejects it.
- Presence and typing indicators are tier 1 forever — never model ephemeral state as rows.
- `local` does no I/O, no `Date.now()`, no `Math.random()`. It must be replayable.
- Offline writes go through the tier-3 mutator queue, never Background Sync guesswork.
- Climb the ladder for a property you need, not for a tier you like. Tier 3 costs a durable client store forever.
