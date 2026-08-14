# Realtime internals

Five stages, four processes, one protocol. Ladder rationale and tier choice: [`../idea/03-realtime.md`](../idea/03-realtime.md). Honest sizing of the effort: [`../idea/15-risks.md`](../idea/15-risks.md).

## Pipeline

```mermaid
graph TD
  PG[("Postgres<br/>logical replication slot")]
  R["replicator role<br/>1 per database"]
  F["change feed<br/>ordered by LSN, per table"]
  M["incremental matcher<br/>registered queries"]
  N(["NATS subject<br/>hash(query,params,tenant)"])
  S["sync role<br/>stateless, N replicas"]
  P["policy.evaluate<br/>per subscriber, per row"]
  C["client store<br/>Solid signals"]

  PG -->|"WAL decode (pgoutput)"| R
  R --> F
  F --> M
  M -->|"enter / leave / update / boundary-evict"| N
  N --> S
  S --> P
  P -->|allow| C
  P -->|deny| X["dropped, counted, never sent"]
  C -->|"mutator local()"| C
  C -->|"mutator server()"| PG
```

| Stage | Owner | Guarantee | Cost |
|---|---|---|---|
| WAL decode | `replicator` (1/DB, advisory lock) | ordered by LSN, at-least-once | one replication slot |
| change feed | `replicator` | per-table, monotonic LSN, bounded ring buffer | memory ∝ buffer window |
| matcher | `replicator` | a change touching no registered query costs one hash lookup | CPU ∝ registered query *shapes*, not subscribers |
| fanout | NATS | subject carries no per-socket state | network ∝ subscriber groups |
| socket + policy | `sync` (stateless) | a row failing policy is never written to the wire | CPU ∝ delivered rows × subscribers |
| patch | client | fine-grained signal update, no list re-render | DOM ∝ changed cells |

## Change feed record

```ts
// packages/realtime/src/changefeed.ts
export interface ChangeEvent<R extends Row = Row> {
  readonly entity: string;         // entity name; the matcher's dependency sets are in entity terms
  readonly op: 'insert' | 'update' | 'delete';
  readonly before: R | null;       // requires REPLICA IDENTITY FULL, see below
  readonly after: R | null;
  readonly lsn: string;            // the only ordering authority — see below
  readonly txid: string;
  readonly orgId: string | null;   // hoisted out of the row so fanout filters without parsing it
  readonly at: number;             // commit time, epoch ms
}
```

`before` is mandatory for correct matching: deciding whether a row **left** a result set requires the old values. Any table with a registered live query is set to `REPLICA IDENTITY FULL` by the generated migration; `x verify` fails a `live: true` query over a table without it (`X_LIVE_REPLICA_IDENTITY`).

### The lsn is a pair, not a WAL position

`lsn` is `<16 hex commit position><8 hex row position inside that transaction>` — 24 characters, zero-padded so string order *is* stream order. Neither half is usable alone:

| Candidate | Why it fails |
|---|---|
| commit lsn | every row of one transaction shares it, and the replicator drops anything that does not strictly increase — a five-row insert would deliver one row |
| per-record WAL position | logical decoding emits **transactions** in commit order, so a later-committing transaction can carry lower record positions than an earlier one |
| a counter, or the clock | not reproducible; a replay would produce new lsns and at-least-once delivery would duplicate instead of dedupe |

The pair is monotonic in delivery order *and* byte-identical on replay. The row position counts every replicated row, selected or not, so narrowing the entity list cannot renumber a stream a resume cursor already points into.

`PgLogicalReplicationFeed` speaks the Postgres v3 protocol directly (`pg-wire.ts`, `pg-auth.ts`, `pg-connection.ts`, `pg-socket.ts`) and decodes `pgoutput` (`pgoutput.ts`) — no driver dependency, because a replication connection is CopyBoth and no pooled client will hand one over. It preflights `wal_level`, the publication and the slot, so the three misconfigurations that produce an unreadable server message each get their own `fix:` line instead.

## Incremental matcher

Registered queries are stored by shape, not by subscriber:

```
registry: Map<tableName, QueryShape[]>
QueryShape = { queryId, predicate(row, params), orderBy, limit, tables, paramsHash }
```

For each `ChangeEvent`:

