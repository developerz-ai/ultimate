# @ultimat3/db 🐘

Postgres access for Ultimate: parameterised SQL, transactions, migrations, drift detection,
branch databases, and a read-only client for anything an LLM drives.

Tier 1. Imports `@ultimat3/core` only. No runtime dependencies; `@electric-sql/pglite` is an
**optional peer**, loaded at first query and only by the embedded driver. **No ORM backs any of
this** — `@ultimat3/entity`'s hand-written `postgresDriver()` compiles every statement out of the
`sql` / `identifier` / `join` fragments below; this package declares the narrow structural types it
consumes (`DbClient`, `SqlFragment`, `EntityDescriptionLike`) so the SQL stays readable and the
boundary stays thin.

## Public API

```ts
import { db, sql, raw, withTransaction, currentTx, readOnly, setDbClient } from '@ultimat3/db';

const rows = await db().query<Post>(sql`select * from posts where org_id = ${orgId}`);

await withTransaction(async (tx) => {
  await tx.execute(sql`update posts set likes = likes + 1 where id = ${id}`);
  tx.onRollback(() => cache.restore(id));      // fires in reverse order on rollback
}, { isolation: 'serializable', readOnly: false });
```

| Export | |
|---|---|
| `sql` / `raw` / `identifier` / `literal` / `join` | fragment builders |
| `db()` / `baseClient()` / `setDbClient()` | the ambient client; `db()` returns the open tx if any |
| `withTransaction()` / `currentTx()` | transaction scope; `currentTx()` is the outbox seam |
| `migrate()` / `rollback()` / `readLedger()` | the `x_migrations` ledger |
| `checkDrift()` / `diffSchema()` / `assertNoDrift()` | drift, with a `--json` report |
| `generateMigration()` | `x db gen "<name>"` — reversible up/down SQL |
| `introspect()` | live schema → `SchemaDescription` |
| `createBranch()` / `dropBranch()` / `reapBranches()` | copy-on-write branch databases |
| `createPgliteClient()` / `branchPglite()` | the embedded database — Postgres in this process |
| `readOnly()` | mutation-rejecting wrapper |
| `ensureReadOnlyRole()` / `grantReadOnlySql()` / `READONLY_ROLE` | a `NOLOGIN`, SELECT-only Postgres role — layer 1 of `db.query`'s defence |
| `readOnlyQuery()` / `READONLY_TIMEOUT_MS` | one statement inside `BEGIN READ ONLY` with a statement timeout — layer 2 |
| `setStatementObserver()` / `statementObserver()` | `As of 2026-08`: one event **and one `db.<verb>` span** per settled statement, both drivers; uninstalled is one branch |
| `expectedQueryLoop()` / `expectedQueryLoopReason()` | `As of 2026-08`: the one way to declare a loop of queries deliberate — the reason rides on every statement it issues as `StatementEvent.expected` |
| `withStatementAttribution()` / `statementAttribution()` | `As of 2026-08`: the `{ entity, op }` pair on `StatementEvent.attribution`, scoped exactly like `expectedQueryLoop()` — `@ultimat3/entity`'s `postgresRepo` is the one producer |
| `STATEMENT_ATTRIBUTE` | `As of 2026-08`: `db.statement`, the OTel attribute each span carries its text under — declared here, read by `x dev`'s timeline |
| `statementFingerprint()` / `statementKind()` / `statementVerb()` | `As of 2026-08`: what shape a statement is — `entity.op` when attributed else its own collapsed text, read or write from the leading verb. One rule, so two detectors group identically |
| `createRecordingClient()` | in-memory `DbClient` that records SQL, for tests |

## `sql` is parameters-only

String interpolation is how every SQL injection ships, and an agent writing SQL cannot be
trusted to remember the difference between a value and a fragment. So:

- scalars (`string`, `number`, `boolean`, `bigint`, `Date`, `Uint8Array`, arrays, `null`) become
  `$1..$n` and never touch `.text`;
- a nested fragment is spliced and its parameters are renumbered;
- **anything else throws `X_SQL_UNSAFE`** — including an object shaped like a `SqlFragment` that
  `sql`/`raw` did not produce;
- `raw(trusted)` is the one audited escape hatch, `identifier(name)` the safe way to interpolate
  a table or column, `literal(text)` for utility statements that reject bound parameters.

## Read-only access for anything an LLM drives

