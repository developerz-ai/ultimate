---
title: Realtime
menu: true
nav: Realtime
description: Three tiers — channels, live queries, local-first — with one mutator shape at every rung, so climbing is a config change rather than a rewrite.
lede: Channels → live queries → local-first. A ladder, not three products. Same `mutator` at every rung.
updated: 2026-07-26
---

## The ladder

| Tier | Name | You write | Server owns | Client owns | Cost |
|---|---|---|---|---|---|
| 1 | **Channels** | `ctx.channel('org:1').publish(evt)` | truth + fanout | subscription | ~0 — pubsub over WS |
| 2 | **Live queries** | `query({ live: true, sql })` | truth + change detection | a reactive result set | one replication slot + a matcher |
| 3 | **Local-first** | the same `mutator` + `persist: true` on the query | truth + rebase | a durable local store, offline writes | IndexedDB store + rebase log |

Tier 1 for presence, typing indicators, toasts, cursors. Tier 2 for "the list updates when
someone else edits". Tier 3 for offline-capable apps.

## Same mutator at every rung

```ts
// mutator (action + optimistic local twin)
export const toggleLike = mutator({
  local(tx, { postId }) { tx.posts.update(postId, (p) => ({ likes: p.likes + 1 })); },
  async server(ctx, { postId }) { return ctx.posts.like(postId); },
  conflict: 'server-wins', // | 'last-write-wins' | custom(merge)
});
```

| Tier | What `local` does | What `server` does |
|---|---|---|
| 1 | not called | runs, publishes an event |
| 2 | applies to the in-memory live result immediately, reverted on server echo | runs, DB change flows back through the live query |
| 3 | applies to the durable local store, queued while offline | runs on reconnect, result rebases the local log per `conflict` |

`local` is a pure function of `(tx, input)` — hence the rule: no I/O, no `Date.now()`, no
`Math.random()` inside it. Anything unreplayable belongs on the server half.

## Tier 2 → tier 3 is a flag

```ts
// tier 2
export const liveFeed = query({ /* ... */ live: true });

// tier 3 — same query, durable client store + offline writes
export const liveFeed = query({ /* ... */ live: true, persist: true });
```

`persist: true` swaps the client result store from memory to IndexedDB and turns the mutator
queue durable. No new mutators, no new authz, no new server code — teams adopt tier 2 in week
one and can afford tier 3 in year two without a migration project.

## The pipeline

```text
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

Every frame carries an LSN. The client's last-seen LSN is what makes reconnect a delta instead
of a refetch.

## Reconnect is the expensive part

A deploy or a network blip drops N sockets at once; each client then asks "what changed since
LSN X?". If the answer requires replaying arbitrary WAL history or re-running every query, a
rolling restart becomes a self-inflicted thundering herd that outlasts the deploy.

| # | Mitigation | Detail |
|---|---|---|
| 1 | **Prototype before locking topology** | milestone 6 is a reconnect benchmark: 50k sockets, forced `sync` restart, measure time-to-consistent and DB load. Topology is not frozen until that number is known |
| 2 | **Bounded per-query change buffer** | the `replicator` keeps a ring buffer of recent changes per query-hash. Reconnect within the window = delta replay from the buffer, zero DB work |
| 3 | **Snapshot fallback, not WAL replay** | outside the window the client gets a fresh snapshot at a current LSN. Cost is one bounded query, never history traversal |
| 4 | **Jittered reconnect-with-backoff, server-directed** | draining `sync` nodes send a `reconnect` frame with a per-client delay so clients redistribute instead of stampeding |
| 5 | **Per-tenant subscription caps** | a registered-query explosion is a load-shedding decision, made with a limit and a typed `X_LIVE_QUERY_LIMIT` error, not by falling over |
| 6 | **Consider wrapping an existing protocol** | if the benchmark says our matcher is the bottleneck, adopting Zero's protocol beats inventing one |

The drain frame is server-directed, not client-guessed:

```json
{ "type": "reconnect", "afterMs": 1830, "resumeFrom": "0/1A2B3C4", "reason": "drain" }
```

:::warn no numbers yet
The benchmark has not been run. No throughput, latency or socket-count claim appears on this
site until it has. `As of 2026-07` the sync engine is roughly 70% of the remaining effort and
the single largest risk in the project.
:::

## Why tier 2 covers most of "realtime app"

What people mean by "make it realtime" is almost always: the list updates without a refresh,
and my own click feels instant. Tier 2 delivers both — server-authoritative truth, optimistic
local application, automatic reconnect — with no client database, no schema versioning on the
client, no conflict-resolution UX, and no offline-write semantics to design.

Tier 3 buys exactly one additional property: writes that survive being offline. That property
costs a durable local store, a rebase log, client-side migrations and a conflict story per
mutator. Charging every app for it is how "realtime frameworks" become slow frameworks. Tiers
1–2 are v1; tier 3 is v2.

## Rules

- Truth is always the server. A client is never the merge authority.
- One authz system — the `query`'s `policy`, re-evaluated per delivered row.
- `sync` is stateless. Any state that must survive a restart lives in Postgres or NATS.
- A live query must be deterministic and bounded (`orderBy` + `limit`), or `x verify` rejects it.
- Presence and typing indicators are tier 1 forever — never model ephemeral state as rows.
