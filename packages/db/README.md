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
| `DbTx.origin` | `As of 2026-08`: the client the transaction was **opened on** — `options.client` or `baseClient()`, never the reservation it runs statements through. `@ultimat3/entity` compares a pinned repository's client against it, so a pinned repo joins its own shard's transaction instead of being refused |
| `withTransaction()` / `currentTx()` | transaction scope; `currentTx()` is the outbox seam. `{ retry: n }` (`As of 2026-08`) re-runs `fn` from the top on a `40001`/`40P01` and on nothing else — default 0, so `fn` must be idempotent before you ask for it |
| `sqlState()` / `sqlStateCode()` / `isRetryableState()` / `SQLSTATE` | `As of 2026-08`: the SQLSTATE a driver error carries, and the closed table from it to a code. `Bun.SQL` puts it on `errno`; PGlite puts it on `code`; **one** reader answers for both |
| `migrate()` / `rollback()` / `readLedger()` | the `x_migrations` ledger |
| `statementsOf()` | `As of 2026-08`: a SQL script → the statements a driver sends one at a time. One send is one statement, so `migrate()` splits with this — a `;` inside a literal, an identifier, a dollar-quoted body or a comment is data |
| `checkDrift()` / `diffSchema()` / `assertNoDrift()` | drift, with a `--json` report. `checkDrift()` is the **post-migrate verification** — the live database against the ledger: columns, declared indexes (columns, uniqueness, direction, and whether a predicate is there at all — never its text) and declared foreign keys, matched on where the key points and not on its constraint name, with the `on delete` rule compared through one normalisation `As of 2026-08-19` |
| `declaredSchema()` / `expectedSchema()` | `As of 2026-08`: the schema the migrations write down, or `undefined` when the newest one carries no snapshot — never an older snapshot standing in for it |
| `parseSnapshot()` | `As of 2026-08`: a `<id>.snapshot.json` sidecar validated to the last nested field, or `undefined`. `{"tables":[null]}` is valid JSON and is not a schema |
| `snapshotJson()` | `As of 2026-08`: the sidecar's **bytes** — the JSON Biome would have printed, trailing newline included. The one writer of a `<id>.snapshot.json`, because `JSON.stringify(…, null, 2)` is not formatter-clean and an app's `lint` step rejected the file `x db gen` had just written |
| `isLedgerMissing()` | `As of 2026-08`: whether an error is Postgres' `undefined_table` for `x_migrations` — the one condition a caller may read as "nothing applied" |
| `appTables()` / `FRAMEWORK_TABLE_PREFIX` | `As of 2026-08`: the live schema minus the `x_` namespace — no migration declares the ledger, the queue, the outbox or an auth table, so none of them is drift |
| `generateMigration()` | `x db gen "<name>"` — reversible up/down SQL, and `destructive` for the marker the file must carry. `As of 2026-08` a foreign key is its own `alter table … add constraint`, emitted after every table statement: inline, a `references()` had to point at a table entity registration order happened to create first, and `down` had to drop them in an order it did not control. `As of 2026-08-19` a **removed** `references()` emits its `drop constraint` (it emitted nothing, and the snapshot then denied a constraint the database still held), a changed `onDelete` is a drop-and-add rebuild, and a declared `on delete` rule reaches the clause at all |
| `destructiveStatements()` / `hasDestructiveMarker()` / `isDestructive()` / `DESTRUCTIVE_MARKER` | `As of 2026-08`: the destructive-SQL rail — does this `up` drop, truncate or retype, and does the file declare it with `-- destructive: true`? One classifier, read by `x db gen` when it writes the marker and by `x verify` when it demands one |
| `stripSqlNoise()` | comments, literals, dollar-quoted bodies and quoted identifiers blanked **in source order**, so a reader sees the operation and not the prose. Shared by `readOnlyQuery()` and the destructive rail |
| `introspect()` | live schema → `SchemaDescription` |
| `createBranch()` / `dropBranch()` / `reapBranches()` | copy-on-write branch databases. `As of 2026-08-19` the marker comment records the **base** as well as the instant (`ultimate:branch:<base>:<iso>`, on `BranchInfo.base`), and `reapBranches()` sweeps only branches of the database it is connected to — one Postgres hosting two Ultimate apps used to mean one app's nightly reap dropped the other's branches. A pre-3.x marker records no base and is skipped, never dropped |
| `createPgliteClient()` / `branchPglite()` | the embedded database — Postgres in this process |
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

