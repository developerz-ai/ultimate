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
| `naming.ts` | export name → `/_x/query/<kebab>`. Pure string math. **Paths only** — no tool name |
| `registry.ts` | export-name registration, `describeQueries()`, and the `registerPrimitiveRegistrar('query', …)` announcement |
| `live.ts` | `LiveQuery` descriptor + cursor arithmetic |
| `matcher.ts` | change event → minimal patch, or `X_MATCHER_UNSUPPORTED` |
| `pagination.ts` | `paginate()` over core's cursor codec — no offset, ever |
| `cursor-value.ts` | what a sort value becomes inside a cursor, and what it becomes again |
| `input-shape.ts` | what a read's `input:` may be, given that its route is a query STRING |
| `sql.ts` | `explain()` / `describeSql()` |
| `cache.ts` | the read path: the request memo, and the fill through `@ultimat3/cache`'s registered tiers |
| `source.ts` | `SqlSource` contract + `from()` in-memory reference |
| `shape.ts` | shared read vocabulary (filters, ordering, seek keys) |
| `policy-gate.ts` | **the only** file that touches `@ultimat3/policy` |
| `deprecation.ts` | `Deprecation` + the RFC 9745/8594 render + the `deprecated_calls_total` counter — TWINNED with `@ultimat3/action`'s |

## Invariants

- Every surface goes through `sourceFor`: parse input, evaluate policy, build the source.
  Adding a second read path is the one unforgivable change here.
- **An explicit `ctx` is INSTALLED, never merely passed** (`As of 2026-08`). `asActor` used to hand
  `options.ctx` to `run(ctx)` and enter no `runWithContext` unless an `actor` was also given, so
  `guard()` decided about that actor while everything reading the AMBIENT context — above all
  `@ultimat3/entity`'s tenant guard, which derives from `tryUseContext()` and not from the ctx it is
  handed — saw a different identity, or none. A read was authorised as one caller and scoped to
  nobody. Absent a `ctx` it reinstalls the ambient one, which is a no-op on every path that already
  worked. The twin fix is `@ultimat3/action`'s `invoke`, and `read-context.test.ts` is written as an
  equality between the three spellings of one caller — ambient, `options.actor`, `options.ctx` —
  because three independent expectations are exactly what let this ship.
