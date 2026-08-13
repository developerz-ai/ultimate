# Caching

Four tiers, one invalidation graph. You declare what a write touches; the framework decides what to evict.

## The four tiers

| Tier | Store | Lifetime | Hit cost | Use |
|---|---|---|---|---|
| 1 | **Request memo** | one request (AsyncLocalStorage) | ~0 | the same `query` called by three components resolves once |
| 2 | **In-process LRU** | process lifetime, size-bounded | ~microseconds | hot rows, policy lookups, compiled templates; per-instance, so treat as a probabilistic hit |
| 3 | **shared** (`Bun.redis`) | cross-instance, TTL + tag sets | ~1ms | shared query results, rendered fragments, session-adjacent data |
| 4 | **CDN / HTTP headers** | client + edge | `Cache-Control`, `ETag`, `stale-while-revalidate` | static + ISR pages, images, assets |

Every tier is read in order 1 → 2 → 3 → origin. A tier is never consulted for a request whose `policy` has not already passed.

**Cache keys should carry the actor's tenant and policy scope**, so that a cache hit cannot leak across tenants. `As of 2026-08` they do **not**: `cacheKeyFor` in `packages/query/src/cache.ts` is the query name, a fingerprint of the parsed input, and the read's sorted tag keys. The tenant therefore reaches the key only through the input — which is the shape every scoped read already has (`feed({ orgId })`) — and a `cache:` read whose answer varies by actor for one input is a cross-tenant hit. Tier 1 is keyed by `Ctx` identity and is not affected. Closing this means the key derives the scope itself; until then the rule is the one the wiki states.

Tier 2 is optional per entry (`local: false` for large or per-tenant-unbounded values). Tier 3 is required for any entry an ISR page depends on, because regeneration happens on a different instance than the write.

### Tier 3 runs on Redis or Valkey, and nothing else today

The shared tier speaks five commands — `GET`, `SET … EX`, `SADD`, `DEL`, `SMEMBERS` — plus one `EVAL` ([`packages/cache/src/redis.ts`](../../packages/cache/src/redis.ts)). That script is where the portability stops, `As of 2026-08`:

```lua
for i, tagKey in ipairs(KEYS) do            -- the tag SETS are declared
  local members = redis.call('SMEMBERS', tagKey)
  for _, key in ipairs(members) do
    redis.call('DEL', key)                  -- the VALUE keys are not
```

`invalidateTags` passes only the tag-set keys in `KEYS`, then deletes members it discovers at runtime. Two engines refuse that:

| Engine | Result |
|---|---|
| Redis / Valkey, single node | works — this is the tested path |
| **Dragonfly**, single node included | refused: `CheckKeysDeclared()` rejects a script touching an undeclared key. `allow-undeclared-keys` buys it back at the cost of a global lock per invalidation |
| **Redis Cluster** | refused: every key of a script must hash to one slot, and `x:t:<tag>` carries no hash tag, so tag sets and their members do not co-slot |

The fix is `packages/cache/src/redis.ts`, never app code — either declare the members in a second round trip and lose the script's atomicity, or hash-tag the key layout. Until one lands, keep `REDIS_URL` pointed at Redis or Valkey, single node. [`17-scale-ladder.md`](./17-scale-ladder.md#dragonfly-honestly) has the operational detail.

## Entity tags are the invalidation graph

A tag is a typed handle derived from an `entity`. There is no string-keyed invalidation API.

```ts
export const tag = tags({
  post: entityTag(posts),                       // tag.post, tag.post.id(x)
  feed: derivedTag('feed', [tag.post]),          // invalidating post cascades to feed
});
```

| Tag form | Scope | Example |
|---|---|---|
| `tag.post` | all posts | a schema-level change |
| `tag.post.id(postId)` | one row | the common case; narrowest eviction |
| `tag.feed` | derived; declares `[tag.post]` as an upstream | list views that a post membership affects |

Queries acquire tags automatically from the tables their `sql` touches. Routes declare them in `revalidate.tags`. Actions declare them in `cache.invalidates`. The graph is a build-time artifact in `x.manifest.json`, so `x cache graph --json` prints exactly what a write will evict — before you run it.

## One hop, all tiers