`As of 2026-07`: a bug in one defence must not become a write, so `db.query` on the MCP dev
server stacks independent layers rather than trusting a single gate. This package owns the two
layers that are Postgres facts rather than MCP facts — the tool-boundary layers (pre-parse scan,
policy) live above it, and `@ultimat3/mcp` never imports this package directly.

```ts
import { ensureReadOnlyRole, readOnlyQuery } from '@ultimat3/db';

const role = await ensureReadOnlyRole(db());                   // layer 1, once at boot
const { rows, guards } = await readOnlyQuery(statement, { role }); // layer 2, per statement
```

| Layer | Export | |
|---|---|---|
| 1 | `ensureReadOnlyRole()` | idempotent DDL (`grantReadOnlySql()`) for `READONLY_ROLE`, a `NOLOGIN` role granted `SELECT` on every table and nothing else. Returns `null` instead of throwing when the connection cannot create or grant roles — a managed Postgres where the app user isn't a role admin |
| 2 | `readOnlyQuery()` | runs one statement inside `BEGIN READ ONLY`, assumes `role` via `SET LOCAL ROLE` when given one, bounds it with `SET LOCAL statement_timeout` (`READONLY_TIMEOUT_MS` default, `timeoutMs: 0` to disable), and always exits via `ROLLBACK` |

`readOnlyQuery()` reports which guards actually engaged (`result.guards`, e.g. `['txn:read-only',
'timeout:5000ms', 'role:ultimate_readonly']`) instead of assuming every layer held — a silently
degraded layer is a caller's problem to surface, never this package's to hide.

Only layer 1 degrades. `readOnlyQuery()` **throws** — a pool that cannot reserve a connection
(`X_DB_UNAVAILABLE`), a refused `SET LOCAL ROLE`, a failed transaction command, or the
statement's own error. Every caller handles that failure; nothing here swallows it.

`ALTER DEFAULT PRIVILEGES` is scoped to whoever creates an object, so pass
`creators: ['migrator']` when migrations run as a different DB user than the one that ran
`ensureReadOnlyRole()` — otherwise a table created later is not selectable by the role, and
layer 1 covers only what existed at grant time.

## The drift contract

`x db drift` compares `introspect()` against the snapshot the newest applied migration carries.
Rendered output is pinned byte-for-byte:

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

| Difference | cause | fix |
|---|---|---|
| live column, no migration | `table "T" has column "C" not present in any migration` | `x db gen "add C"` |
| migrated column, not live | `table "T" is missing column "C" that migrations declare` | `x db migrate` |
| live table, no migration | `table "T" is not present in any migration` | `x db gen "add T"` |
| migrated table, not live | `table "T" is declared by migrations but does not exist` | `x db migrate` |

`checkDrift()` returns every difference; `assertNoDrift()` throws the first. `x verify` fails on it.

## The embedded database

No `DATABASE_URL` means no Docker: `createPgliteClient()` runs Postgres as WASM inside this
process. The module is resolved on the first statement, never at import, so an image that only
ever talks to a managed Postgres never loads it.

```ts
const dev = createPgliteClient({ dataDir: pgliteDataDir(services.db.url) });  // or memory://
await dev.ping();                                       // pay the ~3s boot before serving
setDbClient(dev);

const branch = await branchPglite('feature_x', { from: '.x/pgdata' });
setDbClient(createPgliteClient({ dataDir: branch.dataDir }));
```

PGlite has no `CREATE DATABASE ... TEMPLATE`, so `branchPglite()` copies the data directory —
close the source first, and expect `X_NOT_IMPLEMENTED` on `memory://`, which has no directory to
copy. Branch names go through the same `assertBranchName()` as the Postgres path: here the name
lands in a filesystem path, so an unvalidated one is traversal rather than a typo.

### One session, so callers take turns

Embedded Postgres is a single session, not a pool. `createPgliteClient()` is therefore
`ReservableClient`: `withTransaction()` and `readOnlyQuery()` pin it, and every other statement
waits for its turn. Without that pin two concurrent units of work each run `BEGIN` on the same
connection — the second `COMMIT` commits the first's rows and the first `ROLLBACK` finds no
transaction left to undo.

| On a pooled server | Embedded, on one session |
|---|---|
| concurrent transactions run side by side | they run consecutively; throughput is one at a time |
| a statement outside a transaction gets its own connection | it waits for the open transaction to finish |
| `enqueue(input, { outbox: false })` inside a transaction survives its rollback | it joins that transaction, and rolls back with it |

