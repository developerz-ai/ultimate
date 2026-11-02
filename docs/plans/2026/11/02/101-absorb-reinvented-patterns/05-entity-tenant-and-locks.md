# 05 — Same-tenant foreign keys; row and key locks

> Part of [`overview.md`](overview.md). Depends on: [`04-db-migration-safety.md`](04-db-migration-safety.md) for the deferred key phase. Tier: 1 (`db`), 2 (`entity`), 5 (`cli` guard template).

## Why
**Same-tenant keys.** A pentest finding in one adopter, which hand-listed 18 declarations. The tenant guard reads only the row's own tenant (`entity/src/memory-repo.ts:156`). Reproduced 2026-11-02, actor in org A, input naming B's post:

| Driver | Printed |
|---|---|
| memory | `CROSS-TENANT INSERT ACCEPTED {"commentOrg":"A","postOrg":"B"}` |
| Postgres, generated schema | `CROSS-TENANT INSERT ACCEPTED {"commentOrg":"A","postOrg":"B"}` |
| Postgres, composite key `(org_id, post_id) → posts (org_id, id)` | `refused X_DB_FOREIGN_KEY_VIOLATION`, the same code as a dangling id |

The row is then reachable through every preload and join on that edge.

**Locks.** Four adopters hand-rolled them. 20 concurrent read-modify-writes through the handle: memory `expected 20, got 1`; Postgres `got 2`. Raw `for update` in `withTransaction`: `got 20`, with no tenant guard, no codec and no memory path. `transition()` (`entity/src/state-machine.ts:44`) covers state moves only. The shipped guard is silent on it: its `SELECT` is anchored at `$` (`cli/src/templates/guard-repo-raw-sql.ts:136`), so the earlier claim that it steers repos away is false; nothing steers them anywhere.

## Decisions
| Question | Answer |
|---|---|
| Opt-in `{ sameTenant: true }` or default | **default**, when both ends are tenant-scoped. Opt-in is the list one adopter already kept by hand, and tenancy here is a guard, not a convention (`entity/src/tenancy.ts:1`) |
| Repo check or database | **database**, composite key. A repo read adds a round trip per reference per write and misses raw SQL. The composite answers absent and foreign identically, so there is no existence oracle |
| Escape | `references(() => x.id, { crossTenant: 'shared catalog row' })`, reason required and non-blank, the rule `crossTenant()` already sets (`entity/src/cross-tenant.ts:43`) |
| Memory driver | refuses only a target **found under another tenant**. It enforces no FK at all (probe: dangling id accepted), and starting would break every parent-less fixture |
| `withLock(key, fn)` free function | no: `@ultimat3/db` cannot see the memory driver, which forks the code path again. `db.<table>.lockKey(key, fn)` reaches the driver and scopes the key to the tenant, so org A's key never blocks org B |
| Reuse `withAdvisoryLock` | no. `db/src/migrate.ts:149` is session-scoped and pinned. This is transaction-scoped; the contracts differ |

## Files to change
- `entity/src/column.ts:84,208` — `Binding.tenant` (physical tenant column of the owning entity); `crossTenant` on the `references` option, blank refused.
- `entity/src/describe.ts:58,178`, `entity/src/registry.ts:52` — `sameTenant: { column, targetColumn } | null` on the resolved reference and the column description.
- `db/src/entity-shape.ts:18` — the same field, optional, so older descriptions read as absent.
- `db/src/foreign-key-plan.ts:47` — `foreignKeysOf` emits the composite, named `<table>_<column>_tenant_fkey`.
- `db/src/invariant-ddl.ts` (`declaredIndexes`) — the unique `(tenant, id)` index the target needs, once per referenced table, declared `concurrently: true`: on a table this migration creates that changes nothing, on a live one it lands in the deferred step (`db/src/concurrent-plan.ts:63`).
- `db/src/foreign-key.ts:95` — `on delete set null (<column>)`: a bare `set null` would null the tenant column too.
- `entity/src/memory-repo.ts:78,156`, `entity/src/database.ts:44` — `memoryRepo` takes the driver's lookup; the found-elsewhere refusal beside `assertRowTenant`.
- `entity/src/repo.ts:95` — optional `lock?` and `lockKey?`; optional so a hand-written driver still compiles.
- `entity/src/pg-lock.ts` (new), `entity/src/pg-sql.ts:378` — `for update`, `pg_advisory_xact_lock(hashtextextended(key, 0))`.
- `entity/src/memory-lock.ts` (new) — per-key promise queue, reentrant within one async chain, bounded wait.
- `entity/src/query.ts:205,465` — `lock`, `lockKey` on the table.
- `entity/src/sealed-repo.ts`, `entity/src/append-only.ts`, `entity/src/row-observer.ts` — forward both; sealed values open before `fn` sees the row.
- `cli/src/templates/guard-repo-raw-sql.ts:136,184` and its test — `select * … where id = ? for update` is reported, the fix names `db.<table>.lock(id, fn)`.
- `wiki/Entities-And-Migrations.md:216`, `wiki/Policies-And-Authz.md`, `wiki/Error-Codes.md`, `SECURITY.md`, `packages/entity/README.md`, `packages/entity/CLAUDE.md`.
- `examples/dummy/apps/web/app/posts/repo.ts:276` — the like recount is a read-then-write race today; it takes `db.posts.lock`.
- Both tracked apps' migrations and schema dumps, regenerated.

