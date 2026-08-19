# Caching

Four tiers, one invalidation graph. You declare what a write touches; the framework decides what to evict.

## The four tiers

| Tier | Store | Lifetime | Hit cost | Use |
|---|---|---|---|---|
| 1 | **Request memo** | one request (AsyncLocalStorage) | ~0 | the same `query` called by three components resolves once |
| 2 | **In-process LRU** | process lifetime, size-bounded | ~microseconds | hot rows, policy lookups, compiled templates; per-instance, so treat as a probabilistic hit |
| 3 | **shared** (`Bun.redis`) | cross-instance; jittered TTL, leased tag sets, keys namespaced by build | ~1ms | shared query results, rendered fragments, session-adjacent data |
| 4 | **CDN / HTTP headers** | client + edge | `Cache-Control`, `ETag`, `stale-while-revalidate` | static + ISR pages, images, assets |

Every tier is read in order 1 → 2 → 3 → origin. A tier is never consulted for a request whose `policy` has not already passed.

**Cache keys should carry the actor's tenant and policy scope**, so that a cache hit cannot leak across tenants. `As of 2026-08` they do **not**: `cacheKeyFor` in `packages/query/src/cache.ts` is the query name, a fingerprint of the parsed input, and the read's sorted tag keys. The tenant therefore reaches the key only through the input — which is the shape every scoped read already has (`feed({ orgId })`) — and a `cache:` read whose answer varies by actor for one input is a cross-tenant hit. Tier 1 is keyed by `Ctx` identity and is not affected, and tier 3's build-id namespace separates deploys, not tenants — it is a different problem. Closing this means the key derives the scope itself; until then the rule is the one the wiki states.

Tier 2 is optional per entry (`local: false` for large or per-tenant-unbounded values). Tier 3 is required for any entry an ISR page depends on, because regeneration happens on a different instance than the write.

### Tier 3's key layout is the portability

The shared tier speaks five commands — `GET`, `SET … EX`, `SADD`, `DEL`, `SMEMBERS` — plus two scripts ([`packages/cache/src/redis.ts`](../../packages/cache/src/redis.ts)). Every constraint the tier used to fail is answered by the key shape rather than by a server setting, `As of 2026-08`:

| Key | Shape | Why that shape |
|---|---|---|
| namespace | `<prefix>:<buildId>` — `x:dev` locally, `x:<APP_VERSION>` deployed | two builds sharing one Redis never read each other's payloads. `JSON.parse` does not validate, so an old pod reading a renamed field back gets `undefined` on half the fleet for the length of a rolling deploy. `buildId: null` opts out, for a team that versions its own payloads |
| value | `<ns>:c:<key>` | |
| collection tag bucket | `<ns>:t:{<entity>}` | `{entity}` is a Redis Cluster **hash tag** |
| row tag bucket | `<ns>:t:{<entity>}:<id>` | the same hash tag, so a row's bucket and its collection's bucket land in one slot and one script may take both |

The invalidation script touches only the buckets it was handed, and returns the value keys instead of deleting them:

```lua
local removed = {}
for i, tagKey in ipairs(KEYS) do            -- the tag SETS are declared
  local members = redis.call('SMEMBERS', tagKey)
  for _, key in ipairs(members) do
    table.insert(removed, key)              -- the VALUE keys go back to the caller
  end
  redis.call('DEL', tagKey)
end
return removed
```

`invalidateTags` issues **one call per tag**, never one for the batch, so every key of a call shares one `{entity}`; the tier then drops each value key client-side, one key per `DEL`, which is slot-local whatever the topology. Round trips equal distinct tags, all under one `Promise.all`.

| Engine | Result |
|---|---|
| Redis / Valkey, single node | works — this is the tested path |
| **Dragonfly** | works — every key a script touches is declared, so `CheckKeysDeclared()` is satisfied and `allow-undeclared-keys`, whose price is a global lock per invalidation, is not needed |
| **Cluster mode** — Redis Cluster, Dragonfly `--cluster_mode=yes` | **satisfied by construction** `As of 2026-08`: every key of every call hashes on one `{entity}`. Asserted by [`redis.test.ts`](../../packages/cache/src/redis.test.ts) against the emitted keys — no test runs against a real cluster node, so treat it as unmeasured, not unsupported |

The rule did not relax. Every key of a script must still hash to one slot; the layout is what now satisfies it.

### Three behaviours a shared tier needs and most do not ship

| Behaviour | What it does | Knob |
|---|---|---|
| **Single-flight** | N concurrent misses on one key are one `load()`. Joiners share the leader's write-back too, so 200 readers produce one `set` per tier. A rejection clears the entry, so one failure is never cached as a permanent rejection ([`single-flight.ts`](../../packages/cache/src/single-flight.ts)) | none — always on |
| **TTL jitter** | A rolling restart warms 40,000 keys in 30 seconds on identical leases, and they all expire in the same 30-second window five minutes later; single-flight only merges the loads that overlap. Shaving a random slice off each lease turns the cliff into a ramp. Folded into `assertTtl`, the one choke point no tier can bypass | `jitterFraction`, default `0.05`; `0` disables |
| **Tag-bucket lease** | A tag set with no expiry is unbounded: value keys die on their TTL, membership did not, so `SMEMBERS` on a month-old bucket returned millions of dead keys and one publish became an outage. `SADD` + a conditional `EXPIRE` in one script gives each bucket its newest member's TTL plus 60s grace, **raised only when longer** — a short-lived member must never shorten a bucket a long-lived one is in | grace is fixed at 60s |

Full option list: [`packages/cache/README.md`](../../packages/cache/README.md). [`17-scale-ladder.md`](./17-scale-ladder.md#dragonfly-honestly) has the operational detail on Dragonfly itself.

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

Queries acquire tags automatically from the tables their `sql` touches. Routes declare them in `revalidate.tags`. Actions declare them in `cache.invalidates`. The graph is a build-time artifact in `x.manifest.json`. `x cache graph --json` would print exactly what a write will evict before you run it — **planned, not shipped**; it exits `X_NOT_IMPLEMENTED` and its own fix sends you to `x dev` and the cache panel at `/_x`.

## One hop, all tiers

```ts
// action
export const publishPost = action({
  input:  t.object({ postId: t.uuid, orgId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },
  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id, orgId: input.orgId });
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

Agents are measurably bad at *distant* invariants — the pattern "edit here, remember to also edit there" is where LLM-written code regresses most. Declaring `invalidates` at the write site is local, checkable, and typed: an unknown tag is a compile error. The other half is **not** a gate `As of 2026-08` — a cached query whose tables no tag covers is caught in review, because `X_CACHE_UNTAGGED_QUERY` is reserved and no `.ts` file raises it ([Error codes → Reserved codes](../../wiki/Error-Codes.md#reserved-codes)).

## Semantic cache for LLM calls

Model calls are slow and metered; exact-match caching almost never hits because prompts differ by a word.

```ts
export const summarize = llm({
  model: 'claude-sonnet-5',
  cache: {
    semantic: { threshold: 0.97, ttl: '7d' }, // partitions on the ACTOR by default
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
- Every cached `query` should carry at least one tag — an entry stored without them is reachable and undroppable until its TTL. **A convention, not a rule**: `As of 2026-08` `tags` defaults to `[]` (`packages/query/src/cache.ts:185`) and no step checks it.
- Never cache a value whose policy scope is not in its key.
- `flushAll` has no runtime API. `x cache clear` is **planned**, not shipped.
- Cache misses must be correct and merely slower — no code path may depend on a hit.
