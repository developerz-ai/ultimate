# @ultimat3/cache 🗂️

Four tiers. **One invalidation graph, not three.**

`bun add @ultimat3/cache` · guide: [Caching And Invalidation](https://github.com/developerz-ai/ultimate/wiki/Caching-And-Invalidation)

```ts
cache: { invalidates: [tag.post, tag.feed] }
```

That declaration on an `action` reaches the request memo, the in-process LRU, Redis, every
ISR route that rendered a post, and the CDN surrogate keys — in one hop, through one
function. Manual cache invalidation is the single worst thing you can ask an agent to do,
so the framework removes the decision: tag your writes, never your reads.

## Why one graph

Every framework that ships "cache tags", "revalidate paths", and "CDN purge" as three
separate mechanisms produces the same bug — two of the three fire, the third serves last
week. `graph.ts` is a module singleton with **no exported constructor**. Cache keys, ISR
routes, CDN paths and live queries all register as `CacheDependent`s against tags in that
one graph, and `invalidateTags()` is the only reader. There is nowhere to put a second one.

## Tiers

Reads walk down until a hit, then populate every tier they walked past. Writes populate all.

| Order | Tier | Backing | Invalidation | Omit when |
|---|---|---|---|---|
| 0 | `request-memo` | ALS context (`WeakMap`) | dies with the request | never |
| 1 | `lru` | in-process, byte-budgeted | tag index | never |
| 2 | `redis` | `redisClient()` (`@ultimat3/core/redis`) | tag→keys sorted sets, paged reads + slot-local `UNLINK`s | single node |
| 3 | `cdn` | headers + purge driver | surrogate keys | no CDN |

A tier is a `CacheTier` (`get`/`set`/`del`/`invalidateTags`, plus an optional `fence` for a tier
other processes also write). Swap or omit any of them
without touching a call site — order comes from `@ultimat3/core`'s `CACHE_TIERS`, not registration order.

```ts
import { cacheStack, lruTier, memoTier, registerTier } from '@ultimat3/cache';

const stack = cacheStack([memoTier(), lruTier({ maxBytes: 64 * 1024 * 1024 })]);
for (const tier of stack.tiers) registerTier(tier);

const feed = await stack.read('feed:org-1', () => db.posts.recent(), {
  ttlMs: 30_000,
  tags: [tag('post')],
});
```

**The request memo is bounded: `MEMO_MAX_BYTES` (8 MiB) per ctx, oldest evicted silently.** A
job's ctx is the whole attempt, so an unbounded memo held every page a backfill read until it
ended — 198 MiB after 2,000 batches of 100 rows through a `cache:` query, measured; 8.4 MiB
bounded. An evicted entry costs one more read, never a wrong one. A held value is charged from a bounded
sample (`approxBytes`, ≈2 µs for a 50- or 500-row page, within 2× of the exact figure), never
serialised: the memo charges every query read. One entry over the bound on its
own is not memoized and evicts nothing.

`@ultimat3/query`'s request memo (`readOnce`) is this store too, through
`memoFlights(ctx, 'query')`: one store, one bound, whichever entry point filled it.

**`memoPerRequest(fn, key)` — the same memo for a plain function.** Once per ctx and key; outside a
ctx it calls straight through. An async `fn` hands every concurrent caller one promise, and a
rejection is dropped so the next call retries. Each wrapper owns its key space, and its entries
count against the same 8 MiB. The value is held by reference (it never leaves the request), not
through the codec below.

```ts
import { memoPerRequest } from '@ultimat3/cache';

interface Org { readonly id: string; readonly name: string }
declare const db: { readonly orgs: { find(id: string): Promise<Org> } };

export const loadOrg = memoPerRequest((id: string) => db.orgs.find(id), (id) => id);
```

**Cached values: JSON + `Date` + `bigint` + `Map` + `Set` — the same shape from every tier.**
Every tier (the memo and the LRU included) stores the value as text through one codec
(`value-codec.ts`) and decodes a fresh copy on each hit, so:

| You write | Every tier answers |
|---|---|
| a `Date`, a `bigint`, a `Map`, a `Set` (at any depth) | the same type back |
| a plain object, array, string, number, boolean, `null` | JSON semantics: `NaN`/`Infinity` → `null`, `undefined` members dropped |
| a class instance | a plain object — its prototype is not stored |
| a cycle, a `toJSON` that throws, nesting past `MAX_CACHE_VALUE_DEPTH` (512), a `bigint` past `MAX_CACHE_BIGINT_DIGITS` (4096 chars) | `X_CACHE_VALUE_UNENCODABLE`, at the write — a value is stored and readable, or refused |

A hit is never the object that was written, nor the one another reader got: mutating it changes
nothing in the cache. An app key spelled `$x` (or `$$x`…) is escaped on the way in. The stored text
is `x1:` + JSON; only marked text is revived, so a Redis entry written as plain JSON before the
codec reads back exactly as stored — never revived, never renamed.

**`ttlMs` is positive and finite, in every tier.** Omit it for the tier's default; anything else
is `X_CACHE_TTL_INVALID`. There is no "never expires" and no "do not cache" — `0` used to mean the
first in the LRU tier and one second in the Redis tier, so a stack holding both answered
differently depending on which one hit, and neither reading was what the caller meant. A value you
do not want held is a value you do not put in the cache.

**Every lease is spread.** A tier shortens each `ttlMs` by a random slice of up to 5%
(`DEFAULT_TTL_JITTER_FRACTION`) before it writes, in `assertTtl` — the one place every tier already
called. 40,000 keys warmed by one rolling restart otherwise share one expiry instant and all miss
inside the same 30-second window. The roll is injected, never `Math.random()` at a call site:

```ts
lruTier({ rng: () => 0 });          // the full lease — what a test asserting an exact expiry wants
redisTier({ jitterFraction: 0 });   // off entirely
redisTier({ jitterFraction: 0.2 }); // a wider spread; outside [0, 1) is X_CACHE_JITTER_INVALID
```

**N concurrent misses are ONE origin load.** `stack.read` shares an in-flight `load()` per key, so
a reader arriving while another's load is running joins it instead of issuing its own — the share
ends as the load settles, rejection included, so one failure is never held as a permanent one. A
feed cached for 60s and read 8,000×/s otherwise sends ~1,600 identical queries to Postgres at every
TTL boundary, because the write only lands after `load()` resolves. The primitive is
`singleFlight()` from `@ultimat3/core` if you need it elsewhere (25.0.0 dropped this
package's re-export); the stack holds one per stack.
A `load()` that never settles does **not** hold its key for ever: past `loadDeadlineMs`
(`DEFAULT_LOAD_DEADLINE_MS`, 30s — the point at which `http.requestTimeoutMs` already abandoned the
request that was waiting for it) the key is freed and the next reader loads for itself. Eviction
frees the key and never the work, so the readers already holding that load still get its answer,
and the cost is one duplicate fill — `cacheStack(tiers, { loadDeadlineMs: 5_000 })` for a
tighter ceiling on a fast origin. A joiner shares the
leader's **write** as well as its load, so it contributes to it: tags union, TTLs take the shortest.
Without that the entry landed carrying only the leader's tags and the joiner's invalidation never
fired.

**A fill obeys an invalidation that raced it.** `load()` answers with rows it read in the past, so a
bust landing in between finds a key that is not there yet — it reports `errors: []` and the fill
republishes the pre-write rows for the full TTL, invisibly. `stack.read` samples a fence before the
load and re-checks it before each tier write; a fill that lost the race is dropped, and anything it
already wrote is taken back. The caller still gets what the origin answered: a fence declines to
publish, it never fails a read. It is exported for any cache doing its own read-through:

```ts
const fence = sampleFence({ key, tags });
const value = await run();
if (fence.isValid()) await tier.set(key, value, { tags });
```

**That fence is this process's; the Redis tier keeps a second one for the fleet.** A bust another
replica ran reaches this process only when the broadcast does, and a lost broadcast means never —
so the fill would publish the pre-write rows into the *shared* tier and every replica would promote
them. `redisTier` implements `CacheTier.fence`: a bust writes a leased generation
(`<ns>:g:{entity}:r:<id>`, `:c`, `:a`) **before** it reads its buckets, `stack.read` samples the
generations its tags watch before `load()`, and re-reads them after the tier's `SET`.

| Verdict | Means | The fill |
|---|---|---|
| `valid` | nothing the tags match moved | stands |
| `busted` | a generation moved — proof the value is stale | withdrawn from every tier written so far |
| `unprovable` | Redis could not be asked, the load outlived the 60s proof window, or a joiner brought a tag nobody sampled | that tier alone is left unwritten; nearer tiers keep the value |

Cost, `As of 2026-10`: one pipelined round trip before each `load()` and one after the `SET` (one
`GET` for a collection tag, two for a row tag), two `SET`s per busted tag. Plain commands, no
script. Tag busts only — `stack.drop(key)` and `stack.write(key)` still fence this process alone.

**A tier that refuses a `set` during a fill has the key deleted in that tier.** The refusal is
absorbed (below), so without the `del` the tier keeps answering with the value the fill was
replacing — an entry that outgrew the LRU's budget served its previous version for a whole lease.

**A `null` can carry its own TTL.** `negativeTtlMs` is used when the loaded value is `null` or
`undefined`, so a lookup for a row that has not replicated yet is not held for the positive lease:

```ts
await stack.read(key, () => db.posts.byId(id), { ttlMs: 300_000, negativeTtlMs: 5_000 });
```

**A promoted hit carries its own remaining life.** When a read hits a far tier and populates the
closer ones, it writes them with `expiresAt - now`, not with the `ttlMs` the caller passed — a
fresh full lease on every read is a hot key that never gets stale enough to be refetched. An entry
already past its expiry is dropped on the way through and the read falls to `load()`. Each tier
supplies that expiry from its own store, so the number is real: the Redis tier reads `PTTL`
alongside the value, in the same pipelined round trip.

Every tier call the stack makes is best-effort: a tier that throws on `get`, `set` or `del` is a
tier that did not answer, so `read`, `write` and `drop` carry on. A feed too big for the LRU
(`X_CACHE_TOO_LARGE`) or a Redis with no socket costs the entry, never the read. The one call left
to throw is `load()` — it *is* the business read, and absorbing it would hand back `undefined` as
though it were the value.

Each refusal is one `cache.tier_failure` event on core's instrumentation bus (`CacheTierFailureEvent`,
`As of 2026-11`, v31), naming the tier, the operation, the key and the `X_*` code, and each one also
logged as `cache.tier.failed` — `subscribe('cache.tier_failure', …)` to keep them. Every rung a read
asks is a `cache.hit` or `cache.miss` event (`{ tier, key }`). Same
bargain as `report.errors` on the invalidation side — degraded is visible, not merely slow.

`bestEffort(label, op, key, run)` is that guard, exported: a cache that is not a rung of this ladder
degrades into the same log rather than into a private `try/catch` nobody can read. The label is
closed (`TierLabel`) so the panel can group by it. `'query-read'` is in that union and emits nothing
— it named `@ultimat3/query`'s own read cache, a store in no registry, and that store is gone: a
`cache:` read fills these tiers, so its refusals carry the refusing tier's own name.

## Tags

```ts
tag.post          // the collection — busts lists
tag('post', id)   // one row — also busts the lists that contained it
```

Wire form is `post` / `post:<id>`, identical in Redis keys, CDN surrogate keys and
`--json` reports — the edge adds one `e:<entity>` index key per entity ([CDN](#cdn)). Invalidation is asymmetric-tolerant on purpose: busting a collection
kills its rows, busting a row kills the collections that held it.

`tag.post` is typed via a registry that `x manifest` generates, so `tag.pots` is a build
error:

```ts
declare module '@ultimat3/cache' {
  interface CacheTagRegistry { post: true; feed: true }
}
```

`declareTags()` takes the manifest's entity names at boot and is **additive and process-wide** —
once anything is declared, an undeclared tag is `X_CACHE_TAG_UNKNOWN`. A test that declares its own
fixture entity therefore turns validation on for every later file in the same `bun test` process.
`isolateDeclaredTags()` is the seam for that — see [Test seams](#test-seams).

## The Redis tier's key layout

| Key | Holds |
|---|---|
| `<prefix>:<buildId>:c:<key>` | the value, `SET … PX` |
| `<prefix>:<buildId>:t2:{<entity>}` | members carrying the **collection tag** — `tag('post')` |
| `<prefix>:<buildId>:t2:{<entity>}:<id>` | members carrying **that row's tag** — `tag('post', '1')` |
| `<prefix>:<buildId>:e2:{<entity>}` | members carrying **any** tag of the entity — the index |

Every bucket is a **sorted set**, scored by when its member may be forgotten: the value's expiry
plus `TAG_GRACE_MS` (60 s), on the writer's clock. Layout and commands: `redis-buckets.ts`.

`t2:` buckets are the tags a caller declared and `e2:` is the entity index. A **collection bust**
reads the index, so it clears the rows too; a **row bust** reads that row's bucket and the
collection tag's, so `post:2` survives a bust of `post:1`. That is `tagMatches` — the predicate the
LRU answers through its two indexes and the request memo through `tagsIntersect`.
`tag-parity.test.ts` and `tier-parity.test.ts` compare the rungs; `redis.live.test.ts` runs the
same busts against a real server. The `2` marks the sorted-set layout: a v30 pod's `t:`/`e:` plain
sets never collide with these on a shared server, and expire on their own lease.

**A bucket holds live keys only.** Every write `ZADD`s its member, `ZREMRANGEBYSCORE`s everything
already past its score, and grows the bucket's lease (`REDIS_TAG_LEASE_SCRIPT`: `EXPIRE … GT`
alone leaves a fresh key immortal) — three single-key commands, one pipelined round trip. Before
this only a bust removed members, so an entity written constantly and never invalidated collected
every key it ever wrote, and its first bust read millions in one reply. The grace is what keeps a
pod whose clock runs ahead from pruning a member whose value key still lives.
`redis-tag-bound.test.ts`.

**A bust is paged and pipelined**, on the post-commit path:

| Step | Commands | Bound |
|---|---|---|
| fence | `SET` per generation key (`redis-fence.ts`) | one round trip |
| read | `ZSCAN … COUNT 1000` (`BUST_PAGE_SIZE`), buckets concurrently | a page per round trip; returns every member present for the whole scan, so a concurrent prune or re-score skips nothing — a score/offset cursor did |
| delete | `UNLINK` per value key, 1,024 per burst | `UNLINK` frees off the server's main thread |
| sweep | `ZREM` of exactly what died, 1,000 members per command, 8 in flight | — |

10k members clear in 25 sequential round trips (≤ 100 is the test). Every command names **one
key**, so a bust is slot-local on Redis Cluster and Dragonfly whatever tags it carries;
`{<entity>}` is still a **Redis Cluster hash tag**, so a row's bucket, its collection's and the
index share a slot. A refused `UNLINK` keeps its membership — the bust `ZREM`s only what it
deleted, including from the index a row bust never *reads* — so the retry the error asks for still
finds it. A `set` mirrors it: buckets are joined **before** the value is written and membership is
re-checked (`ZSCORE`) after, because a bust that landed in between would otherwise leave a row
nothing can reach by tag. A collection bust leaves its members in the ROW buckets it never read;
the prune and the lease bound them, and a later bust's `UNLINK` of a dead key is a no-op.

**A value is capped too**: `redisTier({ maxValueBytes })`, default `DEFAULT_REDIS_MAX_VALUE_BYTES`
(1 MiB) of encoded UTF-8, refused with `X_CACHE_TOO_LARGE` before any bucket is joined — the LRU's
`maxBytes` answer, on the rung every replica shares.

**`buildId` defaults to `appVersion()`** (`APP_VERSION`, else `dev`), so two builds sharing one
Redis cannot read each other's payloads. Rename `PostView.author` to `PostView.authorId` and
deploy: `JSON.parse` does not validate, so the old pod reads the new shape back and hands it to a
renderer expecting the old one — an undefined author on every cached post, on half the fleet, for
the length of the rolling deploy. The cost of the default is a **cold shared tier per deploy**,
which is the cheaper of the two. Opt out with `redisTier({ buildId: null })` if you version
your own payloads.

## Invalidating

```ts
const report = await invalidateTags([tag('post', postId)]);
```

One function. It returns the report below, which is also what the `/_x` cache panel renders — and
what `x cache bust --json` will print once it ships; that command is planned and exits
`X_NOT_IMPLEMENTED` today.

```json
{
  "tags": ["post:1"],
  "tiers": [{ "tier": "lru", "keys": ["feed"] }, { "tier": "redis", "keys": ["feed"] }],
  "isr": ["/blog", "/blog/hello"],
  "cdn": ["/feed.xml"],
  "liveQueries": [],
  "durationMs": 1.4,
  "errors": []
}
```

A dead tier lands in `errors` and never throws — a Redis outage must not fail the write
that triggered the bust. Entries there expire by TTL instead.

### Redis down is a slow miss, not a hang

A refused tier was always a miss; a tier that never ANSWERS was unbounded — measured on Redis 7,
a paused server hung `stack.read` 45 s and a bust 20 s, on an action's commit path. `As of 2026-11`:

| Redis is | A read | A bust |
|---|---|---|
| up | answers, single milliseconds | answers |
| paused (accepts, never answers) | one command misses its `commandTimeoutMs` (default 150 ms) → a miss, the source answers; the value path then **parks** for 5 s and every read there is an immediate miss, nothing sent | its own 1,000 ms deadline, **never parked**: a bust skipped for a stall leaves stale rows until TTL. Past it → `report.errors` |
| stopped | refused at once (no offline queue) → a miss | refused at once → `report.errors`; retry with the same tags |
| back | the client reconnects on its own, every pod, no restart | answers |

A missed deadline or a parked command is a `cache.tier_failure` event with `X_CACHE_DRIVER_UNAVAILABLE`,
the cause naming the deadline or the park left; a stopped server's refusal is recorded with Bun's
own `ERR_REDIS_CONNECTION_CLOSED` message and no `code`. The client is core's `redisClient()` (`@ultimat3/core/redis`,
`REDIS_URL`), never `Bun.redis`: its default offline queue made the first read against a stopped
server wait 31 s, and it stopped reconnecting after that. A `client` handed in keeps its own
reconnect behaviour and still gets the deadline. Raise the budget only when that latency is the
store's normal:

```ts
import { redisTier } from '@ultimat3/cache';

redisTier({ commandTimeoutMs: 400 }); // anything but whole ms above 0 is X_CACHE_LIMIT_INVALID
```

The fan-out walks the ladder **farthest tier first** — Redis before the LRU before the request memo
— and reports in read order. Clearing near-to-far leaves the far tier holding the old value after
the near ones are clear, and a read racing the bust promotes it straight back up into them: every
tier reports cleared and the LRU is stale again before the call returns. `stack.drop(key)` reverses
for the same reason.

`cdn` is what the dependency graph hangs off these tags, not what cleared: the `cdn` tier purges
those paths (as surrogate keys, alongside the tags), so what actually cleared is that tier's row
in `tiers`. With no `cdn` tier registered the list purges nowhere, which is why
the `cache.invalidate` event reports `busted` from `tiers` and never from `cdn` — a partial bust
that reads as a clean one is the failure that event exists to catch.

Every bust is also one `cache.invalidate` event on core's bus (`CacheInvalidateEvent`: `tags`,
`busted`, `errors`, `durationMs`, and `source` — the span that called `invalidateTags`, else
`'invalidateTags'`; `'cache.broadcast'` for a peer's bust; a flush's own source). The `/_x` cache panel subscribes and keeps its own bounded buffer — "did it
actually clear?" is answerable without a log dive because the one fan-out path emits the answer,
not because a second recorder was wired next to it. A flush's `source` also rides on its `cache.flush`
span as `ultimate.cache.flush_source`.

### The order of one bust

Read tiers, farthest first (`redis` → `lru` → `request-memo`) → the ISR revalidators → the
broadcast to peers → the `cdn` tier **last**. The edge holds responses, not values a render reads:
purged before the origin dropped its own page, it was handed that page again by the next request
and kept it for a whole `s-maxage`. `report.tiers` is still the ladder in read order.

### The ISR holder is asked by tag

`registerRevalidator(byPath, byTags?)` takes both halves in one call (`@ultimat3/render`'s
controller is the caller). `byPath` is told each `isr-route` dependent the graph holds; `byTags`
(`TagRevalidator`) is handed the busted tags and answers the paths it revalidated — the pages its
STORE holds under them, which the graph cannot know when two controllers share a store or an entry
outlived the process that rendered it. Both lists are one `report.isr`; a rejection is a
`report.errors` row (`tier: 'isr'`), never a failed bust. Omitting `byTags` clears the previous one.

### Across instances

`invalidateTags` clears the tiers of the process that called it. On a fleet that is one pod: a user
edits their profile on pod 3, their next request lands on pod 7, and pod 7's LRU serves the pre-edit
value for up to `defaultTtlMs`. Cache ships the **seam**, not the transport — it is tier 1 and may
not reach `realtime` or a message bus — and whoever owns the transport (`@ultimat3/cli`) wires it at
boot, exactly as `@ultimat3/render` wires the `Revalidator`:

```ts
registerInvalidationBroadcast(async (wireTags) => bus.publish('cache.invalidate', wireTags));
bus.subscribe('cache.invalidate', (wireTags) => receiveInvalidationBroadcast(wireTags));
```

| Half | Function | Emits? |
|---|---|---|
| outbound | `registerInvalidationBroadcast(fn)` — `fn(wireTags: readonly string[])`, called last, best-effort | — |
| inbound | `receiveInvalidationBroadcast(wireTags)` → `InvalidationReport` | **never** |

The inbound half **cannot** re-emit, and that is structural rather than a flag: `emit` lives on the
private fan-out options and `receiveInvalidationBroadcast` is the only caller that passes `false`.
A receiver that re-broadcast would be a storm bounded by nothing. A failed send lands in
`report.errors` under `tier: "broadcast"` and the write that triggered the bust still succeeds.
What happens to that bust is the sender's (`@ultimat3/cli` keeps the refused tags, bounded, and
publishes them when the bus returns); with no such sender the other pods clear on TTL.

