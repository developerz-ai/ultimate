# @ultimat3/query

Owns the `query` primitive: reads, live reads, cursors, the incremental matcher. Tier 3.

## Boundary

- May import: `core`, `schema` (t0), `cache`, `i18n`, `time` (t1), `entity`, `policy`, `http` (t2).
- Never import: `action`, `jobs`, `realtime` (sideways), or any tier 4-5 package.
- Reads only. A query that writes is an `action` in the wrong file.

## Files

| File | Job |
|---|---|
| `query.ts` | the primitive: `query()`, `describeQuery`, `queryHash`; the package's front door for the read path |
| `read.ts` | **the one read path** (`runQuery`, `sourceFor`) + the private declaration store `sql` lives in |
| `facade.ts` | the fluent surface — binds each projection to the query, re-implements none |
| `http.ts` | route projection (`GET /_x/query/<kebab>`, `enforcedBy: 'handler'`) |
| `mcp-tool.ts` | MCP read descriptor, same `sourceFor` |
| `client.ts` | typed read client (browser-safe: no server imports) |
| `naming.ts` | export name → `/_x/query/<kebab>` + snake_case tool name. Pure string math |
| `registry.ts` | export-name registration, `describeQueries()`, and the `registerPrimitiveRegistrar('query', …)` announcement |
| `live.ts` | `LiveQuery` descriptor + cursor arithmetic |
| `matcher.ts` | change event → minimal patch, or `X_MATCHER_UNSUPPORTED` |
| `pagination.ts` | `paginate()` over core's cursor codec — no offset, ever |
| `sql.ts` | `explain()` / `describeSql()` |
| `cache.ts` | the read path: the request memo, and the fill through the tier |
| `read-cache.ts` | the tier itself — the `ReadCache` seam, the bounded `MemoryReadCache` default, `invalidateQueryTags` |
| `source.ts` | `SqlSource` contract + `from()` in-memory reference |
| `shape.ts` | shared read vocabulary (filters, ordering, seek keys) |
| `policy-gate.ts` | **the only** file that touches `@ultimat3/policy` |
| `deprecation.ts` | `Deprecation` + the RFC 9745/8594 render + the `deprecated_calls_total` counter — TWINNED in `@ultimat3/action` |
| `deprecation.ts` | `Deprecation` + the RFC 9745/8594 render + the `deprecated_calls_total` counter — twinned with `@ultimat3/action`'s |

## Invariants

- Every surface goes through `sourceFor`: parse input, evaluate policy, build the source.
  Adding a second read path is the one unforgivable change here.
- The declaration never leaves `read.ts`. `defOf`/`stashDef`/`hasDef` are internal and must
  never be re-exported from `src/index.ts` — that omission is the enforcement.
- A query has no `.def`. Inside the package read it with `defOf(target)`; outside, read the
  lifted `.input`/`.policy`/`.cache`/`.mcp`/`.isLive` or `describe()`.
- App code reaches a projection through the query (`liveFeed.tool()`), never through `.def`
  and never by importing the projection function. `facade.ts` is where a new method is bound;
  the projection itself keeps living in its own file.
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim**, so a query file imports
  one package. Never wrap, spread or re-declare it: `t` delegates to `schemaProvider()` on every
  access, and a copy would freeze the provider at import time. `index.test.ts` asserts identity.
- **`LiveQuery` describes the read *and* runs it.** `execute()` is the source the shape, the reads
  and `sqlText` were taken from — one build of one `(query, input)`. A caller that wanted rows and
  called `sourceFor` itself was a second build: twice the parse, twice the `sql()`, and a matcher
  describing a source the rows never came from. `@ultimat3/realtime`'s shared window is the one
  consumer, and it reads through `execute()`. It never memoises — a subscriber joining an existing
  subscription must see the rows as they are now, not the window someone else opened.
- `isLive` is the declared boolean, `live()` is the subscription. Never name one after the other.
  `QueryDescriptor.live` keeps its name — `@ultimat3/manifest` and `@ultimat3/admin` read it.
