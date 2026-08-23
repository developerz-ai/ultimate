# @ultimat3/cache — agent notes

Tier 1. Tagged caching + THE invalidation graph.

## Boundary

- May import: `@ultimat3/core`, `@ultimat3/schema`. Nothing else, ever.
- Must NOT know about entities, HTTP, jobs, render. `tagsFor()` takes structural args.
- Consumers: `entity` (write hooks), `action` (`cache.invalidates`), `render` (ISR), `cli`.

## Rules

- `invalidateTags()` in `invalidate.ts` is the ONLY fan-out path. Never call
  `tier.invalidateTags()` from outside it. It is also the only place the log is written:
  `recentInvalidations()` is a read of what that one path already reported, never a second
  recorder a caller has to remember to call.
- **The fan-out clears FARTHEST tier first, and reports in read order.** Near-to-far leaves the far
  tier holding the old value after the near ones are clear, and a read racing the bust promotes it
  straight back up — `report.errors` empty, LRU stale again before the call returns. `CacheStack.drop`
  reverses for the same reason. The report is re-sorted into `TIER_ORDER` because it is what the
  `/_x` panel renders. Pinned in `invalidation-race.test.ts`.
- **A fill is fenced: sample before `load()`, ask before the write** (`fence.ts`). A read-through
  fill publishes rows `load()` read in the past, so a bust landing in between finds a key that is
  not there yet, reports `errors: []`, and is overwritten milliseconds later — invisible for the
  whole TTL. `sampleFence({ key, tags })` → `fence.isValid()` is the whole API, `markInvalidated`
  is its write half (called by `fanOut`, `CacheStack.write` and `CacheStack.drop`; a caller only
  needs it for a clearing path of its own). It is **exported** because a store outside this package
  with the same hole must not grow a second mechanism. `cover()` widens a fence
  RETROACTIVELY — needed only where joiners contribute tags the leader never sampled, which is
  `createCacheStack.read` and nothing else. A fence never fails a read: it declines to publish.
  This is the one process-global here with **no `isolate*()` seam and no reset**, and that is
  structural: a fence samples the current generation, which is always at or above what the ring has
  forgotten, so another file's marks cannot invalidate a fence sampled after them.
- One graph. `graph.ts` exports functions over module state and **no constructor** — do not
  add one, do not add a second registry anywhere else.