**Which bus carries it — one rule, logged at boot as `cache.broadcast bus=… source=…`**
(`packages/cli/src/runtime-cache-bus.ts`):

| Deployment | Bus |
|---|---|
| `NATS_URL` set, or `runtime.ts` supplies a `transport` | that transport |
| no NATS, `REDIS_URL` (else `VALKEY_URL`) set — rung 1 | Redis pub/sub, `redisPubSubAt(url)` |
| neither | the in-process bus: this replica only |

`redisPubSub({ publisher, subscriber })` is the protocol, over two dedicated connections
(`REDIS_CLIENT_OPTIONS`): a subscribed connection refuses every other command, and the publisher's
`onconnect` is how the hop hears it is back. Bun 1.4.4 reconnects a dropped subscriber but the
server has forgotten the subscription and the client still holds the listener, so each connect
unsubscribes, subscribes afresh — one SUBSCRIBE/UNSUBSCRIBE at a time, or a flapping connection
registers the listener twice — then fires `onReconnect`; the CLI's listener calls
`flushProcessTiers`, because pub/sub keeps nothing for the window it was away, and publishes the
busts it deferred. A publisher connect fires `onReconnect` too: after a Redis restart the
subscriber may be back first, and the deferred busts are refused until the publisher is. A publish
on a disconnected publisher waits up to `PUBLISHER_CONNECT_WAIT_MS` (1 s) once per outage, then
refuses at once and is deferred. Each SUBSCRIBE/UNSUBSCRIBE is bounded
(`PUBSUB_COMMAND_TIMEOUT_MS`, 1 s), and a resubscribe refused while the connection stays up is
retried on a backoff (250 ms doubling to 10 s, full jitter) until it lands — after `CLIENT KILL` no
second `onconnect` comes. `schedule` and `resubscribeRetryMs` are injectable, so a test fires both
by hand. Every connect also sends `CLIENT SETNAME connectionName` before subscribing —
`redisPubSubAt` passes `cacheBusConnectionName()` (`x-cache-bus:<pid>`), so `CLIENT LIST TYPE
pubsub` says which replica a subscription is. The channel is the hop's one subject,
unprefixed: old and new builds of one app must hear each other mid-rollout.

