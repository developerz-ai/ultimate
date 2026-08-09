# @ultimat3/entity

Columns + invariants; the row type is derived from the columns. Tier 2.

## Boundary

- May import `@ultimat3/core` and `@ultimat3/schema`. Nothing else — `http` and `policy` are the
  same tier.
- No `drizzle-orm`. `types.ts` declares the column vocabulary we consume; Drizzle is the
  production backing, documented not imported.

## Do not regress

- **Cursor pagination only.** OFFSET is wrong under concurrent writes: an insert before the
  offset shifts every later page, so a client silently skips and repeats rows. No `offset` on
  `FindManyArgs` or the builder; the primary key is always the last sort key, so the order is
  total.
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
| `repo.ts` / `tenancy.ts` | `Repo<T>`, cursor codec, tx rollback; `QueryPlan` + `assertScoped()` |
| `registry.ts` | duplicate detection + `describeEntities()` for the manifest |

## Commands

`bun test packages/entity` · `bun run --filter @ultimat3/entity typecheck`