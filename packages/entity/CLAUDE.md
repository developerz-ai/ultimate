# @ultimat3/entity

Columns + invariants; the row type is derived from the columns. Tier 2.

## Boundary

- May import `@ultimat3/core`, `@ultimat3/schema` and `@ultimat3/db`. Nothing else — `http`,
  `policy` and `auth` are the same tier.
- `db` is tier 1 (it imports only `core`), which is what lets the Postgres driver live **here**
  rather than in a tier-3 package: `Driver` and its production implementation stay in one place.
  See [`docs/architecture/01-package-map.md`](../../docs/architecture/01-package-map.md).
- No `drizzle-orm` dependency, and none is the production backing — `postgresDriver()`
  (`pg-driver.ts`/`pg-sql.ts`) is a hand-written SQL driver. `types.ts` declares the narrow
  structural column vocabulary this package consumes so the generated SQL stays readable and
  an agent can self-correct against it.

## Do not regress

- **Two drivers, one meaning.** `memoryDriver()` and `postgresDriver()` share `plan.ts` (scope,
  sort order, page size), `cursor.ts` (one codec, values included) and the `Repo` contract, so a
  test that passes against memory says something about Postgres. A guard, an operator or a sort
  rule added to one and not the other is the bug this split exists to prevent — `pg-driver.test.ts`
  pins the parity.
- **The Postgres driver is proved against a real Postgres, not only against a recording client.**
  `pg-driver.live.test.ts` runs the whole chain — `entity()` -> `$describe()` ->
  `generateMigration()` -> a live server -> `postgresDriver()` -> decoded row — and skips when no
  `TEST_DATABASE_URL` is set. Asserting statement *text* cannot catch a statement Postgres refuses:
  that is how a `unique()` column shipped a migration failing on `42P07` and money's currency
  shipped as `char(1)`. A new operator, column kind or write path is not done until it round-trips
  there.
- **A point lookup batches itself, and the batch is never wider than the statement it replaces.**
  `findById` called several times in one microtask of one request is one `select … where "id" in
  (…)` — `coalesce.ts`, keyed by ctx identity (a `WeakMap`, so the batch dies with the request, the
  shape `@ultimat3/query`'s request memo has one tier up) and by a scope key covering **every**
  input to the statement except the id. Two tenants, two soft-delete visibilities, two projections,
  two entities or two clients therefore never share one: a coalesced statement has to be one each
  of the singles would have been served by, or a caller is answered with rows their own statement
  could never have returned. It declines rather than guesses — no request in scope, a composite
  key, a predicate value it cannot render — and declining is just the statement `findById` always
  sent, which is why `findById` keeps its signature and there is no `batch()` to opt into. The
  window closes before the statement goes out, so a lookup arriving mid-flight opens the next batch
  instead of joining ids already on the wire, and past `MAX_IDS_PER_STATEMENT` a batch becomes
  several whole statements rather than one Postgres refuses for its bind count. A sequential
  `for … of` loop shares no microtask — its `await` ends the window — which is what the sibling
  preload below is for.
- **A page batches the loop it causes, and a preloaded row is only ever served to the statement
  that read it.** `findMany` leaves its page's foreign key *values* behind (`jit-preload.ts`,
  `tagSiblings`), so the first `findById` for any one of them resolves that key for every row of
  the page in one `in` statement and the rest of a `for … of` loop is memory. Five rules, none
  optional. **The scope guard is a security boundary**: a preloaded row is served only under the
  *same* `scopeKey` the coalescer uses — same tenant predicate, same soft-delete visibility, same
  projection, same entity — and the preload statement is that scope widened to the page's ids, so
  a page read under one tenant can never resolve another tenant's rows, whichever tenant asks.
  **Same client, or nothing**: a bucket filled through the ambient pool is not read through a
  pinned one, which is also what stops a row read inside a transaction being served after it —
  `db()` hands back a different client once the transaction is over, rolled back or not.
  **A write drops it**: `postgresRepo`'s `writing()` is the one place every write goes out, and it
  calls `forgetPreloaded(entity.$name)` *before* the statement, so a row a request changed is
  re-read and never served from a page read before it. **Values, not rows**: the index is keyed by
  id and holds ids, so a page early in a long request pins its keys and not its rows, and it dies
  with the request like every other per-ctx store here. **Declining is the old behaviour**: no
  request in scope, an id no page indexed, a key that resolved to nothing — the caller reads the
  statement it always read. `MAX_IDS_PER_STATEMENT` bounds the preload exactly as it bounds a
  batch. What both share — the scope key, `keyOf`, the one `in` statement — lives in
  `batch-read.ts` so the two can never disagree about when a shared statement is legal.