**`flushProcessTiers(source)` is the repair for a process that cannot know what it missed** — its
bus connection was down for a window, or a peer says it had more refused busts than it could keep.
It calls `CacheTier.clear()` on every tier that has one (only a tier whose store is this process's
heap implements it: `lruTier` does, `redisTier` and `cdnTier` do not), marks every ISR page that
depends on a tag stale through the registered revalidator, and fences out every fill in flight
(`markAllInvalidated`). It never re-emits and never throws; its report and its `/_x` event carry
`tags: ['*']` (`FLUSH_ALL_TAG`). An inbound tag this process has not declared is dropped and
reported rather than thrown, because mid-deploy the new pods know an entity the old ones do not and
a throw would kill the subscriber loop that delivered it.

## Test seams

Every registry here is process-global and `bun test` is one process, so a suite undoes its own
registrations with an `isolate*()` — **capture and restore, never a reset**:

```ts
const restoreTags = isolateDeclaredTags();
declareTags(['fixture']);
afterAll(restoreTags);
```

| Helper | Puts back |
|---|---|
| `isolateDeclaredTags()` | the declared-tag set |
| `isolateGraph()` | every tag → dependent edge, across all three indexes |
| `isolateTiers()` | everything `resetTiers()` drops: the tier registry in registration order, the revalidators and the invalidation broadcast |

