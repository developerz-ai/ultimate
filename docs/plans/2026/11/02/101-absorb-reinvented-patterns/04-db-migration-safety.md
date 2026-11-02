# 04 — Migrations a rolling deploy survives

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 1 (`db`), 2 (`entity`), 5 (`cli`). [`05-entity-tenant-and-locks.md`](05-entity-tenant-and-locks.md) uses the deferred key phase designed here. [`20-cli-db-diagnostics.md`](20-cli-db-diagnostics.md) owns the `X_DB_LOCK_TIMEOUT` fix text.

## Why
One adopter had three wedged deploys; three hand-rolled a rolling-deploy guard (one 392 LOC). Reproduced 2026-11-02 on Postgres 17 (RAM disk, 1M child rows; a real disk stalls longer):

| Probe | Printed |
|---|---|
| FK as `x db gen` writes it | worst concurrent insert stall 188 ms |
| `not valid`, then `validate constraint` | stall 1 ms, 1 ms (validate took 165 ms, writes kept flowing) |
| CHECK, plain vs `not valid` + validate | 75 ms vs 1 ms, 1 ms |
| `migrate()` with one reader holding the table for 5 s | `X_DB_LOCK_TIMEOUT` at 3015 ms, deploy failed, no retry |
| N-1 entity after a generated drop: read and insert | both `X_DB_SCHEMA_STALE`: the projection names every declared column (`entity/src/pg-sql.ts:357`) |

The last is worse than unenforced: **no zero-downtime column drop exists.** Deleting a column from the entity generates the drop in the same release (`db/src/generate.ts:355`), and keeping it declared keeps it selected. `docs/ops/01-kubernetes.md:217` says "Nothing enforces this"; `wiki/Entities-And-Migrations.md:727` promises it anyway.

## Decisions
| Question | Answer |
|---|---|
| NOT NULL without default | already handled: added nullable with a backfill comment (`db/src/column-alter.ts:70`, `db/src/generate.ts:225`). Out of scope |
| New enum member refused by N-1 pods | reproduced (`X_INVARIANT_VIOLATED`), **not railed**: adding a member nobody writes yet is safe, and no file says when the first write ships. A rail would fire on every widening. A row in the expand/contract table, no gate |
| How to retire a column | `retired: ['legacy']` on the entity, column gone from `columns`. No `.retired()` chain: leaving `columns` removes it from the row type, projection and inserts with no type machinery |
| Release boundary | no git tags. Static: the retire migration precedes the drop. Runtime: both pending together on a live production database is refused |
| Where a key on a live table is added | the deferred step, never the transaction. A key may need a unique index only that step builds (slice 05), so `not valid` in the transaction would be `42830`. One path for every such key |
| Dropping a retired column and `--allow-destructive` | **the flag stays required.** Rows still go; retiring is not consent to losing them. No second exception in the `X_MIGRATION_IRREVERSIBLE` gate |