`checkDrift()` compares `introspect()` against the snapshot the newest applied migration carries —
`expectedSchema(migrations, ledger)`. `declaredSchema(migrations)` is the same read with the ledger
left out: the schema the files *declare*, applied or not, which is what `x db gen` diffs the app's
entities against so generation needs no database at all. One implementation, two callers — a
snapshot that meant one thing to the generator and another to drift is exactly the divergence the
ledger exists to prevent.

**One `X_DB_DRIFT`, two detectors, and which is which matters.** `checkDrift()` is the post-migrate
verification: it needs a database, so it runs where one is open — `runMigrations` in
`@ultimat3/cli`, which is `x db migrate`, `x db reset` and `ROLE=migrate` alike. It is the only one
that can see a column added by hand. The other, `checkSourceDrift()` (also `@ultimat3/cli`), hashes
the entity source against what `x db gen` recorded, opens nothing, and is `x verify`'s `drift` step
— the gate runs in CI with no database, so a check that needed one could not run at all.

A migration the ledger has not recorded is **not** drift: `expectedSchema` reads the ledger's own
subset, so a database that simply has not migrated yet is pending, not divergent. Neither is a
table in the `x_` namespace — `x_migrations`, the queue's tables, the outbox and every
`@ultimat3/auth` table are created by `create table if not exists` at boot and appear in no
snapshot, so `appTables()` drops them before the diff. `introspect()` keeps its own narrower
exclusion (the ledger alone), because the admin schema view and the MCP `schema.describe` tool
legitimately show `x_users`.

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
| index rebuilt differently | `index "I" on "T" covers (…)` / `is unique` / `is descending` / `is partial`, `not what migrations declare` | `x db migrate` |
| foreign key, rule moved | `foreign key on "T" (C) to "R" is on delete cascade, not what migrations declare` | the `drop constraint` + `add constraint` pair, in a new migration |

`checkDrift()` returns every difference; `assertNoDrift()` throws the first. `x db migrate` renders
them all as findings and exits non-zero; a `ROLE=migrate` container throws the first one
(`assertNoDrift`, in `runRole`) and exits non-zero too, because the release phase has one channel —
the exit code — and a deploy that rolled on past a schema nobody can reconstruct is the failure
drift exists to catch. There is no `x db drift`, and `x verify`'s `drift` step is the *source*
detector (`checkSourceDrift`), which needs no database and never calls this.

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

| Role | max | statement timeout | idle timeout | lock timeout | acquire timeout |
|---|---|---|---|---|---|
| `web` | 20 | 10s | 30s | none | 5s |
| `sync` | 10 | 10s | 60s | none | 5s |
| `worker` | 8 | 120s | 30s | none | 10s |
| `scheduler` | 2 | 15s | 60s | none | 10s |
| `migrate` | 1 | none | 10s | 3s | none |
| `replicator` | 4 | none | 60s | none | none |

The statement timeout is pinned per connection via libpq `options=-c statement_timeout=`, and it
does reach the backend: `client.live.test.ts` asserts `current_setting('statement_timeout')`, which
is the only reading a DSN test cannot fake. `Bun.SQL` is reached lazily, so importing this package
never opens a socket.