## Steps
1. Resolve `sameTenant` at describe time from the two bindings: both ends tenant-scoped, no `crossTenant`, and the column is not itself the tenant column. An edge to an untenanted root (`orgId → orgs.id`) stays plain. A self-reference (`parentId`) is composite too. `crossTenant` where the edge is not same-tenant-eligible is refused: it would state a reason for nothing.
2. Generate. Child and target both new: unique index and composite key in one transaction. Otherwise, all in slice 04's deferred phase: build the index, add the key `not valid`, validate, drop the old key. That covers a new child over a live target, whose index is deferred too. Old key name differs (`_tenant_fkey`), so slice 04's contract phase drops it last and it holds throughout; both snapshots are slice 04's `DeferredKey`.
3. Memory parity: found under another tenant is `X_DB_FOREIGN_KEY_VIOLATION`; not found stays accepted. A parity test pins both drivers on the first case and records the second.
4. `lock(id, (row, tx) => R, options?) => Promise<R>`: opens the driver's `Transactor`, reads through `idPlan` so the tenant and soft-delete guards are the read path's own, `X_NOT_FOUND` when absent, runs `fn`, commits. Nested in `withTransaction` it is a savepoint and the row lock lives to the root COMMIT. `fn` writes with `{ tx }`, the rule on every write (`entity/src/repo.ts:3`).
5. `lockKey(key, (tx) => R, options?)`: the hashed input is `<table>:<tenant or ->:<key>`; on a tenant-scoped entity with no actor it is `X_TENANCY_UNSCOPED`, exactly as a read. Blank key refused by `assert`.
6. No wait options. Bound is the role's `statement_timeout`; a deadlock is the existing `X_DB_SERIALIZATION_FAILURE` (`db/src/sqlstate.ts:121`). Memory waits 5 s, then `X_DB_LOCK_TIMEOUT`.

## Error codes
`bun run new-error-code` for the new one, `--off-socket`.

| Code | When | Fix |
|---|---|---|
| `X_DB_FOREIGN_KEY_VIOLATION` (existing) | reference into another tenant, or absent | existing: the parent it names is gone or not this tenant's. Row-level detail deliberately absent |
| `X_LOCK_UNSUPPORTED` (new, `entity`) | a hand-written `Repo` without `lock` | implement `lock` and `lockKey` on the driver, or use the shipped `postgresDriver()` |
| `X_DB_LOCK_TIMEOUT` (existing) | memory waiter past its bound | a lock taken in opposite order: take them in one order |
| `X_NOT_FOUND`, `X_TENANCY_UNSCOPED` (existing) | as a read | existing |

## Tests
- `entity/src/same-tenant.live.test.ts`: the probe, inverted, through `insert`, `update`, `upsertAll`; `on delete set null` keeps the tenant column; `crossTenant` edge passes; nullable key with null passes.
- `db/src/foreign-key-plan.test.ts`: composite, index, plain edge to a root, self-reference, live-table ordering. Mutation: remove the index and the live test fails `42830`.
- `entity/src/same-tenant-parity.test.ts`: memory and recording client refuse alike.
- `entity/src/lock.live.test.ts`, `entity/src/lock-parity.test.ts`: 20 racers end at 20 on both drivers; another org's id is absent; throw rolls back; two orgs' same key do not block.
- `cli/src/templates/guard-repo-raw-sql.test.ts`.
- `x test live`; `bun test packages/entity/src/same-tenant-parity.test.ts`.

## Semver
**Breaking** (same-tenant default). Upgrading: "`X_DB_DRIFT` until you run `x db gen \"same-tenant keys\"`. It adds one unique index per referenced tenant-scoped table and swaps the key online. A validate failing `X_DB_FOREIGN_KEY_VIOLATION` found rows already pointing across tenants: decide those rows, or state `crossTenant: '<reason>'` on an edge that means it. Rule on a nullable tenant column: a null skips the check." Locks are minor.

## Done when
- The reproduced insert is refused on Postgres and memory with no app change beyond the regenerated migration.
- Live-table upgrade runs under writes with the old key held until the new one validates.
- `db.posts.lock` in the reference app; 20 racers reach 20 on both drivers.
- `bun run verify`, `bun run scripts/reference-app-gate.ts`.