## Files to change
- `db/src/foreign-key.ts:95` — `addForeignKey(table, key, { notValid })`; new `validateConstraint(table, name)`.
- `db/src/concurrent-plan.ts:22` — `DeferredKey { table, name, recorded? }` beside `DeferredIndex`.
- `db/src/concurrent-plan.ts:34,52` — `ConcurrentPlan.keys`, `.validate`, `.deferredKeys`. `stepStatements` order: index builds, key adds, validates, contract.
- `db/src/concurrent-plan.ts:158` — `intermediateSnapshot` also takes the deferred keys: the transactional step's snapshot lacks each new key and keeps what it replaces.
- `db/src/foreign-key-plan.ts:117,124` — a new or rebuilt key on a table in `live` goes to the deferred phase. A table created in this migration keeps the plain transactional form, unless its target's index is deferred. The retype re-add (`predropped`) stays transactional: it holds ACCESS EXCLUSIVE for the rewrite already.
- `db/src/foreign-key-plan.ts:145` — a recorded key whose column a deferred key now covers is dropped in the contract phase, not the transaction.
- `db/src/check-ddl.ts:130,147` — CHECK needs no index, so `not valid` in the transaction and validate deferred.
- `db/src/generate-steps.ts:53,77` — pass deferred keys through to `intermediateSnapshot`.
- `db/src/ungeneratable.ts:48` — add the `validate constraint` form, or the generator trips `X_MIGRATION_UNGENERATABLE`.
- `db/src/drift-findings.ts:13`, `db/src/introspect-catalog.ts:112` — read `convalidated`; new `DriftKind` `not-valid-constraint`, repair is the validate statement.
- `db/src/migrate.ts:238,331` — retry the step on `X_DB_LOCK_TIMEOUT`.
- `entity/src/entity.ts:50`, `entity/src/describe.ts` — `retired?: readonly string[]`, physical names, on the description.
- `db/src/entity-shape.ts:18`, `db/src/generate.ts:75,355` — a retired column stays in the snapshot with `retired: true` (absent otherwise) and emits `-- retires "t"."c"`; a recorded retired column leaving the list emits the drop under `-- contracts "t"."c"`.
- `db/src/generate.ts:360` — `X_MIGRATION_IRREVERSIBLE`'s fix stops saying "deprecate it" and names `retired`.
- `db/src/rolling.ts` (new, beside `destructive.ts`), `cli/src/db-rolling.ts` (new, beside `db-destructive.ts`), `cli/src/verify-checks.ts:194` — the fifth rail in the `drift` step.
- `cli/src/verify-floor.ts:70`, `cli/src/templates/scaffold-repo.ts:471` — `rollingSince` read; the scaffold writes it.
- `cli/src/doctor-rolling.ts` (new), `cli/src/cmd-doctor.ts:15` — the unset case.
- `cli/src/cmd-db-spec.ts`, `cli/src/db-generate.ts` — `--rolling-unsafe`.
- `wiki/Migrations-And-Backfills.md:99,208`, `wiki/Entities-And-Migrations.md:727,799`, `docs/ops/01-kubernetes.md:217`, `docs/ops/06-runbooks.md:136`, `wiki/CLI-Reference.md:399`, `wiki/Upgrading.md`, `packages/db/README.md`, `packages/db/CLAUDE.md`, `packages/entity/README.md`.
- `examples/dummy/packages/db/src/schema/` — one nullable column added, then retired, across two migrations; both tracked apps' `x.verify.json` set `rollingSince`.

