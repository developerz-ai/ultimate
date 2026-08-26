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
import { db, sql, raw, withTransaction, currentTx, setDbClient } from '@ultimat3/db';

const rows = await db().query<Post>(sql`select * from posts where org_id = ${orgId}`);

await withTransaction(async (tx) => {
  await tx.execute(sql`update posts set likes = likes + 1 where id = ${id}`);
  tx.onRollback(() => cache.restore(id));      // fires in reverse order on rollback
}, { isolation: 'serializable', readOnly: false });
```

| Export | |
|---|---|
| `sql` / `raw` / `identifier` / `literal` / `join` | fragment builders |
| `shellInertIdentifier()` | `As of 2026-08-26`: a quoted identifier that is also inert wherever a human PASTES it — or `null`. The one screen a catalog name goes through before it reaches a `fix:`. `identifier()` answers about SQL and **accepts** a backtick and a `$`, which are exactly what a shell substitutes inside double quotes, so a column called `$(id)` inside `x db gen "add $(id)"` runs `id` on paste |
| `db()` / `baseClient()` / `setDbClient()` | the ambient client; `db()` returns the open tx if any |
| `DbTx.origin` | `As of 2026-08`: the client the transaction was **opened on** — `options.client` or `baseClient()`, never the reservation it runs statements through. `@ultimat3/entity` compares a pinned repository's client against it, so a pinned repo joins its own shard's transaction instead of being refused |
| `withTransaction()` / `currentTx()` | transaction scope; `currentTx()` is the outbox seam. `{ retry: n }` (`As of 2026-08`) re-runs `fn` from the top on a `40001`/`40P01` and on nothing else — default 0, so `fn` must be idempotent before you ask for it. Each re-run **waits first**, `As of 2026-08-23`: exponential from 10ms, capped at 500ms, full jitter (`@ultimat3/core`'s `backoffDelay`). A budget of 0 waits not at all |
| `sqlState()` / `sqlStateCode()` / `isRetryableState()` / `SQLSTATE` | `As of 2026-08`: the SQLSTATE a driver error carries, and the closed table from it to a code. `Bun.SQL` puts it on `errno`; PGlite puts it on `code`; **one** reader answers for both |
| `migrate()` / `rollback()` / `readLedger()` | the `x_migrations` ledger |
| `statementsOf()` | `As of 2026-08`: a SQL script → the statements a driver sends one at a time. One send is one statement, so `migrate()` splits with this — a `;` inside a literal, an identifier, a dollar-quoted body or a comment is data |
| `withReplicaReads()` / `replicaScope()` | `As of 2026-08-24`: the scope inside which a plain read may be served by a replica — until it writes, after which every read in it is the primary's. No scope open, nothing routes |
| `replicatedClient()` / `ReplicaStats` / `REPLICA_URL_ENV` | `As of 2026-08-24`: one `DbClient` over a primary and a standby. `baseClient()` builds one when `DATABASE_REPLICA_URL` is set and the single-pool client when it is not |
| `INDEX_METHODS` / `IndexMethod` / `indexMethodOf()` / `indexMethodSql()` / `declaredMethod()` / `isIndexMethod()` | `As of 2026-08-24`: an index's access method — `btree` or `gin`, closed. Absent is `btree`, the live side is read open (whatever `pg_am` said), and the DDL literal is re-derived from the set rather than spliced from the input |
| `isPlainRead()` | `As of 2026-08-24`: whether a statement may leave the primary. An allow-list — everything it cannot vouch for is the primary's |
| `checkDrift()` / `diffSchema()` / `assertNoDrift()` | drift, with a `--json` report. `checkDrift()` is the **post-migrate verification** — the live database against the ledger: columns, declared indexes (access method `As of 2026-08-24`, columns, uniqueness, direction, and whether a predicate is there at all — never its text), declared CHECK constraints by NAME (`missing-check`, `As of 2026-08-25` — never a predicate, which the catalog answers rewritten) and declared foreign keys, matched on where the key points and not on its constraint name, with the `on delete` rule compared through one normalisation `As of 2026-08-19` |
| `declaredSchema()` / `expectedSchema()` | `As of 2026-08`: the schema the migrations write down, or `undefined` when the newest one carries no snapshot — never an older snapshot standing in for it |
| `parseSnapshot()` | `As of 2026-08`: a `<id>.snapshot.json` sidecar validated to the last nested field, or `undefined`. `{"tables":[null]}` is valid JSON and is not a schema |
| `snapshotJson()` | `As of 2026-08`: the sidecar's **bytes** — the JSON Biome would have printed, trailing newline included. The one writer of a `<id>.snapshot.json`, because `JSON.stringify(…, null, 2)` is not formatter-clean and an app's `lint` step rejected the file `x db gen` had just written |
| `isLedgerMissing()` | `As of 2026-08`: whether an error is Postgres' `undefined_table` for `x_migrations` — the one condition a caller may read as "nothing applied" |
| `appTables()` / `FRAMEWORK_TABLE_PREFIX` | `As of 2026-08`: the live schema minus the `x_` namespace — no migration declares the ledger, the queue, the outbox or an auth table, so none of them is drift |
| `generateMigration()` | `x db gen "<name>"` — reversible up/down SQL, and `destructive` for the marker the file must carry. `As of 2026-08` a foreign key is its own `alter table … add constraint`, emitted after every table statement: inline, a `references()` had to point at a table entity registration order happened to create first, and `down` had to drop them in an order it did not control. `As of 2026-08-19` a **removed** `references()` emits its `drop constraint` (it emitted nothing, and the snapshot then denied a constraint the database still held), a changed `onDelete` is a drop-and-add rebuild, and a declared `on delete` rule reaches the clause at all. `As of 2026-08-25` a **retype** drops the partial indexes and CHECK constraints written against that column first and restores them in `down`: Postgres compiles both predicates against the old type and cannot recompile either, so `alter column … type text using …::text` was `42883 operator does not exist: text = post_status` and the migration aborted mid-run. A plain btree over the column is left alone — measured, Postgres rebuilds that one itself. `As of 2026-08-26` `replicaIdentityFull` names the tables a live query subscribes to and emits one `alter table … replica identity full` each, last in `up`, recorded on the snapshot so the next generation emits none — a parameter and never an entity field, because the live-query set is a tier-3 fact (`replica-identity.ts`) |
| `declaredIndexes()` / `invariantChecks()` / `constraintNameFor()` | `As of 2026-08-25`: the DDL an entity **invariant** becomes — a `check` as a named `CONSTRAINT`, a `unique` as a partial-capable unique INDEX, an `assert` as nothing. `EntityDescriptionLike` had no `invariants` field for three majors, so a regenerated migration silently held **none** of them, including the composite UNIQUE `upsertAll`'s `on conflict` is inferred against |
| `declaredChecks()` / `checkClauses()` / `checkPlan()` / `columnChecks()` / `columnCheckName()` / `columnNamesConstraint()` | `As of 2026-08-25`: **every** CHECK a table declares — a column's own (`enumerated()`'s value set, `tz()`'s IANA whitelist, `locale()`'s tags, money's currency pattern and scale bound) and an invariant's — on ONE list, so `createTable`, `diffTable` and `snapshotOf` agree about what exists. A column's check reached `create table` **inline and anonymous** and nothing else: the snapshot recorded none and the diff had no arm, so a value added to `enumerated()` generated no migration and a regenerated ENUM column came back as bare `text`. The name is `<table>_<column>_check` because that is the name **Postgres itself mints** for the old anonymous form — measured — so the repair lands on the constraint an already-generated database is holding; `checkPlan` emits `drop constraint if exists` before the `add` for exactly that column, because a bare add is `42710` there and a no-op everywhere else |
| `defaultExpression()` / `ColumnDefaultLike` | `As of 2026-08-25`: a column's `default` as SQL. A DECLARED default (`{ kind: 'value', value }`) wins; `gen_random_uuid()` and `now()` stay as the inference for a description that carries only `hasDefault` |
| `unrenderedOf()` / `unrenderedComment()` / `UnrenderedDeclaration` | `As of 2026-08-25`: what the generator could **not** write, on `GeneratedMigration.unrendered` and as a `-- UNRENDERED` block at the top of a non-empty `up`. A generator that emits less than the declaration in silence is the defect the whole file exists against, and `x verify`'s `drift` step reads a source hash — it never reads the SQL, so the loss was green. **`unrenderedOf(entities, current)` takes the recorded schema**, required and nullable: a rule declared as an `assert` reaches no SQL by design and is no loss on its own, but one whose CHECK a previous migration RECORDED is dropped by this run and reported by nothing — five in `examples/dummy`, and `@ultimat3/cli`'s `repairFix` then offered `x db gen "drop <name>"` as the repair for the loss that command performs |
| `destructiveStatements()` / `hasDestructiveMarker()` / `isDestructive()` / `DESTRUCTIVE_MARKER` | `As of 2026-08`: the destructive-SQL rail — does this `up` drop, truncate or retype, and does the file declare it with `-- destructive: true`? One classifier, read by `x db gen` when it writes the marker and by `x verify` when it demands one |
| `stripSqlNoise()` | comments, literals, dollar-quoted bodies and quoted identifiers blanked **in source order**, so a reader sees the operation and not the prose. Shared by `readOnlyQuery()` and the destructive rail |
| `introspect()` | live schema → `SchemaDescription`. **App tables only**, `As of 2026-08-24`: a relation an extension owns (`pg_depend`, `deptype = 'e'`) and anything that is not an ordinary or partitioned table are excluded before the fold, and an explicit `exclude` cannot bring them back |
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

## Index access methods

`btree` is the default and is never written out; `gin` is what makes `@>` / `<@` / `&&` / `?` on a
`json()` or `arrayOf()` column an index lookup rather than a sequential scan.

| | |
|---|---|
| declared | `IndexDescriptionLike.using` — `'btree' \| 'gin'`, closed. Anything else is `X_SQL_UNSAFE` before it reaches DDL |
| absent | `btree`, on every side, through `indexMethodOf()` — so a snapshot written before the field existed reads as what it always was |
| emitted | `create index "posts_tags_idx" on "posts" using gin ("tags");` — and `create index "posts_tags_idx" on "posts" ("tags");` when no method was declared, byte for byte what shipped before |
| refused | a unique GIN and an ordered GIN (`X_INVARIANT`) — Postgres has neither, and the alternative is a syntax error inside `ROLE=migrate` |
| recorded | only when declared, so no existing sidecar is rewritten |
| a method that moved | drop and recreate — Postgres cannot alter one in place |
| drift | a declared GIN against a live btree is `changed-index`, and the live method is reported by the name the catalog gave it |

## Read replicas

Opt in twice, and the second one is why it is safe.

```ts
// 1. the pool — an environment variable, read once by baseClient()
//    DATABASE_REPLICA_URL=postgres://reader@replica.internal:5432/app

