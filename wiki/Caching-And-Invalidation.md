# Caching and invalidation

Four tiers, one invalidation graph. You declare what a write touches; the framework decides what to evict.

v1.0.0 `As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)).

## The four tiers

| Tier | Store | Lifetime | Hit cost | Use |
|---|---|---|---|---|
| 1 | **Request memo** | one request (AsyncLocalStorage) | ~0 | the same `query` called by three components resolves once |
| 2 | **In-process LRU** | process lifetime, size-bounded | ~microseconds | hot rows, policy lookups, compiled templates; per-instance, so treat as a probabilistic hit |
| 3 | **Redis** (`Bun.redis`) | cross-instance, TTL + tag sets | ~1ms | shared query results, rendered fragments, session-adjacent data |
| 4 | **CDN / HTTP headers** | client + edge | `Cache-Control`, `ETag`, `stale-while-revalidate` | static + ISR pages, images, assets |

Read order is **1 → 2 → 3 → origin**. A tier is never consulted for a request whose `policy` has not already passed.

**Cache keys always include the actor's tenant and policy scope**, so a cache hit can never leak across tenants. Keys are framework-generated from the query name, its parsed input, and the resolved actor scope.

| Tier | Opt-out / requirement |
|---|---|
| 1 | always on; no configuration |
| 2 | optional per entry — `local: false` for large or per-tenant-unbounded values |
| 3 | **required** for any entry an ISR page depends on, because regeneration happens on a different instance than the write |
| 4 | emitted from the route's render mode; never hand-set on a response |

## Entity tags are the invalidation graph

A tag is a typed handle derived from an [entity](Entities-And-Migrations). There is no string-keyed invalidation API.

```ts
export const tag = tags({
  post: entityTag(posts),                       // tag.post, tag.post.id(x)
  feed: derivedTag('feed', [tags.post]),        // invalidating post cascades to feed
});
```

| Tag form | Scope | Example |
|---|---|---|
| `tag.post` | all posts | a schema-level change |
| `tag.post.id(postId)` | one row | the common case; narrowest eviction |
| `tag.feed` | derived; declares `[tag.post]` as an upstream | list views that a post membership affects |

| Declared where | By |
|---|---|
| Queries | **automatic** — acquired from the tables their `sql` touches |
| Routes | `revalidate: { tags: [...] }` |
| Actions / mutators | `cache: { invalidates: [...] }` |
| LLM calls | `cache: { invalidates: [...] }` |

The graph is a build-time artifact in `x.manifest.json`, so `x cache graph --json` prints exactly what a write will evict — before you run it. Tag typing comes from a generated registry augmentation; `x manifest` regenerates it.

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
| Tier 3 Redis | `SREM`/`DEL` over the tag's key set | immediate, transactional with the outbox |
| ISR pages | routes whose `revalidate.tags` include the tag are marked stale → regenerated in background | next request serves stale, regen enqueued as a job |
| CDN | purge by surrogate key — the same tag strings — through the configured `PurgeDriver` | seconds; `stale-while-revalidate` covers the gap |
| Live queries | the same commit already flows through logical replication | **independent path** — realtime does not depend on cache invalidation |

Fanout is enqueued in the **same transaction** as the write — the transactional outbox from [Jobs and workflows](Jobs-And-Workflows). A rolled-back write never purges; a committed write always does.

There is exactly one fan-out entry point in the implementation (`invalidateTags()`); no caller reaches a tier directly. Tier failures are collected into an invalidation report — **a cache tier may never fail a business write.**

## Failure modes removed

The bug is never "the cache is wrong". The bug is that invalidation is a *decision made at a distance*: the developer editing `publishPost` must remember which of nine cached things this write affects, including two added last month by someone else.

| Failure mode | Cause | Removed by |
|---|---|---|
| Stale page after publish | forgot one `revalidate` call | tags are declared on the route, resolved from the graph |
| Purging too much | uncertainty → `flushAll` | narrow `tag.post.id(x)` is the ergonomic default |
| Tier drift | Redis purged, CDN not | one fanout, all tiers |
| Leak across tenants | hand-built cache key missing the tenant | keys are framework-generated from actor scope |
| Stale forever | a query whose tables no tag covers | the tag rule — **not yet a gate**: `X_CACHE_UNTAGGED_QUERY` is reserved `As of 2026-08` and nothing raises it, so a cached query no tag covers is cached and never invalidated ([Error codes → Reserved codes](Error-Codes#reserved-codes)) |
| Silent typo | `invalidates: [tag.pots]` | `X_CACHE_TAG_UNKNOWN`, or a compile error against the generated registry |

Agents are measurably bad at *distant* invariants — "edit here, remember to also edit there" is where LLM-written code regresses most. Declaring `invalidates` at the write site is local, checkable, and typed.

## The CDN leg

The CDN is the one tier Ultimate never reads back from, so the emitted header and the purge call
are the whole contract. `cacheHeaders()` writes the surrogate keys, and they are the tag strings
unchanged — `post`, `post:1` — which is what keeps an edge purge from ever meaning something
different than an `invalidates: [tag.post]`.

| Driver | Purge | Purge all | Per call |
|---|---|---|---|
| `noopPurgeDriver()` | echoes the keys back | resolves | — |
| `fastlyPurgeDriver({ apiToken, serviceId })` | `POST /service/<id>/purge` with `surrogate_keys` | `POST /service/<id>/purge_all` | 256 keys |
| `cloudflarePurgeDriver({ apiToken, zoneId })` | `POST /zones/<id>/purge_cache` with `tags` | same call with `purge_everything` | 30 tags |

Which one a process installs is decided from the environment — `FASTLY_API_TOKEN` +
`FASTLY_SERVICE_ID`, or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ZONE_ID`. See
[Configuration → CDN purge](Configuration#cdn-purge). With neither pair set, nothing is purged and
no `cdn` line appears in the invalidation report: a tier that reported keys an edge that does not
exist had accepted would be worse than no tier at all.

A refusal is `X_CACHE_PURGE_FAILED` with `meta.retryable`, collected into `report.errors` — a dead
CDN never fails the write that triggered the bust, and the entry expires by TTL instead.

## Semantic cache for LLM calls

Model calls are slow and metered; exact-match caching almost never hits because prompts differ by a word.

```ts
export const summarize = llm({
  model: 'claude-sonnet-4-5',
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

Also cached exactly (tier 3, not semantic): embeddings themselves, keyed by content hash + model. Re-embedding unchanged text is pure waste. See [MCP and AI](MCP-And-AI).

## CLI

| Command | Does |
|---|---|
| `x cache graph --json` | prints the tag → dependents graph: cache keys, ISR routes, CDN paths, live queries. Build-time truth, no runtime call |
| `x cache graph --tag post --json` | the blast radius of one tag |
| `x cache bust <tag>` | runs the real fanout for one tag, all tiers, and prints the invalidation report |
| `x cache clear` | **dev only.** The only `flushAll` that exists; there is no runtime API for it |
| `x cache stats --json` | per-tier hit rate, byte usage against budget, evictions |

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_CACHE_UNTAGGED_QUERY` | **reserved, nothing raises it** `As of 2026-08` — a query's tables are covered by no tag, so it could never be invalidated ([Error codes → Reserved codes](Error-Codes#reserved-codes)) | declare the entity tag, then `x manifest` |
| `X_CACHE_TAG_UNKNOWN` | `tag "<name>" is not declared by any entity` | `x manifest` |
| `X_CACHE_TOO_LARGE` | `entry "<key>" is <n>B, over the <tier> budget of <m>B` | `raise cache.<tier>.maxBytes in app.config.ts, or cache a projection instead of the row` |
| `X_CACHE_DRIVER_UNAVAILABLE` | `cache tier "<driver>" is unavailable` — no Redis binding, or a purge driver built without its token | the error carries the exact config or command to fix |
| `X_CACHE_PURGE_FAILED` | `<driver> refused the purge (HTTP <status>)` — a wrong token, a zone without tag purge, a throttle, or a key a CDN would split | `meta.retryable === true` → the identical purge can land again; otherwise set the env key the `fix` names |

Verbatim shapes: [`packages/cache/src/errors.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cache/src/errors.ts). Full index: [Error codes](Error-Codes).

## Rules

- Cache keys are framework-generated. A hand-built key is a rejected PR.
- Every cached `query` carries at least one tag. Review catches it `As of 2026-08`, not the gate — `X_CACHE_UNTAGGED_QUERY` is reserved and no `x verify` step reads a query's tags.
- Never cache a value whose policy scope is not in its key.
- `flushAll` exists only as `x cache clear` in dev; there is no runtime API for it.
- Cache misses must be correct and merely slower — no code path may depend on a hit.
- Prefer `tag.post.id(x)` over `tag.post`. Narrow eviction is the default, not an optimization.
- A cache tier may never fail a business write. Tier errors land in the invalidation report.
- Realtime is not a cache tier. Live queries flow from logical replication on their own path ([Realtime](Realtime)).
