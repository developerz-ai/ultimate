# @ultimat3/cache 🗂️

Four tiers. **One invalidation graph, not three.**

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
| 2 | `redis` | `Bun.redis` | tag→keys set, one `EVAL` **per tag** + slot-local `DEL`s | single node |
| 3 | `cdn` | headers + purge driver | surrogate keys | no CDN |

A tier is a `CacheTier` (`get`/`set`/`del`/`invalidateTags`). Swap or omit any of them
without touching a call site — order comes from `TIER_ORDER`, not registration order.

```ts
import { createCacheStack, createLruTier, createMemoTier, registerTier } from '@ultimat3/cache';

const stack = createCacheStack([createMemoTier(), createLruTier({ maxBytes: 64 * 1024 * 1024 })]);
for (const tier of stack.tiers) registerTier(tier);

const feed = await stack.read('feed:org-1', () => db.posts.recent(), {
  ttlMs: 30_000,
  tags: [tag('post')],
});
```

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
createLruTier({ rng: () => 0 });          // the full lease — what a test asserting an exact expiry wants
createRedisTier({ jitterFraction: 0 });   // off entirely
createRedisTier({ jitterFraction: 0.2 }); // a wider spread; outside [0, 1) is X_CACHE_JITTER_INVALID
```

**N concurrent misses are ONE origin load.** `stack.read` shares an in-flight `load()` per key, so
a reader arriving while another's load is running joins it instead of issuing its own — the share
ends as the load settles, rejection included, so one failure is never held as a permanent one. A
feed cached for 60s and read 8,000×/s otherwise sends ~1,600 identical queries to Postgres at every
TTL boundary, because the write only lands after `load()` resolves. The primitive is
`createSingleFlight()` if you need it elsewhere — `@ultimat3/core`'s, re-exported here unchanged;
the stack holds one per stack.
A `load()` that never settles does **not** hold its key for ever: past `loadDeadlineMs`
(`DEFAULT_LOAD_DEADLINE_MS`, 30s — the point at which `http.requestTimeoutMs` already abandoned the
request that was waiting for it) the key is freed and the next reader loads for itself. Eviction
frees the key and never the work, so the readers already holding that load still get its answer,
and the cost is one duplicate fill — `createCacheStack(tiers, { loadDeadlineMs: 5_000 })` for a
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

`recentTierFailures()` is where those refusals go: last 100, newest first, each naming the tier, the
operation, the key and the `X_*` code, and each one also logged as `cache.tier.failed`. Same
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
tagsFor(Post, row) // both, for a repo write
```

Wire form is `post` / `post:<id>`, identical in Redis keys, CDN surrogate keys and
`--json` reports. Invalidation is asymmetric-tolerant on purpose: busting a collection
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
| `<prefix>:<buildId>:t:{<entity>}` | members carrying the **collection tag** — `tag('post')` |
| `<prefix>:<buildId>:t:{<entity>}:<id>` | members carrying **that row's tag** — `tag('post', '1')` |
| `<prefix>:<buildId>:e:{<entity>}` | members carrying **any** tag of the entity — the index |

Four keys, three jobs, and the fourth is why: `t:` buckets are the tags a caller declared and `e:`
is the entity index. A **collection bust** reads the index, so it clears the rows too; a **row
bust** reads that row's bucket and the collection tag's, so `post:2` survives a bust of `post:1`.
That is `tagMatches` — the same predicate the LRU answers through its two indexes and the request
memo answers through `tagsIntersect` — and the shared tier is the rung that did not, because `t:`
served as the index as well: `invalidateTags([tag('post', '1')])` came back with every post-tagged
key in the store and deleted them, so one row write emptied the shared tier for that entity while
the in-process tier one rung closer kept exactly the row that had changed.
`tier-parity.test.ts` compares all three rungs and `redis.live.test.ts` runs the same two busts
against a real server.

`{<entity>}` is a **Redis Cluster hash tag**, not decoration: it is what makes a row's bucket, its
collection's bucket and the index hash to one slot, so a script may take them in one `KEYS`.
Invalidation issues
**one script call per tag** for that reason — the batched form carried every tag's buckets in one
`EVAL` and was rejected with `CROSSSLOT` before the script ran, landing in `report.errors` as a
partial bust while stale rows served until TTL. Value keys are still deleted client-side, one `DEL`
each, which is slot-local under every topology.

The script **deletes nothing at all** — not the value keys, and not the buckets either. The tier
`SREM`s exactly the members whose `DEL` succeeded, from every bucket that member joined —
including, for a row bust, the entity index it deliberately never *reads*. Reading `e:{entity}` for
a row bust would return every key of the entity; removing from it cannot over-reach, and a member
left there is a corpse in a set every later write renews the lease on. A refused delete keeps its
membership and the retry the error asks for still finds it; dropping the bucket inside the script
made that failure permanent. A `set` mirrors it: buckets are joined **before** the value is written and membership is
re-checked after, because a bust that landed in between would otherwise leave a row nothing can
reach by tag, serving until its own lease ran out.

**Every tag set carries a lease**, renewed on each write to the member's own TTL plus 60s, raised
only when the new lease is longer — a 60s member must not shorten a bucket a 1h member is in.
Without it a tag set grew forever: value keys died after five minutes, their membership never did,
and after a month `SMEMBERS` on a multi-million-member set blocked the server for hundreds of
milliseconds and answered with a list the client then `DEL`'d in batches. One publish became a
Redis outage. The renewal is a script (`REDIS_TAG_MEMBER_SCRIPT`, one key in `KEYS`) rather than
`EXPIRE … GT`, because `GT` treats a key with no TTL as infinite and would leave a **fresh** bucket
immortal — which is the bug being fixed.

