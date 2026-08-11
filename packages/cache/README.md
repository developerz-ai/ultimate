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
| 2 | `redis` | `Bun.redis` | tag→keys set, one `EVAL` | single node |
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

## Invalidating

```ts
const report = await invalidateTags([tag('post', postId)]);
```

One function. Returns the report the `/_x` cache panel and `x cache bust --json` render:

```json
{
  "tags": ["post:1"],
  "tiers": [{ "tier": "lru", "keys": ["feed"] }, { "tier": "redis", "keys": ["feed"] }],
  "isr": ["/blog", "/blog/hello"],
  "cdn": ["post:1"],
  "liveQueries": [],
  "durationMs": 1.4,
  "errors": []
}
```

A dead tier lands in `errors` and never throws — a Redis outage must not fail the write
that triggered the bust. Entries there expire by TTL instead.

Every report is also kept: `recentInvalidations()` hands back the last 100, newest first, each
one naming the span that triggered it. That is the log the `/_x` cache panel renders — "did it
actually clear?" is answerable without a log dive because the one fan-out path retained the
answer, not because a second recorder was wired next to it.

## CDN

```ts
cacheHeaders({ sMaxAge: 300, staleWhileRevalidate: 86_400, tags: [tag('post', id)] });
// => { 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400',
//      'Surrogate-Key': 'post:1' }
```

The surrogate keys **are** the tags, byte for byte, so an edge purge and an app-level
invalidation can never mean different things. Three `PurgeDriver`s ship:

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

Both pairs at once is `X_CONFIG_INVALID`: one process purges exactly one edge. Half a pair
is refused the same way — treating it as "no CDN" is how a deployment ships believing it
purges. A refused purge is `X_CACHE_PURGE_FAILED` carrying `meta.retryable`, and it lands in
`report.errors` rather than failing the write that triggered it.

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
| `X_CACHE_DRIVER_UNAVAILABLE` | `Bun.redis` missing, or a purge driver built without its token |
| `X_CACHE_PURGE_FAILED` | the CDN refused a purge, or a key it would split on whitespace |
| `X_CACHE_TAG_UNKNOWN` | a tag no entity declared — usually a typo |
| `X_CACHE_TOO_LARGE` | one entry exceeds a tier's whole byte budget |

## Boundary

Tier 1. Imports `@ultimat3/core` and `@ultimat3/schema` only. Knows nothing about
entities, HTTP or jobs — `tagsFor()` takes structural `{ name }` / `{ id }` arguments so
`@ultimat3/entity` can depend on cache and never the reverse.
