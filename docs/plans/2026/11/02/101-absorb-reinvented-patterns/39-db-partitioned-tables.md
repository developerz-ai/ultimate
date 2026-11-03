# 39 — Partitioned tables are tables

> Part of [`overview.md`](overview.md). Depends on: [`04-db-migration-safety.md`](04-db-migration-safety.md), shares `migration-step.ts`; [`05-entity-tenant-and-locks.md`](05-entity-tenant-and-locks.md), whose same-tenant default the recipe must state its way out of. Tier: 1 (`db`).

## Why
A serious event, audit or metering table is partitioned by month so retention is a `detach`, not a delete. On one today the framework reports a correct database as wrong and offers a destructive repair. Probe, PGlite, `events` partitioned by range with one partition, `diffSchema` against migrations declaring it:
```
changed-primary-key  table "events" has no primary key, and migrations declare (id, at)
missing-index        table "events" is missing index "events_kind_idx"
unexpected-table     "events_2026_11" … or, if nothing owns it, run drop table "events_2026_11"
```
Cause: `relkind = 'r'` at `introspect.ts:275`, `:317`, `:329` skips the parent (`p`), so its keys and indexes vanish; `nonAppRelations` (`app-relation.ts:42`) does not exclude a partition, so each child is a stray. A deploy's `checkDrift` then fails terminally, and its `fix:` drops a month of data.
Second probe: a foreign key from `notes` to `events` adds `notes_…_fkey_1`, `_2` targeting each partition, and `events_a` carries clones of the parent's own. All have `conparentid <> 0`. Each new partition would add a false foreign-key finding.

## Decisions
| Question | Answer |
|---|---|
| What is a partition, to drift | not app schema: Postgres owns it, the parent is what migrations declare. Excluded by `relispartition`, the "catalog is the rule" of `nonAppRelations` |
| Which constraints count | `conparentid = 0` only |
| Declaring one | hand-edit the `create table` in the generated migration: `… partition by range ("at")`. The migration file is the author's, and drift compares columns, keys and indexes, which still hold. The primary key must include the partition key, Postgres's rule, and `primary-key.ts` already compares order |
| A same-tenant key into one | 05's default emits a unique `(org_id, id)` on the target. On a partitioned target Postgres refuses it (probe: `0A000`): a unique index must hold the partition key. So the recipe states the reason on the edge: `references(() => events.id, { crossTenant: 'partitioned target: unique index needs the partition key' })`. The repository's tenant guard still holds; the database's composite key does not, and the docs say so |
| `retain` | none on a partitioned table: its retention is `detach`. [`41-add-entity-lifecycle.md`](41-add-entity-lifecycle.md) raises `X_ENTITY_RETAIN_INVALID` from this slice's introspection |
| `entity({ partition })` | not here. Nothing the gate needs, and a value that would also need attach, default partition and retention choices, which are the app's (axiom 8) |
| Creating next month's partition | the app's `task`. Recipe in `wiki/Migrations-And-Backfills.md`, pinned by a test, not a helper |
| `create index concurrently` on a parent | Postgres refuses (probe: `SQLSTATE 0A000`), arriving today as a bare `X_DB_STATEMENT_FAILED`. New code carries the exact sequence |
| The schema dump | today names these in `unrendered.sql` (`catalog-objects.ts:169-181`), so a dump-loaded test database has no table. Render them: `partition by` from `pg_get_partkeydef`, each child `partition of … for values` from `pg_get_expr(relpartbound)`. Per that file's rule, a kind rendered later leaves the list in the same diff |

## Files to change
- `packages/db/src/introspect.ts:275,317,329` — `in ('r', 'p')`, and a `partitioned` field on the table; `:302` — `and c.conparentid = 0`.
- `packages/db/src/app-relation.ts:42-56` — `or c.relispartition`; header comment names the third disqualification.
- `packages/db/src/migration-step.ts`, `migration-errors.ts` — map `0A000` on a concurrent statement to the code; `concurrent-index.ts` holds the wording.
- `packages/db/src/catalog-relations.ts:72-93`, `catalog-objects.ts:161-181`, `catalog-fold.ts`, `schema-dump-table.ts` — render parent then children; child indexes and clones skipped, as the parent's recreate them.
- `packages/db/CLAUDE.md` (Drift, schema dump sections, "Never render a partition as a plain table" stays true), `README.md`, `wiki/Migrations-And-Backfills.md`, `wiki/Error-Codes.md`, `docs/history/db.md`. No `examples/dummy` use: an option on a migration, not a primitive.

## Steps
1. Failing tests first, the probes.
2. Introspection and exclusion. Then foreign keys. Then the dump, with fidelity replay.
3. Error mapping. Check `refuseDependentViews` and `appendOnly` drift on a parent: a trigger on `p` clones as `tgisinternal`, which `:328` already skips.
4. The recipe: a `task` that creates the next partition `if not exists`, detach for retention, no `retain`, and the `crossTenant:` reason above on any reference into the table.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_MIGRATION_CONCURRENT_PARTITIONED` (off-socket) | a concurrent index build on a partitioned parent | build each partition with `create index concurrently`, then `create index … on only <parent>`, then `alter index … attach partition`, in a `-- transaction: false` migration. `bun run new-error-code X_MIGRATION_CONCURRENT_PARTITIONED --package db --title '…' --cause '…' --fix '…' --off-socket` |

## Tests
- `packages/db/src/introspect-partitioned.test.ts` (PGlite, real catalog): parent reports its primary key, indexes, checks; a child appears nowhere; a sub-partition too.
- `packages/db/src/drift-partitioned.test.ts`: the probe's report answers `ok: true`; adding a partition stays `ok`; a truly missing index on the parent, and a truly missing key, are still found: the check must still be able to fail.
- `packages/db/src/introspect-embedded.test.ts`: a foreign key to a partitioned table reports one row.
- `packages/db/src/foreign-key-plan.test.ts`: with the recipe's `crossTenant:`, no `(org_id, id)` index is planned on the partitioned target; without it, the live build answers `0A000`.
- `packages/db/src/schema-dump-fidelity.test.ts`: dump, replay, `unexpectedObjects` empty for a partitioned table with two partitions; the entry leaves `unrendered.sql`.
- `packages/db/src/concurrent-index.test.ts`: the code on `0A000`, with the original still `sourceError`.
- `bun test packages/db/src/drift-partitioned.test.ts`; `TEST_DATABASE_URL` run for parity with real Postgres via `schema-load.contract.test.ts`.

## Semver
Minor. A false finding becomes none; an app with an unpartitioned schema gets byte-identical snapshots and dumps. A previously unrendered kind now appears in a dump: `x db schema-dump` writes new files once, in `CHANGELOG.md`.

## Done when
- The probe prints `{"ok":true,"differences":[]}`.
- `x db migrate` on a partitioned table passes `checkDrift` on both drivers.
- `bun run schema-dumps --check` and `bun run verify` green.
