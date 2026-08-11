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
| `pg-sql.ts` / `pg-row.ts` | plan → parameterised SQL; physical row ⇄ entity row (money is two columns) |
| `registry.ts` | duplicate detection + `describeEntities()` for the manifest |
| `type-pins.ts` | compile-time assertions `tsc` checks — the column proxy, `Invariant` variance, the branded id |

## Commands

`bun test packages/entity` · `bun run --filter @ultimat3/entity typecheck`