- **Skipping a read's policy costs a WRITTEN REASON, never a boolean** (`As of 2026-08`).
  `SourceOptions.enforce?: boolean` is gone; it is `unenforced?: string`, and a blank one is
  refused before the source is built. The bar is `@ultimat3/entity`'s `cross-tenant.ts`: a boolean
  argument "reads exactly like forgetting the tenant", and a forgotten policy reads the same way —
  so the reason IS the mechanism and every skipped policy is one `grep` away with its justification
  attached. It is deliberately NOT capability-gated the way `crossTenant` is: `explain` runs from
  the CLI with no actor to check a scope against, and gating it would close the one surface it
  exists for. **`ToLiveOptions.enforce` stays a boolean**, because it is that one use with exactly
  one reason — `toLiveQuery` translates it into the reason string spelled once as
  `SHARED_WINDOW_REASON`, so a sync node and this file cannot disagree about why the shared window
  has no subject. Two shipped callers, both reading no rows for a subscriber: `sql.ts` and that
  window.
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
- **A read has ONE tool name, and it is the export name verbatim** (`As of 2026-08`). `toQueryTool`
  snake_cased it (`liveFeed` → `live_feed`) while `@ultimat3/mcp` serves the read under
  `queryName(target)` and answers `tools/call` for nothing else — so anything that read the name off
  the descriptor rather than off `tools/list` called a tool the server had never heard of, and the
  scope map in `defineAppMcp` is keyed on the verbatim name too. `toToolName` is **deleted**, not
  merely unused: an exported derivation is a second way to spell one tool. Two pins, both in this
  package because this is where the rule can be broken — `mcp-tool.test.ts` asserts
  `toQueryTool(q).name === queryName(q)` (the presence), and `index.test.ts` asserts the barrel
  exports no key matching `/tool_?name/i` (the absence, which nothing else catches: the only other
  guard is `packages/mcp/src/cross-surface.test.ts`, tier 4 and unimportable from here).
  `naming.ts` derives PATHS only.
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
- **A `RowProvider` may be a list, a sync function or an async one** (`As of 2026-08-19`).
  `execute()` awaits whatever the function returns, so all three were always accepted at runtime —
  the type declared only `() => Promise<readonly TRow[]>`, which refused a repo method already
  holding its page and every in-memory fixture. `source.test.ts` pins all three.
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
- **A sort value carries its own TYPE through the cursor** (`cursor-value.ts`, `As of 2026-08`).
  The codec is JSON, so `paginate()` putting raw column values in meant a `Date` went out and an
  ISO STRING came back: `isAfterKey` compared `"1769904000000"` against `"2026-02-01T…"` through
  `compareValues`' string branch and **page two came back empty** — and a `bigint` sort key was a
  bare `TypeError` out of `JSON.stringify`, with no code and no fix. `@ultimat3/entity`'s
  `cursor.ts` solves the same problem by reading the column's declared kind; a `query` has no
  column kinds — `QueryShape.orderBy` is a name and a direction — so the value is TAGGED instead
  (`{ $x: 'date' | 'bigint', v }`) and `reviveSortKey` is total without knowing which read minted
  it. `undefined` encodes as `null`, because SQL has one absence and dropping the key would shift
  every later one a position left. Anything JSON cannot carry and this cannot tag — an object, an
  array, `NaN`, `±Infinity` — is `X_CURSOR_VALUE_UNSUPPORTED` where the cursor is MINTED, never
  `X_CURSOR_INVALID`: the mistake is the read's own `orderBy` and no retry repairs it.
- **`compareValues` orders numbers and bigints in ONE order, because Postgres does.** The numeric
  fast path was `typeof === 'number'` on both sides, so an `int8` fell to
  `String(left) < String(right)`: `compareValues(9n, 10n)` answered `1` and a sort came out
  `["10", "100", "9"]`. `bigint` is the physical type of every `<p>_minor` column and
  `@ultimat3/entity`'s `count-by.ts` lists it as groupable, so the in-memory source, the live
  matcher and the seek fallback ALL disagreed with the database on any bigint-ordered read.
  `shape-order.test.ts` is the pin, and `As of 2026-08` it reads a REAL kind list: `COLUMN_KINDS`
  is the runtime array `@ultimat3/entity`'s `ColumnKind` derives from, and entity is tier 2 so a
  test here may import it as a VALUE — which is what a `satisfies Record<ColumnKind, …>` could not
  be, since `tsconfig.json` excludes `*.test.ts` and `tsc` never reads one. It had a spelled-out
  list and `const COUNT = 9` beside a union of THIRTEEN members: `9 === 9`, a test that could not
  fail, with `numeric`, `date`, `bytea` and `array` carrying no case at all.