// 2. the scope — reads inside it may be served by the replica
import { db, sql, withReplicaReads, withTransaction } from '@ultimat3/db';

declare const id: string;

await withReplicaReads(async () => {
  await db().query(sql`select id from posts limit 20`); // -> replica
  await db().execute(sql`insert into posts (id) values (${id})`);
  await db().query(sql`select id from posts limit 20`); // -> primary, for the rest of the scope
  await withTransaction(async (tx) => {
    await tx.query(sql`select 1`); // -> primary, always
  });
});
```

| Rule | |
|---|---|
| unconfigured | no `DATABASE_REPLICA_URL` → one pool, statement for statement what it always was |
| no scope | no `withReplicaReads` → nothing routes, whatever is configured |
| read-your-writes | one write anywhere in the scope, at any depth, across any `await`, and every later read in it is the primary's |
| a transaction | always the primary — `reserve()` is delegated there, so BEGIN, the body and COMMIT are one connection on one server. A `readOnly: true` transaction leaves the scope clean |
| eligibility | `select` / `table` / `values` / a read-only `with`, minus locking reads, `select … into` and the functions a standby answers instead of refusing (`pg_advisory_lock`, `set_config`, `nextval`). Everything else is the primary's |
| a replica that fails | the statement is re-run on the primary — exactly-once, because only plain reads are sent there and a `25006` refusal never executed. Three failures in a row park it for ten seconds |
| observability | `client.stats` (`replica`, `primary`, `fallbacks`, `parked`), and a `db.replica_fallback` warning per fallback |

**The URL must name a read-only standby.** The server's own `25006` refusal is the safety net under
a classifier that cannot be complete; pointed at a writable node a misroute becomes a write on the
wrong server, silently.

**Nothing opens the scope for you yet.** `withReplicaReads` is tier 1 and ships first; wrapping a
request in it is the app's call — or one line in the HTTP pipeline — so until that lands no
production traffic is routed.

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
exclusion (the ledger alone), reserving `x_users` for a schema view that wants it.

**A CHECK the catalog no longer holds is drift, `As of 2026-08-25` — by NAME.**
`pg_get_constraintdef` answers Postgres' own rewriting (`status in ('draft', 'published')` reads
back as `CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))`), so the catalog side is
read as `conname` alone and lands on `TableDescription.checkNames`, a **separate field** from the
declaration's `checks`. Only the declared side is judged, so a NOT NULL, an `enumerated()` column's
old anonymous form and an extension's own constraint are all silent; a declared one the catalog
does not hold is `missing-check`, whose `fix:` is the `add constraint` statement itself, because the
migration that declares it is already in the ledger and `x db migrate` would apply nothing. There is
no `changed-check`: presence is a boolean, a predicate is text, and normalising the text is an
expression parser competing with the server's.

**Nor is a relation an extension owns, `As of 2026-08-24`.** `create extension pg_stat_statements`
in `public` is the CNPG, RDS, Supabase and Neon default, and its view read as `unexpected-table`
with `x db gen "add pg_stat_statements"` as the fix — so every deploy failed terminally and the fix
would have written an extension's internal view into the app's migration set. `introspect()` now
excludes every relation Postgres records as extension-owned (`pg_depend`, `deptype = 'e'`), which is
ownership rather than a name: a `pg_*` prefix rule covers that view and misses `postgis`'
`spatial_ref_sys`. Views, materialised views and foreign tables go with them — no snapshot records
one, so counting them could only ever produce a finding an author has no way to clear. A table
someone created by hand carries no such dependency and is still `unexpected-table`.

Rendered output is pinned byte-for-byte:

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

| Difference | cause | fix |
|---|---|---|
| live column, no migration | `table "T" has column "C" not present in any migration` | `x db gen "add C"` — the name goes through `shellInertIdentifier()`, and one it refuses is left OUT of the command rather than escaped into it (`x db gen "add the undeclared column"`, the name in the cause) |
| migrated column, not live | `table "T" is missing column "C" that migrations declare` | `x db migrate` |
| live table, no migration | `table "T" is not present in any migration` | a `create table if not exists` in a migration, then `x db migrate` — or `drop table` in `psql` where nothing owns it. Never `x db gen`, which diffs a table nothing declares against nothing and writes no file (issue #345). The name goes through `shellInertIdentifier()`, and one it refuses leaves the fix as prose |
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
`X_ASYNC_CONTEXT_UNAVAILABLE` naming the scope it could not open. A server saves no allocation —
the store is built on the first `get()` **or** `run()`, so a read constructs it too. What the
laziness costs is nothing observable: `getStore()` outside a scope answers `undefined` whether the
storage was ever constructed or not. Not a claim that the whole package
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

**Four of them carry `retry: "retryable"` in `--json`, `As of 2026-08-23`** — `DB_ERROR_RETRY`:
`X_DB_SERIALIZATION_FAILURE`, `X_DB_LOCK_TIMEOUT`, `X_DB_POOL_EXHAUSTED`, `X_MIGRATE_CONCURRENT`.
Each is a resource that frees, so the same call has a real chance of a different answer with no edit
in between. Everything else keeps core's fail-closed `terminal`, and is deliberately left
UNREGISTERED rather than registered as terminal: `@ultimat3/jobs` dead-letters a registered
`terminal` on attempt 1, so classifying `X_DB_UNAVAILABLE` that way would dead-letter every in-flight
job the moment Postgres fails over.

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
