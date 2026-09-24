# @ultimat3/query

Owns the `query` primitive: reads, live reads, cursors, the incremental matcher. Tier 3.

## Boundary

- May import: `core`, `schema` (t0), `cache`, `i18n`, `time` (t1), `entity`, `policy`, `http` (t2).
- Never import: `action`, `jobs`, `realtime` (sideways), or any tier 4-5 package.
- Reads only. A query that writes is an `action` in the wrong file.

## Files

| File | Job |
|---|---|
| `query.ts` | the primitive: `query()`, `describeQuery`, `queryHash`; the front door for the read path |
| `read.ts` | **the one read path** (`runQuery`, `sourceFor`) + the private declaration store `sql` lives in |
| `facade.ts` | the fluent surface — binds each projection to the query, re-implements none |
| `http.ts` | route projection (`GET /_x/query/<kebab>`, `enforcedBy: 'handler'`) |
| `mcp-tool.ts` | MCP read descriptor, same `sourceFor` |
| `client.ts` | typed read client (browser-safe); dispatches through `@ultimat3/core`'s `clientTransport`, never `fetch` |
| `record-answer.ts` | a read's HTTP answer: bare rows, or the record envelope when `rows:` is an entity's branded row schema |
| — | flight control is **`@ultimat3/core`**'s `client-flight.ts` + `client-wire.ts`, re-exported. No local copy |
| `naming.ts` | export name → `/_x/query/<kebab>` — `derivePath` IS core's `queryPath`. **Paths only** |
| `registry.ts` | export-name registration, `describeQueries()`, the `registerPrimitiveRegistrar('query', …)` announcement |
| `live.ts` | `LiveQuery` descriptor + cursor arithmetic |
| `subscribes.ts` | the relations a live read declares, and the two assertions that keep them true |
| `matcher.ts` | change event → minimal patch, `refill` when the window cannot place the row, or `X_MATCHER_UNSUPPORTED` |
| `pagination.ts` | `paginate()` over core's cursor codec — no offset, ever |
| `cursor-value.ts` | what a sort value becomes inside a cursor, and back |
| `input-shape.ts` | what a read's `input:` may be, given that its route is a query STRING |
| `sql.ts` | `explain()` / `describeSql()` |
| `cache.ts` | the read path: the request memo, and the fill through `@ultimat3/cache`'s registered tiers |
| `search.ts` | `search()` — the query FACTORY over an entity's `.searchable()` columns |
| `source.ts` | `SqlSource` contract + `from()` in-memory reference |
| `shape.ts` | shared read vocabulary (filters, ordering, seek keys) |
| `policy-gate.ts` | **the only** file that touches `@ultimat3/policy` |
| `deprecation.ts` | `Deprecation` + RFC 9745/8594 render + `deprecated_calls_total` — TWINNED with `@ultimat3/action`'s |

## Invariants — the read path

- Every surface goes through `sourceFor`: parse input, evaluate policy, build the source. A second
  read path is the one unforgivable change here.
- **An explicit `ctx` is INSTALLED, never merely passed** — the ambient context (which
  `@ultimat3/entity`'s tenant guard reads) must be the identity `guard()` decided about.
  `read-context.test.ts` asserts ambient, `options.actor` and `options.ctx` are one caller.
- **Skipping a read's policy costs a WRITTEN REASON** (`unenforced?: string`; blank refused).
  `ToLiveOptions.enforce` stays a boolean, translated into `SHARED_WINDOW_REASON`.
- The declaration never leaves `read.ts`. `defOf`/`stashDef`/`hasDef` are never re-exported from
  `src/index.ts` — that omission is the enforcement. A query has no `.def`; outside the package read
  `.input`/`.policy`/`.cache`/`.mcp`/`.isLive` or `describe()`. A projection is reached through the
  query (`liveFeed.tool()`); new methods are bound in `facade.ts`.
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim** (`index.test.ts` asserts identity).
- **`LiveQuery` describes the read *and* runs it** (`execute()`, never memoised).
  `@ultimat3/realtime`'s shared window reads through it.
- `isLive` is the declared boolean, `live()` the subscription. `QueryDescriptor.live` keeps its name
  (`manifest` and `admin` read it).
- `mcp` is opt-in; `isExposed` delegates to core's `isMcpExposed`.
- **A read has ONE tool name, the export name verbatim.** `toToolName` is deleted.
  `mcp-tool.test.ts` asserts `toQueryTool(q).name === queryName(q)`; `index.test.ts` asserts the
  barrel exports nothing matching `/tool_?name/i`.
- **`queryClient` is the map-wide read client (mirror of `rpc`)**; both spellings run
  `queryClientMethodFor`. **`toQueryRoute` and `client()` derive the same URL from `naming.ts`.**
- **The route coerces (`coerceQuery`), `runQuery` validates.** No `request.query(schema)` and no
  `meta.input` on the route.
- **`rateLimit:` is declarable; `toQueryRoute` sets both `meta.rateLimit` and
  `meta.rateLimitBucket`**, via `@ultimat3/http`'s `toBucket` — never a local copy.
- **`deprecated:` is a compat WINDOW**: `Deprecation` / `Sunset` / `rel="successor-version"` on every
  answer, rendered ONCE at projection (`X_QUERY_DEPRECATION_INVALID` at mount). Versioning is two
  deployments behind one ingress.
- **The span wraps the whole read** (`readRows` holds it, `readRowsIn` is the body); bounded
  attributes only — never the input or an actor id. `telemetry.test.ts` asserts the extent through
  `currentSpan()`.
- **`policyCapability` is a display label; `policyPermissions` (`QueryDescriptor.permissions`) is what
  a report matches on.**
- **`client.ts` injects `traceparent`** before the caller's headers; an incomplete span context sends
  nothing.
- **A read is `no-store`, and its policy is `enforcedBy: 'handler'`** — `runQuery` is the one
  evaluation (`http.test.ts` counts exactly one).
- **`meta.auth` comes from `@ultimat3/policy`'s `admitsAnonymous`** (a walk of the tree, via
  `policy-gate.ts`), never the root combinator.
