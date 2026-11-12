# 05 — entity: set-based writes, per-group reads, honest indexes

> Part of [`overview.md`](overview.md). Depends on: [`03`](03-db.md) for index DDL rendering (E8, E9). Tier: 2 (`entity`), with `db` (tier 1) for DDL and `testing` (tier 5) for conformance.

The largest source of hand-written SQL and per-row loops in every app audited. Each row lands on memory, Postgres and `defineDriver` together, held by the driver conformance suite (pattern: `packages/testing/src/job-driver-conformance.ts`).

## Findings

| ID | Sev | Status | Where | Finding | Fix |
|---|---|---|---|---|---|
| E1 | P1 | confirmed; 3 adopters + both tracked apps | `packages/entity/src/query.ts:192,199` (`deleteWhere`/`updateWhere(filter: RowPatch<Row>)`) | Writes filter by equality only. Apps loop per id under an `expectedQueryLoop` (4 sites in the tracked apps: up to 50, 1,000 and 5×1,000 statements) | write terminals on the existing read chain: `.where(…).andWhere('id', 'in', ids).update(patch)` and `.delete()`, tenant-scoped as the chain is, `X_WRITE_UNFILTERED` on an empty predicate. `updateWhere`/`deleteWhere` delegate to them (one implementation); their removal waits on `next` |
| E2 | P1 | confirmed (tracked apps) | same | Per-row *values* cannot be written in one statement (a backfill writing a different excerpt per row) | `updateMany([{ id, patch }])`: one `UPDATE … FROM (VALUES …)`, chunked by bind count as `bulk-write.ts` does, same columns in every patch or a coded refusal |
| E3 | P1 | confirmed (code + live measurement); **marked complete in the previous plan, never shipped** | `packages/entity/src/pg-write-sql.ts:132`; `repo.ts:113` | Every `insertAll`/`upsertAll` ends `returning *`. 100k rows × 4 columns: 3,755 ms and 100k rows decoded back, vs 961 ms for `COPY FROM STDIN` | `insertAll(rows, { returning: false }): Promise<number>` (and `upsertAll`), all drivers. Then check Bun's SQL client for a `COPY FROM STDIN` path: if present, `copyAll`; if absent, file the upstream ask and record it in [`90`](90-owner-decisions.md) |
| E4 | P2 | confirmed (grep); **marked complete in the previous plan, never shipped** | `packages/entity/src/plan.ts` (`MAX_PAGE_SIZE`) | A page is bounded by rows, never bytes: 10k × 1 MiB `jsonb` | `maxPageBytes`, measured on raw rows before decode, coded refusal naming `select()` and a smaller `limit` |
| E5 | P1 | confirmed (demo: `/messages` is 4 + N statements, ≤ 54); 2 adopters | `packages/entity/src/preload.ts`, `batch-read.ts` | No newest-row-per-group read | `latestBy(groupColumn, { order })` on the chain and `preload(rel, { perParent: n })`: one `DISTINCT ON` (or `LATERAL` for n > 1) statement; memory driver mirrors it |
| E6 | P2 | gap; 3 adopters (156, 63 `count(*)` literals) | `packages/entity/src/` aggregates (`countBy`, `series`, `sum` exist) | No filtered aggregate, no several measures in one statement | `countBy(col, { where })` and `aggregate({ name: measure, … })` rendering `count(*) filter (where …)`; one statement |
| E7 | P2 | gap; 1 adopter (34 `expectedSeqScan`), admin search ([`15`](15-admin-ui-testing.md)) | `packages/entity/src/registry.ts:125-145`; `pg-sql.ts` operators | `contains` renders `like '%x%'`, which no btree serves; no trigram index kind | index kind `using: 'trgm'` (`gin (col gin_trgm_ops)`; the migration emits `create extension if not exists pg_trgm`) and a case-insensitive `'contains'` operator that the plan sweep accepts only with that index: `X_QUERY_UNINDEXED` names the declaration |
| E8 | P3 | confirmed (read); 1 adopter (payload filters, 20,305 sequential scans) | `packages/entity/src/registry.ts:125-145` (`IndexDescription`) | No expression index (`unique(lower(email))`, a `jsonb` path), one direction per index, no `INCLUDE` | optional `expression`, per-column `order[]`, `include[]`; absent by default so no drift hash moves. `packages/db/src/index-ddl.ts` renders, `drift.ts` compares |
| E9 | P1 | confirmed (`$describe()` + schema dumps) | `packages/entity/src/column.ts:247` → `entity.ts:312-327`; dedupe only for identical lists (`:357-359`); the tenant index alone checks covering (`tenant-index.ts:45,61-65`) | A foreign-key column gets its own index even when the primary key, a declared index or a unique invariant already leads with it. A declared `(a)` beside `(a, b)` is never collapsed. Every write pays twice | one covering rule for every implicit index, exported from `tenant-index.ts`. On `main`: new declarations stop emitting the redundant index; existing ones are *reported* by `x doctor` and dropped by `x db gen --drop-redundant` (`drop index concurrently`). Making the drop the default waits on `next` |
| E10 | P2 | confirmed (reference app: `likePost` is 13 statements) | `packages/entity/src/row-observer.ts`, `counter.ts`; `examples/dummy/apps/web/app/posts/repo.ts:291-298` | A `countedIn` trigger write is invisible to the in-process row observer, so the reference app recounts per write and teaches it | after a write that fires a `countedIn` trigger, the observer emits `entity.row` for the target (memory driver mirrors). Overlaps the open slice `41-add-entity-lifecycle` of plan `2026/11/02/101`: finish it there, link here |
| E11 | P3 | gap; 2 adopters (15 `pg_advisory_xact_lock` literals) | `packages/entity/src/` (`lockKey`, single key) | No multi-key critical section | `lockKeys(keys, fn)`: sorted acquisition, one transaction, same hashing as `lockKey` |
| E12 | P3 | confirmed (read) | `packages/entity/src/query.ts:351` | `.all()` returns one page (default 50) and drops the cursor silently | on `main`: a dev/test warning event when a next cursor existed, surfaced by exercise as a finding. The coded refusal (→ `inBatches()` / `.limit(n)`) is a break: `next` |
| E14 | P2 | partial; **owner decision OD6** | `packages/entity/src/state-machine.ts:44` (CAS in transitions only); `packages/core/src/conflict-policy.ts` (client side) | No declared optimistic lock: a lost update needs a hand-written `updateWhere` filter | `entity({ version: 'lockVersion' })`: `update` conditions on it and increments it; a mismatch is `X_ENTITY_STALE` (409); the mutator carries the version. Both drivers + parity. An API on entities and mutators: not built until OD6 |
| E13 | P3 | gap; 1 adopter ("the entity layer takes no signal") | entity read path vs `packages/db/src/statement-cancel.ts` | Reads do not honour `ctx.signal` as writes do | reads pass through the same cancel funnel; verify first — the statement funnel may already cover it, in which case this row closes with a test only |