- **`numeric` and the TEXT form of `bigint` are a DECLARED gap here, and closing it is a
  declaration change** (`shape-order.test.ts`, `As of 2026-08`). `@ultimat3/entity`'s `bigint()`
  and `decimal()` hand digits back as strings, so `["9","10","100","2"]` sorts to
  `["10","100","2","9"]` here and `["2","9","10","100"]` in the database — and a cursor's revived
  `bigint` against a stored decimal string (`compareValues(9n, "10")` → `1`) cuts page two where
  the database does not. It is **not** fixed by calling `@ultimat3/core`'s `compareDecimalText`
  from `compareValues`: that function answers only for a caller holding the column's declared kind
  (`@ultimat3/entity`'s `compareByKind`), and `QueryShape.orderBy` is a name and a direction —
  nothing here can tell a `numeric` holding `"10"` from a `text` holding `"10"`, which Postgres
  orders lexically, so a comparator guessing would trade one disagreement with the SQL it prints
  for another. The fix is an `OrderKey` that carries a kind, from `sourceFor` down. Until then the
  `DECLARED_GAP` block asserts both halves, so the gap cannot be silently re-discovered or
  silently widened.
- **A read's `input:` must survive a query STRING, and `query()` refuses one that cannot**
  (`input-shape.ts`, `X_QUERY_INPUT_UNENCODABLE`, `As of 2026-08`). `client.ts` encoded a nested
  member as `JSON.stringify(item)` and skipped a `null`, while `coerceQuery` has no inverse for
  either — `case 'object'` hands the raw value back untouched — so the typed client type-checked
  calls the server's own route then rejected, which is the exact failure `client.ts`'s header
  claims to prevent. **The declaration is the fix, not the encoder**: teaching `coerceQuery` to
  `JSON.parse` a string would make the ONE HTTP-boundary decoder invent structure for every
  surface that shares it — forms and route params included — against that file's own rule that it
  never invents data, and a `null` sentinel would be a reserved string colliding with the value
  `"null"`. Refused: a structural member (`object`, `record`, `money`, or an array/union of one),
  a REQUIRED nullable member, and a top-level input that is not an object. A schema
  `tryIntrospect` cannot read is left alone, or `configureSchemaProvider` would be unusable.
- **A refill is owed by a FULL window and by nothing else** (`matcher.ts`, `As of 2026-08`).
  `removeAt` pushed one whenever `shape.limit !== null`, with no reference to how many rows the
  window holds: three rows under `limit: 50`, delete one, and the patch list was
  `[{remove, position:1}, {refill, from:49}]` — a position no two-row result set has. It is not a
  harmless extra: `@ultimat3/realtime`'s `matcher-bridge` folds any refill into
  `BridgeResult.refill`, and `live-fanout` then sends **no patch frame at all** that round, marking
  every subscriber desynced instead — so on a quiet feed the deleted row stays rendered until some
  other change to the same query id arrives, and on a busy one it is a full DB re-read plus one
  snapshot per subscriber per delete. A window under `limit` has no unknown tail: the source served
  fewer rows than it was allowed to, so what the client holds IS the result set. `held >=
  shape.limit` is the gate, and it is `wasFull` one branch away, already written.
- **A move OUT of a full window is a `refill`, never an `add`** (`matcher.ts`). `insert()` places a
  moved row among the `limit - 1` rows the client still holds, so its position can never reach
  `shape.limit` and the `position >= shape.limit` bail is unreachable on that path — the row was
  re-inserted INSIDE the window. Proven with `limit: 3`, window `[a:1, b:2, c:3]` and a server also
  holding `d:4, e:5`: moving `a` to `99` rendered `[b, c, a:99]` where the true window is
  `[b, c, d]`. Only the server can answer the tail, and whether the moved row is still in the
  window is its answer too.
- **A page is bounded whether or not the caller bounded it.** `paginate` asserts `first` is a whole
  number of rows in `1…MAX_PAGE_SIZE` (10,000) before anything else — `args.first + 1` bound
  whatever an action's input or a route parameter carried, so one request could ask for five
  million rows. The constant is a TWIN of `@ultimat3/entity`'s, under the same tier compromise
  `naming.ts` and `deprecation.ts` are ported under.
- **`tagKeys` is `@ultimat3/cache`'s, not this package's — moved 2026-08.** `src/tags.ts` here and
  `@ultimat3/action`'s were byte-identical, and both packages are tier 3, so neither can import the
  other and a copy in either is a second answer for the other — the same move `toBucket` made into
  `@ultimat3/http`. `tagKey` went with it: `serializeTag` under a second name, zero call sites.
  `@ultimat3/render` exports a *different* function under the same name (declaration order kept);
  never import that one here.
- **A fingerprint is an identity, so two different inputs may not share one — and it is
  `@ultimat3/core`'s, not this package's, `As of 2026-08`.** `canonicalJson` + `fingerprint` moved
  down to tier 0 because `@ultimat3/action` and `@ultimat3/realtime` needed the identical function
  and all three are tier 3, so a copy in any of them was a second answer for the other two — and
  the copies had already diverged. This one had **no `Date` branch**: `Object.keys(date)` is `[]`,
  so the object branch rendered every date as `{}` and `queryHash({from: 2020…, to: 2020…})`
  equalled `queryHash({from: 2026…, to: 2026…})`. Reachable on the ordinary HTTP path — `http.ts`
  decodes a query string through `coerceQuery`, which turns a `t.date` member into a real `Date`,
  and `input-shape.ts` permits `date` members — so ONE read-cache entry answered every date window
  of that read for the TTL, page two of range A was served from range B's cursor scope, and every
  date window shared one live query id. The hash form tags a `Date`, a `Map` and a `Set`
  (`Date(<epoch>)`, `Map(…)`, `Set(…)`) beside the bare `NaN` / `±Infinity` / `-0` tokens it
  already emitted, all for the reason a bare token exists: `'null'` collided with JSON `null` and
  `String(-0)` is `"0"`. `stable.ts` keeps `isJsonObject`/`columnOf` and nothing else. Ordinary
  inputs are byte-identical, so the durable-key cost is confined to reads whose input carries a
  `Date`, a `Map` or a `Set`: those cursors answer `X_CURSOR_INVALID` once, and their cache entries
  are cold once. `query-hash.test.ts` is the pin, at `queryHash` and at `cacheKeyFor`.
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
  `readOnce` plus the fill through the ladder, and `readRows` picks between them on `def.cache`
  alone. The memo is not what `cache:` buys — a list that renders one uncached lookup per row pays for
  every row otherwise, which is the N+1 this collapses. Never gate `readOnce` on `def.cache`
  again, and never let a second key function grow beside `cacheKeyFor`.
- **A cache key carries the read's AUTHORITY, and `cache.scope` is what widens it** (`As of
  2026-08`). `cacheKeyFor` held the name, the input and the tags — nothing about who asked — while
  `sql(input, ctx)` is handed the context and `@ultimat3/entity` derives every tenant predicate
  from `ctx.actor.orgId`. The tier is process-wide, so the first actor to ask filled the entry and
  the next was served it: a query filtering on `ctx.actor.orgId` returned `org-a`'s row to an
  `org-b` actor. `readAuthority(actor, scope)` is the ONE producer of the component and
  `cacheKeyFor`'s fourth argument is **required and positional**, because an optional one is one a
  call site forgets and a forgotten one is that read. `scope` defaults to `'actor'` and the default
  is the mechanism: declaring nothing gets the narrowest key. `'tenant'` and `'global'` are written
  statements about the rows — the `unenforced:` shape one field over — and `'tenant'` with no
  `orgId` narrows to the actor rather than widening to everyone, because nothing here can prove two
  org-less callers share a tenant. **All THREE spellings of "no org" take that branch**, `As of
  2026-08`: `undefined`, `''` and `null`. The last one missed it, so every org-less caller shared
  the single key `["org",null]` and was served the rows of whoever asked first — core's `Actor`
  declares `orgId?: string`, but `@ultimat3/policy`'s `PolicyActorFields` widens it to
  `string | null | undefined` and its `testActor` mints `null`, which is why `orgless()` widens its
  parameter rather than trusting the declared type. The authority is JSON, never a joined string,
  for the reason
  `@ultimat3/entity`'s `scopeKey` gives: an actor id is app data and may carry the separator.
- **`cache.ttlMs` is judged at `query()`, not on the first read.** Every `CacheTier` refuses a
  lease that is not positive and finite (`assertTtl`), and the read tier's one catch absorbs
  `X_CACHE_TOO_LARGE` only — so `ttlMs: Infinity` turned a typo into a permanently failing business
  read whose cause named a cache key. `X_QUERY_CACHE_TTL_INVALID`, on the line that wrote it. It
  restates `assertTtl`'s bar as a refusal and never as a second resolution.
- **`fingerprint` is SHA-256/16, never a 32-bit hash** (`@ultimat3/core`, `As of 2026-08`). It is a
  SHARING key over client-chosen input — which read-cache entry two callers are served from, which
  scope a cursor is bound to — so FNV-1a/32's 4×10⁹ values are a collision found offline in
  seconds. `@ultimat3/realtime`'s `stableDigest` was the same primitive at the same width and is
  gone with the rest of that copy: a `qid` is `queryHash(name, input)` now, imported across the
  declared `realtime -> query` edge, so the two hashes cannot drift apart while `planResume`
  compares one against a cursor's.
- **A fill is FENCED, and the fence is `@ultimat3/cache`'s** (`As of 2026-08`). `run()` answers with
  rows it read in the past: a mutator committing in between busts a key not yet in the tier, so the
  drop is a no-op reporting `errors: []`, and the fill then publishes the pre-write rows for the
  full TTL — invisible to every reader until it expires. The sample happens inside
  `createCacheStack.read`, immediately before `load()`, and is re-asked per rung before each write.
  This package no longer samples one of its own — that copy went with the private store. The caller
  is answered either way: those rows ARE its answer, and only publishing is refused.
  `cache-fence.test.ts` is the proof the property survived the move.
- **This package owns NO cache store, and that is the enforcement** (`As of 2026-08`). A `cache:`
  read fills `createCacheStack(registeredTiers(), { clock })` — the tiers `@ultimat3/cache` has
  registered — and there is nothing here to install, swap or wire. There used to be: a private
  `ReadCache` seam (`setReadCache`/`getReadCache`/`MemoryReadCache`) that `invalidateTags` could not
  reach, because that fan-out walks the registered `CacheTier`s and nothing else. The gap was closed
  by `packages/cli/src/dev-cache.ts` installing the read cache **over** an object it also
  registered — a correctness property held by a wiring line in a CLI file, one edit from being
  wrong, and carrying a second `ReadCache` implementation (`tierReadCache`) that dated entries with
  `Date.now()`. And `invalidateQueryTags` was a second fan-out path, which
  `packages/cache/CLAUDE.md` forbids in as many words. One registry, one fan-out, no seam. **Never
  reintroduce a store here**, and never call `tier.invalidateTags()` from this package.
- **A tier refusal degrades the cache, never the read** — and so does every other tier concern.
  `bestEffort`, the fence, the single flight, the promotion and the TTL are all `createCacheStack`'s,
  which is what "no store here" buys: a refused `get` reads as a miss, a refused `set` as "that tier
  is unchanged", and the failure lands in `recentTierFailures()` under the name of the tier that
  actually refused rather than under a `'query-read'` label for a rung in no registry. Never wrap a
  tier call here in a private try/catch, and never sample a second fence.
- **The read path reads NO clock, and that is what makes it drivable.** It hands the stack a
  RELATIVE `ttlMs`; the tier's own clock turns it into an absolute expiry. `fill` used to compute
  `nowMs(clock) + ttlMs` and `tierReadCache` used to compute `expiresAt - Date.now()`, so the two
  `ReadCache` implementations disagreed about "now" and no frozen clock could drive the
  Redis-backed one. `read-tier.test.ts` pins it: a `createLruTier({ clock, jitterFraction: 0 })` and
  a `ctx.clock` frozen at the same instant produce an expiry a test can assert exactly.
- **A `cache:` read always expires, and the bound is the tier's.**
  `def.cache.ttlMs ?? DEFAULT_READ_CACHE_TTL_MS` (60s) is what `readRows` passes — a query keyed on
  `{ orgId, cursor }` has as many distinct keys as the deployment has tenants, and unbounded that is
  one permanent entry per page per org. `null` is "the caller named none", never "never": it reaches
  the stack as an OMITTED `ttlMs`, which is how a tier is asked for its own default. Every tier
  refuses a non-positive lease outright, so there is no immortal entry to spell.
- **A process that registered no tier reads uncached.** `createCacheStack([])` loads, answers and
  writes nowhere — correct, and slower. That is the trade for deleting the module-default store: a
  script, a worker boot or a test that wants caching calls `registerTier`, the same call every
  other cached surface in the framework already uses.
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