**That setting is MERGED into the operator's own `options`, never assigned over them** (`As of
2026-08`). `?options=-c search_path=app` in `DATABASE_URL` survives on every role, and the role's
`statement_timeout` is appended to it; if the URL sets `statement_timeout` itself, the **role
wins** — it is a bound the pool is sized around — and every other flag is kept. It is emitted for
all six roles, `migrate`'s and `replicator`'s `0` included: `0` is "this role may take as long as
it takes", and left unsaid a server-side `alter database … set statement_timeout` would kill the
one role that has to outlive it. Before this, `set` replaced the whole value and only on the roles
with a non-zero timeout, so a `search_path` survived on `migrate` and vanished on `web` — the role
that runs the migrations and the role that serves the traffic reading different schemas.

**`DATABASE_POOL_MAX` overrides `max`** (`As of 2026-08`), and it is the only pool knob an operator
can turn without shipping an image — 400 `web` pods × the frozen `max: 20` is 8,000 backends. A
value that is not a positive integer refuses at boot rather than falling back.

**`acquireTimeoutMs` bounds `reserve()`**, because queueing turns exhaustion into a hang: `/readyz`'s
`select 1` joins the same queue, the kubelet kills the pod, and the replacement inherits the same
saturated database. 0 waits, which is what a run-once role wants.

**`lockTimeoutMs` bounds a *wait*, never the work.** `alter table … add column` takes `ACCESS
EXCLUSIVE`; a long `SELECT` holding `ACCESS SHARE` makes it queue, and Postgres' lock queue is FIFO,
so every later query on that table queues behind the ALTER. `migrate` runs `statement_timeout = 0`,
so nothing else would ever end that wait. `migrate()` emits it as `SET LOCAL lock_timeout` inside
each migration's own transaction — it reverts at COMMIT, so a DDL value never leaks onto the session
the ledger insert runs on.

## Migrations

`migrate()` takes the advisory lock by **polling** `pg_try_advisory_lock(4919202607)` every 500ms
until `lockWaitMs` (default 60s) and then throwing `X_MIGRATE_CONCURRENT` (`As of 2026-08`).
`pg_advisory_lock` has no timeout, and a predecessor OOM-killed on a partition keeps its backend —
and the lock — for hours, so a deploy hook sat inside one statement printing nothing while
`helm upgrade --wait` blocked and `backoffLimit` never fired, because a job that never finishes
never fails. It then ensures `x_migrations`
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
| Scope | core's `asyncContext<string>('the expected-loop reason')`, never a `new AsyncLocalStorage` here: it survives every `await` at any depth, and two loops running at once never read each other. Nesting keeps the innermost reason |
| What it carries | `StatementEvent.expected`, stamped by both funnels at settle time — a diagnostic judging a whole request runs after every scope in it closed |
| What it suppresses | a **verdict**, never a statement. The SQL is still sent, still observed, still a span: only the thing that warns is told the author already answered |
| What it costs | nothing without a diagnostic — the reason is read inside the branch that already checks for an installed observer |

The framework's own deliberate loops declare themselves at source: `migrate()` and `rollback()`
(one transaction per migration, so a failure leaves an exact ledger) and `@ultimat3/admin`'s
cross-entity search (one indexed lookup per text field).

**Every ambient scope in this package opens through `asyncContext<T>(subject)` from
`@ultimat3/core`** — the transaction store, the attribution pair and this reason — and none of the
three constructs an `AsyncLocalStorage`, `As of 2026-08`. What changed is what a browser bundle
does with these three modules: a bundler stubs `node:async_hooks` to `{}`, so the module-scope `new`
threw `TypeError: undefined is not a constructor` at module **evaluation** — before a line of app
code ran, and taking every importer of the file with it. Now the module evaluates, a read answers
`undefined` (nothing is in flight in a browser, so that is the true answer), and a write throws
`X_ASYNC_CONTEXT_UNAVAILABLE` naming the scope it could not open. A server pays nothing —
`getStore()` before any `run()` answered `undefined` either way. Not a claim that the whole package
bundles: `pglite-branch.ts` imports `node:fs/promises`, which is a separate question.

The rule is a **build error**, not a convention: `scripts/async-context-guard.ts` refuses a
`new AsyncLocalStorage` — and the import that binds the class, aliased or namespaced — anywhere but
`packages/core/src/async-context.ts`, and `scripts/async-context-guard.test.ts` runs it over the
tree in the gate's `unit` step.

## A statement knows who compiled it

`As of 2026-08`: `StatementEvent.attribution` is no longer always `undefined`.

```ts
return withStatementAttribution('members', 'findById', () =>
  client.query(sql`select * from members where id = any(${ids})`),
);
```

| | |
|---|---|
| Scope | core's `asyncContext<StatementAttribution>()`, `expectedQueryLoop()`'s own shape: it survives every `await` at any depth, and nesting keeps the innermost pair |
| What it carries | `StatementEvent.attribution`, stamped by both funnels at settle time, next to `expected` |
| Producer | `@ultimat3/entity`'s `postgresRepo` — the last caller that still knows the entity and the operation once the SQL exists |
| What it costs | nothing uninstalled — `statementObserver()` is read first, and with nothing installed `fn` runs directly; no scope entered, no object allocated |

Hand-written SQL, a migration, a health probe, `x db` commands and `@ultimat3/jobs`' own queue
statements still carry no `attribution` — nothing above them knows an entity to name, so the field
is optional and a detector must fall back to the statement text either way.

## Error codes

Every driver failure is typed by the **SQLSTATE the server sent**, `As of 2026-08`. The state was
always on the error and nothing read it, so a `23505` from two clicks racing a signup answered
"cannot reach the database" and paged on-call for an outage that never happened. The table
(`sqlstate.ts`) is closed; everything outside it is still `X_DB_UNAVAILABLE`, unchanged.

| Code | Meaning |
|---|---|
| `X_DB_UNAVAILABLE` | no reachable database, or a SQLSTATE the table does not name; `fix:` names `DATABASE_URL` |
| `X_DB_UNIQUE_VIOLATION` | `23505` — `fix:` names `upsertAll(rows, { onConflict: [...] })` and the constraint the server named |
| `X_DB_FOREIGN_KEY_VIOLATION` | `23503` |
| `X_DB_SERIALIZATION_FAILURE` | `40001` / `40P01`, and an exhausted `withTransaction(fn, { retry: n })` budget |
| `X_DB_STATEMENT_TIMEOUT` | `57014` — the statement ran past `statement_timeout` |
| `X_DB_LOCK_TIMEOUT` | `55P03` — it waited past `lock_timeout` for a lock it never got |
| `X_DB_POOL_EXHAUSTED` | `53300` / `53200`, or `reserve()` past `acquireTimeoutMs` |
| `X_DB_DRIFT` | live schema differs from migrations |
| `X_MIGRATION_CONFLICT` | ledger app-version fence or checksum mismatch |
| `X_MIGRATE_CONCURRENT` | another migrator still held the lock when the wait ran out |
| `X_MIGRATION_IRREVERSIBLE` | generated `down` would lose data |
| `X_SQL_UNSAFE` | non-bindable interpolation, or an unsafe identifier/branch name |
| `X_BRANCH_EXISTS` | branch database already exists (or is the connected one) |
| `X_NOT_IMPLEMENTED` | branching an in-memory PGlite — a copy needs a directory |
| `X_ENV_MISSING` | core's — `DATABASE_POOL_MAX` is set to something that is not a positive integer |

```bash
x db migrate --json
x db gen "add publish_at"
x db branch ls --json
x db branch create feature_x
x db branch drop feature_x
```

**Drift has no subcommand of its own.** The database half runs *inside* `x db migrate`, which calls
`checkDrift()` on the connection it already holds and exits non-zero on a difference; the source
half is the `drift` step of `x verify`, which hashes entity source against what `x db gen` recorded
and opens no database. Two questions, two owners, and no `drift` subcommand under `x db` — the
`DB_SUBCOMMANDS` set is `gen`, `migrate`, `reset`, `studio`, `branch`, `backfill`.