```ts
// action
export const publishPost = action({
  input:  t.object({ postId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id });
    return post;
  },
});
```

`invalidates: [tag.post, tag.feed]` fans out on commit:

| Target | Mechanism | Timing |
|---|---|---|
| Tier 1 request memo | drop entries carrying the tag | immediate, same request |
| Tier 2 in-process LRU (**all instances**) | tag-invalidation message on NATS | ~ms, best-effort; a missed message costs a stale read until TTL, never a wrong write |
| Tier 3 shared | one `EVAL`: `SMEMBERS` the tag set, `DEL` each member, `DEL` the set | immediate, transactional with the outbox |
| ISR pages | routes whose `revalidate.tags` include the tag are marked stale → regenerated in background | next request serves stale, regen enqueued as a job |
| CDN | purge by surrogate key — the same tag strings — through the configured `PurgeDriver` | seconds; `stale-while-revalidate` covers the gap |
| Live queries | the same commit already flows through logical replication ([`03-realtime.md`](./03-realtime.md)) | independent path — realtime does not depend on cache invalidation |

Fanout is enqueued in the **same transaction** as the write (the outbox from [`04-jobs.md`](./04-jobs.md)). A rolled-back write never purges; a committed write always does.

## Why removing the manual decision matters

The bug is never "the cache is wrong". The bug is that invalidation is a *decision made at a distance*: the developer editing `publishPost` must remember which of nine cached things this write affects, including two added last month by someone else.

| Failure mode | Cause | Removed by |
|---|---|---|
| Stale page after publish | forgot one `revalidate` call | tags are declared on the route, resolved from the graph |
| Purging too much | uncertainty → `flushAll` | narrow `tag.post.id(x)` is the ergonomic default |
| Tier drift | Redis purged, CDN not | one fanout, all tiers |
| Leak across tenants | hand-built cache key missing the tenant | keys are framework-generated — `As of 2026-08` from the query name, the parsed input and the tags, not yet from actor scope, so the read must take the tenant as input |

This is [wrap, don't reinvent](./00-thesis.md#wrap-dont-reinvent) applied to eviction: the tiers are `Bun.redis` and standard CDN headers, and what the wrapper deletes is the decision about which of them to clear. A wrapper that only renamed `DEL` would have earned nothing.

Agents are measurably bad at *distant* invariants — the pattern "edit here, remember to also edit there" is where LLM-written code regresses most. Declaring `invalidates` at the write site is local, checkable, and typed: an unknown tag is a compile error, and a query whose tables are not covered by any tag is an `x verify` failure (`X_CACHE_UNTAGGED_QUERY`).

## Semantic cache for LLM calls

Model calls are slow and metered; exact-match caching almost never hits because prompts differ by a word.

```ts
export const summarize = llm({
  model: 'claude-sonnet-5',
  cache: {
    semantic: { threshold: 0.97, ttl: '7d', scope: ({ orgId }) => orgId },
    invalidates: [tag.post],
  },
  prompt: summarizePrompt,      // versioned artifact, see 09-ai-first.md
});
```

| Aspect | Rule |
|---|---|
| Store | pgvector table, one row per (prompt version, embedded input, scope) |
| Key | embedding of the rendered prompt + model id + **prompt version** |
| Hit | cosine similarity >= `threshold`; default 0.97, never below 0.9 |
| Scope | required — tenant-scoped by default so one org never reads another's completion |
| Bypass | `temperature > 0` results are cached but flagged; `cache: false` for anything user-visible-and-unique |
| Invalidation | participates in the same tag graph; bumping the prompt version invalidates wholesale |
| Metrics | hit rate, tokens saved, cost saved — in `/_x` and `x ai cache --json` |

Also cached exactly (tier 3, not semantic): embeddings themselves, keyed by content hash + model. Re-embedding unchanged text is pure waste.

## Rules

- Cache keys are framework-generated. A hand-built key is a rejected PR.
- Every cached `query` carries at least one tag, enforced by `x verify`.
- Never cache a value whose policy scope is not in its key.
- `flushAll` exists only as `x cache clear` in dev; there is no runtime API for it.
- Cache misses must be correct and merely slower — no code path may depend on a hit.