- `mcp` is opt-in (`expose: true`), exactly as it is for an action: rows reach an agent only when
  the author said so. `isExposed` here delegates to `isMcpExposed` in `@ultimat3/core` — the one
  predicate every reader in the framework asks — rather than spelling `=== true` a second time.
- `client.ts` stays free of server imports — it is bundled into the browser. `@ultimat3/action`
  is the same tier, so its naming is ported here, never imported.
- **`queryClient` is the map-wide read client and the mirror of `rpc`; both spellings run
  `queryClientMethodFor`.** `queryClient<Api['queries']>({ baseUrl })` is how a surface that must
  not import a feature reaches every registered read — `site/` in an app, whose one edge into
  `app/` is a boundary violation, so `.client()` (which needs the query object) is unreachable
  there. The map-wide client re-deriving a path from the property name would be the second URL
  derivation this package spent a release removing; it proxies to the per-query method instead.
- **`toQueryRoute` is the other half of `client()`, and the two derive the same URL from the same
  `naming.ts`.** The client shipped fetching `/_x/query/<kebab>` while nothing built a route for
  it, so every typed read compiled and 404'd; a projection whose only consumer is a URL string is
  the failure this pairing exists to prevent. Named for the primitive rather than `toRoute`,
  because a host mounts it beside `@ultimat3/action`'s — the same reason the tool projection here
  is `toQueryTool`.
- **The route coerces, `runQuery` validates, and only the first belongs to the wire.** A search
  string is characters, so the boundary decodes it with `@ultimat3/schema`'s `coerceQuery` — the
  one HTTP-boundary decoder, which never invents data and hands on what it cannot convert.
  Validating there as well (`request.query(schema)`) would be the second parser: the same read
  would answer `X_BODY_INVALID` where every other surface answers `X_INPUT_INVALID` and prints
  its schema. For the same reason `meta.input` stays **absent** — the pipeline's body stage
  validates it against a body, and a GET has none, so declaring it fails every read on nothing.
- **`rateLimit:` is declarable on a read, and `toQueryRoute` sets the NAME and the NUMBERS.**
  `QueryDef` had neither until 2026-08, so every `GET /_x/query/*` fell through `bucketFor` to
  `default` — 120 burst, 2/s per actor — and one authenticated caller could hold 120 cross-tenant
  aggregates in flight and then 2/s indefinitely, from a single account, with no declaration able
  to say otherwise. The conversion is `toBucket` from **`@ultimat3/http`**, never a copy here:
  http owns `Bucket` and the maths, `@ultimat3/action` is the same tier as this package, and a
  copy in either is a second answer for the other. The field is lifted onto the facade so
  `toQueryRoute` reads it without `defOf`, exactly as `cache` and `mcp` are.
- **`deprecated:` is a compat WINDOW; versioning is two deployments behind one ingress.** Headers
  are rendered ONCE at projection, so an unparseable date is `X_QUERY_DEPRECATION_INVALID` at
  mount and not on the first read. `deprecation.ts` is a TWIN of `@ultimat3/action`'s — both are
  tier 3, so neither may import the other, and the shared home is `@ultimat3/http` if it grows
  one. The same compromise `naming.ts` is ported under; keep the two files identical in behaviour.
- **The span wraps the whole read, not `source.execute()`.** Parse, policy and `sql()`'s own
  construction were outside every span, so a read whose cost was in building the source reported
  milliseconds under a parent that reported seconds — a gap with no name. `readRows` holds the
  span and `readRowsIn` is the body; attributes are bounded (surface, actor KIND, `live`,
  `cached`, `fresh`) plus the row count, and never the input or an actor id — a read is keyed per
  tenant and per cursor, so either would be unbounded. `telemetry.test.ts` asserts the extent
  structurally through `currentSpan()`, because the test clock is frozen. `sourceFor` still has no
  span of its own: adding one would double-span every read that goes through `readRows`.
- **`policyCapability` is a display label and `policyPermissions` is what a report matches on.**
  A composite renders as `or(feed:read, org:administer)`, which equals no permission string, so
  `x policy list` matching on `capability` reported every non-trivially-guarded read's permissions
  as unenforced. `QueryDescriptor.permissions` is the flattened list, published beside
  `capability` and never instead of it.
