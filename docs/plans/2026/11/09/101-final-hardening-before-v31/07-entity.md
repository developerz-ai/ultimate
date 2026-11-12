# 07 — entity: indexed tenants, honest memory driver, a driver kit for custom stores

> Part of [`overview.md`](overview.md). Depends on: [`03`](03-db.md). Tier: 2 (`entity`); `cli` for E14 only. Row/cross-tenant observers move to the bus in [`20`](20-observability.md); `repoConformance` is [`19`](19-conformance-suites.md); the wire page cap is [`11`](11-action-query.md).

## Findings — correctness and large data
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| E1 | **High (perf)** | `entity/src/column.ts:219` vs `tenancy.ts:81` | only `.tenant()` sets `index: true`; an inferred tenant column (`orgId` without `.tenant()`) gets none. Measured, 500k rows / 1,000 orgs: tenant page 43.7 ms unindexed, 2.9 ms on `(org_id)`, 1.5 ms on `(org_id, id)` | every tenant column, inferred or declared, gets `(tenant, pk)`. v31-break: drift hash moves; `x db gen` emits a `create index concurrently` |
| E2 | Med | `entity/src/memory-match.ts:67` | memory orders text by UTF-16 unit; Postgres (`C`) by byte. Proved: `'！'` vs `'😀'` disagree. Pages differ dev vs prod | compare by code point (pattern: `auth/src/memory-adapter.ts:38`) |
| E3 | Low | `entity/src/memory-repo.ts` (`findMany`), `plan.ts:132` | memory ignores `FindManyArgs.select` and returns the full row; Postgres projects (`pg-sql.ts:371`). A raw `Repo` caller reads unselected columns | project in memory as `pg-sql.ts` `projection` does |
| E4 | Low | `entity/src/pg-driver.ts:107` (`idOf`) | composite PK joined with `''`: `('a','bc')` = `('ab','c')`. Unread today, a bug the day it is read | one `rowKey(entity, row)` used by both drivers (replaces `memory-repo.ts:33` `field()`, `cursor.ts` `valueAt`, `storeKey`) |
| E5 | Med (perf) | `entity/src/memory-repo.ts` (`findById`), `memory-seek.ts` | memory `findById` filters and sorts the table: 6.49 ms at 20k rows; 40 pages of 500 = 3.3 s (quadratic). Memory is the default dev/test driver | `findById` = `rows.get(idStoreKey)` + visibility/plan checks (as `addressed()`); cursor position by binary search |
| E6 | Med (big data) | `entity/src/pg-write-sql.ts:102` | every insert/`insertAll`/`upsertAll` ends `returning *`: a 1M-row import streams 1M decoded rows back. No COPY path | `insertAll(rows, { returning: false })` → count. `copyAll` over `COPY FROM STDIN` only if Bun's SQL client exposes it (check; else record in `90-owner-steps.md` as upstream ask) |
| E7 | Med (big data) | `entity/src/plan.ts:34` (`MAX_PAGE_SIZE` 10,000) | bounded by rows, never bytes: 10k × 1 MiB jsonb ≈ 10 GiB decoded | `maxPageBytes` refusal measured on raw rows; document `select()` for wide columns |
| E8 | Med | `entity/src/column-values.ts:37` (`enumerated()`, `tz()`/`locale()` in `columns.ts:160-213`) | `[]` accepted; CHECK becomes `x in ()`; `x db migrate` dies with 42601 | refuse `[]` through `refuseColumn` |
| E9 | Low | sort keys vs indexes | `orderBy` on an unindexed key = full sort per page, silent | `x doctor` finding naming the missing index (with E1) |

## Findings — custom drivers (owner: Mongo, Cassandra, … must be easy and safe)
`Repo` (`entity/src/repo.ts:98`) is not SQL-coupled: predicates, sort keys, opaque cursors. **Blocker: tenant scoping, PK tiebreak, page bounds and `assertSeekable` run inside each driver** (`readPlan`/`idPlan`/`deletePlan`/`updatePlan`, `plan.ts:153`, unexported). A third-party driver reading `args.where` skips tenant scoping: a cross-tenant leak, not a missing feature.

