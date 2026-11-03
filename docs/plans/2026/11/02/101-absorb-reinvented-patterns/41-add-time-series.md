# 41 — Time buckets, rollups, and views the framework can read

> Part of [`overview.md`](overview.md). Depends on: [`13-jobs-bulk-and-rate.md`](13-jobs-bulk-and-rate.md). Tier: 1 (`db`), 2 (`entity`), 3 (`jobs`), 5 (`cli`).

## Why
Any dashboard needs "per day, in this person's zone".

| Gap | Evidence |
|---|---|
| No bucket | `countBy` refuses a timestamp key on purpose (`entity/src/count-by.ts`, a `Date` is no `Map` key), and aggregates are four whole-result functions (`entity/src/aggregate.ts:22`). So every chart is raw SQL, past the tenant guard and past the memory driver |
| The zone is wrong by default | hand-written `date_trunc('day', ts)` truncates in the session's zone. A daily count on a DST day, or across a Tokyo midnight, lands rows in the wrong bucket. The rule "no date without an explicit IANA `timeZone`" stops at SQL |
| Reports recompute | adopters' shapes differ, so no shared table ships. What agrees is the loop: re-aggregate a recent window, upsert, tolerate late rows |
| A stored view cannot be read or tested | `x db gen` emits no view and no entity reads one (`db/src/app-relation.ts:30`). A hand-written migration works and the dump carries it (`wiki/Migrations-And-Backfills.md:153`), but every read is raw SQL with no tenant guard, no codec, no `$view` |

## Decisions
| Question | Answer |
|---|---|
| Rollup table | the app's entity. Which dimensions exist is business (axiom 8) |
| Rollup vs materialized view | two jobs, stated in docs: a time window over append-mostly rows is `rollup()`, recomputing only recent buckets; an arbitrary join is a view, refreshed whole |
| Hypertable or extension | none. Plain Postgres |
| Gap filling | no: the client's range is the client's. `series` answers what exists |

## Files to change
- `packages/entity/src/time-bucket.ts` (new) — the rule file on `count-by.ts`'s shape: units, zone check, group ceiling.
- `packages/entity/src/query.ts:140` — `.series({ on, unit, timeZone, value })`.
- `packages/entity/src/pg-sql-aggregate.ts`, `memory-repo.ts` — both drivers. `repo.ts:146` — `series?` optional, as 05's `lock?`, so a hand-written `Repo` still compiles. `sealed-repo.ts`, `append-only.ts`, `row-observer.ts` — forward it.
- `packages/entity/src/entity.ts` — `view?: { sql, materialized? }`; `$describe` carries it.
- `packages/entity/src/pg-driver.ts:188,297,348`, `memory-repo.ts` — refuse every write on a view.
- `packages/db/src/generate-view.ts` (new), `generate-steps.ts`, `dependent-view.ts`, `migrate-view` paths — emit, re-emit on change, ordering after tables.
- `packages/jobs/src/rollup.ts` (new), `packages/jobs/src/refresh-view.ts` (new) — factories over `job()`.
- `packages/core/src/registrar.ts:83` — `rollup`, `refreshView` rows, `kind: 'job'`.
- `examples/dummy/packages/db/src/schema/` — one rollup entity over `likes`; one view; `examples/dummy/apps/web/api/` — one `.series` read.
- `wiki/Entities-And-Migrations.md`, `wiki/Migrations-And-Backfills.md`, `wiki/Jobs-And-Workflows.md`, `wiki/Queries-And-Live-Queries.md`, `wiki/The-Eight-Primitives.md`, READMEs, `wiki/Error-Codes.md`.

## Steps
1. `posts.where({ orgId }).series({ on: 'createdAt', unit: 'day', timeZone, value: 'count' | { sum: 'amount' } })` answers `{ bucket: Date; value: number | string | MoneyValue }[]`, ascending. `timeZone` is required by the type and validated by `assertTimeZone`. `unit` is closed: `minute, hour, day, week, month`. `value` reuses `aggregate.ts`'s kind table, so it never returns a float.
2. SQL: three-argument `date_trunc(unit, col, zone)`, zone bound. Memory: `Intl`-based truncation in one module, tested against Postgres on a DST-change day in a parity table. A week starts Monday, as `date_trunc` does; stated in docs.
3. `MAX_GROUPS` (`count-by.ts:34`) applies, one more asked, overflow refused and never truncated. Tenant guard and policy paths are the chain's.
4. `rollup({ name, source: ({ ctx, since }) => chain, into: entity, key: [...], lookback: '2d', map, tenant })` returns a job. Each run: read buckets from `now - lookback`, `upsertAll` in one transaction, bounded by `13`'s batching. `lookback` is required and app-chosen: it is how late a row may arrive and still count. Idempotent by construction. Scheduled by the app's `task`.
5. `entity('activeAuthors', { view: { sql, materialized: true }, columns })`: a read-only relation. A write is `X_ENTITY_VIEW_READ_ONLY`. `columns` are checked against the created view at the `drift` step.
6. A tenant column declared on a view keeps the repository's tenant predicate. `.sealed()` columns refused in a view: decrypt-and-group is meaningless.
7. `refreshView({ name, view, concurrently? })` returns a job. `concurrently` needs a unique index, checked at definition. Schedule is the app's.
8. Changing `view.sql`: `x db gen` emits drop and create plus dependents, using `dependent-view.ts`. `X_MIGRATION_VIEW_DEPENDS` keeps its rule.
9. `$describe` rows in the manifest, so admin lists a view read-only and MCP projects only what an action exposes.

## Error codes
`bun run new-error-code` for each new row.

| Code | When | Fix |
|---|---|---|
| `X_ENTITY_SERIES_UNSUPPORTED` (new, 501) | `.series` on a hand-written `Repo` without it | implement `series`, or use the shipped `postgresDriver()` |
| `X_ENTITY_SERIES_INVALID` (new, 422) | unknown unit, non-timestamp `on`, bad zone | a listed unit, a `timestamp()` column, an IANA zone |
| `X_ENTITY_VIEW_READ_ONLY` (new, 500) | a write to a view | write the source table |
| `X_ENTITY_VIEW_DRIFT` (new, off-socket) | `columns` disagree with the view | `x db gen "view"`, or correct `columns` |
| `X_JOB_ROLLUP_INVALID` (new, off-socket) | missing `lookback`, `key` not unique on `into` | a unique index over `key` |

The convention's build error: `drift` raises `X_ENTITY_VIEW_DRIFT`.

## Tests
- `packages/entity/src/time-bucket.test.ts`: one row per case on both drivers: DST spring day has 23 hours; a row at 23:30 UTC is next day in Tokyo; overflow refused.
- `packages/entity/src/series.live.test.ts`: same table against Postgres. Fails if the zone is dropped from the statement.
- `packages/jobs/src/rollup.job.test.ts`: a late row inside `lookback` lands; re-run changes nothing; killed mid-run leaves no half-bucket.
- `packages/db/src/generate-view.live.test.ts`: emit, read through entity, write refused, change re-emits with a dependent.
- `bun test packages/entity/src/time-bucket.test.ts`

## Semver
minor. `Repo.series` is optional, so a hand-written driver still compiles; `view?` is optional. Two `PRIMITIVE_FACTORIES` rows are additive.

## Done when
- `examples/dummy` draws one zone-correct series, one rollup and one view, each in `x.manifest.json`.
- `bun run verify` green.