- **`client.ts` injects `traceparent`**, before the caller's own headers so an explicit one wins,
  and sends nothing when the span context is incomplete — `00-<trace>--01` is a header every
  collector drops. The twin of `@ultimat3/action`'s, ported for the same tier reason.
- **A read is `no-store`, and its policy is `enforcedBy: 'handler'`.** The URL names no actor
  while the answer is scoped to one, so `public` would hand one reader's rows to the next caller
  of that URL; and `runQuery` is the read's one evaluation, deciding from the parsed input, so an
  authz stage deciding first would be a second authz system holding raw strings — and would
  demand an `authorize` hook to decide at all. `http.test.ts` drives both over the real pipeline
  with no hook wired and counts the evaluations: exactly one.
- `registry.ts` announces `registerQueries` in core's registrar table at import. That is how
  `defineApi({ queries })` in `@ultimat3/action` registers a read without importing this package
  sideways. Never remove the announcement: `defineApi` would then throw `X_REGISTRAR_MISSING`.
- Policy runs per subscriber for live queries. Never cache a decision across actors.
- The matcher patches from `QueryShape`, never from SQL text.
- `paginate` has no `offset` parameter and must never grow one, and it is reachable **only** as
  `query.page(input, { first, after })` — a page is the read's own answer, not an imported helper.
  `src/index.ts` exports `Page` and `PaginateArgs` and not the function: re-exporting it would be
  a second way to ask for the thing `.page()` already does.
- **A cursor is a position, not a row.** `isAfterKey` in `source.ts` is the one definition of
  "after this position": `Builder.seek()` compiles it to SQL and `paginate()` applies it when a
  source cannot push the seek down. The fallback used to find the cursor's row by id and slice
  after it — which restarts the listing from the top the moment that row is deleted, the exact
  failure keyset pagination exists to prevent. Never reintroduce a row lookup here.
- The seek predicate is spelled out per key (`(a < $1) or (a = $2 and id > $3)`), the way
  `@ultimat3/entity`'s `seekSql` spells it. A row-value comparison cannot express a mixed
  `createdAt desc, id asc` ordering, and the id-tiebreak-only fallback it replaced returned rows
  the ordering was already past — with `execute()` disagreeing with the SQL it printed.
- **NULL has one meaning, and `isNull` is it.** `null` and a column the row omits are the same
  absence, in the SQL and in memory alike. `=`/`!=`/`in` read NULL as a **value** — `is null`,
  `is not null`, `is distinct from`, `in (…) or is null`, the pair `@ultimat3/entity`'s
  `predicateSql` emits; `>`/`>=`/`<`/`<=` read it as **unknown**, matching nothing on either side,
  which is why they need no special emission; `order by` reads it as the **largest value**, spelled
  `asc nulls last` / `desc nulls first` rather than inherited from the driver. `= $n` with a NULL
  argument is never true in Postgres, so `where({ deletedAt: null })` matched every row in memory
  and none in the database, and `"col" > $n` blanked page two at the first NULL. Never emit a bound
  parameter where NULL is the value being tested, and never let `compareValues` sort a NULL as the
  string `"null"` again — `compareRows`, `isAfterKey` and the matcher's insertion position all
  read it, so one string compare moves rows on three surfaces. `in` takes a list or nothing: an
  empty one is `1 = 0`, and so is an operand that is not an array at all — `matchesFilter` answers
  no rows for it, and `"col" in $n` is a syntax error the driver reports instead of that answer.
- **The id is the tiebreak that makes the order total.** A row without one is
  `X_QUERY_NOT_PAGEABLE` at `seekKeyOf` **and** at the matcher's `idOf`, never `String(undefined)`:
  `"undefined"` is a position every row matches, signed and opaque, so page two would be page one
  forever and one row's patch would land on another's index.
