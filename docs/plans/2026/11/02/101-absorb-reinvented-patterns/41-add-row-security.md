# 41 — The database refuses another tenant's row

> Part of [`overview.md`](overview.md). Depends on: [`05-entity-tenant-and-locks.md`](05-entity-tenant-and-locks.md), [`29-data-pg-pooler.md`](29-data-pg-pooler.md), [`41-add-reads.md`](41-add-reads.md) (the read-transaction helper and the `setLocal` seam). Tier: 1 (`db`), 2 (`entity`), 5 (`cli`, `testing`).

## Why
Tenancy is enforced at the repository (`entity/src/pg-driver.ts:193`, `X_TENANCY_UNSCOPED`). A raw `sql` statement, a report, a hand-written join or a future bug sits above that seam, and the failure is one customer reading another's rows. A bank's auditor asks for a second layer by name, and a team cannot add one today: policies are named in `unrendered.sql` and never in the dump (`db/src/catalog-objects.ts:197-214`, `wiki/Migrations-And-Backfills.md:187`). A test database loaded from the dump therefore has no policies, so a hand-written policy is untested and prod-only.

Not a second way: the same `tenant:` declaration (`entity/src/entity.ts:53`) gains a second enforcer. Authors write nothing new per query. Off by default: it costs a transaction per statement and a role change, and neither is free for a blog.

## Decisions
| Question | Answer |
|---|---|
| Switch | `database.rowSecurity: true` in `app.config.ts` (`core/src/config.ts:219`): whole app, every `tenant:` entity. Per-entity would leave the holes this exists to close |
| Setting | `set_config('x.tenant', $1, true)` through `setLocal` (41-add-reads), local to the transaction. Parameter bound, never concatenated. Safe in pooler transaction mode for that reason |
| Statements outside a transaction | wrapped in one when the actor has a tenant. Accepted cost: measured and stated in the docs |
| `crossTenant()` | sets `x.cross = 'on'` in the same way (`entity/src/cross-tenant.ts`). A malicious raw `set_config` can still lift it: this layer catches forgetting, not hostile SQL in the app's own process, and the docs say so |
| Who is subject | Postgres exempts superusers and `bypassrls` roles, and owners unless forced. So `force row level security`, a serving role that is none of these, and `X_DB_ROW_SECURITY_BYPASSED` at boot otherwise |
| Roles, on every engine | two. App role: `nosuperuser nobypassrls`, owns nothing, serves. Migrator: `bypassrls`, owns the tables, runs `ROLE=migrate`, so a backfill or a key validate under the forced policy still sees every row. Probe: PGlite's default role is a superuser, and forced row security returned 2 of 2 rows. The test services' user `ultimate` is a superuser too (`docker/docker-compose.test.yml:50`). Unchanged, both would see everything and the boot check would refuse the app |
| PGlite | `db/src/pglite.ts` creates `x_app` and `x_migrator` when the flag is on and `set role x_app` on its one session; the migrate path holds `x_migrator` for its scope. A flag-on app needs no flag-specific test setup |
| Test services | `testing/src/template-db.ts` creates the same two roles as `ultimate` and connects flag-on suites as `x_app`. `ultimate` stays bootstrap only |
| Production | names are the operator's: a serving role's `DATABASE_URL` is the app role, `ROLE=migrate`'s the migrator. The boot check reads `current_user`'s attributes, never a name |
| Replica | `set_config` is on the replica's refusal list (`db/src/replica-route.ts:38`) for session state. A transaction is pinned to the primary (`db/src/transaction.ts:255`). So row security with replicas needs a read-only transaction on the standby, through 41-add-reads' `withReadTransaction`. Step 5 |
| Workers | a job's `tenant` (`jobs/src/backfill.ts:69`) sets the actor, so the same path. A job with no tenant runs as cross-tenant only under the `tenancy:cross` scope, as today |
| Framework tables | `x_*` hold no `tenant:` declaration and get no policy |