Checked and fine, not planned: `pg-sql.ts` binding and seek, `memory-match.ts` parity, `decodeRow` (1 µs per row), `coalesce.ts`/`jit-preload.ts` bounds.

## Files to change
- `packages/entity/src/query.ts`, `repo.ts`, `pg-driver.ts`, `pg-write-sql.ts`, `bulk-write.ts`, `bulk-write-send.ts`, `memory-repo.ts`, `define-driver.ts` — E1, E2, E3 (split `query.ts` write terminals into `query-write.ts`; it is near the ceiling).
- `packages/entity/src/plan.ts`, `pg-driver.ts` — E4.
- `packages/entity/src/preload.ts`, `batch-read.ts`, `latest-by.ts` (new), `memory-repo.ts` — E5.
- `packages/entity/src/aggregate.ts` (or its current home), `pg-sql.ts` — E6, E7.
- `packages/entity/src/registry.ts`, `describe.ts`, `entity.ts`, `tenant-index.ts`, `column.ts` — E8, E9.
- `packages/db/src/index-ddl.ts`, `entity-shape.ts`, `drift.ts` — E7, E8, E9 rendering and compare.
- `packages/entity/src/row-observer.ts`, `counter.ts` — E10. `packages/entity/src/lock.ts` — E11.
- `packages/testing/src/entity-driver-conformance*.ts` — one fixture per new method.
- `packages/entity/README.md`, `CLAUDE.md`; `wiki/` entity pages (docs worker).
- Coordinator only: new codes through `bun run new-error-code` (E2 mixed columns, E4 page bytes), changelog + `wiki/Upgrading.md`, `bun run manifest`, `bun run schema-dumps` after E9.

## Steps
1. Split across two sweeps (5a: E1–E4, E13; 5b: E5–E12, E14 if OD6 says ship): the file count passes 100 with tests and conformance.
2. 5a: conformance fixtures first, red on all three drivers; then memory, then Postgres. E3's number re-measured against the local test Postgres and recorded.
3. 5b: E9 before E8 (both touch `describe.ts`: one worker). After E9, `bun run schema-dumps --check` shows which tracked-app indexes become redundant; the app migrations are [`18`](18-tracked-apps.md)'s.
4. Correct the previous plan's record: a dated note in `docs/plans/2026/11/09/101-final-hardening-before-v31/07-entity.md` and its `status.yml` `notes` that E6/E7 there shipped here (coordinator).
5. Close the matching `wiki/Known-Gaps.md` rows in the same PRs.

