# Realtime

Three tiers, one ladder. Same mutator shape at every rung — climbing is a config change, never a rewrite.

v1.1.0 `As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)). Tiers 1–2 ship in v1. Tier 3 (local-first) ships in v2.

## The ladder

| Tier | Name | You write | Server owns | Client owns | Cost |
|---|---|---|---|---|---|
| 1 | **Channels** | `ctx.channel('org:1').publish(evt)` | truth + fanout | subscription | ~0 — pubsub over WS |
| 2 | **Live queries** | `query({ live: true, sql })` | truth + change detection | a reactive result set | one replication slot + a matcher |
| 3 | **Local-first** | the same `mutator` + `persist: true` on the query | truth + rebase | a durable local store, offline writes | IndexedDB store + rebase log |

Tier 1 for presence, typing indicators, toasts, cursors. Tier 2 for "the list updates when someone else edits". Tier 3 for offline-capable apps.

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
| Cursor | the highest LSN the client has applied, per subscription |
| Reconnect inside the change buffer window | delta replay from the `replicator`'s ring buffer — zero DB work |
| Reconnect outside the window | one bounded snapshot query at a current LSN. Never WAL history traversal |
| Cursor unusable and no snapshot path supplied | `X_CURSOR_STALE` |
| Ordering | LSN is monotonic per DB, so a client can never apply an older change over a newer one |

## The reconnect risk

**Reconnect is the expensive part of any sync engine, and it is where naive designs fall over.** A deploy or a network blip drops N sockets at once; each client then asks "what changed since LSN X?" If the answer requires replaying arbitrary WAL history or re-running every query, a rolling restart becomes a self-inflicted thundering herd that outlasts the deploy.

| # | Mitigation | Detail |
|---|---|---|
| 1 | **Prototype before locking topology** | the reconnect benchmark: 50k sockets, forced `sync` restart, time-to-consistent and DB load. **Measured `As of 2026-08`** — the numbers are below, and the result is committed |
| 2 | **Bounded per-query change buffer** | the `replicator` keeps a ring buffer of recent changes per query-hash. Reconnect within the window = delta replay from the buffer, zero DB work |
| 3 | **Snapshot fallback, not WAL replay** | outside the window the client gets a fresh snapshot at a current LSN. Cost is one bounded query, never history traversal |
| 4 | **Jittered reconnect-with-backoff, server-directed** | draining `sync` nodes send a `reconnect` frame with a per-client delay so clients redistribute instead of stampeding. `LiveClient` arms **one** timer per closed socket — that delay when the node assigned one, otherwise its own `backoffDelay` — and the timer calls `connect()`. `useConnection().reconnectAt` renders the wait; `client.close()` cancels it |
| 5 | **Per-tenant subscription caps** | a registered-query explosion is a load-shedding decision, made with a limit and a typed `X_SUBSCRIPTION_LIMIT`, not by falling over. **Reachable, not yet wired** `As of 2026-08`: the boot passes no caps, and the per-tenant scope needs both `maxPerTenant` and `tenantOf`. The **per-socket** cap applies today at its default of 128 |
| 6 | **Consider wrapping an existing protocol** | if the benchmark says our matcher is the bottleneck, adopting Zero's protocol beats inventing one |

## The 50k forced-restart benchmark

Measured, committed, and reproducible: [`scripts/bench/restart-bench.ts`](https://github.com/developerz-ai/ultimate/blob/main/scripts/bench/restart-bench.ts) wrote [`scripts/bench/results/50k-restart.json`](https://github.com/developerz-ai/ultimate/blob/main/scripts/bench/results/50k-restart.json) and its own transcript beside it.

```bash
bun run scripts/bench/restart-bench.ts --clients 50000 \
  --out scripts/bench/results/50k-restart.json
```

| Setup | Value |
|---|---|
| Clients | 50,000 real WebSocket connections, split across 10 client-shard OS processes |
| Server | **one** `sync` node (the shipped `createSyncNode`) in its own process, over `InProcessTransport` |
| Admission | the shipped `AcceptBudget` at its defaults — 500/s, burst 2000 |
| Kill | `SIGKILL`, no drain, **no `reconnect` frame** — recovery is driven only by each client's own `backoffDelay` |
| Readiness | read from the server's own socket count, never the load generator's self-report |
| Time-to-consistent | per client, first receipt of a channel patch after the kill — reconnect **and** resubscribe **and** delivery |

| Restart-phase result | Value |
|---|---|
| Reconnected | **50,000 / 50,000** |
| Received a channel patch inside the window | **49,981** |
| Time-to-consistent p50 | **54.0s** |
| Time-to-consistent p90 | **105.5s** |
| Time-to-consistent p99 | 127.8s |
| Time-to-consistent max | **145.7s** |
| Connect attempts shed before any query path | **156,851** — the DB-load proxy: none of them reached a query or snapshot |
| New server accepting | 2.3s after the kill |

What it is **not**: a multi-node result — the run never crossed NATS, so this is **per-node recovery**, not fanout. Not a throughput figure either: no requests/sec, no message rate, no sustained-load number. Per-node socket capacity in the tables above this section is still a target derived from Bun's native WebSocket implementation, not a benchmark result. Long-running Bun processes are also less battle-proven than Node's; sustained-socket memory profiling is explicit roadmap work.

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

A client on build `A` connecting to a `sync` node on build `B` is **accepted**, then sent a `build-stale` frame; the socket is not killed. The client's `AppUpdateAvailable` signal flips and the app renders its own update affordance. See [PWA and offline](PWA-And-Offline).

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_TOPIC_FORBIDDEN` | actor may not subscribe to a tier-1 topic | `declare a guard for this topic: hub.guard('<topic>', ({ actor }) => ...)` |
| `X_SUBSCRIPTION_LIMIT` | a socket or tenant reached the subscription cap; the error names which scope refused | `raise maxPerSocket on the LiveQueryRegistry (default 128), or unsubscribe unused live queries` — it is a constructor option, not an `app.config.ts` field |
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
