# 02 — DB: the whole schema as one generated, readable file set

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 1.

Rule: the current schema exists as committed SQL — deterministic, split into small files, written
by a command and never by hand. It is a projection of the migrations (axiom 2), held equal to
them by the gate, the way `framework.manifest.json` is held equal to the code.

Evidence: today the schema an agent can read is spread over every entity file plus the newest
migration's `.snapshot.json` sidecar (`wiki/Migrations-And-Backfills.md:50`), and a fresh
database is built by replaying every migration (`packages/cli/src/cmd-db.ts:224`). Introspection
(`packages/db/src/introspect.ts`) reads tables, columns, indexes and keys, and nothing reads
triggers, functions, views or extensions — objects a hand-written migration creates and plan 102
slice 04 (append-only triggers) is about to add. One surveyed app carries 127 migrations and
committed its schema as numbered directories of ≤500-line SQL files for exactly this reason: a
one-table change is a one-file diff, and a new database loads the schema instead of its history.

## Files to change
- `packages/db/src/introspect.ts` — extend to extensions, enum and domain types, sequences,
  views and materialized views, functions, triggers. Catalog queries only; no `pg_dump`, no new
  dependency.
- `packages/db/src/` (new `schema-dump.ts`, `schema-load.ts`) — render and load.
- `packages/db/src/drift.ts` — two new findings: the dump differs from the migrated database;
  an object exists that no migration created.
- `packages/cli/src/cmd-db.ts`, `packages/cli/src/cmd-db-spec.ts:19` — `x db gen` and
  `x db migrate` rewrite the dump; `x db reset` and the test database load it.
- `packages/cli/src/templates/` — the scaffold's `packages/db/schema/` and its `.gitattributes`
  line marking it generated.
- `packages/db/README.md`, `packages/db/CLAUDE.md`.

## Steps
1. Layout under the app's `packages/db/schema/`, one directory per object kind in dependency
   order, so loading in path order always works:

| Directory | Holds |
|---|---|
| `01_extensions/` | `create extension` |
| `02_types/` | enums, domains |
| `03_sequences/` | sequences not owned by a column |
| `04_tables/` | one file per table: columns, defaults, checks, primary key |
| `05_indexes/` | per table |
| `06_foreign_keys/` | per table; after every table exists |
| `07_views/` | views, materialized views |
| `08_functions/` | functions |
| `09_triggers/` | per table |

2. **Deterministic.** Same database, same bytes: objects sorted by name, columns in ordinal
   order, one canonical spelling per type and default, no timestamps, no server version, no
   owner or grant noise. Two dumps of one database are byte-identical; assert it.
3. **One object per file where an object has a name** — a table's file is `04_tables/<table>.sql`.
   A file over the 500-line ceiling the `filesize` step already holds for source is split
   `<table>.1.sql`, `<table>.2.sql` rather than exempted.
4. Framework tables (`x_jobs`, `x_api_keys`, …) are dumped too, under a `framework/` twin of the
   same layout: they are in the database, an operator debugging a queue reads them, and
   `FRAMEWORK_SCHEMA` (`packages/cli/src/framework-schema.ts:30-94`) stays their one source.
5. **Enforced.** `X_SCHEMA_DUMP_DRIFT` on the `drift` step when the committed dump is not what
   the migrations produce; fix `x db gen` or `x db migrate`. The check migrates a scratch
   database (PGlite, already what `x verify` uses) and compares bytes.
6. **Load equals replay.** A database built by `schema-load` and one built by replaying every
   migration must introspect identically. That equality is a test in this package and a check
   in the `drift` step; without it the dump is a second source of truth, and with it the dump is
   a cache of the first.
7. `x db reset` and the test preload build from the dump, then stamp the migration ledger with
   every migration as applied. Measure reference-app test setup before and after and state both
   numbers in the PR; if the dump is not faster, keep replay and ship steps 1–6 only.
8. The `.snapshot.json` sidecar stays: it is the generator's diff base in the entity vocabulary.
   The dump is what the database holds, in SQL. Different questions; say so in both READMEs.
9. Postgres only. The framework is Postgres with no ORM; a multi-database adapter layer is the
   surveyed tool's concern, not this one's.
10. Not taken from the surveyed tool: storing schema versions in a table with a browsing UI. The
    migration ledger with checksums already answers "what is deployed", and git answers "what
    was it before". The `/_x` database panel links to the dump.

## Tests
- `packages/db/src/schema-dump.test.ts`: byte-identical across two runs; a renamed column
  changes exactly one file; each object kind round-trips.
- `packages/db/src/schema-load.contract.test.ts`: load(dump) and replay(migrations) introspect
  equal, on PGlite and on Postgres, for the reference app's migrations.
- `packages/db/src/drift.test.ts`: a hand-created trigger with no migration is reported; a stale
  dump is `X_SCHEMA_DUMP_DRIFT`.
- Command: `bun test packages/db/src/schema-dump.test.ts`.

## Done when
- `examples/dummy/packages/db/schema/` and the demo app's are committed and the `drift` step
  holds them.
- Editing a file under `schema/` by hand turns `x verify` red with the command that regenerates it.
- `X_SCHEMA_DUMP_DRIFT` has its `wiki/Error-Codes.md` row.