## Steps
1. Deferred key phase, in the `_concurrently` step, each statement in its own short transaction under `lock_timeout` (`db/src/migration-step.ts:116`): `drop constraint if exists` + add `not valid`, then `validate constraint`. The drop-if-exists keeps the step re-runnable (`add constraint` has no `if not exists`); an old key under another name holds until contract. Orphan rows surface as the existing `X_DB_FOREIGN_KEY_VIOLATION`; the old release keeps serving.
2. Whole order for a key needing an index: build index, add key `not valid`, validate, drop old key. `down`, reversed at assembly: restore old key, drop new key, drop index.
3. Snapshot fact: `DeferredKey` makes the first file's snapshot true while the second is pending, as `DeferredIndex` does for an index. Without it, a failed second step leaves a ledger claiming a key the catalog lacks, and the next `x db gen` would not re-emit it.
4. `MigrateOptions.lockRetries`, default 5, screened by `finiteCount`; delay at least one `lockTimeoutMs` so the queue behind the ALTER drains, with jitter. One wrap around `applyMigrationStep`: a transactional step rolled back whole, a non-transactional one is idempotent by contract (`db/src/migration-step.ts:99`). A warn line per attempt. Exhausted is `X_DB_LOCK_TIMEOUT`, its cause stating the attempts.
5. `retired`: `x db gen` refuses a name the snapshot does not record, or a NOT NULL column with no default (new pods' inserts would fail). Otherwise writes a marker-only migration. A no-op migration already reaches its ledger row (`db/src/migration-step.ts:37`).
6. `generate.ts:356`, order matters: a removed column not recorded `retired` throws `X_MIGRATION_ROLLING_UNSAFE` first, with or without the flag. A recorded one then meets the existing `X_MIGRATION_IRREVERSIBLE` until `--allow-destructive`, and the destructive marker is written as today (`db/src/generate-steps.ts:33`). `--rolling-unsafe` writes `-- rolling-unsafe: true` for an app that stops before it starts (one instance, `strategy: Recreate`).
7. Rail `rollingUnsafeStatements(up)`, closed list: `drop-column` with no earlier `-- retires` for that name, `rename-column`, `rename-table`. Same lexical path as `destructive.ts:78`, marker read by `db/src/marker-line.ts`.
8. `rollingSince: "<migration id>"` in `x.verify.json` bounds the rail, since an applied migration cannot gain a marker (checksum). `x new` writes `"0"`, judging everything. **Unset: the rail does not run**, and `x doctor` prints one line naming the newest id to set. Never a red `drift` on an existing app.
9. Runtime: `migrate()` refuses before the first BEGIN when a `-- retires` and its `-- contracts` are both pending, the ledger is non-empty and the environment is production. A fresh database (template, branch) replays freely.

## Error codes
`bun run new-error-code` for the new one, `--off-socket`.

| Code | When | Fix |
|---|---|---|
| `X_MIGRATION_ROLLING_UNSAFE` (new, `db`) | a drop or rename old pods would still read, or retire and contract in one deploy | `entity('<t>', { retired: ['<c>'] })`, `x db gen "retire <c>"`, deploy, then remove it from `retired` and `x db gen "drop <c>" --allow-destructive` |
| `X_DB_LOCK_TIMEOUT` (existing) | retries exhausted | `x db diagnostics --json` (slice 20) |
| `X_DB_DRIFT` (existing) | a constraint left `NOT VALID` | `x db migrate --json`: the validate step re-runs |
| `X_DB_FOREIGN_KEY_VIOLATION` (existing) | validate finds orphans | existing fix |

## Tests
- `db/src/foreign-key-plan.test.ts`, `db/src/check-ddl` pins: live table's key lands in the deferred phase in order; new table stays plain; new table over a deferred target index defers; retype stays transactional. Mutation: drop the `live` branch.
- `db/src/concurrent-plan.test.ts`: `intermediateSnapshot` lacks the new key and keeps the replaced one; `stepStatements` order, both directions.
- `db/src/generate-rolling.test.ts`, `db/src/rolling.test.ts`: refusal order; **the printed path end to end**: retire, then remove without the flag is `X_MIGRATION_IRREVERSIBLE`, with it the drop plus markers; a mention in a comment or literal is no statement.
- `db/src/migrate-lock-retry.live.test.ts`: reader held past one timeout, migrate succeeds; held past all attempts, `X_DB_LOCK_TIMEOUT`.
- `entity/src/retired.live.test.ts`: two entity versions on one table across the drop, the probe above inverted.
- `db/src/foreign-key-online.live.test.ts`: orphan row fails validate; drift reports the unvalidated state; re-run after repair passes; old key held throughout a swap, under concurrent writes.
- `cli/src/db-rolling.test.ts`: rail, `rollingSince`, unset is silent there. `cli/src/doctor-rolling.test.ts`: unset prints the line. Scaffold test: `x new` writes `"0"`.
- `bun test packages/db/src/rolling.test.ts`, `x test live`.

## Semver
**Breaking, one thing:** `x db gen` refuses to drop a column not retired first. Upgrading: "A column drop now takes two releases: `retired: ['<c>']` and `x db gen`, deploy, then remove it and `x db gen --allow-destructive`. One instance that stops before it starts: `--rolling-unsafe`. Optional: set `rollingSince` in `x.verify.json` to your newest applied migration id; `x doctor` reminds you." Everything else is minor: applied migrations and their checksums do not move, and an existing app's `drift` stays green.

## Done when
- `x db gen` on a live table writes the key into the `_concurrently` step and a CHECK as `not valid` + validate; a new table's SQL is byte-identical to today.
- A key whose index is built in the same deferred step applies with no `42830`, proven live.
- The probe's 5 s reader no longer fails `migrate()`; `docs/ops/01-kubernetes.md` no longer says nothing enforces this.
- A column drops across two releases, following the printed fix verbatim, with no `X_DB_SCHEMA_STALE` from either entity version, proven live.
- Both tracked apps pass `bun run scripts/reference-app-gate.ts`.