- `registry.ts` announces `registerQueries` in core's registrar table at import; `defineApi` in
  `@ultimat3/action` depends on it (`X_REGISTRAR_MISSING` otherwise).
- Authz goes through `enforce(surface, policy, { input, actor, ctx })`; a live denial keeps its 4403
  close code on `QueryDeniedError.denial`. Policy runs per subscriber for live queries — never cache a
  decision across actors.

## Invariants — the client

- **Flight control is `@ultimat3/core`'s, re-exported** (`createClientFlight`,
  `DEFAULT_CLIENT_RETRY`, `isTransientFailure`, `isSuperseded`, the types) — the same objects
  `@ultimat3/action` exports. Fix the pipeline in `packages/core/src/client-flight.ts`. No new error
  code, curve, fence or retry loop here; `bun run flight-copies` says so.
- **`isTransientFailure` INVERTS `retryDecision`'s unclassified default** — a caller's own
  `AbortError` is terminal. Must survive.
- **`ClientFlight` is a TYPE inside `client.ts`, never a value.**
- **Every read dispatches through core's `clientTransport`; `client.ts` calls no `fetch`.** The
  transport owns `Accept`, trace/budget headers, the principal fence, the error decode and the record
  envelope; the flight handed to it dedups concurrent identical reads. `bun run browser-transport`
  is the guard.
- **`@ultimat3/query/client` is the read client without the barrel** — `client.ts` and `naming.ts`
  import core from `@ultimat3/core/page`, the page keys live in the leaf `page-keys.ts`, and
  `client.ts` never imports `page-controls.ts` or `stable.ts`. `client-bundle.test.ts` fails on any
  titles table in the graph or past 11 kB; `client-subpath.test.ts` pins the specifier. Byte figures
  (`As of 2026-09-22`, browser, minified): barrel `queryClient` 24,114 B; `./client` 10,210 B.
- **The record envelope is derived from `rows:`** — `answersRecords(rows)` (`hasEntityRows`,
  `@ultimat3/entity`), decided once at projection for `http.ts` and `openapi.ts`, sent on every
  answer. No `rows:` is byte-identical on the wire.
- **The `sideEffects` array is load-bearing**: `errors.ts` and `registry.ts` run at import. Never `false`.

## Invariants — numbers, search, live declarations