- **`totalOrder` is the order a read is served in, and all three readers use it.** The declared
  keys then `id asc`, unless the ordering already names `id` — `Builder.servedOrder()` compiles it,
  the in-memory sort applies it, and `positionFor` places a row by it. The matcher comparing
  `shape.orderBy` alone appended a tied row after its whole tie group, which is a position no
  re-read returns and a cursor that skips every tie it was pushed past. `SeekKey` is the same list
  decomposed — `key` for the declared part, `id` for the tiebreak — so never add `id` to
  `QueryShape.orderBy` to get it: `seekKeyOf` would then sign the id twice. An unordered query
  appends, because SQL promises no position there to get wrong.
- **A live read asks for that order explicitly, and `sourceFor` is where it asks.** `total()` is
  the `SqlSource` method for "the same read, served in `totalOrder`" — no cursor, no window — and
  `buildSource` calls it when `surface === 'live'`, for nothing else, and only when the source
  implements it. A live window served by the declared keys alone puts a tied row wherever the
  database returned it, while `positionFor` places the patch by id and the resume re-read seeks by
  id: the client then renders an order no re-read answers. Never reach for `seek(null, limit)`
  instead — a live query need not carry a limit, and inventing one is a window nobody asked for.
- The cursor codec is `@ultimat3/core`'s (`encodeCursor` / `decodeCursor` / `configureCursorSigning`).
  This package supplies only the scope a cursor is bound to — `queryHash(name, input)` — and never
  signs, encodes or parses one itself. An unverified or foreign cursor is `X_CURSOR_INVALID`, thrown
  by core's `CursorInvalidError`, which `errors.ts` re-exports so the name stays on this surface.
- **The request memo holds the read, not the rows.** `readOnce` publishes the in-flight promise
  before its first await, so two reads of one key in one request are one execution and one tier
  round trip whether the second follows the first or races it. A value-keyed map could not express
  that, and could not tell a memoized `undefined` from a miss either. A rejection is evicted — a
  failed read is not the request's answer, and the next read retries. `requestMemo(ctx)` is
  therefore `Map<string, Promise<unknown>>`; never put a settled value in it.
- **Every read is memoized; only a `cache:` read goes through the tier.** `readThrough` is
  `readOnce` plus `fill` and nothing else, and `readRows` picks between them on `def.cache` alone.
  The memo is not what `cache:` buys — a list that renders one uncached lookup per row pays for
  every row otherwise, which is the N+1 this collapses. Never gate `readOnce` on `def.cache`
  again, and never let a second key function grow beside `cacheKeyFor`.
- **`invalidateQueryTags` drops two things, and both are required.** `invalidateTags` reaches the
  graph `@ultimat3/cache` owns — every registered `CacheTier`, ISR route, CDN path and live query;
  the read tier is *not* in that registry (it is this package's seam, swapped per deployment
  through `setReadCache`), so the same tags are passed to `tier.invalidateTags?.()` in the same
  hop. Dropping only the first is the defect this pairing replaced: the fan-out reported success
  and the pre-write list was served until the process ended. An entry is therefore written with
  the read's `cache.tags` — `readThrough`'s last argument — or it is reachable by key alone and
  can only expire.
- **The read tier is bounded and a `cache:` read always expires.** `MemoryReadCache` is
  `@ultimat3/cache`'s `LruCache` (byte budget, tag index, one definition of tag matching — never
  a second one derived here), and `def.cache.ttlMs ?? DEFAULT_READ_CACHE_TTL_MS` is what
  `readRows` passes. A query keyed on `{ orgId, cursor }` has as many distinct keys as the
  deployment has tenants; unbounded and immortal, that is one permanent entry per page per org.
  A `null` expiry is "the caller named none", never "never" — the tier applies its own default.
- **The memo holds an execution, never a decision.** `readRows` runs `buildSource` — parse, guard,
  `sql()` — *before* it reaches the memo, on every call, and `.as()` reads in a child context whose
  identity is its own memo. So a memoized answer is still one this actor was allowed to ask for,
  and no impersonated read can join a read made as someone else. Moving the memo above
  `buildSource` would turn it into an authz bypass.