**`buildId` defaults to `appVersion()`** (`APP_VERSION`, else `dev`), so two builds sharing one
Redis cannot read each other's payloads. Rename `PostView.author` to `PostView.authorId` and
deploy: `JSON.parse` does not validate, so the old pod reads the new shape back and hands it to a
renderer expecting the old one — an undefined author on every cached post, on half the fleet, for
the length of the rolling deploy. The cost of the default is a **cold shared tier per deploy**,
which is the cheaper of the two. Opt out with `createRedisTier({ buildId: null })` if you version
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

The fan-out walks the ladder **farthest tier first** — Redis before the LRU before the request memo
— and reports in read order. Clearing near-to-far leaves the far tier holding the old value after
the near ones are clear, and a read racing the bust promotes it straight back up into them: every
tier reports cleared and the LRU is stale again before the call returns. `stack.drop(key)` reverses
for the same reason.

`cdn` is what the dependency graph hangs off these tags, not what cleared: the `cdn` tier purges
those paths (as surrogate keys, alongside the tags), so what actually cleared is that tier's row
in `tiers`. With no `cdn` tier registered the list purges nowhere, which is why
`recentInvalidations()` reports `busted` from `tiers` and never from `cdn` — a partial bust that
reads as a clean one is the failure that log exists to catch.

Every report is also kept: `recentInvalidations()` hands back the last 100, newest first, each
one naming the span that triggered it. That is the log the `/_x` cache panel renders — "did it
actually clear?" is answerable without a log dive because the one fan-out path retained the
answer, not because a second recorder was wired next to it.

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
`report.errors` under `tier: "broadcast"` — the other pods then clear on TTL, and the write that
triggered the bust still succeeds. An inbound tag this process has not declared is dropped and
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
| `isolateTiers()` | everything `resetTiers()` drops: the tier registry in registration order, the revalidator, the invalidation broadcast, `recentInvalidations()` and `recentTierFailures()` |

Each returns the function that puts back **exactly what it found**, so a per-test `resetGraph()` is
still fine — pair it with the module-scope isolate and the process gets its baseline back. A reset
alone is not a substitute: it drops what a neighbouring file registered, and
`@ultimat3/testing`'s leak guard compares its samples for *additions*, so the loss is invisible to
it and surfaces as a failure in an innocent file. That is the one leak no mechanism catches for you.
The last two live in the modules that own the state because a test file cannot reach it: the
revalidator has no reader, and neither log has a writer.

**`resetTierFailures()` and `isolateTierFailures()` are deliberately off `index.ts`.** Nothing
outside this package clears that log except through `resetTiers()`, which `isolateTiers()` already
covers — so a suite outside `packages/cache` isolates the tiers and gets the failure log with them.
`recentTierFailures()` is the only member of that module the public surface carries.

## CDN

```ts
cacheHeaders({ sMaxAge: 300, staleWhileRevalidate: 86_400, tags: [tag('post', id)] });
// => { 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
//      'Surrogate-Key': 'post:1' }
```

The surrogate keys **are** the tags, byte for byte, so an edge purge and an app-level
invalidation can never mean different things. A `cdn-path` dependent registered against a tag goes
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
`report.tiers` and in `recentInvalidations().busted`, with `errors: []`, in the default state of a
deployment that has no CDN at all. `isNoopPurgeDriver(driver)` is the same probe, exported.

Both pairs at once is `X_CONFIG_INVALID`: one process purges exactly one edge. Half a pair
is refused the same way — treating it as "no CDN" is how a deployment ships believing it
purges. Either refusal names the keys that are actually set, in `cause` and in
`meta.configured`, so the diagnostic can never point at a variable nobody set. A refused
purge is `X_CACHE_PURGE_FAILED` carrying `meta.retryable`, and it lands in `report.errors`
rather than failing the write that triggered it.

## Semantic cache

For LLM calls, where "list my orders" and "show me my orders" must hit the same entry.
`createMemorySemanticCache()` does cosine similarity at a 0.92 threshold (tight on
purpose — a false hit answers the wrong question, which is worse than a miss) and is the
only backing this package ships — it is O(n) and in-process. The interface (`SemanticCache`)
is a driver seam for that reason; a Postgres/pgvector-backed implementation does not exist
yet here (`@ultimat3/ai`'s `PgVectorStore` is a separate store, for RAG retrieval, not this
cache).

## Errors

| Code | Cause |
|---|---|
| `X_CACHE_DRIVER_UNAVAILABLE` | `Bun.redis` missing, a purge driver built without its token, or a batch size that is not a positive integer |
| `X_CACHE_JITTER_INVALID` | a tier's `jitterFraction` outside `[0, 1)` |
| `X_CACHE_PURGE_FAILED` | the CDN refused a purge, or a key it would split on whitespace |
| `X_CACHE_TAG_UNKNOWN` | a tag no entity declared — usually a typo |
| `X_CACHE_TOO_LARGE` | one entry exceeds a tier's whole byte budget |
| `X_CACHE_TTL_INVALID` | a `ttlMs` that is not a positive, finite number of milliseconds |

## Boundary

Tier 1. Imports `@ultimat3/core` and `@ultimat3/schema` only. Knows nothing about
entities, HTTP or jobs — `tagsFor()` takes structural `{ name }` / `{ id }` arguments so
`@ultimat3/entity` can depend on cache and never the reverse.
