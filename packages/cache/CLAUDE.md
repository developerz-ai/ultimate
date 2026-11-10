# @ultimat3/cache — agent notes

Tier 1. Tagged caching + THE invalidation graph.

## Boundary

- May import: `@ultimat3/core`, `@ultimat3/schema`. Nothing else, ever.
- Must NOT know about entities, HTTP, jobs, render. `tagsFor()` takes structural args.
- Consumers: `entity` (write hooks), `action` (`cache.invalidates`), `render` (ISR), `cli`.

## Rules

- **A tier's own LIMIT is screened where `app.config.ts` names it** — `assertFiniteCapacity`,
  `assertFiniteDurationMs`, `assertFiniteSimilarityFloor`, beside `assertTtl` in `tiers.ts`, all
  raising `X_CACHE_LIMIT_INVALID`. A `NaN` limit makes every comparison false, so the guard switches
  itself off (no eviction, no similarity floor). Never `Math.max(1, x)` in front: a clamp is not a
  validator. **The `Finite` in the names is load-bearing** — `bun run finite-bounds` recognises a
  repair by the call's shape.
- `invalidateTags()` in `invalidate.ts` is the ONLY fan-out path, and (with `flushProcessTiers`) the
  only emitter of `cache.invalidate`. Never call `tier.invalidateTags()` from outside it.
- **No ring buffer, no slot (v31, `X_INSTRUMENT_SLOT_FORBIDDEN`)**: busts, swallowed refusals and
  every rung a read asks are core bus events — `cache.invalidate`, `cache.tier_failure`,
  `cache.hit`/`cache.miss` — payloads core's (`CacheInvalidateEvent`, `CacheTierFailureEvent`,
  `CacheLookupEvent`), re-exported. The `/_x` panel subscribes and keeps its own buffer. Tests read
  them through `recordCacheEvents()` (`cache-events-fixture.ts`).
- **The fan-out clears FARTHEST tier first, and reports in read order** (core's `CACHE_TIERS`, what `/_x`
  renders). Near-to-far lets a racing read promote the stale far value straight back up.
  `CacheStack.drop` reverses for the same reason. `invalidation-race.test.ts`.
- **The EDGE is purged last**: read tiers → ISR revalidators → broadcast → `cdn`. Purged first, a
  request before the origin's own delete was a public hit the purged edge cached again for a whole
  `s-maxage`. A refused broadcast purges it again when the deferred one is published
  (`purgeEdgeAgain`, called by cli); a flush purges it last too. `invalidate-order.test.ts`.
- **A fill is fenced: sample before `load()`, ask before the write** (`fence.ts`). `sampleFence({ key,
  tags })` → `fence.isValid()`; `markInvalidated` is the write half (`fanOut`, `CacheStack.write`,
  `CacheStack.drop`). Exported so a store outside this package reuses it rather than growing a
  second mechanism. `cover()` widens a fence for joiners' tags (`cacheStack.read` only). A
  fence never fails a read — it declines to publish. The one process-global here with no `isolate*()`
  seam, structurally: a fence samples the current generation.
- **The Redis tier keeps a second fence, for the FLEET** (`CacheTier.fence`, `tier-fence.ts`,
  `redis-fence.ts`): a bust `SET`s a leased generation BEFORE it reads its buckets; `stack.read`
  samples before `load()` and asks AFTER the tier's `set`. `busted` withdraws the whole fill,
  `unprovable` (Redis unreachable, past `FENCE_PROOF_WINDOW_MS`, an unsampled joiner tag) skips
  that tier only. Plain `SET`/`GET`, never a script — so `redis-fence.test.ts` proves it on the
  fake. Tags only; `drop`/`write` by key still fence one process.
- **A refused `set` in `fill` is followed by a `del` in that tier.** `LruCache.set` called
  directly still leaves the entry it refused to replace.
