# 11 — Migrations: one engine. Backfills: a first-class pattern.

> Part of [`overview.md`](overview.md). Depends on: 01 (advisory-lock fix), 07 (`inBatches` powers backfill batching). Tiers: 1 (`db`), 3 (`jobs`), 5 (`cli`).

Environments: migrations run everywhere — local, CI, staging, production. Backfills run in
staging/production (locally only to test them). Both must be one engine per concern (axiom 1).

## Part A — unify the migration engine (bug: two engines exist today)

- **Production** (`ROLE=migrate`, `packages/cli/src/serve.ts:143-151`) applies migrations through `@ultimat3/db`'s own `migrate()` — `x_migrations` ledger, checksums, app-version fence, advisory lock (`packages/db/src/migrate.ts:153`).
- **Local/CI** (`x db gen|migrate|reset`, `packages/cli/src/cmd-db.ts:111-165`) shells out to `bunx drizzle-kit` — a second engine with its own journal, while `generateMigration()` (`packages/db/src/generate.ts:263`) already diffs entity snapshots natively. Two ledgers for "what has run" = guaranteed divergence; likely a contributor to the reference app's pinned `drift` step.
- Fix: `x db gen` calls `generateMigration()`; `x db migrate`/`reset` call `migrate()` — the same engine `ROLE=migrate` runs, so local, CI, staging and production share one ledger and one answer. Remove the drizzle-kit shell-outs (and the implied dependency); `x db studio` gets a non-drizzle answer or moves to `cmd-planned.ts` with a runnable fix (never silently keep a second engine for one subcommand).
- Drift detection (`checkDrift`, `packages/db/src/introspect.ts`) stays the post-migrate verification in both paths.
- Safety rail (the strong-migrations idea, enforced not documented): `generateMigration` flags destructive operations (drop column/table, type narrowing) — emitting them requires an explicit `destructive: true` marker in the migration file; `x verify`'s `drift` step refuses unmarked destructive SQL. New code `X_MIGRATION_DESTRUCTIVE` with the marker as the fix.

## Part B — backfills as a factory over `job`

No ninth primitive: `backfill()` is a factory over `job` (the `llm()` shape,
`packages/ai/src/llm.ts:108-121`) in `packages/jobs/src/backfill.ts`. A backfill is a job with
four framework-supplied guarantees the author no longer hand-rolls:

1. **Batched + resumable.** Iterates `inBatches` (07) with the cursor checkpointed through `step.run` per batch — a killed backfill resumes at the last completed batch, not row zero. Steps already give replay (`packages/jobs/src/steps.ts`).
2. **Once per environment, tracked like migrations.** An `x_backfills` ledger mirroring `x_migrations` (`packages/db/src/migrate.ts:12,73-96` — `ensureLedger`/`readLedger` are the pattern): one row per backfill with name, checksum of the definition, started_at/completed_at, app version, rows processed, last cursor, status (`running|completed|failed`). Re-enqueueing a completed backfill is a no-op with a report; `--force` reruns and records a new row (history preserved, never overwritten — reruns are visible). A checksum change on a completed name is a warning, same as a migration edited after applying. Inspect: `x db backfill --list` prints the ledger (and `--json`), the same way the migration ledger is readable.
3. **Throttled.** `rate` option (batches/sec) so production backfills don't saturate the pool; default conservative.
4. **Observable.** Progress (rows done / cursor position) written to the ledger row; surfaced in `x jobs` output and the `/_x` jobs panel.

Declaration shape (entity vocabulary, not SQL):

- `backfill({ name, source: <entity or ReadBuilder>, batch: 500, rate, handle: (rows, step) => … })` → returns a `Job`; projects like one (enqueue, inspect, test) — the job template's comment (`packages/cli/src/templates/job.ts:122`) already calls `.enqueue()` "the backfill path"; this makes that true.
- Run it: `job.enqueue()` in staging/production (release checklist step, or an `x db backfill <name>` alias on cmd-db); locally in tests via the jobs fixture.
- Generator: `x g backfill <name>` scaffolds the file + test (follow `x g job`).

## Docs

- `wiki/Migrations-And-Backfills.md`: the one-engine story per environment (local/CI/staging/prod all through the ledger), `ROLE=migrate` as the release phase, destructive-marker rule, the `backfill()` contract, when to write a migration vs a backfill (schema vs data), staging-first rollout advice.
- `docs/ops/` runbook entry: running and monitoring a production backfill.

## Tests

- Engine unification: `x db migrate` and `runMigrations` produce identical ledger rows (one test through each path against the same migration set); drizzle-kit absent from the repo (`grep` gate in the test).
- Destructive rail: a generated drop-column migration without the marker fails verify with `X_MIGRATION_DESTRUCTIVE`.
- Backfill: kill mid-run → resume completes without reprocessing (idempotency via cursor checkpoint); completed ledger row blocks re-run; `--force` reruns; rate limit honored (fake clock).
- Commands: `bun test packages/db/src/migrate.test.ts`, `bun test packages/jobs/src/backfill.test.ts`, live: `TEST_DATABASE_URL=… bun test packages/db`.

## Done when

- One migration engine, one ledger, all four environments; drizzle-kit gone; destructive rail enforced.
- `backfill()` ships with ledger/resume/throttle/progress; reference app gains one real backfill (e.g. recompute `likeCount`) exercised in its job suite.
- New codes registered + documented + `bun run manifest`; `bun run verify` green.