| # | Change | Breaking? |
|---|---|---|
| E10 | `@ultimat3/entity/adapter` subpath: plan builders, `cursorFor`/`seekFrom`, `narrowRow`, `upsertPlan`/`conflictKeys`, `matchesPredicate`, `refuseAbandoned`, `compareByKind`, `sameValueOfKind` | no |
| E11 | `defineDriver({ repo: rawRepo, capabilities })`: builds the scoped `QueryPlan` before the raw repo sees it, wraps `sealedRepo`/`appendOnlyRepo`/`assertRowTenant`/`refuseAbandoned`. Memory and Postgres drivers move onto it — one path | no |
| E12 | `X_DRIVER_UNSUPPORTED` (capability in `meta`: `transactions`, `lock`, `series`, `aggregate:<kind>`, `matches`); `entityUniqueViolation(entity, constraint)` replaces the faked SQLSTATE `23505` in `memory-unique.ts:9` | no |
| E13 | `transactor()` optional for drivers declaring no transactions; a seed dry run refuses with E12's code | no |
| E14 | `wiki/Entities-And-Migrations.md` + `packages/entity/README.md`: migrations, drift and `x db` are Postgres-only; a non-SQL driver owns its schema. `packages/cli` `drift` step skips (with a printed reason) when no Postgres driver is configured | no |

## Files to change
- `packages/entity/src/column.ts`, `tenancy.ts`, `describe.ts` — E1. `memory-match.ts` — E2. `memory-repo.ts` (split: read path / write path), `memory-seek.ts` — E3, E5. `pg-driver.ts`, `cursor.ts`, `row-key.ts` (new) — E4. `pg-write-sql.ts`, `bulk-write.ts` — E6. `plan.ts` — E7. `column-values.ts`, `columns.ts` — E8.
- `packages/entity/src/adapter.ts` (new subpath), `define-driver.ts` (new), `memory-driver.ts`, `pg-driver.ts`, `memory-unique.ts`, `errors.ts`, `package.json` (`exports`) — E10–E13.
- `packages/cli/src/doctor-*.ts` (index finding) — E9; the `drift` verify step — E14.
- Near-ceiling splits on touch: `entity.ts` (495), `types.ts` (482), `expr.ts` (473).

## Tests
- `describe-tenancy.test.ts`: inferred and declared tenants both list `(tenant, pk)`.
- `compare-parity.test.ts`: astral vs BMP-private-use pair. `select-parity.test.ts`. `row-key.test.ts`: composite collision gone.
- `memory-repo.perf.test.ts`: `findById` at 20k rows < 0.1 ms; 40 pages linear.
- `bulk-write.live.test.ts`: `returning: false` → count, no rows.
- `columns-refusal.test.ts`: `[]` refused for all three builders.
- `define-driver.test.ts`: a raw repo that ignores tenancy still cannot read another tenant's row through `defineDriver`.
- Uncovered branches: `cursor.ts:312-316`, `memory-match.ts:221-225`, `tenancy.ts:236-237`, `sealed-repo.ts:239-241`, `coalesce.ts:114,122`.
- `bun test packages/entity` · live parity in CI.

## Done when
- A 20-line toy key-value driver in a test, built with `defineDriver`, passes the read half of `repoConformance` ([`19`](19-conformance-suites.md)) and refuses the rest with `X_DRIVER_UNSUPPORTED`.

## Correction, 2026-11-11

E6 (`insertAll(rows, { returning: false })`, `copyAll`) and E7 (a page bounded by bytes) were marked complete with this file and never shipped: `pg-write-sql.ts` still ended every bulk insert `returning *`, and `plan.ts` bounded a page by rows only. Both shipped in 31.9.0 as E3 and E4 of [`2026/11/11/101-full-stack-efficiency-sweeps/05-entity.md`](../../11/101-full-stack-efficiency-sweeps/05-entity.md) — the measurements are in its Outcome.