- One graph. `graph.ts` exports functions over module state and **no constructor**; no second registry.
- Tag order is core's `CACHE_TIERS`, never registration order. `sortTiers()` enforces it.
- **The rung NAMES are `@ultimat3/core`'s (`CACHE_TIERS`); the ladder is this package's.** `TierName`
  aliases core's `CacheTierName`; the read order IS `CACHE_TIERS`, imported — 25.0.0 deleted the
  `TIER_ORDER` alias (`X_HELPER_COPY` refuses a value of core's under a second name). Adding a
  rung is an edit to `packages/core/src/cache-vocabulary.ts` plus a factory here; `scripts/render-modes.ts` refuses a second declaration of the set. **`isr` is
  not a tier** — the `'isr'` in `invalidate.ts` is an ISR route (`DependentKind = 'isr-route'`).
- **`flushProcessTiers(source)` is for a process that cannot name what it missed** (its bus was
  away): `CacheTier.clear()` on in-process tiers only, tagged ISR pages stale, fills fenced out
  (`markAllInvalidated`). Never re-emits. A shared tier must NOT implement `clear`.
- **`bestEffort()` is the only sanctioned way to swallow a cache refusal.** A `cache.tier_failure` subscriber that throws is contained by the bus, as every subscriber is (`instrument.subscriber_failed`, logged once) — never the read's failure. Its label is `TierLabel`
  (`TierName` plus `'query-read'`), deliberately not a widening of `TierName`.
- **A refusal is rendered with `renderThrowable()`, never `error.message`** — at all five absorbing
  sites. Tiers, revalidators, broadcasts and purge `fetch`es are app-supplied, so their rejection
  values are too. The code field keeps its own total probe (`ultimateCode` in `tier-failures.ts`):
  a driver `code` is a SQLSTATE, never an `X_*`.
- Tier failures go into `report.errors`; a cache tier may never fail a business read or write.
  `cacheStack` routes every `get`/`set`/`del` through `bestEffort()` into a
  `cache.tier_failure` event. `load()` is the one unguarded call (it IS the business read).
  `LruCache.set` still throws `X_CACHE_TOO_LARGE` to a direct caller.
- **`serializeTags` is the wire form; `tagKeys` is the IDENTITY form** (sorted, de-duplicated —
  `@ultimat3/query`'s `cacheKeyFor` builds keys from it). It lives here because `action` and `query`
  are one tier and cannot share a copy. `@ultimat3/render`'s order-preserving route form is its
  internal `routeTagKeys` (`render/src/route.ts`) — one public `tagKeys`, this one.
- **`invalidateWireTags` has no production caller and is KEPT**: the outbound twin of
  `receiveInvalidationBroadcast`, which `packages/cli/src/runtime-cache.ts` calls.
- `tag.x` typing comes from the `CacheTagRegistry` augmentation, generated by `x manifest`.
- **`declareTags()` is additive and process-wide: a test undoes it with `isolateDeclaredTags()`,
  never `resetDeclaredTags()`** (the empty set switches `assertKnownTags` off).
- **Every process-global registry has that seam: `isolateGraph()`, `isolateTiers()`.** A reset
  belongs only where an empty registry is the subject, paired with the module-scope isolate and
  `afterAll(restore)` — the leak guard sees additions, never deletions.
- Clocks are injected (`LruOptions.clock`, `CacheStackOptions.clock`); read them through `nowMs()`.
- **`ttlMs` is positive and finite, and `assertTtl` (`tiers.ts`) is the one place that says so** —
  every tier calls it before writing, the request memo and `memorySemanticCache.remember`
  included (scope `'semantic'`, `jitterFraction: 0`). `X_CACHE_TTL_INVALID`, never a resolution.
- **`assertTtl` also SPREADS the lease it validated.** `rng` is injected (`LruOptions.rng`,
  `RedisTierOptions.rng`) — never `Math.random()` at a call site; `rng: () => 0` is the full lease.
  `jitterFraction` outside `[0, 1)` is `X_CACHE_JITTER_INVALID`, refused, not clamped.
- **`cacheStack` is the production read path, and `@ultimat3/query`'s `readThrough` is its
  caller** — it is what makes an action's `cache.invalidates` reach a `cache:` query.
- **`cacheStack` shares one in-flight `load()` per key** through `@ultimat3/core`'s
  `singleFlight`, imported by `tiers.ts` (`single-flight.test.ts` exercises it through the
  stack); 25.0.0 deleted the `single-flight.ts` door and its re-export. A rejected load clears its entry. One `SingleFlight` per stack.
- **A wedged `load()` frees its key after `DEFAULT_LOAD_DEADLINE_MS` (30 s)** — http's
  `requestTimeoutMs` default, written as a literal because http is tier 2. `loadDeadlineMs`
  overrides it and `schedule` injects the timer. Eviction frees the KEY only; the load runs on. Not
  an `app.config.ts` key on purpose.
- **A read refuses to join a load a bust has overtaken** (`tier-leading.ts`): a reader's unseen tags are
  covered, then an invalid fence evicts the key and the read leads. A joiner from before the bust keeps
  its load. An entry lives exactly while the flight holds the key (`released`). A joiner asks the fence
  only when the generation moved or it brought a new tag: ~1,600 arrivals must not each walk the marks.
- **A joiner survives its leader's abort** (`singleFlight`'s `signal`, `tryUseContext()?.signal`): it
  re-leads under its own context. A failure with the leader's signal live is still shared.
- **A joiner shares the leader's WRITE, so it contributes to it** (`FlightJoin`, `mergeSetOptions`
  in `set-options.ts`): tags union, TTLs take the shortest. `work` reads the merge after the load
  AND once more after the fill (`tagsAddedSince`), re-filling every tier.
  `tiers.test.ts`'s "a single-flight joiner that arrives during the FILL" is the proof.