- Tag order is `TIER_ORDER`, never registration order. `sortTiers()` enforces it.
- **The rung NAMES are `@ultimat3/core`'s (`CACHE_TIERS`); the ladder is this package's.**
  `TierName` is an alias of core's `CacheTierName` and `TIER_ORDER` IS `CACHE_TIERS` — the same
  array object, which `tier-vocabulary.test.ts` asserts by identity. Tier 0 owns the spelling
  because `app.config.ts`'s `cache.tiers` names the same rungs and core is the only place a tier-0
  declaration and this package can both see. It was spelled twice until 2026-08-22 (issue #293):
  config accepted `memo | lru | shared | isr | cdn`, so `cache: { tiers: ['isr'] }` typechecked and
  selected nothing, and `sortTiers` would have placed either unknown name at `-1` — AHEAD of the
  request memo. Adding a rung is an edit to `packages/core/src/cache-vocabulary.ts` plus a factory
  here; `scripts/render-modes.ts` refuses a second declaration of the set anywhere in `packages/*/src`.
  **`isr` is not and never was a tier** — it is a `RenderMode`; the `'isr'` in `invalidate.ts` is an
  ISR ROUTE queued for regeneration (`DependentKind = 'isr-route'`), which is a different subject.
- **`bestEffort()` is public, and it is the only sanctioned way to swallow a cache refusal.** A
  store outside this package that wraps its own `try/catch` degrades invisibly, and a second
  failure log nobody reads is what this bounded one exists to prevent. Its label is `TierLabel` —
  `TierName` plus `'query-read'` — closed, and deliberately NOT a widening of `TierName`: a name
  missing from `TIER_ORDER` sorts to `-1`, ahead of the request memo. A label is a log facet; a
  `TierName` is a position on the ladder.
- **A refusal is rendered with `renderThrowable()`, never `error.message`** — the five sites that
  absorb one (`bestEffort`'s log entry, `fanOut`'s tier, ISR and broadcast catch blocks, and
  `purgePost`'s transport catch). A tier, a revalidator, a broadcast and the `fetch` a purge driver
  is given are all app-supplied, so the value they reject with is too:
  `instanceof` runs a `Proxy`'s `getPrototypeOf` trap and `String()` runs `Symbol.toPrimitive`, so
  building the log line used to raise INSTEAD of absorbing the refusal — on the business write that
  triggered the bust, which is the one caller both contracts promise to protect. The code field
  keeps its own total probe (`ultimateCode` in `tier-failures.ts`) rather than core's `stringField`:
  a driver error's `code` is a SQLSTATE and must never be reported as an `X_*` one. Consequence to
  know: a recorded `message` carries the throwable's NAME (`Error: nats is down`, `"just a string"`),
  which is what `renderThrowable` renders and what the tests here now pin.
- Tier failures go into `report.errors`. A cache tier may never fail a business read or write.
  `createCacheStack` routes every `get`/`set`/`del` through `bestEffort()` for that reason — a
  refusal becomes "that tier did not answer" and lands in `recentTierFailures()`, the read side's
  equivalent of `report.errors`. `load()` is the one unguarded call: it is the business read, so
  swallowing it would return `undefined` as if it were the value. `LruCache.set` still throws
  `X_CACHE_TOO_LARGE` to a direct caller — the stack is the layer that degrades, not the tier.
- **`serializeTags` is the wire form; `tagKeys` is the IDENTITY form, and the difference is the
  point.** `tagKeys` sorts and de-duplicates, because its readers build a descriptor field and a
  cache KEY out of it — `@ultimat3/query`'s `cacheKeyFor` above all, where a key that varied with
  declaration order fills two entries for one read and an action's `invalidates` drops whichever
  one it happens to name. It lives here, in the package that owns `serializeTag`, because
  `@ultimat3/action` and `@ultimat3/query` held byte-identical copies of it and are the same
  tier — so neither can import the other and a copy in either is a second answer for the other.
  The same move `toBucket` made into `@ultimat3/http`. **Known collision, not fixed here:**
  `@ultimat3/render` exports its own `tagKeys` (`render/src/route.ts`) with different behaviour —
  `serializeTags` over an optional list, declaration order preserved, pinned by its own
  `dsl.test.ts`. Two behaviours under one name in two packages an app imports together; the
  consolidation is render's to make, and this doc block is where a reader finds out.
- **Two exports here have no production caller and both are KEPT — re-verified 2026-08.**
  `invalidateWireTags` is the wire-form door (`x cache bust` is planned and exits
  `X_NOT_IMPLEMENTED`); its sibling `receiveInvalidationBroadcast` takes the same wire form and DOES
  have one (`packages/cli/src/dev-cache.ts`), so deleting the outbound door would leave one of a
  matched pair. `recentTierFailures()` is the read-ladder half of `report.errors` and the `/_x`
  cache panel is still **not** its reader — `packages/cli/src/dev-dashboard.ts` imports
  `recentInvalidations` and nothing else — so it is read only by tests, `@ultimat3/query`'s
  `cache-degraded.test.ts` included. Neither is dead in the sense that matters: a bounded log with
  no panel is a log an operator can still reach, and removing it is removing the only evidence a
  degraded tier leaves. Wire the panel or leave them; do not delete one and keep the other.
- `tag.x` typing comes from the `CacheTagRegistry` augmentation, generated by `x manifest`.
- **`declareTags()` is additive and process-wide, so a test undoes it with `isolateDeclaredTags()`,
  never with `resetDeclaredTags()`.** The empty set is what switches `assertKnownTags` off, so one
  suite declaring a fixture entity makes every later file in the same `bun test` process validate
  against a registry it never saw — the cross-file X_CACHE_TAG_UNKNOWN `packages/query`'s read-cache
  suite used to fail with. A reset would drop a neighbour's declarations instead of only your own;
  `@ultimat3/testing`'s leak guard fails the file that leaks either the tag set or the tier registry.
- **Every process-global registry here has that same seam, and a test file uses it: `isolateGraph()`
  (`graph.ts`), `isolateTiers()` (`invalidate.ts`), `isolateTierFailures()` (`tier-failures.ts`).**
  A per-test `resetGraph()` / `resetTierFailures()` stays where an empty registry is the subject —
  pair it with the module-scope isolate and an `afterAll(restore)`. The leak guard reports
  *additions* only, so a file that DELETES a neighbour's registrations is invisible to it and lands
  as a failure in an innocent file: a reset in a test file is the one leak nothing catches for you.
  The last two exist in the owning module because a test file cannot reach the state — the
  revalidator has no reader and neither log has a writer, so `resetTiers()` is unrecoverable from
  outside. `isolateTierFailures` is deliberately off `index.ts`, same as `resetTierFailures`:
  nothing outside this package can clear that log except through `resetTiers()`, which
  `isolateTiers()` already covers.
- Clocks are injected (`LruOptions.clock`, `CacheStackOptions.clock`); read them through `nowMs()`.
- **`ttlMs` is positive and finite, and `assertTtl` (in `tiers.ts`) is the one place that says so.**
  Every tier calls it before it writes — **the request memo included, `As of 2026-08`**: it was the
  last rung skipping it, so `ttlMs: 0` was stored by the memo and refused by the other three, and
  `createCacheStack` swallows both refusals through `bestEffort`, so the read HIT out of the one
  tier that should never have taken it. It validates a lease it then discards (it holds nothing past
  the request), and only a lease the caller SUPPLIED — there is no memo default to fall back on.
  So does `createMemorySemanticCache.remember` — which was
  the one writer skipping it, so `ttlMs: 0` stored an entry already past its expiry and every lookup
  missed with a completion bill as the only evidence. Its scope is `'semantic'` (`TtlScope`), with
  `jitterFraction: 0`: spreading a lease is a herd defence for a SHARED store, and that one is per
  process. `0` used to be "never expires" here and `EX 1` in `redis.ts`,
  so one stack answered two ways; the rule lives beside `CacheSetOptions` precisely so a new tier
  cannot invent a third reading. `X_CACHE_TTL_INVALID`, never a resolution.
- **`assertTtl` also SPREADS the lease it validated** — validate, then jitter, one choke point. A
  rolling restart warms 40,000 keys in 30s on one lease and they all expire in one 30s window; the
  spread is what makes that a ramp. `rng` is injected (`LruOptions.rng`, `RedisTierOptions.rng`) —
  **never `Math.random()` at a call site**, or nothing downstream is deterministic. `rng: () => 0`
  is the full lease and is what a test asserting an exact `expiresAt` passes; `jitterFraction: 0`
  turns it off. Outside `[0, 1)` is `X_CACHE_JITTER_INVALID`, refused rather than clamped.
- **`createCacheStack` is the production read path, and `@ultimat3/query` is its caller** (`As of
  2026-08`). It had none for two releases — read-down/promote-up, the fence, single flight and the
  negative TTL were the package's whole design, reachable only from its own tests, while the one
  cached read path in the framework kept a private store beside the registry. `readThrough` calls
  `createCacheStack(registeredTiers(), { clock })` now, so deleting or bypassing this function
  removes the only thing that makes an action's `cache.invalidates` reach a `cache:` query.
- **`createCacheStack` shares one in-flight `load()` per key** (`single-flight.ts`, mirroring
  `realtime`'s `entry.reading`). The share ends as the load settles — a REJECTED load must clear
  its entry too, or one origin failure becomes a permanent cached rejection. One `SingleFlight` per
  stack, never a module-level map: two stacks are two ladders.
  **The mechanism is `@ultimat3/core`'s since 2026-08-23** — this file's shape verbatim, one tier
  down, because four packages each grew a deduper and only copies can drift. `single-flight.ts`
  stays as the door, so `createSingleFlight`, `SingleFlight` and `FlightJoin` are still exported
  from `@ultimat3/cache` unchanged; `single-flight.test.ts` pins the delegation by IDENTITY, since
  behavioural parity is exactly what let the four copies drift in the first place.
- **A wedged `load()` no longer holds its key for ever** (`As of 2026-08-23`). It used to: every
  later reader of that key joined a promise nothing would resolve, so a cache stopped damping an
  outage and became one. `createCacheStack` passes `deadlineMs: DEFAULT_LOAD_DEADLINE_MS` (30s;
  `loadDeadlineMs` overrides it, `schedule` injects the timer). The number is `@ultimat3/http`'s
  `requestTimeoutMs` default written out — a `load()` still running at 30s has no reader left to
  serve, because the request waiting on it was abandoned at the same instant — and it is a literal
  because cache is tier 1 and http is tier 2. **Eviction frees the KEY and nothing else**: `load()`
  is the app's function and this stack holds no signal to abort it, so the wedged load runs on and
  its own readers still get its answer. The cost is one duplicate fill, which the ladder's
  last-write-wins `set` already tolerates. Not an `app.config.ts` key on purpose — the ceiling
  belongs to whoever wrote the `load()`, and `bun run scripts/config-readers.ts` refuses a leaf
  key nothing reads.
- **A joiner shares the leader's WRITE, so it contributes to it** (`FlightJoin`, merged by
  `mergeSetOptions` in `set-options.ts`). Keyed on `key` alone and read late, the entry used to land
  carrying only the leader's tags: the joiner's tag reached nothing, so the invalidation it declared
  never fired. Tags union, TTLs take the SHORTEST — an entry held longer than a caller asked for is
  stale to that caller. `work` reads the merge through `shared()` **after** the load, or it sees
  only what the leader brought — and **once more after the fill**, because the flight stays open
  for the whole ladder and a joiner merging a tag mid-fill hit the identical hole one rung later.
  The second read re-fills EVERY tier rather than the rungs still to come: re-reading per tier
  would land the near tier — the one every later read hits first — with the FEWEST tags, so an
  invalidation would clear the far rungs and leave the near one serving. `tagsAddedSince` in
  `set-options.ts` is what makes the second pass conditional; `tiers.test.ts`'s
  `a single-flight joiner that arrives during the FILL` is what notices.
- **`negativeTtlMs` is the stack's decision, not a tier's.** Only `createCacheStack` sees what
  `load()` answered, so the `null`/`undefined` branch lives in `ttlOptionsFor` there and reaches a
  tier as an ordinary `ttlMs`.
- **A promotion carries the entry's remaining life, not `options.ttlMs`** — `createCacheStack.read`
  writes the closer tiers with `hit.expiresAt - now`, and drops a hit that fails `isExpired`. A
  fresh full lease per read is a hot key that never goes stale enough to refetch. `isExpired` was
  exported and unit-tested and called by nothing; the stack is its one caller.
- **Every tier's `get` therefore reports `expiresAt`, or the promotion above has nothing to carry.**
  `redis.ts` reads it from `PTTL`, issued alongside the `GET` so Bun pipelines the pair — the server
  owns the clock, so it survives skew between the node that wrote and the node that reads, and no
  stored payload shape changes under a running deployment. `-1`/`-2` are sentinels, not durations:
  they mean no expiry, never one millisecond ago.
- **`t:` is the TAG's bucket and `e:` is the ENTITY index, and one key may not be both** (`As of
  2026-08`). Three tiers implement `tagMatches` and the shared one was the outlier: a row-tagged
  write joined the collection bucket, and a row bust read that bucket back, so
  `invalidateTags([tag('post', '1')])` returned every post-tagged key in the store and deleted them
  — one row write emptying the shared tier for that entity, while the LRU one rung closer kept
  exactly the row that changed. `writeBucketsFor` joins the declared tag plus `e:{entity}`;
  `bustBucketsFor` reads the index for a COLLECTION bust and `t:{entity}:<id>` + `t:{entity}` for a
  ROW one. A collection bust also reads `t:{entity}` — a strict subset of the index today, kept so a
  `buildId: null` deployment upgrading into this layout does not MISS its old two-role buckets;
  over-reading a subset costs a round trip, under-reading is a stale read. It IS a wire-layout
  change: a cold shared tier, which the default build-id namespace already pays per deploy.
  Pinned by `tier-parity.test.ts` (all three rungs, one test each) and `redis.live.test.ts` (the
  same two busts against a real server, asserting the LRU's and Redis's survivors are EQUAL).
  **A row bust does not read the index and still SREMs from it** (`sweepBucketsFor`) — reading it
  over-reaches, removing a member cannot: only what the bust deleted leaves. Without that, a
  deleted value key kept its membership in `e:{entity}` for ever while every write renewed that
  index's lease — the unbounded `SMEMBERS` the lease was added to prevent, rebuilt out of corpses.
- **`CacheTier.set` REJECTS, never throws synchronously.** `createLruTier` and `createMemoTier` are
  `async` for that reason alone — `LruCache.set` stays a sync API, but a `CacheTier` is one
  interface with three implementations and `tier.set(...).catch(...)` has to mean the same thing on
  every rung. `bestEffort` absorbs both shapes; a direct caller does not.
- **`redis.ts`'s script deletes NOTHING — it reads.** The members of a tag set are value keys in
  slots this node may not own, so `DEL`ing them from Lua is a cross-slot access that fails on Redis
  Cluster and Dragonfly strict mode — into `report.errors`, so the bust reads as partial and stale
  rows serve until TTL. The script returns the members; the tier deletes them client-side, one key
  per `DEL`, which is slot-local under every topology.
- **The bucket is not dropped in the script either, and the tier `SREM`s only what it deleted.**
  Dropping it atomically with the `SMEMBERS` made one failure permanent: a refused `DEL` left its
  member with no bucket to be found in, so the retry the error asks for answered `keys: []` and
  those rows served until their own TTL. `Promise.allSettled` is what makes "what actually died"
  knowable. A member a concurrent write added between the two halves keeps its membership instead
  of being orphaned by a bust that never deleted it.
- **A `set` joins its buckets BEFORE it writes the value, and re-checks membership after.** Value
  first left a window where a bust's `SMEMBERS` saw an empty bucket and the value survived its own
  invalidation for the full TTL. Joining first moves the window somewhere observable: membership
  gone by the time the `SET` lands means this write was busted in the air, and the value goes with
  it — a row nothing can reach by tag is one no later bust can clear. Only a literal `0` from
  `SISMEMBER` counts as gone (`saysAbsent`); a reply the tier cannot read is not evidence, and
  deleting on one is a cache that never caches.
- **`GET` and `PTTL` are two commands and the key can die between them.** `PTTL: -2` for a value
  the `GET` returned is a MISS, not an entry with no expiry — reported as a hit it is promoted into
  the LRU on the CALLER's ttl, so a row one millisecond from death gets a fresh five minutes one
  tier closer.
- **That fixed half of it; `KEYS` itself was the other half.** Tag keys carry a `{entity}` hash tag
  (`<ns>:t:{post}`, `<ns>:t:{post}:7`) and `invalidateTags` issues **one script call per tag**, so
  every key a call is handed hashes to one slot. A single `EVAL` carrying two tags' buckets is
  `CROSSSLOT`-rejected before the script runs. The invariant a test pins: no command's `KEYS` ever
  spans two hash tags.
- **Every tag set carries a lease, and the lease only grows.** `TAG_MEMBER_SCRIPT` does the `SADD`
  and the `EXPIRE` in one call, one key in `KEYS`. A set with no TTL is unbounded memory and a
  multi-million-member `SMEMBERS` on the next publish. `EXPIRE … GT` is NOT enough on its own — it
  treats a key with no TTL as infinite, so a fresh bucket would stay immortal, which is the bug.
  `SREM`-on-`del` is deliberately not done: `del(key)` does not know the key's tags without a read,
  and a bounded bucket lease already bounds the growth.
- **A fake cannot run Lua, so it must never pretend to.** Both fakes used to mirror
  `INVALIDATE_SCRIPT` and `TAG_MEMBER_SCRIPT` in TypeScript and match on the exported constant's
  identity — so gutting either script to `return 1` / `return {}` left all 517 tests in `cache` +
  `query` green, with the entire shared-tier invalidation path proving nothing. The fakes are
  recorders now: the wire traffic is what a unit test asserts, and a test whose path READS a
  script's reply states it with `answerEval(script, reply)` — an unprogrammed `EVAL` throws rather
  than answering `[]`, which is exactly what the gutted script returns. **Every claim about what a
  script DOES belongs in `redis.live.test.ts`** (`describe.skipIf(!TEST_REDIS_URL)`), which is the
  only place either one is executed.
- **The Redis namespace carries the build id by default** (`namespaceFor`, `appVersion()`). Two
  builds sharing one Redis otherwise read each other's payloads through a `JSON.parse` that does
  not validate. `buildId: null` opts out. The layout is wire-visible: changing it is a cold cache.
- **Cross-instance invalidation is a SEAM here, never a transport.** `registerInvalidationBroadcast`
  (outbound) and `receiveInvalidationBroadcast` (inbound) mirror `registerRevalidator`; `cli` owns
  the bus. The inbound half cannot re-emit and that is structural — `emit` is on `fanOut`'s private
  options and only `receiveInvalidationBroadcast` passes `false`. An inbound tag this process never
  declared is dropped into `report.errors`, never thrown: a throw kills the subscriber loop and
  silently ends cross-instance invalidation for the whole process.
- **A `cdn` tier holding `noopPurgeDriver()` reports `skipped`, never keys.** That is the default
  state of every deployment with no CDN credentials (`selectPurgeDriver`), and the noop ECHOES the
  keys it is handed — so the tier reported every tag as CLEARED and `busted` listed keys nothing
  had purged, with `errors: []`. `isNoopPurgeDriver` lives in `cdn.ts`, beside the `name: 'noop'`
  it tests for, because `createCdnTier` cannot import `purge-env.ts` without a cycle.
- **`report.cdn` is what depends on the tags; `report.tiers` is what cleared.** The `cdn` tier
  purges `cdn-path` dependents itself, alongside the tags, so `busted` is built from `tiers` +
  `isr` + `liveQueries` and never from `cdn` — folding in a list nothing purged is exactly the
  partial-bust-reading-as-clean this log exists to prevent.
- A purge driver is selected by `selectPurgeDriver` from the environment, never from an
  `app.config.ts` field — nothing loads that file's contents at runtime. Two CDN credentials at
  once is refused, not resolved, and half a pair is refused too: "no CDN" is the one wrong answer,
  because a deployment then ships believing it purges. The token never reaches a printed string.
- A purge key is a wire tag unchanged. Every CDN splits a key list on whitespace and a comma, so
  `assertPurgeableKeys` refuses either **before** the request — a split key is purged successfully
  and clears nothing, which is the one CDN failure no later read can catch.
- `retryable` on `X_CACHE_PURGE_FAILED` is derived, never guessed: 408/409/425/429 and 5xx, plus
  any request that never got a status. The table is **`@ultimat3/core`'s** `isRetryableStatus`
  (`retryable-status.ts`), `As of 2026-08-23`, and is edited there — `purge-http.ts` re-exports it
  so both drivers still read "what a failure means" off the shared HTTP half, the same door
  `@ultimat3/auth`'s `tokens.ts` gives `timingSafeEqual`. It was a private `RETRYABLE_STATUSES`
  here that was byte-identical to `packages/mail/src/driver-resend.ts`'s, in two packages that
  cannot import each other, so one copy was always going to be edited alone.
  **It reaches `error.retry` too, `As of 2026-08-23`** — `CachePurgeFailedError` passes
  `retry: input.retryable ? 'retryable' : 'terminal'`. Without it the constructor fell back to
  `retryFor('X_CACHE_PURGE_FAILED')`, this package registers no retry class, and the default is
  `terminal`: a 429 serialised as `{ "retry": "terminal", "meta": { "retryable": true } }` — one
  error answering the retry question two ways, with `errorRetry()` (the one question a retry loop
  asks) giving the wrong one. Per-INSTANCE, never `registerErrorRetry`: one code covers a 401 that
  will never land and a 429 that will.
- `X_CACHE_PURGE_FAILED` means a provider refused. A batch size that is not a positive integer is
  this package miswired, so `chunked()` raises `X_CACHE_DRIVER_UNAVAILABLE` instead — and it raises
  it *before* the loop, because a `0` spins forever and a `NaN` yields one empty batch, a purge that
  reports success having cleared nothing.
- Every `fixFor()` branch names a command, an env key or a call. The gate's `fix:` scanner reads
  `fix:` properties, not the `return` literals in those functions, so the colocated
  "every failure fix names a command" tests are the only thing enforcing it.
- A refusal's diagnostic reads the environment, never a hardcoded pair: `meta.configured` and the
  cause name the keys that are actually set. Names only — all four keys can hold a credential.
- A remote driver takes an injected `fetch` so a test never unseals the network; the loopback
  proof in `purge-fastly.test.ts` is the only place the default one runs.

## Files

| File | Owns |
|---|---|
| `tags.ts` | `tag` factory, wire form, match semantics, `tagKeys`, declared-tag registry |
| `graph.ts` | tag → dependents (cache keys, ISR routes, CDN paths, live queries) |
| `tiers.ts` | `CacheTier`, `TIER_ORDER`, `TierLabel`, `assertTtl`, read-through stack |
| `fence.ts` | the invalidation fence a fill (here or in `query`) checks before it publishes |
| `set-options.ts` | how two callers' `CacheSetOptions` combine, and the `null`-load TTL |
| `tier-failures.ts` | `bestEffort()`, and the bounded log of refusals it absorbs |
| `memo.ts` | request memo over the ALS ctx (WeakMap, no lifecycle) |
| `lru.ts` | byte-budgeted LRU (linked list + map + tag index) |
| `redis.ts` | `Bun.redis` tier, build-namespaced keys, hash-tagged buckets, one script call per tag |
| `single-flight.ts` | the door onto `@ultimat3/core`'s `createSingleFlight` — one in-flight `load()` per key, shared by every concurrent miss. No implementation of its own since 2026-08-23 |
| `cdn.ts` | `Cache-Control`/`Surrogate-Key` emission, the `PurgeDriver` seam, `noopPurgeDriver` |
| `purge-http.ts` | the HTTP half both remote drivers share: one POST, batching, key guard, and core's retryable table re-exported |
| `purge-fastly.ts` | `fastlyPurgeDriver`: surrogate-key batch purge, `purge_all` |
| `purge-cloudflare.ts` | `cloudflarePurgeDriver`: cache-tag purge, `purge_everything` |
| `purge-env.ts` | `selectPurgeDriver`: which edge an environment purges, and nothing else |
| `invalidate.ts` | the single entry point, `InvalidationReport`, and the bounded log `/_x` renders |
| `semantic.ts` | embedding cache for LLM calls |

## Commands

```
bun test packages/cache
bun run --filter @ultimat3/cache typecheck
```