The last row is the one divergence a second connection would remove and PGlite cannot: a statement
issued *inside* an open transaction's scope runs immediately rather than waiting for a turn that
scope is already holding, because waiting would be a deadlock with no error to explain it.

## Pool sizing by role

`ROLE` picks the profile — a `worker` draining a queue must not size like a `web` process.

| Role | max | statement timeout | idle timeout |
|---|---|---|---|
| `web` | 20 | 10s | 30s |
| `sync` | 10 | 10s | 60s |
| `worker` | 8 | 120s | 30s |
| `scheduler` | 2 | 15s | 60s |
| `migrate` | 1 | none | 10s |
| `replicator` | 4 | none | 60s |

The timeout is pinned per connection via libpq `options=-c statement_timeout=`. `Bun.SQL` is
reached lazily, so importing this package never opens a socket.

## Migrations

`migrate()` takes an advisory lock (`pg_advisory_lock(4919202607)`), ensures `x_migrations`
(`id, name, checksum, applied_at, app_version, duration_ms`), audits, then applies each pending
migration inside its own transaction. It refuses **before applying anything** when:

- the ledger records a migration this build does not ship **and** its `app_version` differs from
  the running one — another version owns the database; or
- an applied migration's `up` SQL no longer matches its recorded checksum.

Report (`--json`): `{ applied: [{ id, name, durationMs }], skipped: [id], durationMs, appVersion }`.

## A loop of queries that is deliberate says so

`As of 2026-08`:

```ts
return expectedQueryLoop('one indexed lookup per text field beats one unindexed OR', async () => {
  for (const field of fields) hits.push(...(await repo.list({ where: [match(field)] })));
  return hits;
});
```

One mechanism, and only one: no comment pragma, no config list of exempt call sites (axiom 1).
`reason` is required and non-blank — an exemption with no argument is a pragma, and the next
reader cannot tell a considered loop from a silenced one.

| | |
|---|---|
| Scope | an `AsyncLocalStorage`: it survives every `await` at any depth, and two loops running at once never read each other. Nesting keeps the innermost reason |
| What it carries | `StatementEvent.expected`, stamped by both funnels at settle time — a diagnostic judging a whole request runs after every scope in it closed |
| What it suppresses | a **verdict**, never a statement. The SQL is still sent, still observed, still a span: only the thing that warns is told the author already answered |
| What it costs | nothing without a diagnostic — the reason is read inside the branch that already checks for an installed observer |

The framework's own deliberate loops declare themselves at source: `migrate()` and `rollback()`
(one transaction per migration, so a failure leaves an exact ledger) and `@ultimat3/admin`'s
cross-entity search (one indexed lookup per text field).

## A statement knows who compiled it

`As of 2026-08`: `StatementEvent.attribution` is no longer always `undefined`.

```ts
return withStatementAttribution('members', 'findById', () =>
  client.query(sql`select * from members where id = any(${ids})`),
);
```

| | |
|---|---|
| Scope | an `AsyncLocalStorage`, `expectedQueryLoop()`'s own shape: it survives every `await` at any depth, and nesting keeps the innermost pair |
| What it carries | `StatementEvent.attribution`, stamped by both funnels at settle time, next to `expected` |
| Producer | `@ultimat3/entity`'s `postgresRepo` — the last caller that still knows the entity and the operation once the SQL exists |
| What it costs | nothing uninstalled — `statementObserver()` is read first, and with nothing installed `fn` runs directly; no scope entered, no object allocated |

Hand-written SQL, a migration, a health probe, `x db` commands and `@ultimat3/jobs`' own queue
statements still carry no `attribution` — nothing above them knows an entity to name, so the field
is optional and a detector must fall back to the statement text either way.

## Error codes

| Code | Meaning |
|---|---|
| `X_DB_UNAVAILABLE` | no reachable database; `fix:` names `DATABASE_URL` |
| `X_DB_DRIFT` | live schema differs from migrations |
| `X_MIGRATION_CONFLICT` | ledger app-version fence or checksum mismatch |
| `X_MIGRATION_IRREVERSIBLE` | generated `down` would lose data |
| `X_SQL_UNSAFE` | non-bindable interpolation, or an unsafe identifier/branch name |
| `X_BRANCH_EXISTS` | branch database already exists (or is the connected one) |
| `X_READONLY_VIOLATION` | a mutating statement reached a `readOnly()` client |
| `X_NOT_IMPLEMENTED` | branching an in-memory PGlite — a copy needs a directory |

```bash
x db migrate --json
x db drift --json
x db gen "add publish_at"
x db branch create feature_x
```