- **`fresh: true` skips the memo on the way in and publishes to it on the way out.** A memo is a
  cache whose lifetime is the request, so `fresh` refuses to *join* an entry — `readFresh` is
  `readOnce` minus the join, both sharing one `publish` — but it must still *become* one. Returning
  the rows early instead left the pre-write entry standing, so "the one way to read past a write
  made earlier in the same request" ended at the single call that asked for it and the next plain
  read of that key got the stale answer back. Invalidation still drops tier entries only.
- **A read can declare a `rateLimit:`, and `toQueryRoute` enforces it — added 2026-08.** `QueryDef`
  had no such field and the route set no bucket, so **every** `GET /_x/query/*` fell through
  `bucketFor` to `default` — 120 burst, 2/s per actor. One authenticated caller could hold 120
  cross-tenant aggregates in flight and then 2/s indefinitely, from a single account, and the
  declaration that would have throttled it did not exist in the type. `meta.rateLimit` (the name)
  **and** `meta.rateLimitBucket` (the numbers) are both set, because a name nothing registers is
  the same silent fall-through. The conversion is `toBucket` from **`@ultimat3/http`** — http owns
  `Bucket` and the maths, and `@ultimat3/action` is this tier, so a copy here would be a second
  answer for the write half. Never derive a bucket locally.
- **`deprecated:` is a compat WINDOW; versioning is not here and will not be.** `Deprecation`
  (RFC 9745, `@<unix seconds>`) and `Sunset` (RFC 8594, IMF-fixdate) on every answer including the
  failures, a `rel="successor-version"` link built through `derivePath` — the same derivation
  `client()` uses, never a second one — the dates on the descriptor, and
  `deprecated_calls_total{primitive,name}`, which is the only way to answer "is anyone still
  reading it?" before deleting the read. Rendered ONCE at projection, so a date that cannot become
  a header is `X_QUERY_DEPRECATION_INVALID` at mount rather than on the first read. Running two
  versions side by side is two deployments behind one ingress (axiom 7). `deprecation.ts` is a
  twin of `@ultimat3/action`'s: both are tier 3, the shared home is `@ultimat3/http` if it ever
  grows one, and this is the same compromise `naming.ts` is ported under.
- **The span wraps the whole read, not `source.execute()`.** Wrapping the execution alone left the
  input parse, the policy evaluation and `sql()`'s own construction outside every span, so a read
  whose cost was in building the source reported milliseconds under a parent reporting seconds —
  a gap with no name, which reads as framework overhead. Attributes are bounded: surface, actor
  KIND, `live`, `cached`, `fresh`, and the row count. Never the input and never an actor id — a
  read is keyed per tenant and per cursor, so either would be unbounded. `telemetry.test.ts`
  asserts the EXTENT structurally, reading `currentSpan()` from inside the policy predicate and
  `sql:`, because the test clock is frozen and a timing assertion would hang on it.
- **`policyCapability` is a display label; `policyPermissions` is what a report matches on.** A
  composite renders as `or(feed:read, org:administer)`, which equals no permission string, so
  `x policy list` matching on `capability` reported every non-trivially-guarded read's permissions
  as *unenforced*. `QueryDescriptor.permissions` is the flattened list from `@ultimat3/policy`,
  published beside `capability` and never instead of it.
- **`queryClient`/`client()` inject `traceparent`.** Core's `traceparent()` had no caller in the
  repo, so a service-to-service read began a fresh root trace on the far side. Set BEFORE the
  caller's own headers so an explicit one wins; an incomplete span context (`spanId: ''`) sends
  nothing rather than a header every collector drops. In a browser there is no ambient context, so
  a cross-origin read gains no CORS preflight it did not already have. The helper is twinned in
  `@ultimat3/action`'s client for the same tier reason `naming.ts` is.
- Authz goes through `enforce(surface, policy, { input, actor, ctx })` from
  `@ultimat3/policy`; a live denial keeps its 4403 close code on `QueryDeniedError.denial`.
  `policy-gate.ts` is the only file that imports the policy package.

## Commands

```
bun test packages/query
bun run typecheck
```
