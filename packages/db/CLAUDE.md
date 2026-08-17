# @ultimat3/db — agent notes

Tier 1 — it imports `@ultimat3/core` and nothing else, so tier 1 is the lowest its real imports
allow. That placement is load-bearing: `@ultimat3/entity` (tier 2) owns the Postgres driver and
reaches down to this package for it. **Never** import `entity`, `jobs`, `http` or anything higher
— entity snapshots arrive as a parameter (`EntityDescriptionLike`), never as an import.

| Rule | |
|---|---|
| Deps | none. `@electric-sql/pglite` is an **optional peer**, imported by variable specifier inside `loadPgliteDriver()` so no consumer's `tsc` or bundler resolves it. **No ORM** — `entity`'s hand-written `postgresDriver()` is the production backing |
| SQL | `sql` binds `$n`; anything non-scalar and non-fragment throws `X_SQL_UNSAFE` |
| Escape hatches | `raw()`, `identifier()`, `literal()` — each call is an audit point |
| SQLSTATE | one reader, `sqlState()` (`sqlstate.ts`). Never read `error.code` for a SQLSTATE |
| Errors | subclass `DbError`; never `throw new Error` **in source**. A test simulating a *database* failure throws `dbUnavailable()`; a test simulating the *caller's body* failing throws a bare `Error` on purpose — an arbitrary throw is exactly what rollback and disposal must survive, and a `DbError` there would prove the narrower thing |
| New code | add to `DB_ERROR_CODES` **and** `DB_ERROR_TITLES` in `errors.ts` |
| Exports | explicit in `src/index.ts`; no `export *` |
| Files | < 200 LOC, one responsibility, `kebab-case.ts`, test beside source |

Pinned public seam — `@ultimat3/auth`, `@ultimat3/entity` and `@ultimat3/jobs` are written
against these exact names: `SqlFragment`, `sql`, `raw`, `identifier`, `join`, `DbClient`, `DbTx`,
`db`, `setDbClient`, `withTransaction`, `currentTx`. Changing a signature here breaks three
packages — `entity`'s `postgresDriver()` compiles every statement out of `sql`/`identifier`/`join`
and finds its connection through `db()`.

Deliberate cycle (safe — nothing is referenced at module-evaluation time):
`client.ts ⇄ transaction.ts`, and `pglite.ts → transaction.ts` for the same reason. `db()`
consults `currentTx()`; `withTransaction` uses `baseClient()`, never `db()`, or it would re-enter
itself. Keep both sides `function` declarations so hoisting covers the TDZ.

`pglite.ts` is a pool of exactly one: PGlite is a single session, so `reserve()` (backed by
`pglite-turns.ts`) is what stops two concurrent `BEGIN`s becoming one transaction. Three rules
hold it together and none is optional — the plain path takes a turn; a statement issued while
`currentTx()` is set skips the queue because it is already inside the transaction holding it; and
a reservation runs direct **only while its turn is held**, re-queueing through `turns.run` once
`release()` has been called. Drop the first and a rollback is silently lost; drop the second and
`enqueue(input, { outbox: false })` inside `withTransaction` hangs forever; drop the third and a
`tx` handle leaked past its scope writes into whichever transaction holds the connection next. The
first two are pinned by real-database tests in `pglite-embedded.test.ts` and a fake driver cannot
catch either; the third is a fake-driver test in `pglite.test.ts`, because it is about ordering,
not SQL. That is the split between the two files: `pglite.test.ts` pins the adapter against fakes,
`pglite-embedded.test.ts` boots the WASM module once and pins the binding.

`Turn` (`pglite-turns.ts`) is `Disposable`, same shape as `DbConnection`: `release()` and
`[Symbol.dispose]` are the same call, idempotent for free because it is a settled promise's
`resolve`, not a counter. `TurnQueue.run()` holds its turn with `using`, not a hand-rolled
`try`/`finally` — the pattern this package uses everywhere a scope-bound resource must go back on
every exit. `reserve()` in `pglite.ts` cannot use `using` for the turn it takes: the turn outlives
that function, released later by the caller's own `release()`/`[Symbol.dispose]`, so it calls
`turn.release()` explicitly instead.

The third rule is **both** drivers', not PGlite's alone: `client.ts`'s pinned handle also runs
direct only while it is held, and once `release()` has been called a late statement goes back
through the pool for a connection of its own. On a server the leak is quieter than on PGlite and
worse — the pool has already handed that physical connection to another unit of work, so the stray
row lands inside *their* transaction and is committed or rolled back with it. `release()` is
idempotent on both, because nothing in the type stops a caller from also releasing by hand, and a
second release frees a pin that is no longer ours. `DbConnection` is `Disposable`: `using
connection = await client.reserve()` is the shape, and `[Symbol.dispose]` is `release()` itself,
never a second code path.

