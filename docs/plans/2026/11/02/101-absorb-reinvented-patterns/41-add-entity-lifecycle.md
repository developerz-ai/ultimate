# 41 — Declared on the entity: how long a row lives, what it was, how many it has

> Part of [`overview.md`](overview.md). Depends on: [`04-db-migration-safety.md`](04-db-migration-safety.md), [`10-schema-sensitive-and-rules.md`](10-schema-sensitive-and-rules.md), [`39-db-partitioned-tables.md`](39-db-partitioned-tables.md) (`retain` refusal reads its introspection), [`41-add-reads.md`](41-add-reads.md) (`setLocal`), [`40-next-subject-data.md`](40-next-subject-data.md) (`subject-plan.ts`). Tier: 1 (`db`), 2 (`entity`), 3 (`jobs`), 5 (`cli`).

## Why
| Gap | Evidence |
|---|---|
| Retention is a promise nothing checks | `purge()` runs what it is handed (`jobs/src/purge.ts:101`). A table with a GDPR window needs a hand-written `PurgeTarget` with `purgeInBatches` (`jobs/src/purge-batches.ts:57`) and an index. Forgetting any of the three is silent until an audit |
| "What was this row on Tuesday" | `action({ audit })` records calls, the admin log records operations. `setRowObserver` gives whole rows, but on bulk writes only a count (`entity/src/row-observer.ts:53`), and raw SQL not at all. Recording is a property, what the record means is not (`docs/idea/19-mechanism-not-convention.md:93`), so before and after images ship and approval chains do not |
| Counters drift | `countBy` per page is a statement (`entity/src/count-by.ts`). A denormalized `likeCount` is hand-kept on every path, and `deleteWhere`, `upsertAll` or a raw statement skips it. Repair is a hand-written sweep |

Each is a declaration compiled to a trigger or target on the shape of `entity({ appendOnly })` (`entity/src/entity.ts:82`, `db/src/generate-append-only.ts`). None is a second way: each replaces the hand-written form, and a target or trigger the app wrote keeps working.

## Files to change
- `packages/entity/src/entity.ts:82` — `retain?`, `history?`.
- `packages/entity/src/columns-scalar.ts` — `.counts(() => likes.postId)` on an integer column.
- `packages/entity/src/retain.ts` (new) — `retainTarget(entity)`, satisfying `PurgeTarget` structurally.
- `packages/entity/src/history.ts` (new) — `historyEntity(parent)`, a real `entity()` value registered beside its parent, `$historyOf`; `$history(id, { cursor })`, memory parity.
- `packages/entity/src/counter.ts` (new) — declaration checks; memory parity through the repository wrapper.
- `packages/entity/src/describe.ts` — the manifest row: `retain`, `history`, `counts`.
- `packages/db/src/generate-history.ts`, `generate-counter.ts` (new), `generate-steps.ts` — triggers once per table.
- `packages/db/src/drift-*.ts` — both triggers named expected, as `drift-append-only.ts` does.
- `packages/entity/src/pg-transactor.ts` — `x.actor` through `setLocal` (41-add-reads) for a write on a history table.
- `packages/jobs/src/subject-plan.ts` — a `_history` table is reachable when its parent is: `row_id` is no foreign key, so `relationMap()` alone would miss it. `'delete'` is legal on it. `packages/testing/src/seed-graph.ts` — skips a `$historyOf` entity: the trigger writes it.
- `packages/jobs/src/purge.ts:101` — `purge({ targets, entities? })`; `entities: 'declared'` adds every `retain` entity.
- `packages/cli/src/verify-checks.ts`, `packages/cli/src/guards.ts` — the checks below, in `boundaries`.
- `packages/cli/src/cmd-db-backfill.ts` — `x db recount <entity>.<column>`, through `backfill()`.
- `examples/dummy/packages/db/src/schema/` — `retain` on `run-events`, `history` on `posts`, `counts` on `likes` to `posts`.
- `wiki/Entities-And-Migrations.md:122-138`, `wiki/Migrations-And-Backfills.md`, `packages/entity/README.md`, `CLAUDE.md`, `wiki/Error-Codes.md`, `wiki/CLI-Reference.md`.

