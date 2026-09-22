# 04 — Append-only entities

> Part of [`overview.md`](overview.md). Depends on: none. Tiers: 1 (`db`), 2 (`entity`).

Rule: `entity({ appendOnly: true })` makes UPDATE and DELETE impossible on three layers, all
derived from that one flag: the generated trigger, the repo type, and the repo at runtime. Audit,
evidence and ledger tables stop needing a hand-written migration.

Grants (`REVOKE UPDATE, DELETE ... FROM <runtime role>`) stay out of scope. Role names are
deployment facts the framework does not know (axiom 7). The trigger holds even for the owner role,
which is the property that matters. A role split is recorded in `Known-Gaps` (slice 13).

## Files to change
- `packages/entity/src/entity.ts:65-93` — `readonly appendOnly?: boolean` on `EntityInit`, projected into the snapshot. Doc comment: "no UPDATE, no DELETE, no soft-delete column; corrections are new rows".
  - `appendOnly` together with `.softDelete()` or a `transition()` state machine is refused at definition time with `X_ENTITY_APPEND_ONLY`, because both imply an UPDATE.
- `packages/entity/src/repo.ts:95-130` — for an `appendOnly` entity, the repo type omits `update`, `updateWhere`, `delete`, `deleteWhere` and `upsertAll` with `onMatch: 'update'`. `insert`, `insertAll` and `upsertAll({ onMatch: 'nothing' })` remain. This is done with a conditional type on the entity brand; a `repo.update` must be a `TS2339`.
- `packages/entity/src/pg-write-sql.ts`, `memory-repo.ts` — runtime refusal `X_ENTITY_APPEND_ONLY`, for callers reaching the SQL through a cast or a generic helper. `memory-repo` gets the same check so dev matches Postgres.
- `packages/entity/src/errors.ts` — `X_ENTITY_APPEND_ONLY`, fix: "insert a correcting row; append-only tables never change a written row".
- `packages/db/src/introspect.ts:75-120` — `TableDescription.appendOnly?: boolean`, read from `pg_trigger` joined to `pg_proc`, keyed by the framework's trigger name `x_append_only_<table>`. It is absent in older sidecars, following the `checks` precedent at `:82-88`.
- `packages/db/src/generate.ts` — when the snapshot flips to `appendOnly`, emit:
  - the shared function once per schema: `create or replace function x_refuse_mutation() returns trigger language plpgsql as $$ begin raise exception 'X_ENTITY_APPEND_ONLY: % on %', tg_op, tg_table_name using errcode = 'P0001'; end $$`;
  - `create trigger x_append_only_<table> before update or delete on <table> for each row execute function x_refuse_mutation()`.

  Also emit a `truncate` statement-level trigger, since truncate bypasses row triggers. The `down` drops both. Each statement is separate, per the one-statement rule (`wiki/Migrations-And-Backfills.md` §migrate).
- `packages/db/src/drift.ts:216` area — `compareAppendOnly(live, expected)`: a declared-append-only table without the trigger is a difference, `X_APPEND_ONLY_TRIGGER_MISSING`. Only the declared side is judged, the rule `compareIndexes` states at `:65`.
- `packages/db/src/sqlstate.ts` — map `P0001` with the `X_ENTITY_APPEND_ONLY:` message prefix back to the entity error, so a trigger hit surfaces as the coded error rather than a raw driver error.
- `packages/entity/README.md`, `packages/db/README.md` — one section each.

## Steps
1. Add the entity option, the type narrowing and the runtime refusal, with tests on memory and PGlite.
2. Add introspection of the trigger, then generation, then drift.
3. Pin `generate` output with a snapshot test, and prove it on PGlite. The trigger and `raise` were probed working on PGlite 0.5.4, 2026-09-22.

## Tests
- `bun test packages/entity/src/repo.test.ts packages/db/src/generate.test.ts packages/db/src/drift.test.ts`.
- A type test (`type-pins.ts` pattern): `repo.update` on an append-only entity does not compile.
- PGlite: insert, then `update` via raw SQL raises. The error maps to `X_ENTITY_APPEND_ONLY`. `truncate` raises too.
- Drift: drop the trigger by hand, and `x verify` `drift` reports `X_APPEND_ONLY_TRIGGER_MISSING`.
- Serialized appends (hash-chain use case): a `transaction()` holding `pg_advisory_xact_lock` plus insert works on PGlite. No framework change, but add a test so it stays true.

## Done when
- An app declares `appendOnly: true`, runs `x db gen`, and gets the trigger with a valid sidecar. No hand migration is needed.
- Drift is green with the trigger and red without it.