## Files to change
- `packages/db/src/row-security.ts` (new) — pure: `enableRowSecuritySql(table, column, type)`, the policy text, the drop.
- `packages/db/src/generate.ts`, `generate-steps.ts` — emit once per tenant table, on the precedent of `generate-append-only.ts`.
- `packages/db/src/catalog-objects.ts:197-214` — remove `row security`, `forced row security`, `row security policy` from the unrendered list; new `catalog-policies.ts` renders them.
- `packages/db/src/dump-*`, `object-drift.ts`, `catalog-fold.ts` — a tenth rendered kind. `wiki/Migrations-And-Backfills.md:153-187` follows.
- `packages/db/src/transaction.ts:327` — `withTransaction` sets the tenant from a registered provider through `setLocal`, same seam shape as `currentWriteOrigin`.
- `packages/db/src/pglite.ts`, `packages/testing/src/template-db.ts` — the two roles, as above. `packages/cli/src/framework-schema.ts` — with the flag on, grants on `x_*` to the app role.
- `packages/db/src/replica-route.ts`, `replica-client.ts` — a scoped read-only transaction on the standby when row security is on.
- `packages/entity/src/pg-driver.ts`, `pg-transactor.ts` — wrap a tenant-bearing statement; register the provider.
- `packages/cli/src/serve-boot.ts` — the boot check. `packages/core/src/config.ts:219` — `DatabaseConfig.rowSecurity`.
- `packages/cli/src/templates/scaffold-*.ts` — generated migrator and app role split, commented, when the flag is set.
- `examples/dummy` — turn it on; both tracked apps' dumps regenerate through `bun run schema-dumps`.
- `wiki/Policies-And-Authz.md`, `docs/ops/` secrets and roles page, `packages/{db,entity}/README.md`, `CLAUDE.md`, `wiki/Error-Codes.md`.

## Steps
1. `bun run new-error-code` for each code below.
2. Policy text: `using (org_id = nullif(current_setting('x.tenant', true), '')::<type> or current_setting('x.cross', true) = 'on') with check (same)`. Unset fails closed: no rows.
3. `x db gen` on a flipped flag emits a migration for every tenant table, with `NOT VALID`-style care not needed: `enable` takes a brief lock. Under the lock retries of [`04-db-migration-safety.md`](04-db-migration-safety.md).
4. Memory driver and PGlite: the repository seam is unchanged on memory, which has no raw SQL to escape. PGlite runs the real policy.
5. Replica: with the flag on, a replica-safe read runs `withReadTransaction(fn, { client: replica, settings: { 'x.tenant': id } })`: read only, tenant set, read, commit. `isPlainRead` is judged on the app's statement, never the framework's `set_config`.
6. Grants: the same migration grants the app role `select, insert, update, delete` on each table and sets default privileges for the migrator, so a later table is reachable.
7. Add to `x doctor`: the row-security state and the app role's attributes. Differences are listed, never overruled.
8. Bench it: `scripts/bench`, one read with and without. Put the number in `wiki/Policies-And-Authz.md` with `As of`.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_DB_ROW_SECURITY_BYPASSED` (new, off-socket) | `database.rowSecurity` on, role is superuser, owner without force, or `bypassrls` | `alter role <r> nosuperuser nobypassrls`, and connect as a role that does not own the tables |
| `X_DB_ROW_SECURITY_DRIFT` (new, off-socket) | a tenant table lacks its policy, or one exists with the flag off | `x db gen "row security"` |
| `X_DB_DRIFT` (existing) | a hand-edited policy | `x db gen` |

The convention's build error: the `drift` step raises `X_DB_ROW_SECURITY_DRIFT`.

## Tests
- `packages/db/src/row-security.live.test.ts`, Postgres: raw `select *` under tenant A sees only A; unset sees none; `crossTenant` sees both; a write naming B refused by `with check`.
- The same, after a pooled connection returns: the next statement sees no leftover tenant. Must fail if `set_config` is ever non-local.
- `packages/db/src/dump-drift.test.ts`: load the dump, policy present; load equals replay.
- `packages/cli/src/serve-boot.test.ts`: a superuser boot refused; a boot as the app role passes.
- `packages/db/src/pglite-row-security.test.ts`: flag on, PGlite: raw `select *` under A sees 1 of 2. Must fail if the session stays superuser: that is the probe's 2 of 2.
- `packages/entity/src/pg-driver.test.ts`: statement count with the flag on is exactly begin, set, statement, commit.
- `bun test packages/db/src/row-security.live.test.ts`

## Semver
Minor for the flag. **Breaking row:** the dump kind moves out of `unrendered.sql`, so an app with hand-written policies goes `X_SCHEMA_DUMP_DRIFT`. Upgrading: "`x db gen`, commit `packages/db/schema/`. A hand-written policy now appears in the dump."

## Done when
- A raw cross-tenant read in `examples/dummy` returns nothing with the flag on, on PGlite and on the test services.
- `bun run verify`, `bun run scripts/reference-app-gate.ts`, `scaffold-smoke` green.