## Steps
1. `retain: { after: '90d', on: 'createdAt' }`. The window is required and app-chosen; no default anywhere. `on` must be an indexed timestamp, else `X_ENTITY_RETAIN_UNINDEXED` at definition. `entity({ appendOnly, retain })` refused: that trigger refuses every delete, with no exemption, by design. A history table is not that declaration (step 3). A `tenant:` entity sweeps across tenants under the job's declared scope. A partitioned table declares no `retain`: its retention is `detach` ([`39-db-partitioned-tables.md`](39-db-partitioned-tables.md)), and `drift` raises `X_ENTITY_RETAIN_INVALID` when introspection reports the parent partitioned.
2. Build check in `x verify`: an entity with `retain` that no `purge()` covers is `X_ENTITY_RETAIN_UNSWEPT`. That is what makes a retention promise real.
3. `history: true` makes `<table>_history (id, <tenant column>, row_id, op, at, actor_id, request_id, before jsonb, after jsonb)`, with the parent's tenant column when it has one. Registered as an entity, so `$tenantColumn` holds, row security emits its policy, and `40-next-tenant-proof` and `40-next-subject-data` walk it. Its guard is its own trigger, `ultimate_history_guard`: update refused always, delete refused unless `current_setting('x.purge', true)` names this table. `retainTarget` and `subjectErase` alone set that, through `setLocal`. As `x.cross`, this catches forgetting, not hostile SQL in the app's own process. The history trigger, not the repository, records, because only a trigger sees `updateWhere` and raw SQL. `before`/`after` omit `.sensitive()` columns (10); `.sealed()` columns stay ciphertext. A row that changes nothing records nothing.
4. `actor_id` and `request_id` from `current_setting('x.actor', true)`, set in the write's transaction, so a statement with no transaction records `null`, never a guess. Columns for a reason or reviewer: none. An app adds domain audit with a factory over `mutator()`.
5. `posts.$history(id)` is a tenant-scoped read, same seam, paged by cursor. `retain` may be set on history: `history: { retain: { after: '7y' } }`, swept under the exemption in step 3, and it joins step 2's check. No default window here either.
6. `.counts(() => likes.postId, { where? })`: a trigger on the child, after insert, delete, or update of the key, runs `set n = n + 1` on the parent in the same transaction. Lock order is the parent row, so a hot parent serializes its writers; the docs state this and name `countBy` plus a cache as the alternative. `where` is a closed `Expr` (`entity/src/expr.ts:41`), compiled once.
7. The memory driver maintains the same effects in its repository, so unit tests agree with Postgres. Parity is a test, not an assumption.
8. `x db recount` compares and repairs through `backfill()`, paced. `--dry-run` reports the difference.
9. No `statement_timeout` here: a table has no time budget. A read's bound is in [`41-add-reads.md`](41-add-reads.md).

## Error codes
`bun run new-error-code` for each row, all `--off-socket`.

| Code | When | Fix |
|---|---|---|
| `X_ENTITY_RETAIN_UNINDEXED` | `retain.on` has no index | add `{ on: ['createdAt'] }` to `indexes` |
| `X_ENTITY_RETAIN_UNSWEPT` | no `purge()` covers it | `purge({ entities: 'declared' })` in `defineApi` |
| `X_ENTITY_RETAIN_INVALID` | no window, beside `appendOnly`, or on a partitioned table | set `after`; drop one option; or `detach` in a `task` |
| `X_ENTITY_COUNTS_INVALID` | not an integer, or not a foreign key to this entity | `.counts(() => child.parentId)` on an `integer()` |

## Tests
- `packages/db/src/generate-history.live.test.ts`: raw `update` and `updateWhere` both record images; a sealed column is ciphertext; a sensitive column absent; `update … set x = x` records nothing; a raw delete of a history row refused; the same under `x.purge` for that table passes, for another table refused.
- `packages/entity/src/history.test.ts`: the history entity reports the parent's `$tenantColumn`; `$history(id)` under another tenant answers nothing.
- `packages/db/src/generate-counter.live.test.ts`: 20 concurrent inserts count 20; delete, re-parent and `deleteWhere` stay correct. Must fail with the trigger removed.
- `packages/entity/src/counter.test.ts`, `history.test.ts`: memory answers as Postgres does, in one parity table.
- `packages/jobs/src/purge-entities.job.test.ts`: old rows go, new stay, batched.
- `packages/cli/src/verify-checks.test.ts`: `X_ENTITY_RETAIN_UNSWEPT` red on a fixture.
- `bun test packages/entity/src/counter.test.ts`

## Semver
minor. All options. A new check fires only on a new option.

## Done when
- Each of the three declared once in `examples/dummy`, and visible in `x.manifest.json`.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