**A pin is held by a `using` declaration, never a hand-rolled `try/finally`** — `withTransaction`
and `readOnlyQuery` are the two sites, and both now read the same. A `finally` only covers the
statements someone remembered to put in its `try`, and `withTransaction` proved it: `BEGIN` sat
*above* the block, so a `BEGIN` that rejected — a dead connection, a server in recovery, a
`statement_timeout` — returned the pin to nobody. On a pool that leaks one connection per failure;
on PGlite it holds the single session's turn, and every statement in the process after it waits
forever. `BEGIN` therefore lives inside the guarded scope, which is what `readonly-query.ts`
already did. Consequence worth knowing: a failed `BEGIN` now also emits a best-effort `ROLLBACK`
the server answers with a notice — cheaper than a second code path for the one statement that
opens nothing.

**`sqlstate.ts` is the only place a SQLSTATE is read, and the ordering inside it is the whole
point.** Measured, bun 1.3.14 against Postgres 17: `Bun.SQL` puts the literal string
`ERR_POSTGRES_SERVER_ERROR` on `code` and the SQLSTATE on `errno`; PGlite — node-postgres' protocol
— puts the SQLSTATE on `code` and carries no `errno` at all. So `errno` is read first, `code`
second, and both are shape-tested (`^[0-9A-Z]{5}$`) so an Ultimate code can never be mistaken for
one. `isLedgerMissing` used to do this read itself, reading `code` alone: correct on the embedded
driver and **`false` for a genuinely missing ledger on every production one**, which is exactly the
split axiom 1 forbids. `DB_SQLSTATE_CODES` is closed — a state the framework has no instruction for
stays `X_DB_UNAVAILABLE`, and a new instruction is a new row there, never a new `catch` at a call
site. `driverError()` in `errors.ts` is the only consumer that builds an error out of it, and
`sendOn` is the only caller of that.

**`DbTx.origin` is the client the scope was opened on, never the pin it runs on.** A `DbClient`
handed to `withTransaction` (or `baseClient()`) is what identifies the *database*; the reservation
is how this scope keeps its statements on one connection, which is an implementation detail nobody
above should have to know. The field exists because tier 2 could not answer the question without
it: `@ultimat3/entity`'s repositories can be pinned (`database(shard)`), and a pinned repository
inside `withTransaction` sends to its own pool while the `BEGIN` sits on a reservation, so the write
commits immediately, survives the rollback, and is invisible to reads inside the transaction —
silent loss of transactionality, not a crash. `{ client: shard }` does not fix it either: the
transaction runs on a *reservation* of the shard. With nothing to compare, entity's only honest
answer was `X_REPO_CLIENT_PINNED`; `tx.origin === thePinnedClient` makes the case work and leaves
the refusal for a genuine two-database mix. A nested scope reports the root's, because a SAVEPOINT
belongs to the transaction that opened.

**`withTransaction(fn, { retry })` re-runs `fn` from the top, and only on `40001`/`40P01`.** Default
0, because a retry nobody asked for silently doubles every non-idempotent handler in the framework.
Each attempt takes its own pin, its own `BEGIN` and its own undo list, so `runRoot` is extracted and
the loop is around it — a retry reusing the pin would be re-running against a transaction that is
already gone. A **nested** `retry` is refused through core's `assert` (`X_INVARIANT`), not ignored:
measured against Postgres 17, a `40001` aborts the whole transaction, so the `ROLLBACK TO SAVEPOINT`
that would start attempt two answers `25P01 ROLLBACK TO SAVEPOINT can only be used in transaction
blocks`. There is nothing to retry into, and an author who believes they hold a budget they do not
is worse off than one who is told.

**The migration lock is polled, never waited on.** `pg_advisory_lock` blocks with no timeout, so a
predecessor OOM-killed on a network partition kept its backend — and the lock — for hours while the
new `ROLE=migrate` pod sat inside one statement printing nothing: `helm upgrade --wait` blocked on a
pod that was `Running`, and because the job never *failed*, `backoffLimit` never fired.
`acquireLock` loops on `pg_try_advisory_lock` every `MIGRATION_LOCK_POLL_MS` until
`MIGRATION_LOCK_WAIT_MS` and then throws `X_MIGRATE_CONCURRENT` — a code reserved since 1.0 and
never thrown until now. The loop declares itself with `expectedQueryLoop`, like every other
deliberate loop here. `createRecordingClient` therefore stubs `pg_try_advisory_lock` to `locked:
true` by default: a fake that answers nothing would read as "held" and make every migration test in
every app wait out the full budget.

**`lock_timeout` is the migration's, not the pool's.** `PoolProfile.lockTimeoutMs` is 0 everywhere
but `migrate` (3s), and `migrate()`/`rollback()` emit it as `SET LOCAL lock_timeout` inside each
migration's own transaction rather than on the connection string. `SET LOCAL` reverts at COMMIT, so
a value chosen for DDL never leaks onto the session the ledger insert runs on — and the profile is
read by role `migrate` whatever role is running, because an `alter table` takes the same `ACCESS
EXCLUSIVE` from a laptop as from a deploy hook. Without it the migrator waits forever behind a long
`SELECT` and, because Postgres' lock queue is FIFO, so does every later query on that table.