| # | Step | Result |
|---|---|---|
| 1 | look up shapes registered on `table` | miss → one hash lookup, done |
| 2 | evaluate `predicate(before)` and `predicate(after)` | `false→true` = enter, `true→false` = leave, `true→true` = update, `false→false` = ignore |
| 3 | for a windowed query (`orderBy` + `limit`), compare the row's sort key to the cached **boundary key** | an enter inside the window emits `insert` **plus** a `boundary-evict` for the row falling off the end |
| 4 | emit one patch op per affected `(queryId, paramsHash, tenant)` group | published to that group's NATS subject |

Constraints that make step 2 cheap enough to be honest about:

- `live: true` requires a **deterministic, bounded** `sql`: total `orderBy` + `limit`, no non-deterministic functions. Otherwise `x verify` rejects it (`X_QUERY_UNBOUNDED`).
- Predicates must be evaluable against a single row. A live query joining more than the configured table count falls back to **re-execution on change** — correct, more expensive, and reported by `x live explain <query>` so the cost is never a surprise.
- Aggregates (`count`, `sum`) are supported as incremental deltas only for `+1/-1` shapes; anything else re-executes.

## Policy is per subscriber, never per query

Two clients can subscribe with **identical** `queryId` and params and still be entitled to different rows: row-level policy reads actor attributes (role, team, ownership, org membership), not just the query parameters.

| Collapse policy to the query | Consequence |
|---|---|
| evaluate once per `(queryId, params, tenant)` and fan out the same rows | the first subscriber's entitlements become everyone's. A member sees an admin-only row because an admin subscribed first |
| cache the allow decision by query hash | privilege escalation with a cache hit rate |

So: fanout is grouped by query shape (that is what makes it scale), and **`policy.evaluate` runs on the `sync` node for every subscriber × every candidate row before the frame is written**. Same `evaluate`, same actor resolution, same denial reason as HTTP and MCP — one authz system ([`../idea/02-primitives.md`](../idea/02-primitives.md)).

`liveQueryDefinition(query, { ctx })` is what makes that reachable from a declared `query({ live: true })`, and the split is in the file: what it caches per query id is the compiled source, the shape and the matcher, and what it never caches is a decision.

| Keyed by | Built | Holds |
|---|---|---|
| query id | once, with `enforce: false` — **no subject at all** | source, shape, matcher, the shared pre-policy row window |
| subscriber | `authorize` at every subscribe, `visible` at every row of every delivery | the decision, and nothing else |

The `enforce: false` is the point rather than a shortcut: building the shared half under the *first* subscriber's authority and then caching it by query id is precisely how that subscriber's entitlements become everyone's. It removes no check — `authorize` is still the subscribe-time decision, and it still runs once per subscriber.

Making that affordable:

| Technique | Detail |
|---|---|
| Subscribe-time snapshot check | the window is read once per subscribe through the query's own source, then filtered per subscriber by `visible` |
| Per-delivery re-check | the incremental path re-checks each row; a denial drops the row and increments a counter |
| Pure predicates | policies must not do I/O; a policy needing a lookup declares the repo, and that lookup is memoized per request/subscription |
| No decision memo | **nothing caches an allow.** A bounded LRU keyed `(actorId, policyId, rowTenant, rowOwnerId)` is the only shape that could ever be safe here, and it is not shipped: without an actor-scoped invalidation to clear it, a TTL of seconds is a revoked grant that keeps delivering rows for seconds. `@ultimat3/query`'s `policy-gate.ts` says the same thing in one line — *its result is never cached* |

A dropped row is a metric (`live.rows_denied`), never a client-visible error — telling a client "there is a row you may not see" is itself a leak. `LiveQueryRegistry` counts every drop (`rowsDenied`) and reports each one through `onRowDenied`, carrying the query id, the subscription, the actor and the row id — never the row.

That is a **denial**. A gate that never reached a decision — a rule whose lookup timed out, a predicate with a typo in it — is a different fact and gets a different number: `live.gate_failed` (`gateFailures`, reported through `onGateFailed` with the stage, the row id and the error). Reading one as the other publishes an outage as a permission change, which is silent by construction: the rows leave the screen and the drop counter explains why.

| Stage | Denial | Failure |
|---|---|---|
| `subscribe` snapshot | row dropped | raises out of `subscribe` — a snapshot missing the undecidable rows is a short result set the client renders as the whole one |
| `deliver` patch | dropped, or a `delete` when the subscriber holds the row | that one subscriber is desynced and re-snapshotted next flush; the fanout to the rest completes |