- **`negativeTtlMs` is the stack's decision** (`ttlOptionsFor`), reaching a tier as an ordinary `ttlMs`.
- **A promotion carries the entry's remaining life**, `hit.expiresAt - now`, and drops a hit that
  fails `isExpired`. So every tier's `get` reports `expiresAt`: `redis.ts` reads `PTTL` pipelined
  with the `GET` (server clock). `-1`/`-2` are sentinels, and `PTTL: -2` beside a returned value is a MISS.
- **`t2:` is the TAG's bucket and `e2:` is the ENTITY index; one key is never both**
  (`redis-buckets.ts`). `writeBucketsFor` joins the declared tag plus `e2:{entity}`;
  `bustBucketsFor` reads the index for a collection bust and `t2:{entity}:<id>` + `t2:{entity}` for
  a row one. `sweepBucketsFor` (what a bust `ZREM`s from) is a superset: a row bust cleans the index
  it never reads. Pinned by `tag-parity.test.ts`, `tier-parity.test.ts` and `redis.live.test.ts`.
- **A bucket is a sorted set scored `expiry + TAG_GRACE_MS` (writer's clock), and every join prunes
  `-inf (now`** — so it holds live keys only (`redis-tag-bound.test.ts`). The grace absorbs clock
  skew between pods; never score by the bare expiry. Changing the layout bumps the segment (`t2`)
  rather than migrating.
- **Every tier stores codec TEXT, never the caller's object** (`value-codec.ts`: JSON + tagged
  `Date`/`bigint`/`Map`/`Set`, app `$x` keys escaped). One shape whichever tier hit, no shared
  mutable reference; a cycle, depth > 512 or a bigint > 4096 chars is `X_CACHE_VALUE_UNENCODABLE`
  at the write. Only `x1:`-marked text is revived; unmarked (pre-codec) is plain `JSON.parse`.
- **`CacheTier.set` REJECTS, never throws synchronously** — `lruTier`/`memoTier` are
  `async` for that alone.
- **A bust has no script.** `readBucket` pages `ZSCAN … COUNT 1000` — never a score/offset
  cursor: a concurrent prune of a read tie group, or a re-write re-scoring a read tie member, shifts
  an offset past live keys. `ZSCAN` returns every member present for the whole scan (the fake's
  `ZSCAN` keeps exactly that guarantee and nothing stronger); `unlinkAll` `UNLINK`s one key per command; `sweepBuckets` `ZREM`s only what
  `Promise.allSettled` says died, 8 commands in flight, so a refused `UNLINK` stays findable for the
  retry. 10k members ≤ 100 sequential round trips (`roundTrips` in the fixture counts them).