**The migration advisory lock is held by one pinned session, and `migrate()`/`rollback()` run every
statement on it.** `pg_advisory_lock` is scoped to a Postgres *session*, so taking it on a pooled
handle locks whichever connection the pool lent for that one statement and then gives the session
back: the unlock later lands on a different connection, answers `false`, and the lock stays held
until that backend dies — the next migrator then waits forever rather than for the migration. The
same split loses the lock the other way: the locking session sits idle for the whole run and the
pool's idle timeout (`migrate`'s is 10s) closes it, releasing the lock mid-migration. `ROLE=migrate`
hid the first half by accident — its pool is `max: 1`, so every statement found the same connection.
No other role and no test has that. The pin is therefore also why the lock scope hands its session
*down*: on `max: 1` a statement sent to the pool while the pin is held waits for a connection that
cannot come back until the migration blocking on it finishes. `lock: false` (`x db branch`, a
private database) reserves nothing and takes no lock, exactly as before.

Pinned by `migrate.live.test.ts` against a real Postgres: two concurrent `migrate()` calls (one
applies, the other skips — never both, never a unique-violation crash) and a migration that fails
mid-run (the next `migrate()` still finishes in ~0.3s instead of hanging on a lock the failure
left stuck). Both are invisible to a recording client, which cannot tell a pinned session from a
pooled one apart — the statement text is identical either way. Skips unless `TEST_DATABASE_URL` is
set.

Every transaction-control statement is `.catch`ed exactly where a failure would *mask* the error
that caused it, and nowhere else: `ROLLBACK` and `ROLLBACK TO SAVEPOINT` are best-effort, while
`SAVEPOINT` and `RELEASE SAVEPOINT` are deliberately uncaught — a savepoint that was never taken
means the nested scope never opened, and a release that failed means its work is not durable in
the outer one. Swallowing either would keep running against a transaction that is not the one the
caller thinks it is in.

`close()` reads its cached driver into a local, clears the field, **then** awaits the teardown —
`client.ts` and `pglite.ts` both. A teardown that rejects has still torn the pool down, so clearing
after the await left the corpse cached for the next `connect()`, and a second `close()` threw in
the same place rather than clearing it. The rejection still reaches the caller on `client.ts`
(`pglite.ts` swallows a failed *boot*, which is a different thing: there is nothing to close).

`execute()` trusts the command tag only when it is `> 0`, in **both** drivers — `rowsOf`
(`pglite.ts`) and `affectedBy` (`client.ts`) are one rule written twice, not two rules. PGlite
counts MODIFIED rows, so a SELECT that returned rows is tagged `0` and `??` would report 0 for
every read; a driver that tags a read `0` on the pooled side would have diverged from PGlite the
same way, and the same guard closes both. A write that modified nothing returned no rows either, so
the fallback stays 0 there.

`observe.ts` is the seam a statement-level diagnostic installs into: one process-wide `StatementObserver`, installed with
`setStatementObserver()` and read with `statementObserver()`, the same ambient shape as
`setDbClient()`. Three rules, each load-bearing. **Guard at the call site** — read the accessor,
branch on `undefined`, and only then build the `StatementEvent`; a `notify(event)` wrapper would
allocate an event per statement for nobody to receive, and this seam is on the path every statement
in the process takes. **One observer, not a list** — a second install replaces the first (axiom 1);
a consumer needing several composes them itself. **The accessor returns the installed identity and
the seam swallows nothing** — a throw from `onStatement` is how strict test mode fails the test its
N+1 happened in, so a guarding facade here would silently delete that mode. `onStatement` is
synchronous, runs on the caller's stack after the statement settled, and must not issue SQL: a
statement from inside it re-enters the funnel and observes itself. Only two places may invoke it —
`runOn` (`client.ts`) and `statement()` (`pglite.ts`), the funnels every statement already passes
through. Reserving a connection, booting PGlite and closing a pool are not statements and stay out.

Both funnels are now split in two, and the split is the whole design: `sendOn`/`send` is the raw
statement plus the `X_DB_UNAVAILABLE` wrap — byte-identical to what the funnel used to be — and
`runOn`/`statement` is the observed shell around it. Three rules hold, in both drivers:
**guard first** — read the accessor, and with nothing installed hand straight to `sendOn`/`send`,
no clock read and no event; **observe both settle paths** — a failed statement is an event with
`rows: 0` and the already-wrapped error the caller is about to be thrown, because fifty identical
timeouts are still fifty statements; **notify outside the statement's own `try`** — a throw from
`onStatement` on the success path is the observer's, and catching it there would wrap a statement
that succeeded as `X_DB_UNAVAILABLE` and delete strict test mode's failure. On the failing path
the observer's throw replaces the DB error instead, which is the price of never swallowing — an
observer that only reports must not throw. `rows` comes from the same helper `execute()` uses
(`affectedBy` in `client.ts`, `rowsOf` in `pglite.ts`, hoisted to module scope for it), so the
report and the return value cannot disagree about one statement.