- **Cursor pagination only.** OFFSET is wrong under concurrent writes: an insert before the
  offset shifts every later page, so a client silently skips and repeats rows. No `offset` on
  `FindManyArgs` or the builder; the primary key is always the last sort key, so the order is
  total. The cursor carries the sort **values**, not just an id — seeking by an id that was
  deleted between two requests would restart pagination at the top.
- **The codec is `@ultimat3/core`'s, and both drivers reach it through exactly two functions**:
  `cursorFor(entity, plan, row, id)` and `seekFrom(entity, plan)` in `cursor.ts`. Both call
  `assertSeekable`, so an ordering that cannot carry a position — a nullable key, an undeclared
  column, a money property named without `.minor`/`.currency` — is refused when the cursor is
  *minted*, not one page later where the page size decides whether anyone finds out. This package owns only
  what a cursor is *bound* to — `planScope(plan)`: the entity, its filters and its sort order,
  hashed. Not the page size (a bigger next page is the same query) and not `select` (a projection
  cannot move a row). A cursor that fails either the signature or the scope is `X_CURSOR_INVALID`;
  it must never decode to "start from the top", which is what the old codec's `null` did.
- **A relation is a foreign key read a second way, never a second declaration.** `relations.ts`
  derives `belongsTo` from an entity's own `references()` columns and `hasMany` from the inbound
  ones; there is no `hasMany: […]` init key and adding one would put two declarations of one fact
  in the schema. A thunk is resolved in exactly one place — `referenceBinding()` in `column.ts` —
  so the DDL projection (`describe.ts`) and the relation map can never disagree about what a
  `references()` points at. Naming is order-independent by construction: when two keys want one
  name, **every** member of that group takes its long form, so declaring a second foreign key
  never renames the first relation behind a caller's back. What the two tiers cannot separate is
  refused with `X_INVARIANT_VIOLATED` naming both columns — never collapsed into one relation.
- **Relations reach query time through `RegistryEntry.references()`, and the DDL string is
  rendered from it.** The resolved records are the source; `ColumnDescription.references` spells
  `"<table>.<column>"` out of one for the migration generator, which is in tier 1 and cannot
  import this package. Never parse that string back — it carries physical names and a traversal
  reads row *properties*, so the parse would be a second, lossy resolver. `references()` is a
  method, not a field: a thunk may point at an entity two modules of an import cycle have not
  finished evaluating. `relationMap()` memoises the whole-registry derivation against
  `registryGeneration()`, which every registration bumps — a schema module imported late must
  rebuild the map, never be missed by it. The derivation is **one pass** over the foreign keys,
  filed under both ends as it goes — a rescan per entity is the schema squared, paid again after
  every late registration. `relationNamed()` refuses an unknown name with
  `X_PRELOAD_UNKNOWN_RELATION` whose `fix` is a `relationNamed()` call on a relation that does
  exist, the rest by name after it; a relation is derived, so there is no file a reader could open
  to find them. An entity with no foreign key at all gets `x entities list --json` instead — the
  declaration it needs names a target this error cannot know.
- **A repository call rejects, never throws synchronously** — `tableFor`'s writes are `async` for
  that reason alone: `$parse` throws, and a call site should not need two error paths for one
  mistake.