- **A `set` joins its buckets BEFORE it writes the value, and re-checks membership after**; only a
  literal `null` from `ZSCORE` counts as busted-in-the-air (`lostMembership`).
- **Every command the tier sends names ONE key** (the lease `EVAL` included), and bucket keys carry
  a `{entity}` hash tag — slot-local on Redis Cluster and Dragonfly by construction.
- **Every tag set carries a lease that only grows** — `REDIS_TAG_LEASE_SCRIPT`, the tier's one
  script (`GT` alone leaves a fresh bucket immortal).
- **`redisTier({ maxValueBytes })`, default 1 MiB of encoded UTF-8, is `X_CACHE_TOO_LARGE`** —
  checked after encoding, before any bucket is joined; the LRU's `maxBytes`, on the shared rung.
- **The fake holds plain commands as state and never runs Lua** (`redis-fake-fixture.ts`): values,
  sorted sets, `UNLINK`. An `EVAL` other than the lease script throws. Every claim about what a
  script DOES belongs in `redis.live.test.ts`.
- **The Redis namespace carries the build id by default** (`namespaceFor`, `appVersion()`);
  `buildId: null` opts out. Changing the layout is a cold cache.
- **Redis down is a slow miss, never a hang** (`redis-deadline.ts`). Every value-path command gets
  `commandTimeoutMs` (150 ms); one miss parks the value path `REDIS_PARK_MS` (5 s) — commands refuse
  unsent, one clock read, no state machine. A bust NEVER parks and gets 1,000 ms: a skipped bust is
  stale rows until TTL. A miss or a park is `X_CACHE_DRIVER_UNAVAILABLE`, which `bestEffort` records;
  so is a STOPPED store (Bun's `ERR_REDIS_CONNECTION_CLOSED`, typed in `withinDeadline`, a bust's
  included). A server's own error reply passes through (`redis-outage.test.ts`).
  The client is core's `redisClient()` (no offline queue, endless reconnect); never `Bun.redis`.
- **Cross-instance invalidation is a SEAM, never a transport.** `registerInvalidationBroadcast` /
  `receiveInvalidationBroadcast`; `cli` owns the bus. The inbound half cannot re-emit (only it passes
  `emit: false`). An undeclared inbound tag goes to `report.errors`, never a throw.
- **A `cdn` tier holding `noopPurgeDriver()` reports `skipped`, never keys** (`isNoopPurgeDriver`,
  in `cdn.ts`). **`report.cdn` is what depends; `report.tiers` is what cleared** — `busted` is built
  from `tiers` + `isr` + `liveQueries`, never `cdn`.
- A purge driver is selected by `selectPurgeDriver` from the environment, never `app.config.ts`. Two
  CDN credentials, or half a pair, is refused. The token never reaches a printed string.
- `assertPurgeableKeys` refuses whitespace or a comma in a key **before** the request — and at
  EMISSION (`surrogateKeys`, `cacheHeaders`), where an unpurgeable key would otherwise be tagged.
- **The edge speaks `tagMatches` through two key lists in `cdn.ts`**: a response carries each wire
  tag plus `e:<entity>`; a row bust purges `<entity>:<id>` + `<entity>`, a collection bust
  `e:<entity>` + `<entity>`. Never purge `e:` for a row. `tag-parity.test.ts` runs one fixture
  table through memo, LRU, Redis and CDN.
- **The one shipped emitter of surrogate keys is `toResult` in `packages/render/src/render-isr.ts`**
  (`surrogateKeys(tags, 'isr')`, `As of 2026-10-02`; http strips them on a rewrite to private). `cacheHeaders` has no production caller, and
  `@ultimat3/http`'s `applyCacheHeaders` joins `CacheHint.tags` verbatim — a caller hands it
  `surrogateKeys` output. Render screens `revalidate.tags` at registration with this function.
