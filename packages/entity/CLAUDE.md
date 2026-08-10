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
- **Cursor pagination only.** OFFSET is wrong under concurrent writes: an insert before the
  offset shifts every later page, so a client silently skips and repeats rows. No `offset` on
  `FindManyArgs` or the builder; the primary key is always the last sort key, so the order is
  total. The cursor carries the sort **values**, not just an id — seeking by an id that was
  deleted between two requests would restart pagination at the top.
- **The codec is `@ultimat3/core`'s, and both drivers reach it through exactly two functions**:
  `cursorFor(plan, row, id)` and `seekFrom(entity, plan)` in `cursor.ts`. This package owns only
  what a cursor is *bound* to — `planScope(plan)`: the entity, its filters and its sort order,
  hashed. Not the page size (a bigger next page is the same query) and not `select` (a projection
  cannot move a row). A cursor that fails either the signature or the scope is `X_CURSOR_INVALID`;
  it must never decode to "start from the top", which is what the old codec's `null` did.
- **A repository call rejects, never throws synchronously** — `tableFor`'s writes are `async` for
  that reason alone: `$parse` throws, and a call site should not need two error paths for one
  mistake.
- **Tenancy applies to writes too.** `update(id, patch)` and `delete(id)` build the same plan a
  read does, so an id alone never addresses a row on a tenant-scoped entity. Another tenant's id
  reads as `X_NOT_FOUND`, never as their row.
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
| `types.ts` | `Column`, `RowOf`, `Insertable` — the type derivation |
| `column.ts` / `columns.ts` | the chain + property-key binding; the blessed builders |
| `expr.ts` / `invariants.ts` | the `(c) => …` rule language; bind + `toSql()` DDL |
| `entity.ts` / `describe.ts` | `entity()`, `$row`; the `EntityDescription` projection |
| `view.ts` | `$view(keys)` — the row projection an action names as its `output` |
| `query.ts` / `database.ts` | chainable read to a cursor page; `database()` + `Driver` |
| `repo.ts` / `tenancy.ts` | `Repo<T>` + `memoryDriver`'s repo, tx rollback; `QueryPlan` + `assertScoped()` |
| `plan.ts` / `cursor.ts` | the plan both drivers execute; the one keyset cursor codec |
| `pg-driver.ts` | `postgresDriver()`, `postgresRepo()`, `postgresTransactor()` |
| `pg-sql.ts` / `pg-row.ts` | plan → parameterised SQL; physical row ⇄ entity row (money is two columns) |
| `registry.ts` | duplicate detection + `describeEntities()` for the manifest |

## Commands

`bun test packages/entity` · `bun run --filter @ultimat3/entity typecheck`