- **Tenancy applies to writes too.** `update(id, patch)`, `delete(id)`, `deleteWhere(filter)` and
  `updateWhere(filter, patch)` build the same plan a read does, so an id or a filter alone never
  addresses a row on a tenant-scoped entity. Another tenant's id reads as `X_NOT_FOUND`, never as
  their row.
- **`deleteWhere(filter)` and `updateWhere(filter, patch)` are the only filtered writes, and they
  are bounded by construction.** `delete(id)` and `update(id, patch)` need a single-column primary
  key, so on a composite key — `likes`, `blocks`, `participants`, any join table — the filtered
  pair is the only write path that exists; without them the entity is create-only and a row can be
  written and never unwritten. Properties, none of them optional:
  - an empty filter is `X_WRITE_UNFILTERED` and never every row; an empty patch is `X_PATCH_EMPTY`
    and never a counted no-op. An `undefined` value is dropped *before* either count, so a
    forgotten variable lands on the error rather than on the table.
  - **one code for both verbs**, because it is one situation with one remedy. Splitting it into
    `X_DELETE_UNFILTERED`/`X_UPDATE_UNFILTERED` would give two codes the same `fix` and make a
    caller choose which to catch. The situations that genuinely differ — no filter, no patch —
    are what get separate codes.
  - the filter guard runs before tenancy is applied, because one tenant's every row is still
    every row.
  - soft delete follows the entity's `deletedAt` column exactly as `delete(id)` does: stamped rows
    are not matched twice, and `updateWhere` carries the same `deleted_at is null` clause
    `update(id, patch)` does, so a deleted row is never patched back into shape.
  - both return a count, never `void`: a filtered write that silently matches nothing is
    indistinguishable from one that worked.
- **`touch()` in `query.ts` is the ONE place `onUpdateNow()` columns are stamped**, for
  `update(id, patch)` and `updateWhere(filter, patch)` alike — a second copy is how one of them
  ends up writing a stale `updatedAt`. It returns an empty patch untouched, so whether
  `X_PATCH_EMPTY` fires depends on the call and not on whether the entity happens to declare the
  column.
- **Nothing is interpolated into SQL.** `pg-sql.ts` binds every value through `sql` and resolves
  every identifier through the entity, so a column name can only be one the entity declared.
  `raw()` appears exactly twice, for `asc|desc` and the seek operator — both closed sets.
- **Money is `bigint` minor units + `char(3)` currency.** A float throws. Never one column,
  never an implied single currency.
- **Timestamps are `timestamptz`.** A naive timestamp must stay inexpressible.
- **A tenant column means every query needs an org predicate** — runtime guard, not convention.
  Missing ⇒ `X_TENANCY_UNSCOPED`. `tenant: 'orgId'` declares it; omitted, inference still applies
  (`.tenant()`, else a column named `orgId`), so silence never means unscoped. Never make the
  declaration the only switch.
- **Every framework member on an entity is `$`-prefixed** — the columns are `Object.assign`ed onto
  the core, so an unprefixed member would make `view`, `name` or `tenant` an illegal column name.
  `$view`, never `view`; no free `view(entity, keys)` either — one way to write a projection.
- **Invariants run twice**: in the app on write AND as a Postgres CHECK/UNIQUE via `toSql()`. An
  untranslatable JS predicate reports `kind: 'assert'`, `sql: null` — never a pretend CHECK.
- **`invariants` is ONE callback, and `InvariantColumns<C>` is a mapped type.** `invariants: (c) =>
  [invariant(name, expr)]`, never an array of `(c) => …` builders: a per-element builder is a call
  TypeScript checks before `entity()`'s `C` is fixed, so `C` fell back to its constraint and `c`
  stayed open-keyed. Open-keyed means an index signature, and under `noUncheckedIndexedAccess` that
  made every `c.title` a `ColumnExpr | undefined` — every generated entity red until the author
  added `!`. The Proxy in `invariantColumns()` stays regardless: a JS caller and a dynamically
  built rule never see the compile error, and its message names the columns that do exist.