- `retryable` on `X_CACHE_PURGE_FAILED` is core's `isRetryableStatus` (re-exported by
  `purge-http.ts`), plus any request with no status, and `CachePurgeFailedError` passes it through
  as a per-instance `retry` — never `registerErrorRetry`, one code covers a 401 and a 429.
- A non-positive-integer batch size is `X_CACHE_DRIVER_UNAVAILABLE`, raised by `chunked()` before
  the loop.
- Every `fixFor()` branch names a command, an env key or a call; the colocated tests enforce it,
  because the gate's scanner reads `fix:` properties only. A refusal names the env keys actually set,
  never their values.
- A remote driver takes an injected `fetch`; `purge-fastly.test.ts`'s loopback proof is the only
  place the default runs.
- **The purge URL in a `fix:` goes through `renderFixShellArg`** — it is operator data, and
  `renderFixLiteral`'s double quotes leave `$(…)` live.

- **`./adapter` (`adapter.ts`) is the `cacheTiers` and `purge` ports for an adapter author**:
  `CacheTier`, `PurgeDriver`, their shapes and the two errors a tier or driver raises. No installer:
  `@ultimat3/cli` READS `runtime.ts`'s `cacheTiers` (each replaces the rung of its own name;
  `cache.tiers` still names the ladder) and `purge`. Type moves: none — every name stays on `.` too.

## Files

| File | Owns |
|---|---|
| `tags.ts` | `tag` factory, wire form, match semantics, `tagKeys`, declared-tag registry |
| `graph.ts` | tag → dependents (cache keys, ISR routes, CDN paths, live queries) |
| `tiers.ts` | `CacheTier`, `TierLabel`, `assertTtl`, read-through stack |
| `fence.ts` | the invalidation fence a fill (here or in `query`) checks before it publishes |
| `tier-leading.ts` | which fence each in-flight load holds, and whether a reader may join it |
| `tier-fence.ts` | `TierFence`/`FenceVerdict`, and how a fill samples and asks a shared tier's fence |
| `redis-fence.ts` | the leased generation keys a bust writes and a fill watches |
| `redis-buckets.ts` | the tag → keys sorted-set layout: join + prune + lease, paged read, `UNLINK`, sweep |
| `set-options.ts` | how two callers' `CacheSetOptions` combine, and the `null`-load TTL |
| `tier-failures.ts` | `bestEffort()`, and the `cache.tier_failure` event for each refusal it absorbs |
| `memo.ts` | request memo over the ALS ctx (WeakMap, no lifecycle) |
| `lru.ts` | byte-budgeted LRU (linked list + map + tag index) |
| `value-codec.ts` | the one value encoding every tier stores and decodes |
| `redis.ts` | the shared tier over core's `redisClient()` (`@ultimat3/core/redis`, never `Bun.redis`), build-namespaced keys, the value budget, the write/bust order |
| `redis-deadline.ts` | `withinDeadline`: a per-command deadline (150 ms, `commandTimeoutMs`), a 5 s park of the value path after one is missed, and the bust view that skips the park on its own 1,000 ms |
| `cdn.ts` | `Cache-Control`/`Surrogate-Key` emission, `surrogateKeys`, the purge key list, the `PurgeDriver` seam |
| `purge-http.ts` | the HTTP half both remote drivers share: one POST, batching, key guard, and core's retryable table re-exported |
| `purge-fastly.ts` | `fastlyPurgeDriver`: surrogate-key batch purge, `purge_all` |
| `purge-cloudflare.ts` | `cloudflarePurgeDriver`: cache-tag purge, `purge_everything` |
| `purge-env.ts` | `selectPurgeDriver`: which edge an environment purges, and nothing else |
| `invalidate.ts` | the single entry point, `InvalidationReport`, and the `cache.invalidate` event |
| `cache-events-fixture.ts` | tests only: `recordCacheEvents()`, the `cache.*` events a test caused |
| `semantic.ts` | embedding cache for LLM calls |

## Commands

```
bun test ./packages/cache/
bun run --filter @ultimat3/cache typecheck
```

Why each rule above is shaped the way it is: [`docs/history/cache.md`](../../docs/history/cache.md).