A patch whose row the shared window does not hold is a third answer and neither of these: an update patch carries the changed columns only, so there is no whole row to decide about. It is withheld — dropped, or the one `delete` that tells a subscriber holding it so — and counted as neither, because nothing decided anything. The window *is* the result set.
| `reauthorize` | unsubscribed, sid returned in `dropped` | the subscription survives, desynced — the row gate still decides every row under the new actor, from the same policy `authorize` consults |

### One lane per query id

The shared window is a read-modify-write across awaits — match, apply the patches, append to the retained buffer, then one policy pass per subscriber — and nothing upstream orders the callers. The `sync` node fires `void registry.deliver(change)` off its bus subscription, because the handler has to return before the next change arrives. Two changes back to back therefore both start, and an interleaved fanout hands one subscriber lsn 2 and then asks it to fold lsn 1 on top: the row settles at the older value, and the cursor is rewound to 1, so the next reconnect replays it again.

`WindowLock` gives every entry a FIFO lane and `deliver` enters every lane before it awaits any of them. Across query ids nothing is ordered and nothing needs to be — a qid pins the query *and* its input, so two entries share no state. Three properties make the lanes safe to hold at once:

| Property | Why |
|---|---|
| No fanout ever takes a second lane | holding all of them at once cannot be a cycle, and entering them all up front is what queues two deliveries onto each query id in call order |
| Each task chains on a settled shadow, never on its own promise | one fanout that threw rejects its own caller; the changes queued behind it still run |
| A lane that fails desyncs its own subscribers, and `allSettled` lets the rest finish | the window advanced under a fanout that did not, so those subscribers hold a cursor below the change; awaiting one entry before entering the next let a throw skip every entry behind it with nobody desynced |

The definition's read shares the same lane and the same rule. It happens **once per entry**: a cold subscriber arriving while another's read is in flight joins it rather than issuing a second one, then runs its own policy pass over the result — the read is shared, the authz is not. It is a share and not a cache; the in-flight promise is cleared as it settles, so a subscriber arriving later reads current rows. And the window it produces is assigned in the lane and only ever forwards: a snapshot that resolved after a newer change had already been fanned out is discarded, because writing it back would hand that subscriber rows the fanout has moved past, at a cursor behind the change that would have corrected them.

The one gate pass outside the lane is a resume, and it reads the live window deliberately: the window can only have moved forwards, and a row whose grant was revoked in the meantime is one the pass must refuse rather than replay from the state it had at the cursor's lsn. An entry nothing has read yet has no live window at all, so a resume onto a cold one fills it first — conditional on purpose, because re-reading per resuming subscriber is the cost a delta resume exists to skip in a restart storm.

## Cursor and reconnect

Every frame carries an LSN. The client's last-seen LSN is what makes reconnect a delta instead of a refetch.

```
{ qid: 'q_7f3a', op: 'insert', row: {...}, lsn: '0/1A2B3C4', trace: '4bf9…' }
```

Reconnect handshake:

```
client → { type: 'resume', subs: [{ qid, paramsHash, sinceLsn }], buildId }
server:
  1. is sinceLsn within the ring buffer window for this query group?
       yes → replay buffered ops after sinceLsn                    (zero DB work)
       no  → fresh snapshot at current LSN + { type: 'reset', qid } (one bounded query)
  2. re-evaluate policy for every replayed/snapshotted row
  3. resume live delivery
```

### Cost model

| Scenario | Path | DB cost | Notes |
|---|---|---|---|
| Reconnect inside the buffer window | buffer replay | **0** | the common case: a blip, a laptop lid, a rolling deploy |
| Reconnect outside the window | snapshot | 1 bounded query per subscription | bounded by `limit`, index-backed |
| Cold subscribe | snapshot | 1 bounded query | same as any page load |
| Steady state | matcher + fanout | 0 | changes only |
| Buffer sizing | `buffer.window` per query group; default 30s of ops, capped by bytes | memory | tuned by `x live explain` |
| Never | replaying arbitrary WAL history per client | — | rejected design: it makes reconnect O(history) |

**Snapshot fallback, never WAL replay.** Outside the window the client gets a fresh snapshot at a current LSN. Cost is one bounded query, never history traversal.

### Thundering herd

Dropping N sockets at once means N simultaneous resubscribes during a deploy, when capacity is already reduced — and it is fractal: surviving nodes overload, drop connections, and the herd re-forms.

Mitigations, all mandatory:

| # | Mechanism | Effect |
|---|---|---|
| 1 | Server-directed reconnect frame on drain: `{ type: 'reconnect', afterMs: 1830, resumeFrom: '0/1A2B3C4', reason: 'drain' }` | reconnects arrive spread over a window, not as a spike |
| 2 | Window computed from live connection count | 500 clients drain in a second; 500k spread over minutes |
| 3 | `resumeFrom` LSN | reconnect is a buffer delta, not a resubscribe-and-refetch |
| 4 | Stateless `sync`, no sticky sessions | the LB redistributes clients across remaining nodes |
| 5 | Client backoff is a floor, not the mechanism | a socket lost without a frame still backs off exponentially with jitter. `LiveClient` arms **one** timer per closed socket — the node's `afterMs` when a frame assigned one, otherwise `backoffDelay()` — and the timer calls `connect()`; `close()` cancels it |
| 6 | Per-tenant subscription caps | a registered-query explosion is a load-shedding decision with `X_LIVE_QUERY_LIMIT`, not a fall-over |
| 7 | Snapshot admission control | snapshot regeneration is queued with a concurrency cap; excess clients get a jittered retry frame |

Drain sequencing across roles: [`13-topology-runtime.md`](./13-topology-runtime.md).

## What tier 3 adds

`persist: true` on the query. No new mutators, no new authz, no new server code — the client half changes.

| Added | Detail |
|---|---|
| Durable local store | IndexedDB-backed, same row shapes, same signal API |
| Offline mutation queue | `mutator.local()` applies immediately and the intent is persisted, ordered, with its input |
| Rebase log | on reconnect, queued mutations replay against the server-authoritative state per `conflict: 'server-wins' \| 'last-write-wins' \| custom(merge)` |
| Client schema version | the local store is versioned; a mismatch after a deploy discards and re-snapshots rather than reading old shapes |

State that **must** be persisted client-side:

| Key | Why | On mismatch |
|---|---|---|
| store schema version | shapes change with deploys | drop store, re-snapshot |
| last-seen LSN per subscription | delta resume | fall back to snapshot |
| pending mutation queue (input + local patch + idempotency key) | offline writes | replay in order |
| rebase checkpoint | which mutations the server has acknowledged | re-send unacknowledged |
| build ID that wrote the store | detects skew ([`../idea/08-pwa-offline.md`](../idea/08-pwa-offline.md)) | discard on incompatible contract |

Requirements this places on `mutator.local`: pure function of `(tx, input)` — no I/O, no `Date.now()`, no `Math.random()`. It is replayed, possibly many times, possibly on a later build.

## Limits — stated plainly

`As of 2026-07`, tiers 1–2 are the v1 target; tier 3 is v2. The sync engine is roughly 70% of the framework's total effort ([`../idea/15-risks.md`](../idea/15-risks.md)).

| Limit | Reality |
|---|---|
| Matcher generality | single-row predicates are fast; multi-table joins and non-trivial aggregates re-execute. `x live explain` tells you which class your query is in |
| Matcher throughput | CPU on one `replicator` per database. A high-write table with many distinct query shapes is the bottleneck, not socket count |
| Memory per subscriber | grows with subscribed-result size. 100k sockets holding 50-row results is fine; 100k holding 5k-row results is not |
| Ordering | per table, by LSN. There is no cross-table transactional snapshot on the wire; a UI that requires one must read via a query, not a subscription |
| Delivery | at-least-once. Patches are idempotent by `(qid, lsn, rowKey)`; clients must tolerate a repeat |
| Bun process maturity | long-running socket processes are less battle-proven than Node's; sustained-load memory profiling is explicit roadmap work |
| Escape valve | if the reconnect benchmark says our matcher is the bottleneck, adopting an existing protocol (Zero-shaped) beats defending ours |

## Codes

| Code | Meaning | Fix |
|---|---|---|
| `X_LIVE_QUERY_LIMIT` | per-tenant registered-subscription cap reached | raise `realtime.maxSubsPerTenant` or reduce subscriptions |
| `X_LIVE_REPLICA_IDENTITY` | `live: true` on a table without `REPLICA IDENTITY FULL` | `x db gen "replica identity for <table>"` |
| `X_QUERY_UNBOUNDED` | live query missing total order + `limit` | add `orderBy` tiebreak and `limit` |
| `X_REPLICATOR_SLOT_HELD` | a second replicator found the advisory lock held | scale `replicator` to 1 per database |
| `X_SYNC_RESUME_STALE` | `sinceLsn` older than the buffer and snapshot admission is full | client retries after the jittered delay |
| `X_MUTATOR_IMPURE` | `local()` used I/O, `Date.now()`, or randomness | move the value into `input` |
