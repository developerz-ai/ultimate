# @ultimat3/entity

Table + domain type + invariants. Tier 2.

## Boundary

- May import: `@ultimat3/core`, `@ultimat3/schema`. Nothing else.
- No `drizzle-orm` dependency. `types.ts` declares the structural `ColumnDef`/
  `TableDef` we consume; Drizzle is the production backing, documented not imported.
- Never import `@ultimat3/http` or `@ultimat3/policy` — same tier.

## Rules

- Money is `bigint` minor units + `char(3)` currency. A float throws. Never one column.
- Timestamps are `timestamptz`. There is no naive-timestamp helper and there will not be.
- An invariant that cannot be expressed in SQL does not belong in `invariants` — it is
  a service-layer rule.
- `orgId` column present ⇒ every query needs an org predicate. Guard, not convention.
- Cursor pagination only. Do not add `offset` to `FindManyArgs`.
- Never throw a bare `Error` — use `errors.ts`.

## Files

| File | Job |
|---|---|
| `columns.ts` | blessed helpers + `table()` name derivation |
| `invariants.ts` | app check + `toSql()` DDL, one declaration |
| `repo.ts` | `Repo<T>`, cursor codec, memory driver, tx rollback |
| `tenancy.ts` | `QueryPlan`, `orgScoped()`, `assertScoped()` |
| `registry.ts` | duplicate detection + `describeEntities()` for the manifest |

## Commands

```
bun test packages/entity
bun run --filter @ultimat3/entity typecheck
```