- **`Invariant<T>.holds` is a method, never `readonly holds: (row: T) => boolean`.** A
  function-typed property is contravariant, so `Invariant<Post>` stopped being assignable to
  `Invariant<unknown>`, `Entity<Post, C>` stopped satisfying `EntityCore`, and every
  `database({ … })` degraded to `Table<unknown>` — one position, 36 cascading errors downstream.
- **A branded id survives to the signature, or it does not exist.** `uuid<PostId>()` declares the
  brand once; the derivation (`TypeOf`/`RowOf`/`Insertable`) always carried it, but the BUILDER
  hard-coded `Column<string>` so there was nothing to carry, and `Repo`/`Table` then took
  `id: string`, which erased the rest — two entities' ids were mutually assignable and
  `posts.update(someUserId, …)` compiled into a query that matched nothing. Both halves are
  pinned: fixing either alone leaves that call legal. Id parameters are `IdOf<Row>`, which is
  `string` for every unbranded row and every composite key, so this is additive.
- **`type-pins.ts` is where all of those are enforced.** Source, not a test: `tsconfig.json`
  excludes `src/**/*.test.ts`, so `tsc` never reads a test file and a type-level assertion written
  in one can never fail. It emits nothing and exports nothing anybody imports.
- **Row types are derived, never re-declared.** No `as unknown as` to fake the derivation.
- **`src/index.ts` re-exports `t` from `@ultimat3/schema` verbatim**, so an entity file that also
  hand-writes a view schema imports one package. Never wrap, spread or re-declare it: `t` delegates
  to `schemaProvider()` on every access, and a copy would freeze the provider at import time.
  `index.test.ts` asserts identity.
- Never throw a bare `Error` — use `errors.ts`.
- Tests restore the process-global registry in `afterAll` (`clearRegistry()`): a leaked registry
  breaks an unrelated package's tests, as it did in `@ultimat3/policy`.

## Files

| File | Job |
|---|---|
| `types.ts` | `Column`, `RowOf`, `Insertable`, `IdOf` — the type derivation |
| `column.ts` / `columns.ts` | the chain + property-key binding; the blessed builders |
| `expr.ts` / `invariants.ts` | the `invariants: (c) => …` rule language; bind + `toSql()` DDL |
| `entity.ts` / `describe.ts` | `entity()`, `$row`; the `EntityDescription` projection |
| `view.ts` | `$view(keys)` — the row projection an action names as its `output` |
| `query.ts` / `database.ts` | chainable read to a cursor page; `database()` + `Driver` |
| `repo.ts` / `tenancy.ts` | `Repo<T>` + `memoryDriver`'s repo, tx rollback; `QueryPlan` + `assertScoped()` |
| `plan.ts` / `cursor.ts` | the plan both drivers execute; the one keyset cursor codec |
| `pg-driver.ts` | `postgresDriver()`, `postgresRepo()`, `postgresTransactor()` |
| `coalesce.ts` | one microtask of `findById` calls → one `where id in (…)`, per request |
| `batch-read.ts` | what a shared point read is made of — the scope key, `keyOf`, the one `in` statement |
| `jit-preload.ts` | a page's foreign key values → one `in` statement for the whole `for … of` loop |
| `pg-sql.ts` / `pg-row.ts` | plan → parameterised SQL; physical row ⇄ entity row (money is two columns) |
| `registry.ts` | duplicate detection, `describeEntities()` for the manifest, `references()` per entry |
| `relations.ts` | `relationMap()`/`relationsFor()`/`relationNamed()` — the FKs as a named `belongsTo`/`hasMany` map |
| `type-pins.ts` | compile-time assertions `tsc` checks — the column proxy, `Invariant` variance, the branded id |

## Commands

`bun test packages/entity` · `bun run --filter @ultimat3/entity typecheck`