Each returns the function that puts back **exactly what it found**, so a per-test `resetGraph()` is
still fine — pair it with the module-scope isolate and the process gets its baseline back. A reset
alone is not a substitute: it drops what a neighbouring file registered, and
`@ultimat3/testing`'s leak guard compares its samples for *additions*, so the loss is invisible to
it and surfaces as a failure in an innocent file. That is the one leak no mechanism catches for you.
The last two live in the modules that own the state because a test file cannot reach it: the
revalidator has no reader. The events this package emits hold no state here: a test subscribes and
unsubscribes (core's `resetInstrumentation()` is the backstop).

## CDN

```ts
cacheHeaders({ sMaxAge: 300, staleWhileRevalidate: 86_400, tags: [tag('post', id)] });
// => { 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
//      'Surrogate-Key': 'post:1 e:post', 'Cache-Tag': 'post:1,e:post' }
```

An edge purges by exact key, so `tagMatches` is built from what a response **carries** and what a
bust **purges** — both from `cdn.ts`, so they cannot drift:

| | Row tag `post:1` | Collection tag `post` |
|---|---|---|
| a response carries (`surrogateKeys(tags)`) | `post:1` `e:post` | `post` `e:post` |
| a bust purges | `post:1` `post` | `e:post` `post` |

So a row bust clears that row's pages and the lists keyed `post`, never `post:2`'s; a collection
bust clears everything of the entity. `e:<entity>` is the edge twin of the Redis tier's entity
index. Carrying the wire tags alone left a detail page unreachable by a collection bust, and a
list unreachable by a row bust, with `errors: []`. Header growth, measured: `len(entity) + 3`
bytes per distinct entity in each of the two headers — 7 bytes each for `post`, 14 per response.

`surrogateKeys()` is exported for any emitter that does not go through `cacheHeaders()`. Both
refuse a key carrying whitespace or a comma **at emission** (`X_CACHE_PURGE_FAILED`): the CDN
would split it into keys no purge ever names. A `cdn-path` dependent registered against a tag goes
out in the same purge — as a surrogate key, the one currency `PurgeDriver` has — so a host
registering one must tag that response with its own path. Three `PurgeDriver`s ship:

| Driver | Purge | Purge all | Batch |
|---|---|---|---|
| `noopPurgeDriver()` | echoes the keys back | resolves | — |
| `fastlyPurgeDriver({ apiToken, serviceId })` | `POST /service/<id>/purge` with `surrogate_keys` | `POST /service/<id>/purge_all` | 256 keys |
| `cloudflarePurgeDriver({ apiToken, zoneId })` | `POST /zones/<id>/purge_cache` with `tags` | same call, `purge_everything` | 30 tags |

Which one a process installs comes from the environment, never from `app.config.ts` —
nothing loads that file's contents at runtime:

| Set | Selects |
|---|---|
| `FASTLY_API_TOKEN` + `FASTLY_SERVICE_ID` | Fastly |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID` | Cloudflare |
| neither | nothing is purged, and `x dev` prints `cdn=none` |

A `cdn` tier holding the noop driver answers an invalidation with
`{ tier: 'cdn', keys: [], skipped: 'no purge driver configured' }` — never a list of keys. The noop
echoes what it is handed, so reporting its reply as accepted made every tag read as CLEARED in
`report.tiers` and in the `cache.invalidate` event's `busted`, with `errors: []`, in the default state of a
deployment that has no CDN at all. `isNoopPurgeDriver(driver)` is the same probe, exported.

Both pairs at once is `X_CONFIG_INVALID`: one process purges exactly one edge. Half a pair
is refused the same way — treating it as "no CDN" is how a deployment ships believing it
purges. Either refusal names the keys that are actually set, in `cause` and in
`meta.configured`, so the diagnostic can never point at a variable nobody set. A refused
purge is `X_CACHE_PURGE_FAILED` carrying `meta.retryable`, and it lands in `report.errors`
rather than failing the write that triggered it.

## Semantic cache

For LLM calls, where "list my orders" and "show me my orders" must hit the same entry.
`memorySemanticCache()` does cosine similarity at a 0.92 threshold (tight on
purpose — a false hit answers the wrong question, which is worse than a miss) and is the
only backing this package ships — it is O(n) and in-process. The interface (`SemanticCache`)
is a driver seam for that reason; a Postgres/pgvector-backed implementation does not exist
yet here (`@ultimat3/ai`'s `postgresVectorStore()` is a separate store, for RAG retrieval, not this
cache).

A similarity that is not a number is not a match. A pair with no defined cosine — one side
carrying a `NaN` component, or a dot product and norms that overflow together — makes
`cosineSimilarity` answer `NaN`: honestly, rather than a `0` that would rank a directionless
vector above every opposed one. The lookup SKIPS such a record: it misses, rather than answering
one question with another's entry. Every comparison against `NaN` is false, so a record that
reached the floor unchecked would have passed it, at any floor — `0` included.

## Errors

| Code | Cause |
|---|---|
| `X_CACHE_DRIVER_UNAVAILABLE` | a Redis command missed its deadline, or the tier is parked after one; a purge driver built without its token; or a batch size that is not a positive integer |
| `X_CACHE_JITTER_INVALID` | a tier's `jitterFraction` outside `[0, 1)` |
| `X_CACHE_PURGE_FAILED` | the CDN refused a purge, or a key it would split on whitespace |
| `X_CACHE_TAG_UNKNOWN` | a tag no entity declared — usually a typo |
| `X_CACHE_TOO_LARGE` | one entry exceeds a tier's whole byte budget |
| `X_CACHE_TTL_INVALID` | a `ttlMs` that is not a positive, finite number of milliseconds |
| `X_CACHE_VALUE_UNENCODABLE` | a value with a cycle, a throwing `toJSON`, nesting past 512 levels or a `bigint` past 4096 digits, written to any tier |

### Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `CacheDriverUnavailableError` | `X_CACHE_DRIVER_UNAVAILABLE` | `src/errors.ts` |
| `CachePurgeFailedError` | `X_CACHE_PURGE_FAILED` | `src/errors.ts` |
| `CacheTooLargeError` | `X_CACHE_TOO_LARGE` | `src/errors.ts` |
| `CacheValueUnencodableError` | `X_CACHE_VALUE_UNENCODABLE` | `src/errors.ts` |

## Writing a tier or a purge driver: `@ultimat3/cache/adapter`

`CacheTier`, `PurgeDriver`, the shapes they read and answer (`CacheEntry`, `CacheSetOptions`,
`TierInvalidation`, `TierFence`, `FenceScope`, `CacheTag`) and the errors they raise
(`CacheDriverUnavailableError`, `CachePurgeFailedError`). An app hands its own to the boot in
`apps/web/runtime.ts` — `cacheTiers: [myRedisTier]` replaces the rung of that name (`cache.tiers`
still decides which rungs exist; a supplied rung it does not name is logged `cache.tier.unnamed`
and unused), `purge: myPurgeDriver` replaces the `CLOUDFLARE_*`/`FASTLY_*` selection. The
conformance suites are `@ultimat3/testing/conformance`'s `cacheTierConformance` and
`purgeDriverConformance`.

## Boundary

Tier 1. Imports `@ultimat3/core` and `@ultimat3/schema` only. Knows nothing about
entities, HTTP or jobs, so `@ultimat3/entity` can depend on cache and never the reverse.