## Tests
- `packages/entity/src/query-write.test.ts` — chain `update`/`delete` with `in`; empty predicate refused; another tenant's rows untouched.
- `packages/entity/src/pg-driver-bulk.live.test.ts` — `returning: false` returns a count and decodes nothing; `updateMany` of 1,000 rows is ≤ 2 statements (the `statements` fixture).
- `packages/entity/src/latest-by.test.ts` + live — 20 groups: one statement, the right row per group, ties broken by id.
- `packages/entity/src/describe-indexes.test.ts` — join table with a leading foreign key: no extra index; declared `(fk, x)`: none; unique `(fk, y)`: none; unique `(fk)`: kept.
- `packages/db/src/generate-index.live.test.ts` — expression, `INCLUDE`, mixed order and trigram round-trip through drift.
- Command: `bun test ./packages/entity/src/<file>.test.ts`; live suites need `docker/test-services.env`.

## Done when
- No `expectedQueryLoop` left in the tracked apps for a write that a chain terminal or `updateMany` expresses ([`18`](18-tracked-apps.md)).
- 100k-row `insertAll({ returning: false })` under half of 3,755 ms on the same box, recorded.
- `$describe()` of both tracked apps emits no index led by an existing one.
- Conformance green on memory, Postgres and a `defineDriver` double.

## Outcome

As of 2026-11-11, sweep 5a, for 31.9.0. Bun 1.4.4, local test Postgres 17 on loopback. E5–E12, E14: sweep 5b.

| # | Verdict | What shipped, or why not |
|---|---|---|
| E1 | shipped, renamed | `.updateAll(patch)` / `.deleteAll()` on the read chain (`query-write.ts`), not `.update()`/`.delete()`: `Table` already has `update(id, patch)`/`delete(id)` and must stay assignable to `ReadBuilder`. One plan builder for both spellings (`write-where.ts` `writeWherePlan`/`updateWherePlan`); `updateWhere`/`deleteWhere` pass the chain as `options.where`. A chain predicate valued `undefined` is `X_WRITE_UNFILTERED` (the filter still drops one); `limit()`/`after()`/`search()` are `X_INVARIANT_VIOLATED`. Removing `updateWhere`/`deleteWhere` still waits on `next` |
| E2 | shipped | `updateMany([{ id, patch }])` (`update-many.ts`, `pg-update-many-sql.ts`, `update-many-send.ts`): 1,000 rows = 1 statement (`pg-update-many-sql.test.ts`; live ≤ 2 in `update-many.live.test.ts`). `UPDATE … FROM (VALUES …)` as planned fails on typed columns — `VALUES` binds as text, "UNION types uuid and text cannot be matched" — so the source is typed from the table: `select … from t where false union all select $…`. No new code: `X_INVARIANT_VIOLATED` (uneven columns, a repeated id, a JS-only-invariant batch past `MAX_ASSERTED_ROWS`) and `X_PATCH_EMPTY` |
| E3 | shipped; the "under half" target met by `copyAll`, not by `returning: false` | 100k rows × 4 columns, typed handle, median of 5 at load 13–15: `insertAll` 2,880 ms · `insertAll({ returning: false })` 2,778 ms (0.74× the 3,755 ms baseline) · `copyAll` 1,073 ms (0.29×). An insert statement cannot reach half: sending the prebuilt statements alone is ≈1.9 s. Re-run at load 21–28 after `instantText` stopped building its refusal per value: `returning: false` / `returning *` = 0.69–0.73 (0.96 before). COPY exists on Bun 1.4.4 ([`03`](03-db.md) D7): `copyIn`/`canCopyIn` in `@ultimat3/db` (`copy-in.ts`); no upstream ask. The bench probe was not committed; `pg-copy.live.test.ts` and `pg-driver-bulk.live.test.ts` hold the behaviour |
| E4 | shipped | `MAX_PAGE_BYTES` = 64 MiB, a constant (`page-bytes.ts`), weighed before decode on Postgres and on the projected page in memory and `defineDriver`; `X_ENTITY_PAGE_TOO_LARGE` (500) names the heaviest column, `.select({ … })` and a `.limit(n)` that fits. Heaviest real page across both tracked apps' suites: 16,560 B (120 `users` rows), the bound ≈ 4,000× over it. Cost: 3–4 µs per 51-row page, 11–12 µs with a small `jsonb` per row (re-run 2026-11-11). `inBatches` halves on the refusal (`batch-bytes.ts`), so reindex and history sweeps over large rows finish |
| E13 | closed with a test | no wiring: an entity read goes out through `@ultimat3/db`'s pooled funnel, whose `watchAbort` (`statement-cancel.ts`) cancels it on the server — `pg-read-cancel.live.test.ts`, `X_ABORTED` within 200 ms. By db's design a read sent in an already-aborted scope runs (cleanup reads in `finally`) and a pinned-transaction read is not cancelled (that is the transaction guard's call); memory and `defineDriver` agree |

The previous plan's record is corrected in [`../../09/101-final-hardening-before-v31/07-entity.md`](../../09/101-final-hardening-before-v31/07-entity.md). Its `status.yml` `notes`: coordinator.