- **Every numeric option is refused when not FINITE** (`finiteOption()`: the read cache's `ttlMs`,
  `search()`'s `page.max`, `page.default`, `termMax`). `finite-bounds` pins this package at zero.
- **`search()` is a FACTORY over `query()`**: it owns the input schema (`q` + a bounded `limit`),
  refuses a blank term and calls `.search(term)` on the chain the app hands it (structural
  `SearchChain`). No `PRIMITIVE_FACTORIES` row (it returns a query from the query package). **It serves
  ONE page**: `windowOf.execute` refuses only when rows would be CUT; `onePage.seek` narrows with
  `Builder.limit()`, never `Builder.seek()`, so the chain's own ranking survives; no `total()`.
  `search.test.ts`'s fixture must stay NOT id-ascending.
- **`subscribes:` is DECLARED (nothing can derive it) and CROSS-CHECKED**: `toLiveQuery` asserts
  `shape.entity` is among the declared names at first subscribe (`X_QUERY_SUBSCRIBES_DRIFT`) —
  membership, never equality. An empty list, or one on a non-live read, is refused at `query()`
  (`X_QUERY_SUBSCRIBES_INVALID`).
- **A read's `input:` must survive a query STRING** (`input-shape.ts`, `X_QUERY_INPUT_UNENCODABLE`):
  refused are structural members (`object`, `record`, `money`, or an array/union of one), a REQUIRED
  nullable member, and a non-object top level. An un-introspectable schema is left alone.

## Invariants — ordering, cursors, the matcher

- The matcher patches from `QueryShape`, never from SQL text.
- `paginate` has no `offset` and never grows one; it is reachable only as
  `query.page(input, { first, after })`. **A page is bounded**: `first` is 1…`MAX_PAGE_SIZE`
  (10,000, a twin of `@ultimat3/entity`'s).
- **A `RowProvider` may be a list, a sync function or an async one** (`source.test.ts`).
- **A cursor is a position, not a row**: `isAfterKey` (`source.ts`) is the one definition of "after";
  never reintroduce a row lookup. The seek predicate is spelled out per key
  (`(a < $1) or (a = $2 and id > $3)`), never a row-value comparison.
- **NULL has one meaning, `isNull`**: `=`/`!=`/`in` treat NULL as a value (`is null`,
  `is distinct from`, `in (…) or is null`); range operators treat it as unknown; `order by` treats it
  as the largest value (`asc nulls last` / `desc nulls first`). Never bind a parameter where NULL is
  the tested value. `in` with an empty or non-array operand is `1 = 0`.
- **The id is the tiebreak that makes the order total.** No id is `X_QUERY_NOT_PAGEABLE`, never
  `String(undefined)`. **`totalOrder`** (declared keys, then `id asc`) is the served order for SQL,
  memory and `positionFor`; never add `id` to `QueryShape.orderBy`. A live read asks for it via
  `SqlSource.total()` (called by `buildSource` for `surface === 'live'`), never `seek(null, limit)`.
- **The keyset tiebreak keeps the id's TYPE** (`SeekKey.id: unknown`), carried at the tail of `key`
  through `serializeSortValue` (`pagination-id-type.test.ts`).
- **A sort value carries its TYPE through the cursor** (`cursor-value.ts`: `{ $x: 'date' | 'bigint',
  v }`; `undefined` → `null`). Untaggable values are `X_CURSOR_VALUE_UNSUPPORTED` where the cursor is
  minted.
- **`compareValues` orders numbers and bigints in one order**; equality treats `number` and `bigint`
  as one family (`shape.ts` `same`). `shape-order.test.ts` reads `@ultimat3/entity`'s `COLUMN_KINDS`.
- **`numeric` and the TEXT form of `bigint` are a DECLARED gap** (`DECLARED_GAP` in
  `shape-order.test.ts`): closing it needs an `OrderKey` carrying a kind, never a guessing comparator.
- **A refill is owed by a FULL window only** (`held >= shape.limit`). **A move OUT of a full window is
  a `refill`, never an `add`.**
- **A position is decided against the rows the WINDOW holds**: `unprojectedOrderKey` — a held row
  missing an ordering column (`Object.hasOwn`, never a value check) gets a `refill` rather than a
  guess. A delete is addressed by index and still patches.
- **`tagKeys` is `@ultimat3/cache`'s.** `@ultimat3/render` exports a different `tagKeys`; never import
  that one here.
- **A fingerprint is `@ultimat3/core`'s** (`canonicalJson` + SHA-256/16 `fingerprint`), tagging `Date`,
  `Map`, `Set`. `query-hash.test.ts` pins it at `queryHash` and `cacheKeyFor`. `stable.ts` keeps
  `columnOf` and re-exports core's `isJsonObject`.
- The cursor codec is `@ultimat3/core`'s; this package supplies only the scope (`queryHash(name,
  input)`). An unverified cursor is `X_CURSOR_INVALID` (`CursorInvalidError`, re-exported).

## Invariants — caching

- **The request memo holds the read, not the rows**: `readOnce` publishes the in-flight promise
  before its first await; a rejection is evicted. `requestMemo(ctx)` is `Map<string, Promise<unknown>>`.
- **Every read is memoized; only a `cache:` read goes through the tier** (`readThrough`). One key
  function, `cacheKeyFor`.
- **A cache key carries the read's AUTHORITY**: `readAuthority(actor, scope)` is its one producer and
  `cacheKeyFor`'s fourth argument is required. `scope` defaults to `'actor'`; `'tenant'` with no
  `orgId` (`undefined`, `''` or `null` — `orgless()`) narrows to the actor. The authority is JSON.
- **`cache.ttlMs` is judged at `query()`** (`X_QUERY_CACHE_TTL_INVALID`). A `cache:` read always
  expires: `def.cache.ttlMs ?? DEFAULT_READ_CACHE_TTL_MS` (60 s); an unset TTL is OMITTED so the tier
  defaults.
- **A fill is FENCED, by `@ultimat3/cache`'s fence inside `createCacheStack.read`** — never a second
  one here (`cache-fence.test.ts`).
- **This package owns NO cache store**: a `cache:` read fills
  `createCacheStack(registeredTiers(), { clock })`. Never reintroduce a store, never call
  `tier.invalidateTags()` here. A tier refusal degrades the cache, never the read.
- **The read path reads NO clock** — it hands the stack a relative `ttlMs` (`read-tier.test.ts`).
- **A process that registered no tier reads uncached** — correct, and slower.
- **The memo holds an execution, never a decision**: `buildSource` (parse, guard, `sql()`) runs on
  every call before the memo. Moving the memo above it would be an authz bypass.
- **`fresh: true` skips the memo on the way in and publishes to it on the way out.**

## Commands

```
bun test packages/query
bun run typecheck
```

Why each rule above is shaped the way it is: [`docs/history/query.md`](../../docs/history/query.md).
