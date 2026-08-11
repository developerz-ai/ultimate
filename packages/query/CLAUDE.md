# @ultimat3/query

Owns the `query` primitive: reads, live reads, cursors, the incremental matcher. Tier 3.

## Boundary

- May import: `core`, `schema` (t0), `cache`, `i18n`, `time` (t1), `entity`, `policy` (t2).
- Never import: `action`, `jobs`, `realtime` (sideways), or any tier 4-5 package.
- Reads only. A query that writes is an `action` in the wrong file.

## Files

| File | Job |
|---|---|
| `query.ts` | the primitive: `query()`, `describeQuery`, `queryHash`; the package's front door for the read path |
| `read.ts` | **the one read path** (`runQuery`, `sourceFor`) + the private declaration store `sql` lives in |
| `facade.ts` | the fluent surface — binds each projection to the query, re-implements none |
| `mcp-tool.ts` | MCP read descriptor, same `sourceFor` |
| `client.ts` | typed read client (browser-safe: no server imports) |
| `naming.ts` | export name → `/_x/query/<kebab>` + snake_case tool name. Pure string math |
| `registry.ts` | export-name registration, `describeQueries()`, and the `registerPrimitiveRegistrar('query', …)` announcement |
| `live.ts` | `LiveQuery` descriptor + cursor arithmetic |
| `matcher.ts` | change event → minimal patch, or `X_MATCHER_UNSUPPORTED` |
| `pagination.ts` | `paginate()` over core's cursor codec — no offset, ever |
| `sql.ts` | `explain()` / `describeSql()` |
| `cache.ts` | request memo + `ReadCache` tier + `invalidateTags` |
| `source.ts` | `SqlSource` contract + `from()` in-memory reference |
| `shape.ts` | shared read vocabulary (filters, ordering, seek keys) |
| `policy-gate.ts` | **the only** file that touches `@ultimat3/policy` |

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
- `isLive` is the declared boolean, `live()` is the subscription. Never name one after the other.
  `QueryDescriptor.live` keeps its name — `@ultimat3/manifest` and `@ultimat3/admin` read it.
- `mcp` is opt-in (`expose: true`), exactly as it is for an action: rows reach an agent only when
  the author said so.
- `client.ts` stays free of server imports — it is bundled into the browser. `@ultimat3/action`
  is the same tier, so its naming is ported here, never imported.
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
- **The id is the tiebreak that makes the order total.** A row without one is
  `X_QUERY_NOT_PAGEABLE` at `seekKeyOf`, never `String(undefined)`: `"undefined"` is a position
  every row matches, signed and opaque, so page two would be page one forever.
- The cursor codec is `@ultimat3/core`'s (`encodeCursor` / `decodeCursor` / `configureCursorSigning`).
  This package supplies only the scope a cursor is bound to — `queryHash(name, input)` — and never
  signs, encodes or parses one itself. An unverified or foreign cursor is `X_CURSOR_INVALID`, thrown
  by core's `CursorInvalidError`, which `errors.ts` re-exports so the name stays on this surface.
- Authz goes through `enforce(surface, policy, { input, actor, ctx })` from
  `@ultimat3/policy`; a live denial keeps its 4403 close code on `QueryDeniedError.denial`.
  `policy-gate.ts` is the only file that imports the policy package.

## Commands

```
bun test packages/query
bun run typecheck
```
