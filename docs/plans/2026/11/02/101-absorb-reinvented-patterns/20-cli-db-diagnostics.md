# 20 — `x db diagnostics`

> Part of [`overview.md`](overview.md). Depends on: none. [`04-db-migration-safety.md`](04-db-migration-safety.md) relies on the fix line changed here. Tier: 1 (`db`), 5 (`cli`).

## Why
Six adopters run a Postgres dashboard tool. Nothing here answers slow queries, unused indexes, dead tuples or blockers: `db/src/db-health.ts:17` is one timed `select 1`, `x doctor` asks about configuration, and the `pg_stat_activity` in `core/src/probe-database-sweep.ts:78` drops test databases. An agent's route today is hand-written catalog SQL on `psql`, and `X_DB_LOCK_TIMEOUT` hands out exactly that. The queries are the same for a bank and a blog.
Proved 2026-11-02 through `readOnlyQuery` on Postgres 17 and on PGlite: activity, blockers, unused indexes, invalid indexes, `NOT VALID` constraints and dead tuples all answer on both; `pg_stat_statements` is `42P01` on both, surfacing as `X_DB_SCHEMA_STALE`. So absence must be a reported state, never a failure.

## Decisions
| Candidate | Outcome |
|---|---|
| `x db query --readonly` | **killed.** `db.query` over `x mcp serve` is that path: parse guard (`mcp/src/readonly-sql.ts:80`), SELECT-only role, read-only transaction, caps (`mcp/src/dev-server.ts:252`). A CLI twin is a second door for one adopter. Its derived sealed-column refusal defends nothing: a sealed column holds ciphertext (`wiki/Entities-And-Migrations.md:518`), and the hand-kept map covers that app's own columns, a business list |
| Thresholds, or a gate | none. Facts only; exit 0 whatever they say. "How bloated is too bloated" differs per app, and a verdict on production load would make `x verify` depend on a live database |
| A bloat estimate | no. Catalog estimates are guesses; dead tuples and last autovacuum are facts |
| `CREATE EXTENSION` for the user | no. Reported `unavailable`, with the fix |
| Name | `x db diagnostics`. `db/src/db-health.ts` is the readiness probe `/readyz` reads; "health" would name two different things |
| Admin `database` screen | deferred, a follow-up: the function in `db` is what a later screen reads, with no second query set |

## Files to change
- `db/src/db-diagnostics.ts` (new; `db-health.ts` stays the readiness probe, and `DbHealthReport` keeps its meaning) — `dbDiagnostics(options)`.
- `db/src/index.ts:41` — explicit export of `dbDiagnostics` and `DbDiagnostics`.
- `cli/src/cmd-db-spec.ts:7,23` — `diagnostics` subcommand; summary and usage strings.
- `cli/src/cmd-db.ts:69` — `runDiagnostics`, `--json`, connects as `x db migrate` does.
- `cli/src/db-diagnostics.ts` (new) — the terminal rendering.
- `db/src/errors.ts:226`, the `X_DB_LOCK_TIMEOUT` fix: `x db diagnostics --json` replaces the raw `psql`; `wiki/Error-Codes.md:267`, `docs/ops/06-runbooks.md`.
- `wiki/CLI-Reference.md:33,399`, `wiki/Observability.md`, `packages/db/README.md`, `packages/db/CLAUDE.md`, `packages/cli/CLAUDE.md`.
- No reference-app use needed: not primitive-level.

## Steps
1. `dbDiagnostics({ client?, limit? })` answers `{ blockers, activity, slowQueries, unusedIndexes, invalidIndexes, notValidConstraints, deadTuples }`, each `{ available: true, rows } | { available: false, reason, fix }`. Each section is one statement through `readOnlyQuery` (`db/src/readonly-query.ts`), `timeoutMs` 2,000, `maxRows` = limit (default 20), each failing alone: one timeout does not lose the other six.
2. `unusedIndexes` excludes unique and primary, since they enforce. It carries `pg_stat_reset` age, because a stat counted since last week is not "unused". Reported alongside: replica counters are per server.
3. `slowQueries` reads `pg_stat_statements` when `pg_extension` lists it; otherwise `available: false`, fix: `create extension pg_stat_statements` plus `shared_preload_libraries`, in the database, by the operator. Query text is what the server normalised: no bound values.
4. `activity` under a role without `pg_read_all_stats` shows other sessions' query as hidden. Reported as a field, not an error.
5. `x db diagnostics --json` prints `data`; plain output is one table per available section. Exit 0, except when no connection opens: existing `X_DB_UNAVAILABLE`.

## Error codes
None new. `X_DB_UNAVAILABLE` (existing) when no connection opens. A section's failure is data, never a thrown error.

## Tests
- `db/src/db-diagnostics.test.ts` (recording client): seven statements, each read-only and capped; a section throwing leaves six; absent extension is `available: false`.
- `db/src/db-diagnostics.live.test.ts`: a real blocker held on a second connection appears with `blocked_by`; a real `not valid` constraint appears; an unused index appears, a unique one does not. Mutation: drop the `indisunique` filter.
- `cli/src/cmd-db.test.ts`: `--json` shape, `--help`, spec row reachable; `errors` step resolves the new fix line.
- `x test live`; `bun test packages/db/src/db-diagnostics.test.ts`.

## Semver
minor.

## Done when
- `x db diagnostics --json` answers against Postgres and against the embedded database, with `slowQueries.available` false on the latter.
- `X_DB_LOCK_TIMEOUT`'s fix runs and names the blocking pid.