`attribution.ts` is `StatementEvent.attribution`'s producer: `withStatementAttribution(entity, op,
fn)` runs `fn` with every statement it issues — at any depth, across every `await` — attributed to
that pair, on an `AsyncLocalStorage` the same shape `expected-loop.ts` already uses. Four rules,
none optional. **Guard first** — it reads `statementObserver()` before touching the scope at all
and, with nothing installed, hands straight to `fn`: one property read, one branch, no object
allocated, on the path every statement in the process takes (axiom 6) — which is also why the pair
arrives as two strings rather than a `StatementAttribution` literal, since a literal at the call
site would be allocated before the branch could decline it. **A scope, not a parameter** — the
statement leaves several frames and at least one microtask below the repository call that caused
it: the coalescer flushes its batch from a `queueMicrotask` (`coalesce.ts`), a wide write is a
chunked loop, a preload sends through `readByIds`, and threading a parameter through all of those
is the same fact written five times, with every path an author forgot it emitting unattributed SQL.
**Nesting keeps the innermost pair**, exactly as `expectedQueryLoop` keeps the innermost reason: a
relation preloaded during `findMany` reads through the *related* repository, so its statement is
attributed to that entity and its own operation, not to the read that triggered the preload.
**The funnels stamp, on both settle paths** — `runOn` (`client.ts`) and `statement()` (`pglite.ts`)
read `statementAttribution()` inside the branch that already found an observer, next to
`expectedQueryLoopReason()`, and put it on the event whether the statement succeeded or failed, the
same argument as `expected`: a diagnostic that judges a whole request runs long after every scope
in it closed. `@ultimat3/entity`'s `postgresRepo` is the one producer — the last caller that still
knows both once the SQL exists (`packages/entity/CLAUDE.md`) — and an observer installed *during*
`fn` sees the statements that follow unattributed, since installation happens once, at boot.

`statement-shape.ts` is what a statement's *identity* is, and it lives here because its only input
is a `StatementEvent`. `statementFingerprint(event)` is `entity.op` when the event is attributed and
the event's own whitespace-collapsed text when it is not; `statementKind(text)` is read or write off
`statementVerb(text)`, a closed set of verbs and never a set of repository operations — a soft delete
is an `update`, an op list would drift with `@ultimat3/entity`'s method names, and hand-written SQL
carries no operation at all. Two detectors group by that identity (`x dev`'s ledger,
`@ultimat3/testing`'s `statements` fixture) and `statementSpanName` reads the same verb, so the rule
is written once — a second copy is two answers to "is this the same statement again". Nothing here
counts: the threshold is `@ultimat3/entity`'s `N_PLUS_ONE_THRESHOLD`, next to the codes whose `fix`
depends on it.

`statement-span.ts` is the other half of the observed shell: `withStatementSpan` wraps the **send
alone**, so the span's duration is the statement's and the observer's own work is not charged to
the database. Three decisions, each load-bearing. **`db.<verb>`** (`db.select`, `db.begin`; a text
opening with a comment is `db.statement`) — `@ultimat3/cli`'s `dev-traces.ts` reads the `/_x` panel
kind off the name prefix like it does for `query.`/`cache.`/`job.`, and this package is tier 1 and
cannot name a tier-5 vocabulary. **The text is `STATEMENT_ATTRIBUTE`** — `db.statement`, OTel's own
attribute and the one `dev-traces.ts` prefers over the span name, so a repository loop is fifty rows
of one SQL text in `repeatedSql` and not one `query.feed`. It is **exported** and re-exported from
`src/index.ts` precisely because it is a contract across two packages: `dev-traces.ts` and its test
import it, so renaming it here is a compile error there rather than a panel that quietly groups
nothing while every test stays green. **It opens only when an observer is installed**, inside the
guarded branch that already exists: installing an observer is the single switch that turns
statement instrumentation on, event and span together (axiom 1), and an uninstalled process mints
no span id and allocates no span object per statement — which on this path is every statement in
the process. The OTel `kind` is `client`; the database is the remote peer.

`expected-loop.ts` is the **only** suppression mechanism, and the reason it is a scope rather than
a pragma or a list is the same reason `observe.ts` is one observer: a second path is the tax
(axiom 1). `expectedQueryLoop(reason, fn)` rides an `AsyncLocalStorage`, so it survives every
`await` at any depth and two loops running concurrently never read each other; nesting keeps the
innermost reason, because the closest scope is the one describing this loop. A blank reason is
`X_INVARIANT` through core's `assert` — no new code for it, and an exemption with no argument is a
pragma with extra steps. Three rules. **The funnel stamps, the consumer reads** — `runOn` and
`statement()` call `expectedQueryLoopReason()` inside the branch that already found an observer and
put the answer on the event as `expected`; a detector that judges a whole request runs long after
every scope in it closed, so reading the ALS later would find nothing. **It suppresses a verdict,
not a statement** — the SQL is still sent, still observed, and the span still opens, so anything
that measures still sees the loop and only the thing that warns is told the author already
answered. **It costs nothing uninstalled** — the read lives inside the observer branch, so the
production path is still one property read and one branch.

The framework's own deliberate loops declare themselves at source, and new ones must: `migrate()`
and `rollback()` (`migrate.ts`) apply and reverse one migration per transaction so a failure leaves
an exact ledger, and `@ultimat3/admin`'s `search.ts` runs one indexed lookup per text field. Adding
a `db` dependency to `admin` for that one import is deliberate — the alternative is re-exporting the
scope from a package `admin` already imports, which is the second path this rule forbids.

**`@ultimat3/jobs` never imports this package** (`packages/jobs/CLAUDE.md`), so nothing about the
observer, the span or `expectedQueryLoop` is this package's concern *from inside* `jobs` —
`driver-pg.ts` speaks only the two-method `PgExecutor` it declares itself, satisfied by anything
shaped like `query(sql, params)`. That is a statement about the package boundary, not about what a
running process does with it: `packages/cli/src/dev-queue.ts`'s `startQueue` — the only place in
the repo that builds a `PgExecutor`, reached by every role through `dev-runtime.ts`'s
`startServices` and by `migrate` through `serve.ts`'s `runMigrations` — wraps a real
`PostgresClient`/`PgliteClient` `.query()` call for it. So today, in this framework's own boot
code, every job-driver statement (claim, ack, nack, enqueue, heartbeat, step read/write) **does**
pass through `runOn`/`statement()` and is visible to an installed `StatementObserver` and traced
exactly like any other statement — just with no `attribution`, which is not a `jobs` gap now
either: `@ultimat3/entity`'s `postgresRepo` is `attribution.ts`'s producer (above), but `jobs`' own
statements never reach it — `driver-pg.ts` compiles its SQL directly against `PgExecutor`, not
through a repository, so nothing calls `withStatementAttribution` on a claim, an ack, a nack or a
heartbeat's behalf, and every one of those events still reads `attribution: undefined`. An entity
read or write sharing the same process now carries the pair; a job-driver statement does not, and
the gap is real, just narrower than it was. This is incidental, not guaranteed:
`PgExecutor` is duck-typed, so a deployment that hands `createPgDriver` an executor not backed by
this package — a raw `Bun.SQL` instance, a hand-rolled pool, `driver-redis`/`driver-nats` (which do
not touch Postgres at all) — gets zero observation of its queue traffic, and nothing here or in
`jobs` enforces otherwise. A detector reading `attribution` (PR 9's N+1 work) sees a claim loop as
anonymous SQL, never as a `job` statement, and will keep seeing it that way until `jobs` threads its
own pair through `driver-pg.ts` the way `postgresRepo` now threads entity's — that is still future
work, not something this change reaches.

**`generate.ts` reads an index, it never re-derives one.** `EntityDescriptionLike.indexes` carries
`columns`, `unique`, `where` and `order`, and `createIndex` writes every one of them out. It used to
carry names alone and `parseIndexName` recovered the column list from the `<table>_<a>_<b>_idx`
convention — which does not run backwards: `_` joins the columns *and* appears inside them, so a
two-column index emitted `("org_id_created_at")`, a column that does not exist, `42703`, and a
migration nobody can apply. The same loss took the rest of the declaration with it: a partial index
emitted as a total one refuses rows the entity allows, and a `desc` index came out ascending. Any
new part of an index is added to `IndexDescriptionLike` and spelled in `createIndex`, never encoded
into the name for a reader to parse back out. An index naming no column is `X_INVARIANT` through
core's `assert` — `entity()` refuses `on: []` at declaration, so nothing the framework produces can
reach it, and a hand-built description gets the error rather than DDL Postgres cannot parse.
`generate.test.ts` pins the generated SQL text; `migrate.live.test.ts`'s composite-index describe
block is the join of that fix with the engine it ships through — an entity description into
`generateMigration`, applied by `migrate()` itself against a real server, columns confirmed against
`pg_indexes`, rather than either half alone.

**One send is one statement, so `migrate()` and `rollback()` split the script.** `tx.execute(raw(
migration.up))` on a text holding two commands is where the two drivers disagreed, and the
disagreement is the whole reason this is a bug rather than a preference: `pglite.ts` calls
PGlite's `query()`, which is the extended protocol always and answers `cannot insert multiple
commands into a prepared statement`, while `client.ts`'s `Bun.SQL.unsafe(text, values)` degrades to
the *simple* protocol whenever `values` is empty and applies the same script — measured on bun
1.3.14, guaranteed by nothing. `createTable` emits the table *and* every index it carries, and
`x dev`/`x db branch` run on the embedded driver, so the broken case was the common one on the
path an author uses most. `applyScript` (`migrate.ts`) sends `statementsOf(script)` one at a time
inside the **same** transaction; a half-applied migration is worse than an unapplied one, and it
needs no `expectedQueryLoop` of its own because both call sites already run inside the one declared
for the migration loop. `pglite-embedded.test.ts` is where that is pinned — a recording client
replies to any text, and only a real engine has an opinion about a script.

`statement-split.ts` is that splitter and the only one: `statementsOf(script)` is a left-to-right
scan, never a `split(';')`, because a `;` inside a string literal, a quoted identifier, a
dollar-quoted body, a `--` comment or a **nested** block comment is data — and a generated migration
holds all five, including the `-- backfill "c", then: … set not null;` note. Three rules. `$1` is a
bound parameter and never a `$tag$`, so a tag may not begin with a digit — otherwise one parameter
swallows the rest of the script. A backslash escapes only inside an `E''` string, which is also the
only place the `''` escape is observable: everywhere else, closing and reopening the run lands on
exactly the same separator. A chunk of whitespace and comments alone is **not** a statement and is
dropped, so an empty `up` reaches its ledger row instead of sending an empty query. An unterminated
literal is returned as it stands — Postgres names that syntax error precisely, and a second parser
competing with it would only report the same fault in worse words. `@ultimat3/entity`'s and
`@ultimat3/ai`'s live tests import it rather than hand-rolling a seventh copy; splitting a script is
one question with one answer (axiom 1).

`destructive.ts` is the rail, and it decides **what** is destructive — never **whether** a given
repo has any. `x db gen` reads `isDestructive(up)` to write `-- destructive: true` into the file;
`x verify`'s `drift` step reads `hasDestructiveMarker`/`destructiveStatements` to refuse a file that
lacks it (`@ultimat3/cli`'s `db-destructive.ts`). One classifier for both, because a generator that
wrote no marker where the gate demanded one would ship a migration failing its own gate. Four rules.
**Only `up`** — reversing a `create table` is a `drop table`, so a rail reading `down` marks every
migration ever generated and a marker on all of them marks none. **A closed list of four kinds** —
`drop table`, `drop column`, `truncate`, `alter column … type`; a rail enumerating every Postgres
foot-gun is a second SQL parser competing with the server's, and every one of these four is a
statement `generateMigration` emits, so each has a generated case holding it honest. `drop
constraint`/`default`/`not null` and `drop index` are excluded by name: the database rebuilds them.
**Decide on blanked text, report the original** — `statementsOf` + `stripSqlNoise` before a keyword
is looked for, so `-- drop table users` is prose and `values ('drop table users')` is data; but the
excerpt in the error keeps its identifiers, because `drop table ""` names nothing an author can act
on. **The marker is a top-level line comment**, like `-- down`, so a file merely mentioning it has
declared nothing — and one inside a `/* … */` or a dollar-quoted body has declared nothing either,
which a regex over the raw file could not tell apart. `hasDestructiveMarker` walks `sql-scan.ts`
for the same reason the classifier does: the marker is a lexical fact, not a substring. It is also SQL the checksum covers, which is deliberate: marking an already-applied
migration is an edit, and `X_MIGRATION_CONFLICT` is the correct answer to that.

`X_MIGRATION_DESTRUCTIVE` and `X_MIGRATION_IRREVERSIBLE` are two questions, not two spellings of
one. Irreversible refuses to *generate* a plan whose `down` cannot restore the rows, and
`--allow-destructive` is the override. Destructive refuses to *ship* a plan whose `up` destroys them
without saying so — and a retype is reversible in DDL, gated by no flag, and still rewrites every
row, so it is marked without ever being refused.

`sql-scan.ts` is the **one** lexer under all of it: `noiseAt(text, index)` names the span starting
at one offset — line comment, block comment, literal, quoted identifier, dollar-quoted body — or
`null` for code. `statement-split.ts`, `sql-noise.ts` and `destructive.ts`'s marker all walk it, and
a splitter that disagreed with a guard about where a literal ends is a `;` sent as data or a
`delete` read as prose. Two rules it owns. **Source order, never a sequence of replacements**:
`stripSqlNoise` blanked comments before literals, so the `--` in `select '--'; delete from posts`
read as a comment and erased the `delete` before `inspectStatement()` saw it — a mutating fragment
through `readOnly(client, { seal: false })`. **A `$tag$` needs separating from the identifier before
it**: `$` is legal in a name after the first character, so `foo$tag$` is one identifier and
`select foo$tag$; select 2;` is two statements — read as a body opener it went out as one send.
The run before the delimiter is walked to its start rather than one character being read, because
`$1$tag$` is a bound parameter followed by a real delimiter and a run opening with a digit or a `$`
cannot be an identifier at all.

`sql-noise.ts` holds `stripSqlNoise` alone, for the three guards that share it — `readonly.ts`,
`readonly-query.ts`, `destructive.ts`. It lives apart from all of them because `errors.ts` names the
rail's wording and the rail reads SQL text: leaving the blanker in `readonly.ts` would have put the
error registry, which registers codes at module evaluation, inside an import cycle.

`runningAppVersion()` delegates to `@ultimat3/core`'s `appVersion()` and keeps its explicit
override — `x_migrations.app_version` and `@ultimat3/jobs`' `x_backfills.app_version` are two
durable columns an operator reads side by side, and `jobs` cannot import this package for the
answer, so the key has one reader at tier 0 rather than one per writer.

`checkDrift()` is the **post-migrate verification** and the only drift question that needs a
database: the live catalog against the ledger the run just wrote. It is asked where a connection is
open — `@ultimat3/cli`'s `runMigrations`, which is `x db migrate`, `x db reset` and `ROLE=migrate`
alike — and returned, never thrown. The *other* `X_DB_DRIFT` is `@ultimat3/cli`'s
`checkSourceDrift`: the entity source hashed against what `x db gen` recorded, no database, which is
what `x verify`'s `drift` step runs in a CI with nothing listening. Two conditions, two detectors,
one code — and neither may grow the other's half. Until 1.2.0 both were named `checkDrift`, the
file-hash one was wired everywhere and this one had no callers at all.

`declaredSchema()` answers with the **newest** migration's snapshot or with `undefined`, never with
the newest one that happens to have a snapshot. `0001` records `posts`, `0002` adds a column and
writes nothing down, and reaching back to `0001` reports a column the database correctly holds as
`unexpected-column` — drift against a schema that is exactly right, with `x db gen "add …"` as the
fix for a migration that already exists. `checkDrift` turns that `undefined` into an
`unknown-schema` difference rather than `ok: true`, and `x db gen` refuses with
`X_MIGRATION_SNAPSHOT_MISSING` rather than diffing against the empty schema, which would emit
`create table` for every table the database already holds.

`compareTable` compares **nullability**, and it is the only column property it compares besides
existence. `snapshotOf` had recorded `nullable` all along and nothing read it, which made the
expand/contract flow a one-way door: `generate.ts` emits a `NOT NULL` add as nullable plus a
`-- backfill "c", then: … set not null;` comment, phase 2 is a thing a human has to remember, and
with nullability uncompared the column stayed nullable forever against an entity schema that said
otherwise — `ok: true` on every check until an `undefined` write landed as `NULL` three services
away. **Primary key columns are excluded, by the union of both sides' keys**: Postgres makes a key
column `NOT NULL` whether or not anything declared it, so a snapshot spelling `id` nullable would
otherwise put one finding on every table in a correct database. The type is still not compared —
the catalog and a snapshot spell types differently often enough that it would report drift on a
right database, and `x db gen`'s `retypeColumn` owns that question where both sides are generated.
The `fix:` is the `alter table … set not null` itself and deliberately not `x db gen`, which has
never emitted one and would answer with an empty migration.

`compareTable` judges **declared** indexes: one the migrations name and the catalog does not hold is
`missing-index`, and one whose column list or uniqueness moved is `changed-index` — which is what
catches a composite index rebuilt with its columns the other way round while the column diff said
`ok: true`. A live index no snapshot names is deliberately **not** reported: Postgres creates one for
every primary key and every unique constraint, so counting those is eight findings against a correct
database, the same argument `appTables()` makes. The predicate and the direction are not compared
either — the catalog returns its own rewriting of an expression (`(deleted_at IS NULL)`) and the
snapshot holds the author's spelling, so a text comparison reports two identical indexes as drift.
`x db gen` compares them instead (`redefineIndex`), where both sides are generated. Named in
`wiki/Known-Gaps.md`.

`compareForeignKeys` judges **declared** keys the same way, and matches on **where the key points**
— its columns, its target table, its target columns — never on the constraint name. `snapshotOf`
names one the way Postgres names an inline `references` clause (`posts_org_id_fkey`) because that is
what the generated SQL produces, but a hand-written migration may have said `constraint fk_posts_org`
and a key pointing the same way under another name is the same key. `onDelete` is not compared: the
catalog spells it `a`/`c`/`r` and no generated clause has ever declared one, so a snapshot has
nothing truthful to hold there. Before this, `snapshotOf` recorded `foreignKeys: []` beside an `up`
emitting `references "orgs" ("id")` — a snapshot denying a constraint its own migration creates — so
`alter table … drop constraint` on the database answered `ok: true`. `x db gen` still emits no
`add constraint`/`drop constraint` of its own; see `wiki/Known-Gaps.md`.

`introspect()` reads an index's columns in **index key order** (`indkey`, not `attnum`) and carries
its predicate and direction. Ordering by `attnum` returned a composite index's columns in table
order, which reads correct and compares wrong.

A foreign key's two column lists are read the same way and, crucially, **together**: `conkey` and
`confkey` are unnested in one `unnest(a, b) with ordinality` and ordered by that shared position,
because they are one ordered pairing and not two sets. Matching each independently
(`sa.attnum = any(c.conkey)`, `ta.attnum = any(c.confkey)`) is a cross product — a two-column key
came back as four source columns against four referenced ones, duplicated and misaligned, so
`compareForeignKeys` judged a correct database as drift and the admin schema view showed a key
that does not exist. Only a real engine can tell the two queries apart, which is what
`introspect-embedded.test.ts` is for: it boots PGlite, declares `(org_id, user_id) references users
(tenant_id, id)` — neither list alphabetical, the two orders deliberately different — and asserts
the pair comes back whole. Same split as `pglite.test.ts`/`pglite-embedded.test.ts`:
`introspect.test.ts` pins the row -> description fold against a recording client, and the embedded
file pins the catalog SQL against Postgres.

`appTables()` is why it can run: a table in the `x_` namespace is framework bookkeeping — the
ledger, `x_jobs`/`x_job_steps`, `x_outbox` and every `@ultimat3/auth` table are `create table if not
exists` at boot, declared by no migration and carried in no snapshot, so counted as app schema they
are eight `unexpected-table` findings against a correct database. The prefix is the rule, not a
list, so a table a future package adds needs no second declaration here. `introspect()` keeps its
narrower default (`x_migrations` alone) because the admin schema view and the MCP `schema.describe`
tool legitimately show `x_users` — only drift wants the whole namespace gone.

The `X_DB_DRIFT` rendering in `drift.ts` and the title in `DB_ERROR_TITLES` are pinned by the
framework contract and duplicated in `@ultimat3/entity`. Change them together or not at all.
`errors.ts` registers `DB_ERROR_TITLES` **unconditionally**, in one call, and that is deliberate:
a presence guard would turn "a second package claims one of db's codes" from an
`X_ERROR_CODE_DUPLICATE` at import into whichever module loaded first deciding the title. Entity
borrows `X_DB_DRIFT` and declares no title for it, for the same reason.

`readOnly()` is the regex-gated client for any caller that cannot open its own transaction. The
MCP `db.query` tool does not use it — it goes through `readOnlyQuery()`, which is stronger.

**`readOnlyQuery` takes ONE statement**, refused through `statementsOf` before the transaction
opens (`X_SQL_UNSAFE`, `multipleStatements`). This is not a second mutating-keyword scan — it is a
different question, and the one the layer's own guards depend on: the statement is *spliced* into
`DECLARE … CURSOR FOR`, and only the first command of that text is bounded by the `SET LOCAL
statement_timeout` set moments earlier, so `select 1; set statement_timeout = 0` undid the guard
while `guards` went on reporting `timeout:5000ms`. `BEGIN READ ONLY` still held, so this was a
defeated layer reported as an engaged one rather than a write — and a guard list that lies is worse
than a guard list that is short. `statementsOf` is the package's one splitter, so a `;` inside a
literal, a comment or a dollar-quoted body stays data.

`readonly-role.ts` and `readonly-query.ts` are layers 1–2 of that tool's defence-in-depth: a
`NOLOGIN` Postgres role (`ensureReadOnlyRole`) and a per-statement `BEGIN READ ONLY` + statement
timeout (`readOnlyQuery`). Only layer 1 degrades: `ensureReadOnlyRole` returns `null` on a missing
permission and leaves reporting the degraded layer to the caller. **`readOnlyQuery` throws** — a
failed reservation (`X_DB_UNAVAILABLE`), `SET LOCAL ROLE`, transaction command or the statement
itself all reach the caller, and every caller must handle that. Layers 3–4 (pre-parse scan, MCP
policy) live in `@ultimat3/mcp`, which must still never import this package — the CLI wires the
two together.

```bash
bun test                      # from packages/db
bun run typecheck
```

Gotchas:
- `exactOptionalPropertyTypes` — declare optional fields as `x?: T | undefined`.
- `noUncheckedIndexedAccess` — array reads are `T | undefined`; `chunks[i] ?? ''` everywhere.
- Tests use `createRecordingClient()` + `setDbClient()`; no test may need a live database.
- A test that must prove a pin came back uses `reservableOver()` (`fake-reservable.ts`), never a
  local copy — the recording client cannot see a leak, so the counter is the whole assertion and
  a second copy of it drifts.
- `ALTER DEFAULT PRIVILEGES` is scoped to an object's creator, so layer 1 covers future tables
  only for the roles in `creators` (default: the connected user). Migrations running as another
  DB user must name it, or tables created later are not selectable by `ultimate_readonly`.
- `Bun.SQL` is reached lazily inside `connect()` — importing `client.ts` must not open a socket.
