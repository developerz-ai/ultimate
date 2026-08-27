# @ultimat3/db — agent notes

Tier 1 — it imports `@ultimat3/core` and nothing else, so tier 1 is the lowest its real imports
allow. That placement is load-bearing: `@ultimat3/entity` (tier 2) owns the Postgres driver and
reaches down to this package for it. **Never** import `entity`, `jobs`, `http` or anything higher
— entity snapshots arrive as a parameter (`EntityDescriptionLike`), never as an import.

| Rule | |
|---|---|
| Deps | none. `@electric-sql/pglite` is an **optional peer**, imported by variable specifier inside `loadPgliteDriver()` so no consumer's `tsc` or bundler resolves it. **No ORM** — `entity`'s hand-written `postgresDriver()` is the production backing |
| SQL | `sql` binds `$n`; anything non-scalar and non-fragment throws `X_SQL_UNSAFE` |
| A name reaching a `fix:` | `shellInertIdentifier()` (`sql.ts`), the tree's ONE screen for it, `As of 2026-08-26`. `identifier()` alone does not close it: it refuses `"`, `\` and whitespace and **accepts** a backtick and a `$` — `SAFE_IDENTIFIER` allows `$` on its fast path — which are the two characters a shell substitutes inside DOUBLE quotes. A refused name is left OUT of the command, never escaped into it |
| Escape hatches | `raw()`, `identifier()`, `literal()` — each call is an audit point. `literal()` is the tree's ONE SQL-string-literal escape (`scripts/sql-literal-copies.ts`, pinned at zero) and it emits `E'…'` when the value carries a backslash |
| SQLSTATE | one reader, `sqlState()` (`sqlstate.ts`). Never read `error.code` for a SQLSTATE |
| Reading a caught value | `renderThrowable()` from core; never `error instanceof Error ? error.message : String(error)` — both halves RUN app code (a `Proxy` trap, `Symbol.toPrimitive`) and `checkDb` backs `/readyz`, where a render that throws is an exception in place of the report the kubelet asked for |
| Errors | subclass `DbError`; never `throw new Error` **in source**. A test simulating a *database* failure throws `dbUnavailable()`; a test simulating the *caller's body* failing throws a bare `Error` on purpose — an arbitrary throw is exactly what rollback and disposal must survive, and a `DbError` there would prove the narrower thing |
| New code | add to `DB_ERROR_CODES` **and** `DB_ERROR_TITLES` in `errors.ts` — always there, whichever file the CONSTRUCTOR lives in. `errors.ts` reached the 500-line ceiling on 2026-08-25, so a migration's constructors are `migration-errors.ts` and an invariant's are `invariant-errors.ts`; both import `DbError` from `errors.ts` and neither is imported back, and `src/index.ts` re-exports every one of them so no consumer can tell |
| A value ambient across an `await` | `asyncContext<T>(subject)` from `@ultimat3/core` — never `new AsyncLocalStorage`. Three scopes here use it: `transaction.ts`, `attribution.ts`, `expected-loop.ts` |
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

**The three ambient scopes open through core's one lazy seam, and that is a build error rather than
a convention, `As of 2026-08`.** `transaction.ts` (`TxState`), `attribution.ts` (the entity/op
pair) and `expected-loop.ts` (the reason) each constructed a module-scope `AsyncLocalStorage` until
issue #255 closed it. A bundler stubs `node:async_hooks` to `{}` — Bun's `target: 'browser'` emits
`var { AsyncLocalStorage } = (() => ({}))` — so the `new` threw
`TypeError: undefined is not a constructor` at module **evaluation**, before any app code ran, and
took every importer of that file down with it. Through `asyncContext<T>(subject)` the module
evaluates, `get()` answers `undefined` (in a browser nothing IS in flight, so that is the true
answer) and `run()` throws `X_ASYNC_CONTEXT_UNAVAILABLE` naming the scope. Deferring the
construction changes nothing a server can observe: the storage is built on the first `get()` or
`run()` rather than at module load, and `getStore()` outside a scope answers `undefined` either
way — one object per scope, on first use, in place of one at module evaluation.
`scripts/async-context-guard.ts` refuses a `new AsyncLocalStorage` — and the import that binds the
class, aliased or namespaced — anywhere but `packages/core/src/async-context.ts`, and
`scripts/async-context-guard.test.ts` runs it over the tree in the gate's `unit` step.

`pglite.ts` is a pool of exactly one: PGlite is a single session, so `reserve()` (backed by
`pglite-turns.ts`) is what stops two concurrent `BEGIN`s becoming one transaction. Three rules
hold it together and none is optional — the plain path takes a turn; a statement issued while a
transaction is **live** (`inLiveTx()`) skips the queue because it is already inside the transaction
holding it; and a reservation runs direct **only while its turn is held**, re-queueing through
`turns.run` once `release()` has been called. Drop the first and a rollback is silently lost; drop
the second and `enqueue(input, { outbox: false })` inside `withTransaction` hangs forever; drop the
third and a `tx` handle leaked past its scope writes into whichever transaction holds the connection
next. The first two are pinned by real-database tests in `pglite-embedded.test.ts` and a fake driver
cannot catch either; the third is a fake-driver test in `pglite.test.ts`, because it is about
ordering, not SQL. That is the split between the two files: `pglite.test.ts` pins the adapter
against fakes, `pglite-embedded.test.ts` boots the WASM module once and pins the binding.
`pglite-observer.test.ts` is the third, split off the first purely for the line ceiling, along the
seam `observe.ts` already draws.

**The second rule fences on `inLiveTx()`, never on `currentTx() !== undefined`** — the two are
different questions and reading the second as the first was a cross-transaction write. The
async-context store rides into every promise chain started inside `withTransaction`, so a
statement the app forgot to `await` still found a store after COMMIT, skipped the turn queue, and
landed inside whichever unit of work held the single session next: measured `BEGIN`, `select 'inside
tx'`, `COMMIT`, `BEGIN`, `select 'straggler'`, `select 'inside tx 2'`, `COMMIT` — committed by a
transaction that never issued it, with nothing anywhere to read. `runRoot` now marks `TxState.live`
false on every exit and `inLiveTx()` (`transaction.ts`) is the one reader. A closed scope falls
through to `turns.run` **quietly**, exactly as `client.ts`'s released pin sends a late statement back
to the pool — one answer to one question, on both drivers. `currentTx()` deliberately still answers
with the dead handle: its statements go through the reservation, whose own `held` fence already
re-queues them, and it is a pinned public seam three packages are written against.

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

**A re-run waits first, `As of 2026-08-23`, and the default still waits not at all.** The loop had
NO backoff: two transactions that deadlocked woke in the same microsecond, took the same locks in
the same order, and one of them lost again — so a `retry: 8` budget was spent inside one round
trip's worth of wall clock, which is the deadlock reproduced rather than resolved.
`transaction-backoff.ts` is the schedule: `@ultimat3/core`'s `backoffDelay`, exponential from
**10ms**, capped at **500ms**, **full** jitter. The constants are contention's, not an outage's — the
winner of the race is already committing, and this loop holds a connection on a request's critical
path, so ai's 500ms base and jobs' one-second base would turn a recovered transaction into a
timed-out one. Full jitter because the two callers whose retries must not re-collide are, by
construction, scheduled at the same offset from the same event. Nothing waits when `retry` is 0 or
absent, and nothing waits after the LAST attempt. `{ sleep, random }` on `TransactionOptions` are
the injection seams and production passes neither.

**Four codes are classified `retryable`, and the terminal ones are deliberately NOT classified,
`As of 2026-08-23`.** `DB_ERROR_RETRY` registers `X_DB_SERIALIZATION_FAILURE`, `X_DB_LOCK_TIMEOUT`,
`X_DB_POOL_EXHAUSTED` and `X_MIGRATE_CONCURRENT` — each is a resource that frees. Before it, this
package classified nothing, so `X_DB_SERIALIZATION_FAILURE` rendered `retry: "terminal"` in every
problem document while its own `fix:` line read `withTransaction(fn, { retry: 3 })`.

The half that needs the argument is the codes left OUT. Core's shape (`CORE_ERROR_RETRY` lists only
the exceptions) rather than `@ultimat3/scraping`'s exhaustive one, because a REGISTERED `terminal` is
not the same as an unclassified code: `@ultimat3/jobs`' `nextRetryForError` dead-letters the first on
attempt 1 and keeps the attempt count for the second. `X_DB_UNAVAILABLE: 'terminal'` is defensible
for an HTTP client — four of its six throw sites are permanent config faults — and would dead-letter
every in-flight job the moment Postgres fails over. A code that means two things to two readers stays
unclassified until it is two codes. `errors-retry.test.ts` asserts the absence, so adding one is a
failing test first.

**What did NOT move down is core's `retry()` executor.** It stops on a `terminal` classification and
retries everything else, so an UNCLASSIFIED throw is retried — and the value caught here is a raw
driver error carrying a SQLSTATE, which core cannot see and nobody classified. Adopting it would
have re-run `fn` on a unique violation, a statement timeout and a throw from `fn` itself.
`isRetryableState` stays the guard, `40001`/`40P01` stays this package's Postgres knowledge, and only
the arithmetic is core's.

**`BEGIN` re-derives its isolation level from the closed set, `As of 2026-08-23`.** `BEGIN` takes
no parameters, so `beginStatement` is one of the two statements here built as TEXT — and the level
was `options.isolation.toUpperCase()` spliced into it. The TYPE is not the guard: the value reaches
`withTransaction` from an app's config, a JSON body or a CLI flag, and
`{ isolation: 'read committed; drop table x; --' }` became exactly that statement while a
non-string became an uncoded `TypeError` inside a template literal. `isolationMode` is a `switch`
over `IsolationLevel` whose `default` arm is `never` — a fourth level with no SQL beside it is a
type error, and anything else at runtime is `X_SQL_UNSAFE` (`isolationLevelInvalid`), the code
`branchNameInvalid` already uses for a value spliced into a statement.

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
cannot come back until the migration blocking on it finishes. `lock: false` reserves nothing and takes no lock, exactly as
before — for a database only this process can reach. **No shipped path passes it**: both option
comments named `x db branch`, which does not, and the only callers in the repo are
`migrate-pin.test.ts`'s. The option stays because it is public API shipped in 3.0.0 and the "no pin
was taken" assertions cannot be written without it; the false attribution is pinned out by
`migrate-pin.test.ts`, which also refuses a passer appearing inside this package.

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
(`pglite.ts`) and `affectedBy` (`statement-funnel.ts`) are one rule written twice, not two rules. PGlite
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
`runOn` (`statement-funnel.ts`) and `statement()` (`pglite.ts`), the funnels every statement already passes
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
(`affectedBy` in `statement-funnel.ts`, `rowsOf` in `pglite.ts`, hoisted to module scope for it), so the
report and the return value cannot disagree about one statement.

`attribution.ts` is `StatementEvent.attribution`'s producer: `withStatementAttribution(entity, op,
fn)` runs `fn` with every statement it issues — at any depth, across every `await` — attributed to
that pair, on an async context the same shape `expected-loop.ts` already uses. Four rules,
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
**The funnels stamp, on both settle paths** — `runOn` (`statement-funnel.ts`) and
`statement()` (`pglite.ts`) read `statementAttribution()` inside the branch that already found an observer, next to
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
(axiom 1). `expectedQueryLoop(reason, fn)` rides an async context, so it survives every
`await` at any depth and two loops running concurrently never read each other; nesting keeps the
innermost reason, because the closest scope is the one describing this loop. A blank reason is
`X_INVARIANT` through core's `assert` — no new code for it, and an exemption with no argument is a
pragma with extra steps. Three rules. **The funnel stamps, the consumer reads** — `runOn` and
`statement()` call `expectedQueryLoopReason()` inside the branch that already found an observer and
put the answer on the event as `expected`; a detector that judges a whole request runs long after
every scope in it closed, so reading the scope later would find nothing. **It suppresses a verdict,
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

**An index's ACCESS METHOD is carried end to end, `As of 2026-08-24`, and it had to land here
before `@ultimat3/entity` could declare it.** `@>` / `<@` / `&&` / `?` on a `json()` or `arrayOf()`
column is a sequential scan without a GIN index. `IndexInit.using` on the entity side while this
package ignored it would emit a **btree for a declared GIN index** — a declared-and-never-wired key,
which is the defect class this release exists to eliminate and strictly worse than the missing
capability. So the method reaches all four places or none: `createIndex` emits it, `snapshotOf`
records it, `indexShape` rebuilds on it, and `compareIndexes` reports it.

`index-method.ts` is the vocabulary, its own file for the reason `foreign-key.ts` holds
`onDeleteRule`: a generator and a detector that disagreed about what "the default" is would report
drift on a database that is exactly right. Four rules.

**The set is closed at two — `btree` and `gin`.** `gist`, `brin`, `hash` and `spgist` are legitimate
and are deliberately absent: nothing declares one, and each brings a rule that would have to be
enforced with no caller to test it (`hash` and `brin` cannot be unique, `gist` needs `btree_gist` to
be, none of the three accepts `asc`/`desc`). Adding a member later is additive; shipping four nobody
uses is four ways for a first caller to be silently wrong.

**Declared is CLOSED, live is OPEN.** `IndexDescriptionLike.using` is `IndexMethod | undefined` —
what an entity may ask for. `IndexDescription.using` is `string | undefined` — whatever `pg_am`
answered, `gist` and an extension's own access method included. Folding an unknown catalog name into
`btree` would hide exactly the difference drift exists to report, so `indexMethodOf` passes the live
side through verbatim and `declaredMethod` is the one place the open reading is narrowed back — a
**refusal**, never a silent fall back, because its one caller is `redefineIndex`'s `down` and a
`gist` quietly rebuilt as a btree is a rollback leaving a state no migration describes.

**Absent is `btree`, on both sides, through one function.** `indexMethodOf` is that function.
Postgres' default is written out by nobody, every index created before this existed is one, and
every sidecar written before the field is silent about it — so `snapshotOf` records `using` only
when one was declared. Writing `'btree'` out for every index would rewrite every sidecar in every
app on the next `x db gen`, a diff on every file for a fact that was already true.

**The literal is re-derived from the set, never spliced from the input** — `indexMethodSql` is a
`switch` whose `default` arm is `never` and throws `indexMethodInvalid` (`X_SQL_UNSAFE`, the code
`isolationLevelInvalid` and `branchNameInvalid` already use for a value spliced into a statement).
The type is not the guard: this value arrives from an entity declaration, a config or a hand-edited
snapshot, and `using ${method}` on an operand TypeScript never saw is the **identical hole** to the
one `columnName` carried when it was `meta.name ?? snake(property)` with only the second branch
validated — a name that closed the parenthesis and opened a second command, measured through
`generateMigration`. `create index "x" on "t" using gin ("c") where (...)` also refuses a unique or
an ordered GIN through core's `assert` (`X_INVARIANT`), the discipline `createIndex` already applies
to an index naming no columns: Postgres has neither, and a syntax error inside `ROLE=migrate` fails
the release phase with the server's words and none of the entity's.

`introspect()` reads the method from `pg_am` joined through `pg_class.relam`, and
`introspect-embedded.test.ts` is where that is pinned — a recording client can pin the SQL text and
nothing more, and a query that silently returned no method would read as `btree` everywhere and make
drift blind to the one case `using` exists for. Measured on PGlite: a real `using gin` index reads
back `gin`, the btree beside it and the primary key's own index read back `btree`.

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

**The ledger audit asks one question — does this build ship every migration the ledger records?**
`auditLedger`'s `foreign` filter is `!known.has(row.id)` and nothing else, `As of 2026-08`. It used
to also require `row.app_version !== appVersion`, which switched the audit OFF wherever the two
agree: `runningAppVersion()` answers `dev` for every development build, so a migration applied by an
earlier `dev` build and since deleted was invisible, and `expectedSchema` (`drift.ts`) then dropped
its table from the comparison — `x db drift` answering `ok: true` against a database that still has
the table. The version is a detail of the ANSWER and lives in the cause, never in the predicate.

**`rollback({ steps })` refuses anything that is not a positive safe integer, before the lock.**
`steps` reaches `slice(0, steps)`, where a negative count counts from the END: `steps: -1` selected
every applied migration but the newest and reversed four of five. `X_INVARIANT` (core's generic
code, borrowed in `DB_BORROWED_ERROR_CODES` the way `@ultimat3/money`'s `roundRatio` borrows it —
a bad argument is not a fact about the ledger), thrown by `rollbackStepsInvalid` before the advisory
lock is taken and before the ledger is read. Same discipline as `poolMaxInvalid`: a number this
build cannot honour is refused, never reinterpreted.

**`reapBranches` sweeps branches of THIS database, never the server's, `As of 2026-08-19`** (issue
#133, closed). `listBranches` walks `pg_database` for the whole server and admits every database
carrying the marker, so two Ultimate apps on one Postgres plus one nightly reap was the other app's
branches dropped. The discriminator was in hand and thrown away: `createBranch` already resolves
`options.base ?? currentDatabase(client)` and wrote only the timestamp. The marker is now
`ultimate:branch:<base>:<iso>` and `BranchInfo.base` carries it, so the reaper skips a branch whose
base is not the database it is connected to. **Split on the ISO tail, never on the first `:`** — a
database name may contain one and an instant certainly does. A pre-4.x one-segment comment matches
no base, keeps its readable date for `x db branch ls`, and is **skipped, never dropped**: a branch
of nothing is not a branch of this database, which is what makes the change self-healing with no
migration. Postgres records no template lineage in the catalog and `datdba` is shared when both
apps use one role, so writing the base down at creation is the only answer there is.
`@ultimat3/cli`'s `ls`/`drop` scope by the `<source>_branch_` name prefix instead — its own guard,
and unaffected.

**`reapBranches` skips a `createdAt` it cannot parse; it never reads one as infinitely old.**
`NaN > cutoff` is `false`, which is the same answer "older than the cutoff" gives — so a
`COMMENT ON DATABASE` that was truncated or hand-edited used to be a database DROPPED on the next
nightly sweep whatever `maxAgeMs` said. `Date.parse` + `Number.isFinite`, the discipline
`@ultimat3/seo`'s `feed-dates.ts` applies to the same question. (Whose branches it may touch at
all is the paragraph above.)

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
constraint`/`default`/`not null` and `drop index` are excluded by name — a `drop index` holds no
rows of its own, its `down` recreates the recorded definition, and `redefineIndex` has emitted one
on every index rename since it existed, so classifying it marks nearly every migration and a marker
on all is none.
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
read as a comment and erased the `delete` with it — every reader downstream then judged a SELECT
where a mutating statement stood. **A `$tag$` needs separating from the identifier before
it**: `$` is legal in a name after the first character, so `foo$tag$` is one identifier and
`select foo$tag$; select 2;` is two statements — read as a body opener it went out as one send.
The run before the delimiter is walked to its start rather than one character being read, because
`$1$tag$` is a bound parameter followed by a real delimiter and a run opening with a digit or a `$`
cannot be an identifier at all.

`sql-noise.ts` holds `stripSqlNoise` alone, for the two readers that share it —
`readonly-query.ts`'s cursorable check and `destructive.ts`. It stays its own module rather than
moving into either: `errors.ts` names the destructive rail's wording and the rail reads SQL text,
so a blanker living beside a guard puts the error registry, which registers codes at module
evaluation, inside an import cycle. Its own test is the regression suite for all of them.

`runningAppVersion()` delegates to `@ultimat3/core`'s `appVersion()` and keeps its explicit
override — `x_migrations.app_version` and `@ultimat3/jobs`' `x_backfills.app_version` are two
durable columns an operator reads side by side, and `jobs` cannot import this package for the
answer, so the key has one reader at tier 0 rather than one per writer.

**Read replicas are opt-in twice, and the second opt-in is the correctness argument, `As of
2026-08-24`.** A replica pool exists when `DATABASE_REPLICA_URL` names one (`default-client.ts`);
a read is *offered* to it only inside `withReplicaReads(fn)` (`replica-scope.ts`). With no scope
open nothing routes and the client is byte-identical to the single-pool one it has always been —
which is what makes "nobody adopted it yet" today's behaviour rather than a wrong answer.

The scope is what closes **read-your-writes**, and the reason it is a scope and not a request id is
worth writing down because the request id is the obvious answer and it does not work. `Ctx.requestId`
IS reachable from here — `@ultimat3/http`'s pipeline opens `runWithContext` around every request
(`packages/http/src/pipeline.ts`), `withChildContext` may not change the id, and `tryUseContext()` is
tier 0 — but nothing tells tier 1 when a request ENDED. A `Map<requestId, wrote>` therefore only
grows, ~100 bytes a request forever, and every eviction policy that forgets a request which WROTE
serves it a stale row on its next read. That is a data-correctness bug strictly worse than the
capacity problem replicas exist to solve, so the marker lives on a mutable value on an async context
(`ReplicaScope.wrote`, the same shape as `TxState.live`) whose lifetime somebody else already owns.

**`withTransaction` is on the primary structurally, not by rule.** `runRoot` pins a connection
through `reserve()`, and `replicatedClient` delegates `reserve()` to the primary and exposes it only
when the primary has one — so BEGIN, every statement and COMMIT are one connection on one server.
`isReservable` therefore has to keep answering about the DATABASE and not about the wrapper: a
wrapper that always exposed `reserve` makes `runRoot` pin a client that cannot pin, and one that
never exposed it makes `runRoot` run BEGIN, the body and COMMIT on three different pooled
connections. What `runRoot` adds is one line — `markScopeWrote()` unless `readOnly: true` — because
its statements go through a reservation and never through the router, so the scope could not
otherwise see that the request has written.

**`isPlainRead` is an allow-list, and that inversion is why it is not the lexer this file forbids.**
`readonly.ts` was deleted for defaulting to PERMISSION: a 22-word deny-list that read
`select pg_sleep(60)` as safe. This one defaults to the primary — a statement shape nobody
anticipated costs a replica opportunity and never an answer. **`statementKind()` is not the
authority and must not become it**: it calls `with … update … returning` a read, which is right for
an N+1 report and catastrophic for a routing decision, and `replica-route.test.ts` asserts the
disagreement so the two can never be collapsed. Three refusals earn their line — a locking read
(`for update`/`for share`; a standby cannot take the row lock), `select … into` (it creates a
table), and the functions a word boundary cannot reach (`pg_advisory_lock`, `set_config`,
`nextval`), which a standby ANSWERS rather than refusing, so the server cannot be the safety net for
those the way it is for a real write.

**A misroute fails loudly and repairs itself; a replica outage costs latency and never an answer.**
A statement a standby refuses (`25006`) never executed, and only `isPlainRead` statements are ever
sent there, so re-running one on the primary is exactly-once rather than at-least-once — which is
what makes the blanket fallback in `replica-client.ts` safe. The breaker is what stops that from
doubling every read during an outage: three consecutive failures park the replica for ten seconds,
counted on `Clock.monotonic()` so an NTP step cannot un-park it. `ReplicaStats` is exposed on the
client for a test that cannot scrape, the same reason `@ultimat3/realtime` exposes
`droppedChannelFrames`, and each fallback logs `db.replica_fallback` with `renderThrowable(error)`.

**The URL must name a read-only standby**, and nothing here can check it. The `25006` refusal is the
whole safety net under a text classifier that cannot be complete; pointed at a writable node, a
misroute becomes a write on the wrong server with nothing anywhere to report it.

**Nothing opens `withReplicaReads` per request yet.** The scope, the client and the wiring are tier
1 and land here first; the adopter is one call in `@ultimat3/http`'s pipeline (or an app's own
handler), and until it exists no production traffic is routed. That is the tier rule working —
lowest tier first, consumers after — not an omission.

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

**Those two answers describe one condition, so they must name one remedy — and until 2026-08 they
named each other.** `unknown-schema`'s fix was `x db gen "snapshot <name>"`, which raises
`X_MIGRATION_SNAPSHOT_MISSING`, whose fix was "restore … from version control" for a file version
control never had: reproduced on a pristine `x new` scaffold, whose `0000_initial.sql` ships with no
sidecar, so the app's first `x db migrate` had no way out at all. Both now lead with the same two
remedies in the same order — restore the sidecar (`git checkout --`, a real command that fails
loudly when git has no copy), or, if it was never written, **delete the migration's files first and
only then** run `x db gen`. The order is the whole point: `x db gen` named before the files are gone
is the cycle. `snapshotSiblings`/`migrationNameOf` (`errors.ts`) build that second command out of
the path the caller passed and the id, never out of a directory this tier-1 package invents —
`unknown-schema` has no path at all and uses a `"*<id>.snapshot.json"` git pathspec for the same
reason.

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

**A CHECK that went missing is drift, `As of 2026-08-25`, and it is compared by NAME because it
cannot be compared any other way.** `pg_get_constraintdef` answers Postgres' own rewriting —
`status in ('draft', 'published')` reads back as
`CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))`, measured on 18.4
(`drift-check.live.test.ts`) — so a catalog value could never equal a generated one and a text
comparison reports a correct database as wrong forever. That is why nothing here read
`pg_constraint` for CHECKs at all, and why `alter table … drop constraint` in a psql session was
`ok: true` on every check that followed it.

**The two readings do not share a field, and that split is the whole design.**
`TableDescription.checks` is the DECLARED side — name **and** expression, `snapshotOf`'s own
spelling, the value `checkPlan` diffs. `TableDescription.checkNames` is the CATALOG side — `conname`
for `contype = 'c'`, names and nothing else, written only by `introspect()`. Filling `checks` from
the catalog instead would put a rewritten expression where `checkPlan` expects a generated one, and
every `x db gen` in every app would then drop and re-add every constraint it has, forever, because
the two strings can never be equal. Split, the TYPE says which reading a value came from and
`checkPlan` cannot be handed a catalog value by accident.

Three rules ride with it. **Absent and `[]` are different on both sides** — an absent `checks` is a
sidecar written before the field existed (declares nothing, so nothing can be missing), and an
absent `checkNames` is a description that never asked the catalog, which reading as "the database
holds none" is one finding per declared constraint against a database nobody looked at.
`introspect()` therefore always writes `checkNames`, `[]` included. **Only the declared side is
judged**, the rule `compareIndexes` and `compareForeignKeys` already state: a NOT NULL (`contype =
'n'` from Postgres 17 on), an `enumerated()` column's old anonymous form and every constraint an
extension brought would each be a finding against a database that is exactly right. **There is no
`changed-check` and there never will be** — presence is a boolean, the predicate is text, and
normalising the text is an expression parser competing with the server's. `missing-check`'s `fix:`
is the `add constraint` statement itself, not `x db migrate`: the migration declaring it is already
in the ledger, so the migrator applies nothing, and the declared side carries the predicate that
makes an executable fix possible at all.

**`literal()` DOES receive caller input, and this file's own source said otherwise until
2026-08-25.** `column-default.ts:43` renders `ColumnDefaultLike` through it — an app's own
`.default('C:\\logs')`, crossing the tier seam from `@ultimat3/entity`, validated by nothing and
guarded by no `identifier()`. Measured through `generateMigration` on 18.4: the emitted
`default 'C:\logs'` stores `C:\logs` with `standard_conforming_strings` on and **`C:logs`** with it
off. A declaration that type-checks, a migration that applies, a column defaulting to a value nobody
wrote, and no error anywhere. A value ENDING in a backslash is worse — the escaped quote leaves the
literal unterminated.

The rule is `E'…'` **only** when the value actually carries a backslash: without one there is no
escape mechanism for the two GUC settings to disagree about, so every migration already on disk
stays byte for byte what it was and nothing regenerates spuriously. That property is load-bearing —
both tracked apps hold applied migrations whose `.hash` covers this text — and
`generate-default.live.test.ts` pins both halves against a real server, applying the same generated
migration under `on` and under `off` and reading the stored default back. `sql.test.ts` pins the
five shapes; the round trip through `statementsOf` is there too, because this package's own lexer
has to read back what its escape writes or `migrate()` starts miscounting statements
(`sql-scan.ts`'s `escapesAt` already knew the `E''` prefix).

**The other two callers here are safe by CONSTRUCTION, never by input, and the difference matters
if either is refactored.** `readonly-role.ts:71` sits in the same `sql` template as
`identifier(role)`, which throws on a backslash before the tag function runs; `branch.ts:85` runs
after an already-awaited `identifier(base)`. Neither is validating the value it passes to
`literal()` — a caller moved out of that ordering loses the guard silently.

`literal()` is now the tree's ONE answer, enforced: `scripts/sql-literal-copies.ts` refuses a
`replace`/`replaceAll` whose replacement is `''` anywhere but `packages/db/src/sql.ts`, matched on
the TRANSFORMATION rather than on a name — the three copies were called `literal`, `literalText`
and an unnamed inline template. Pinned at zero.

**A retype takes the objects written against the column out of its way first, `As of 2026-08-25`,
and `retype-dependents.ts` decides which those are.** Postgres compiles a partial index's predicate
and a CHECK's expression against the column's type at creation and cannot recompile either:
`alter table "posts" alter column "status" type text using "status"::text` answered
`42883 operator does not exist: text = post_status` and the migration aborted mid-run — inside
`ROLE=migrate`, with the ledger recording nothing. It is what blocked `examples/dummy` from
regenerating at all.

**Which objects are dependent is measured, never assumed** (`generate-retype.live.test.ts`, one
shape at a time on 18.4):

| recorded object | survives the ALTER |
|---|---|
| btree over the column — plain, unique or composite | **yes**, Postgres rebuilds it itself |
| partial index whose predicate names the column | **no — 42883** |
| partial index naming another column | yes |
| CHECK whose expression names the column | **no — 42883** |
| a view over the column | no, `0A000`; no snapshot records a view, so `migrate()` refuses it instead (`dependent-view.ts`) |

So only an expression that MENTIONS the column is moved, and a plain btree is left alone — dropping
it is a table scan to rebuild for nothing.

**The reference test over-approximates on purpose, and it cannot be narrowed by type name.**
Measured: `char(1)` → `char(3)`, `varchar(80)` → `text` and `numeric` → `integer` all re-derive
their predicates cleanly, while `integer` → `text` under `check (c >= 0)` is `42883` — both sides
built-ins. Whether an expression re-resolves depends on operator resolution, which is exactly the
knowledge a generator with no database cannot have, so every ambiguous case answers "dependent":
a miss is `42883` in the release phase, a false positive is a rebuild on a statement that is
already rewriting the whole table under ACCESS EXCLUSIVE. `referencesColumn` walks `sql-scan.ts`
rather than matching a substring — a name inside a literal or a comment is not a reference,
`status_code` is not `status`, and a **quoted** identifier IS one, which is the one span the lexer
calls noise and this reader must not skip.

**What is moved aside is put back by the ORDINARY diff, never twice.** `up` drops the dependents
before the ALTER and `MovedAside` carries their names to the two arms that would otherwise act on a
thing that is no longer there: the index loop CREATES a declared name instead of comparing it
(`redefineIndex` is silent on a definition that never moved, which here means the table comes out
with no index at all), and `checkPlan` neither drops nor re-adds a predropped name — a declared one
takes the bare `add constraint` because the name is provably free, and a recorded one the entity no
longer declares is simply gone, which is what `checkPlan` would have done to it anyway. `down`
pushes the restores forwards and is reversed as a whole, so it reads: drop the new objects, retype
back, then recreate the ones compiled against the old type — restoring first is `42883` in the
other direction. What it restores is what the snapshot RECORDED, never what the entity declares.

**A FOREIGN KEY over the retyped column is moved too, `As of 2026-08-25`, and `retype-keys.ts`
decides which — above `diffTable`, which is the whole point.** Postgres re-checks a key's two ends
against each other on every `alter column … type`: measured on 18.4, `42804 foreign key constraint
"rk_posts_org_code_fkey" cannot be implemented — Key columns "org_code" … and "code" … are of
incompatible types: integer and text`, thrown by the ALTER itself, inside `ROLE=migrate`, with the
ledger recording nothing.

**It could not be answered from inside `diffTable` and that is not an implementation detail.** The
constraint that breaks is recorded on the table that OWNS it, so for a retype of the key's TARGET it
is a different entity's row — `diffTable(orgs)` is handed `orgs`'s record and can never see
`posts.foreignKeys`. So `retypedColumns(entities, current)` derives the whole schema's retype set
once, before the entity loop, and `retypeColumn` READS it instead of asking
`recorded.dataType === wanted` a second time: two answers to "is this column being retyped" is the
axiom-1 split this package has spent the week closing.

Four rules ride with it.

| Rule | Why |
|---|---|
| the drop goes in a `preAlters` bucket merged at the TOP of `up` and at the FRONT of `down` | both ends of one key can move in two different entities' diffs, so the drop must precede every ALTER in the migration and the restore must follow every one of them. `down` is reversed at assembly, so the front becomes the end: drop the new key, retype both ends back, then add the recorded one. Restoring any earlier is `42804` in the other direction |
| what comes back in `up` is written by `foreignKeyPlan`, never here | `moveKeysAside` answers a set of `keyId`s and `ConstraintPlans.predropped` reads it as "the schema does not record this key" — the same reading `checkPlan` gives its own `predropped`. That is what makes the three outcomes fall out of code that already exists: still declared (added back in the `constraints` bucket that already runs after every table statement), no longer declared (gone, exactly as the removal arm would have left it), `on delete` moved (added back carrying the new rule). Three branches restating them here is the collision this was deferred over |
| **both** ends of `breaksOn` earn their line, and they do not overlap | the OWNER arm catches a key whose table is retyped while its TARGET's table is being dropped; the TARGET arm catches the mirror — the key's own table is doomed, so nothing retypes its column and `foreignKeyPlan` is never called for it at all, while `drop table` is emitted at the END of `up`, long after the ALTER it would have unblocked. Both are pinned live (`generate-retype-key.live.test.ts`), because when both tables survive either arm alone would do |
| a key whose own table or whose target is doomed gets a `--` note in `down` | `add constraint` against a table no `down` can restore is a rollback that cannot run — the rule `unrestorableDrop` already states |

**Re-adding the key is still the SERVER's judgement, deliberately.** An entity that retypes one end
and not the other declares a pairing Postgres has no operator for, and the `add constraint` at the
end of `up` is where that is said. Refusing it at generation would need to know whether two types
share an equality operator — `varchar(80)` and `text` do, `integer` and `text` do not — which is the
operator-resolution knowledge a generator with no database cannot have, and the same reason
`referencesColumn` over-approximates. What it cannot see at all is a key the recorded schema does
not hold: a hand-written migration's, or a sidecar written before `foreignKeys` was recorded.

`sql-type.ts` holds `SQL_TYPES`/`sqlType`, split out of `generate.ts` so the pre-pass can ask what a
kind renders to without importing the module that imports it. The read is **guarded** with
`Object.hasOwn`, and db's `proto-index` pin dropped 5 → 4 in the same commit — the ratchet reports a
count that drops as `stale`, so the two could not land apart. `kind` is data: unguarded,
`SQL_TYPES['constructor']` answered the `Object` function and its source went into the type position
of an `alter` statement, and `'__proto__'` answered `[object Object]`. Guarded, both pass through as
themselves like any other unknown kind, and no other input's answer moves.

**A generated column's REBUILD moves its dependents aside too, `As of 2026-08-25`, and it reuses
`retypeDependents` rather than answering again.** Plain → generated has no `set expression`, so
`regenerate` drops the column and adds it back — and `drop column` silently takes every partial
index whose PREDICATE names it and every CHECK whose expression does (measured, 18.4). The `rebuilt`
set `diffTable` carries into its index loop is keyed on an index's COLUMNS, so neither is a name it
can find: the table came back without them, the snapshot still recording both, and `down` unable to
restore either. `regenerate` therefore takes `live` and `moved` and calls `moveDependentsAside`,
which drops each explicitly, restores it in `down`, and puts the name where the ordinary diff will
CREATE it. `generate-generated-rebuild.live.test.ts` applies it both ways.

**A generated column's own `alter … type` deliberately does NOT move them, and the reason is
measured.** It trips the same `42883` (`operator does not exist: text > integer`, on a generated
`integer` column under `where (doubled > 0)`) — but moving the index aside only relocates the
failure to the `create index` that puts it back, because a predicate whose operator the NEW type has
no resolution for cannot be written either. The plain path's dependents survive precisely because an
untyped literal re-resolves (`status = 'published'` under an enum and under `text`), and a generated
column reaching that shape needs its EXPRESSION changed in the same migration, which `regenerate`
emits AFTER the type statement. Left open with the failure named in the source rather than closed
with a change no test could fail on.

And **what no migration wrote down** is still invisible to the generator by construction — `x db gen`
runs with no database open, so a hand-added expression index over the column is `42883` whatever
this does, since `SchemaDescription` has a field for it nowhere.

**A VIEW is NOT discoverable from anything this generator reads, and the honest ceiling is a
refusal one statement earlier, `As of 2026-08-25`.** `SchemaDescription` has no field for a view,
`introspect()` reads none by construction (`app-relation.ts` excludes every non-table relation), and
no `entity()` can declare one — so a `GenerateOptions.views` with no caller to fill it would be the
declared-and-never-wired defect this release exists to eliminate, and the caller is
`@ultimat3/cli`'s. What DOES have a connection is `migrate()`. `dependent-view.ts` is the preflight:
`refuseDependentViews(tx, script)` runs inside each migration's own transaction, before its first
statement, and both `migrate()` and `rollback()` call it.

It repairs nothing and does not claim to — the deploy still stops. What it replaces is
`X_DB_UNAVAILABLE: cannot reach the database`, whose registered `fix:` is "set `DATABASE_URL` to a
reachable Postgres url", on a database the migrator is connected to and mid-transaction on. The
server's own words name the view in a **DETAIL** field nothing printed:
`0A000 cannot alter type of a column used by a view or rule` /
`rule _RETURN on view dv_docs_published depends on column "rank"`. `X_MIGRATION_VIEW_DEPENDS` names
the view, the table and the column, and its `fix:` is the `drop view` plus the `create view` built
from `pg_get_viewdef(oid, true)` — a paste, not an archaeology.

Four rules.

| Rule | Why |
|---|---|
| `retypeTargets` is a WORD scan over `sql-scan.ts`, never a regex | a retype inside a `--` comment is prose and one inside a literal is data, and both reach the scan when they sit inside an `alter table` statement — read as code either invents a target on a column the statement never touches. A **quoted** name is never a keyword: `alter table "t" alter "column" type text` retypes a column called `column`, and read as the keyword it names `type` and matches nothing |
| the matcher is **narrow on purpose** | a miss costs exactly what happens today — the server's own `0A000`, one statement later — while a false positive refuses a migration that would have applied. Every retype `generateMigration` emits is `alter table <t> … alter [column] <c> type`; a hand-written `ALTER TABLE ONLY t …` is not, and is left to the server |
| one catalog round trip, and the PAIR is filtered in JS | the query asks every retyped table against every retyped column, so it answers pairs nobody retypes — `dv_notes.rank` out of `dv_docs.rank` and `dv_notes.mark`. Refusing on one is a deploy stopped over a view standing in nobody's way, which is worse than the message this exists to improve. Pinned live |
| the `fix:` is built through `identifier()` **inside a `try`** | `identifier()` refuses a name holding a quote, a space or a backslash, all three legal inside a quoted Postgres name, and a `fix:` may not throw — the rule `rebuildForeignKey` already states, with the same shape. `errors.ts` takes the finished string rather than importing `sql.ts`: that module imports `identifierUnsafe` from it, and an import cycle around the module whose evaluation REGISTERS every code is not one worth having for a quoted name |

A script that retypes nothing costs one text scan and no round trip, which is nearly every migration
an app writes.

**`index-ddl.ts` holds `createIndex`, `redefineIndex`, `indexShape`, `dropIndex`,
`dropRecordedIndex`, `mayBeConstraintBacked` and `asDeclared`**, split out of `generate.ts` at the
500-line ceiling along the seam `check-ddl.ts` and `generated-column.ts` already drew —
`generate.ts` assembles a plan, `index-plan.ts` decides which index statements go in it, and
`index-ddl.ts` writes them. `drift-findings.ts` is the same split on the other file: every `DriftDifference`
constructor and the `DriftKind` union, with `drift.ts` keeping the comparisons and re-exporting both
types explicitly so the public surface does not move.

**`index-plan.ts` walks both directions, `As of 2026-08-25`** — the third arm to learn it, after
`checkPlan` and `foreignKeyPlan`. `diffTable`'s index loop walked `declaredIndexes(entity)` and
matched by name with **no reverse pass**, so an index the entities stopped declaring stayed on the
database forever while the sidecar beside it stopped recording it: measured on `examples/dummy`,
`member_unique_per_org`, `members_tz_idx` and `post_slug_unique_per_org` all survived a regeneration
that recorded none of them, and the `drift` gate step was green over all three because drift judges
the declared side. `indexPlan(entity, live, plan, context)` is the whole question now — declared
first and removed last, the order `checkPlan` uses — and `generate.ts` calls it.

**A recorded UNIQUE index cannot be told from a UNIQUE CONSTRAINT's, and it never will be.**
`TableDescription` carries no discriminator and cannot usefully be given one: the *same*
declaration reaches the server as either, depending on which migration created it. A `unique` column
on a table `createTable` writes goes out as `create table … slug text unique`, which Postgres backs
with a **constraint** named `posts_slug_key`; the same column gaining `unique` later takes
`diffTable`'s `create unique index "posts_slug_key"` and is a plain index. `snapshotOf` records both
as `{ unique: true, primary: false }`, and every sidecar already on disk was written that way, so a
new field could not classify one retroactively. Measured on 18.4
(`index-removal.live.test.ts`):

| statement | on a constraint's index | on a plain index |
|---|---|---|
| `drop index "n"` | **2BP01** | ok |
| `drop index if exists "n"` | **2BP01** — `if exists` does not suppress it | ok |
| `alter table … drop constraint if exists "n"` | drops it, index and all | notice, no-op |

So `dropRecordedIndex` emits the **pair**, constraint first — reversed, the `drop index` reaches a
constraint's index and is the 2BP01 this exists to avoid — and only for the shape a constraint could
be backing: `mayBeConstraintBacked` is unique, non-primary, total, unordered and btree, because
`add constraint … unique` and a `unique` column clause can produce nothing else. A partial or
ordered or GIN index takes the bare `drop index`. The asymmetry that remains is named rather than
hidden: `down` recreates it with `create unique index`, so a constraint comes back as an index. That
is the one statement this generator has, and it restores what the record described.

Four names are skipped by the removal arm, and each is a statement Postgres would refuse or repeat:
a `primary` index (2BP01, and the key is `TableDescription.primaryKey`), one already in
`MovedAside.indexes` (a retype dropped it ahead of the ALTER — 42704), one over a column
`regenerate` rebuilt (it went with the `drop column` — 42704), and one over a column this migration
DROPS (`alter table … drop column` takes it, the rule `foreignKeyPlan` already applies to a
constraint on a dropped column). A doomed **table** needs no arm at all: `generate.ts` only reaches
a diff for a table an entity still declares. The known limit is written in the file header — a
unique index a foreign key on ANOTHER table still references cannot be dropped (2BP01), and this arm
sees one table at a time.

**An entity's INVARIANTS reach the DDL, `As of 2026-08-25`, and `invariant-ddl.ts` is what they
become.** `EntityDescriptionLike` had no `invariants` field at all — the same seam gap
`onDelete` carried until 3.0 — so a regenerated migration held **none** of them: measured on
`examples/dummy`, nine database-expressible rules across six tables, including
`member_unique_per_org UNIQUE(org_id, user_id)`, which is the constraint `upsertAll`'s inferred
`on conflict` rests on, and `post_slug_unique`. The `drift` gate step hashes entity SOURCE against a
sidecar and never reads the SQL, so the squash that lost them would have been **green**.

Four rules, none optional.

| Rule | Why |
|---|---|
| a `check` is a named `CONSTRAINT`, a `unique` is a unique **INDEX**, an `assert` is nothing | a soft-deleting entity stamps `deleted_at is null` onto a unique invariant and Postgres has no partial unique CONSTRAINT — only a partial unique index. An `assert` declares itself as a rule only the app can judge (`sql: null`), which is what `hasJsOnlyInvariant` already reads it as, so on its own it is not an unrendered loss — see the next paragraph for the case where it is |
| a `unique` invariant joins the ONE declared index list (`declaredIndexes`) | `createTable`, `diffTable` and `snapshotOf` must agree about what exists. A `create unique index` emitted and not recorded is `42P07` on the very next `x db gen` — worse than the silent drop |
| a `check` is recorded on `TableDescription.checks`, **absent** and never `[]` | a sidecar that predates the field must read as "nothing recorded" so the next generation ADDS the constraints the database is genuinely missing. `[]` would mean "declares none" and leave every already-generated app's invariants unenforced forever. That absence is the repair path, and `parseSnapshot` preserves it |
| the constraint name is `<table>_<name>_<check\|key>`, re-derived, bounded at 63 bytes, and **validated as an identifier** | nothing validates an invariant name at declaration, so `invariant('x" ); drop table t; --', …)` type-checks all the way to `create table` — the identical hole `columnName` carried. `identifier()` is the one rule; `constraintNameUnsafe` (`invariant-errors.ts`) exists only for its `fix:`, which names the `invariant()` call an author edits, and `generate-invariant.test.ts` pins that line because a guard whose value is its message is proven by nothing else |

**An `assert` IS an unrendered loss the moment a migration recorded its CHECK, `As of 2026-08-25`,
and that is the half `unrenderedOf` could not see.** `checkPlan` drops a recorded check nothing
declares — "a snapshot may not lie" — and an `assert` declares nothing in SQL, so regenerating
**deletes the database's half of a rule the entity still states**, with nothing added back and no
`-- destructive:` marker (`destructive.ts` excludes `drop constraint` by name, on the argument that
the database rebuilds it; here nothing does). Measured on `examples/dummy`: `x db gen` emitted
`alter table "posts" drop constraint "post_slug_shape"` and four more, and `unrenderedOf` answered
`[]` — so `@ultimat3/cli`'s `repairFix`, whose whole job is to refuse `x db gen` as the instruction
when the generator would lose something, read the empty list and handed out
`x db gen "drop post_slug_shape"`: the command that performs the loss, offered as the repair for it.

**The discriminator is what the recorded schema holds, never the kind.** An `assert` with nothing
recorded behind it loses nothing and is reported by nothing — the previous reading was right about
that, and a marker on nearly every app's every migration marks none. `unrenderedOf(entities,
current)` therefore takes the recorded schema, **required and nullable**: a caller with no sidecar
(the first migration) has to say `undefined`, because an argument nobody passes is a blind answer
nobody notices, which is exactly how the five drops shipped. `namesConstraint` (`invariant-ddl.ts`)
is the match, under **both** spellings — this generator's `<table>_<name>_check` and the rule's own
name, which is what a hand-written `0001_init.sql` calls it — and it never throws, because its
caller is a reporter reached by the `drift` gate step where a throw replaces a finding with a crash.
Self-clearing: once the drop is applied and the new sidecar written, nothing records the check and
the next generation reports nothing.

**A COLUMN declares a CHECK too, and until 2026-08-25 it reached `create table` and nothing else.**
`check-ddl.ts` is what it becomes. `columnClause` wrote `check (…)` **inline and anonymous**,
`snapshotOf` recorded no check for a column and `diffTable` had no arm for one — so the constraint
existed only in the statement that created the table and was invisible to every generation after it.
Neither `drift` nor `unrendered` could see the loss: the gate's `drift` step hashes entity SOURCE
against a sidecar and never reads the SQL, and `unrenderedOf` keys on declared **invariants**, which
these are not — they are minted by the column builder (`enumerated()`'s value set,
`tz()`'s IANA whitelist, `locale()`'s tags, money's currency pattern and scale bound;
`packages/entity/src/enum-column.ts` implements `enumerated(V)` as `kind: 'text'` plus
`check: oneOf(V)`). Three consequences, measured on `examples/dummy`: a value added to
`enumerated()` generated **no migration at all**, so the app accepted `'archived'` and the database
answered `23514`; a regenerated migration retyped every Postgres-ENUM column to bare `text` with no
CHECK beside it; and the sidecar claimed a schema the database did not have, so `down` and every
later diff reasoned off a lie.

Four rules, none optional.

| Rule | Why |
|---|---|
| every CHECK is a **named** constraint on ONE list (`declaredChecks` = `columnChecks` then `invariantChecks`) | `createTable`, `diffTable` and `snapshotOf` must agree about what exists, the rule `declaredIndexes` already states. An anonymous constraint is not diffable at all — there is nothing to match a recorded name against |
| the name is `<table>_<column>_check`, and it is **not a convention chosen here** | it is the name Postgres itself mints for an anonymous single-column CHECK — measured, `check-ddl.live.test.ts`, including for a multi-clause predicate like `scaleCheck`'s. Any other spelling makes the repair add a SECOND constraint beside the one an already-generated database is holding |
| an ADD onto a column the recorded schema already had is `drop constraint if exists` **then** `add constraint` | the two databases the generator cannot tell apart read identically in the snapshot — one is holding the old anonymous form under exactly this name, one is holding nothing because the old `diffTable` emitted nothing. A bare `add constraint` is `42710` on the first (measured), inside `ROLE=migrate`, with the server's words and none of the entity's. A column this migration ADDS, or one `regenerate` rebuilt, takes the bare add: the name provably cannot be taken |
| two declarations naming one constraint are **refused**, never deduped | `invariant('status', …)` on a table whose `status` is an `enumerated()` derives the same `posts_status_check` the column owns, and two `add constraint` under one name is `42710` — a migration nobody can apply, which is worse than either declaration being dropped. `X_INVARIANT` through core's `assert`, the refusal `createIndex` already gives a unique GIN. Unlike two identical index definitions there is nothing to dedup: the predicates differ |

**What an app with an existing sidecar sees on its first `x db gen` after this.** One
`drop constraint if exists` / `add constraint` pair per checked column, on every table it already
has — the same absent-never-`[]` discipline `checks` was given for invariants, read the other way
round: the sidecar says nothing, so the generator emits the pair that is correct whether the
database is holding the constraint or not. Self-clearing — the new sidecar records the check and the
next generation emits nothing. It is not free: `add constraint … check` takes `ACCESS EXCLUSIVE` and
scans the table, under `migrate`'s 3s `lock_timeout`. Validating is deliberate over `NOT VALID`,
which would accept the rows already in the table — and a database holding the identical constraint
has none that can fail.

**`checkPlan` takes the `rebuilt` set for the same reason `diffTable`'s index loop does.**
`regenerate`'s plain -> generated path is `drop column` + `add column`, which takes the constraint
with it while the snapshot still records it — so without the set the check is silently gone, which
is this file's own defect one level in.

`rebuildCheck` is NOT `destructive.ts`'s concern: `drop constraint` is excluded there by name on
the argument that the database rebuilds it, and here the very next statement does.


**A default's VALUE crosses the seam too.** `ColumnDescriptionLike.default` carries
`ColumnDefaultLike` and `defaultExpression` renders it; `hasDefault` stays beside it as the older,
narrower fact `generatedClause` reads. `@ultimat3/entity` projects the value beside the flag
(`packages/entity/src/describe.ts:175`), so the nine defaults in `examples/dummy` — `plan_code`,
`billing_currency`, `role`, `tz`, `locale`, `theme`, `digest_opt_in`, `status`, `like_count` — do
reach the SQL. A description whose producer does not project it still reads `hasDefault` alone, and
that half **is not silent**: `unrenderedOf` reports each one on `GeneratedMigration.unrendered` and
`unrenderedComment` writes a `-- UNRENDERED` block at the top of the emitted `up`.

Comments, never a refusal, and never onto an EMPTY diff. A refusal would be a generator no app with
a `.default('draft')` could run at all until tier 2 ships one line, and a migration nobody can
generate repairs nothing. The empty-diff exclusion is `@ultimat3/cli`'s
`generateAppMigration`, which reads `up.trim().length === 0` as "nothing changed": a comment there
makes every `x db gen` write a file holding no statement — a ledger row, a checksum and a place in
the apply order for nothing.

**`REPLICA IDENTITY FULL` is emitted, `As of 2026-08-26` — by a PARAMETER, never by an entity
field.** `@ultimat3/realtime` refuses a live query on a table without it and nothing in the
framework wrote it, so a scaffolded app generated a schema its own preflight rejected (issue #357).
Which tables need it is **declared** by each `live: true` query's `subscribes:` and read out of the
manifest — **not derived**, and this file said "derived" until 2026-08-26. It cannot be derived: the
relation name is a string inside the query's `sql:` callback, which no generator can invoke without
valid input, so a live-query-to-table set does not exist anywhere to be read. `liveFeed` in the
reference app requires `{ orgId: t.uuid, limit }` and its table is the `'posts'` literal inside
`from<PostSummary>('posts', …)`; `packages/query/src/sql.ts` says the same thing about itself —
"`null` when no sample input was supplied". `X_QUERY_SUBSCRIBES_DRIFT` is what keeps the declaration
honest, checked against the resolved shape at first subscribe. It is still a PARAMETER and never an
`EntityDescriptionLike` field — this package is tier 1 and can see neither the manifest nor
`@ultimat3/query` — so such a field would have been a declared-and-never-wired key, the defect class
this release exists to eliminate. `GenerateOptions.replicaIdentityFull: readonly string[] |
undefined` is the shape, passed by `@ultimat3/cli`'s `db-generate.ts` from `describeQueries()` —
the descriptor, one hop BEFORE the manifest. `x.manifest.json` projects the same declaration
(`QueryFact.subscribes`) and is what any other reader should use, but `appManifest(root)` re-loads
the app and calls `appIdentity(root)`, which throws `X_APP_PACKAGE_INVALID` where there is no
`package.json` — and `x db gen` has never needed one. `replica-identity.ts` owns every rule that
rides with it.

| Rule | Why |
|---|---|
| recorded on the snapshot as `TableDescription.replicaIdentityFull` | `true` or **absent**, never `false` — the literal type is the enforcement. Absent is "nothing recorded", the reading `checks` and `using` already have, so a sidecar written before the field emits the ALTER once more and Postgres accepts it on a table that has it. Without the record the statement lands in **every** migration forever, which is a generator an author learns to ignore |
| the snapshot records the **union** with what was already recorded | a caller passing no set must not erase the fact. `snapshotOf(entities)` alone answers `NONE`, so the one place the union is computed is `generateMigration` |
| dead **last** in `up` | the table has to exist and a `create table` in this same migration is why it might not. It is ordered against nothing else — replica identity constrains no column, index or constraint — so the end is the only placement that cannot read as depending on a statement above it |
| never `-- destructive: true` | it drops no row, rewrites no column and matches none of `destructive.ts`'s four rules. `generate-replica-identity.test.ts` asserts both the verdict and `destructiveStatements()` |
| a name **no entity declares** is skipped, silently | the list comes from the manifest, and a live query whose entity was deleted is an app fault this generator cannot repair. Emitting it anyway is `42P01` at `ROLE=migrate`, which is the one place this package refuses to put a fault |
| nothing is ever **reverted** | the option is optional, so "absent" and "no live query subscribes any more" are the same value. Reading them alike would let a caller that never passes it turn off replication for every subscribed table in the app |
| `down` is `replica identity default`, except on a table this migration **creates** | that table's whole `down` is already `drop table`; a second statement ahead of it is a line an author reads and nothing performs |

**A column the DATABASE computes is a different thing at every step, and `generated-column.ts` is
all of them** — `As of 2026-08-24`. `ColumnDescriptionLike.generated` carries the
`generated always as (<expr>) stored` body across the tier seam (this package cannot import
`@ultimat3/entity`, so a field that is not on the projection reaches no DDL at all), and it reached
none until this date: `@ultimat3/entity`'s `.searchable()` emitted a `tsvector not null` column that
`columnClause` rendered plain, so nothing computed it and **the first insert was a `23502`**. Loud,
which was deliberate — but a feature nobody can insert into is not shipped. Four rules ride with it,
each one measured against a real server (`generate-generated-column.live.test.ts`):

| Rule | Why it is not the ordinary column's rule |
|---|---|
| the clause sits directly after the type | `"c" tsvector generated always as (…) stored not null check (…)` is what Postgres accepts; a column constraint may follow it |
| **generated and defaulted is refused** at `x db gen` | Postgres has no such column (`42601`) — a generated column's value IS its expression. `X_INVARIANT`, the same refusal `createIndex` gives a unique GIN, and for the same reason: the alternative is DDL whose first reader is `ROLE=migrate` |
| an expression that moved is **`set expression as (…)`**, never a drop and recreate | Postgres 17's statement, and it rewrites the table, recomputes every row and **keeps the column's indexes** — measured. Dropping the column takes its GIN index with it and nothing in the diff puts one back, and `alter table … drop column` is what `destructive.ts` reads as data loss: every expression change would then carry `-- destructive: true` on a migration that loses nothing, and a marker on all is none |
| a retype on it carries **no `using`** | Postgres refuses `using` on a generated column outright, which is exactly what `retypeColumn` emits for every other column — and there is nothing to convert, because the expression produces the new type itself |
| the NOT NULL add is **one statement**, never nullable-then-backfill | the database computes it for every existing row inside the same `add column`. The ordinary path's `-- backfill "c", then: … set not null;` names a step nobody can perform: writing to a generated column is `428C9` |

Two transitions have no `set expression`. **Generated → plain is `drop expression`**, which keeps
every value the column already computed. **Plain → generated is the whole column again** — drop,
add, and every index over it stated a second time, which is why `regenerate` answers `rebuilt` and
`diffTable` carries that set into its index loop: `redefineIndex` sees a definition that never moved
and would emit nothing, so the table would come back with no index at all.

**`introspect` deliberately does not read `generation_expression` back.** Postgres stores its own
rewriting (`COALESCE(title, ''::text)` for `coalesce("title", '')`), so a catalog value could never
compare equal to a generated one and drift would report a correct database forever. The diff that
DOES read it is `x db gen`'s, where both sides are this generator's own spellings — the rule
`IndexDescription.where` already states.

`compareTable` judges **declared** indexes: one the migrations name and the catalog does not hold is
`missing-index`, and one whose access method, column list or uniqueness moved is `changed-index` — which is what
catches a composite index rebuilt with its columns the other way round while the column diff said
`ok: true`. A live index no snapshot names is deliberately **not** reported: Postgres creates one for
every primary key and every unique constraint, so counting those is eight findings against a correct
database, the same argument `appTables()` makes. **Three of the four parts are compared, and the fourth never
will be**, `As of 2026-08-19`: the predicate's *text* stays uncompared, because the catalog returns
its own rewriting of an expression (`(deleted_at IS NULL)`) where the snapshot holds the author's
spelling, and normalising that is an expression parser competing with the server's — `x db gen`
compares the text instead (`redefineIndex`), where both sides are generated. Its *presence* is a
boolean, not text, and the direction is a closed enum on both sides, so both are compared now: a
partial index recreated as a total one silently widens the constraint, and a `desc` index rebuilt
ascending serves a feed's newest page off the wrong end. `asc` normalises to `null` first —
`createIndex` writes `"col" asc`, which Postgres stores as not-descending, so the raw values differ
on every ascending index in a correct database.

`compareForeignKeys` judges **declared** keys the same way, and matches on **where the key points**
— its columns, its target table, its target columns — never on the constraint name. That identity is
`foreignKeyTarget` (`foreign-key.ts`), the **one** copy, read by this comparison and by `x db gen`'s
own diff: a generator and a detector that disagreed about whether two keys are the same key is drift
reported on a correct database. `snapshotOf` names a key `<table>_<column>_fkey` — what Postgres
would have called an inline `references` clause — and `addForeignKey` now writes that name out, so
the snapshot records a name the migration beside it chose rather than one it guessed; a hand-written
migration may still have said `constraint fk_posts_org`, and a key pointing the same way under
another name is the same key. `onDelete` **is** compared, `As of 2026-08-19`, through `onDeleteRule`
(`foreign-key.ts`) — the one normalisation both sides pass through, because the catalog spells the
rule `a`/`c`/`r`/`n`/`d` and a description spells it out, and `a` (`no action`) is what a key that
declared nothing has. A difference is `changed-foreign-key`, never a `missing` one: the rule is not
part of a key's identity (`foreignKeyTarget` ignores it, pinned by `foreign-key.test.ts`), the
constraint is there, and what changed is what happens to the child rows. Its `fix` is the drop/add
pair built from `dropForeignKey`/`addForeignKey`, not `x db migrate` — a rule cannot be altered in
place and no `x db gen` diff emits one for a schema already applied. Before
this, `snapshotOf` recorded `foreignKeys: []` beside an `up` emitting `references "orgs" ("id")` — a
snapshot denying a constraint its own migration creates — so `alter table … drop constraint` on the
database answered `ok: true`.

**A foreign key is `alter table … add constraint`, never a clause inside `create table`** — decided
2026-08, and it is the difference between a first migration that applies and one that does not.
Inline, the constraint is created with the table, so the referenced table must already exist; the
order `generateMigration` walks is `describeEntities()`, which is the app's *import* order and has
nothing to say about which table a `references()` points at. Measured against PGlite on a scaffolded
app: `create table "comments" (… references "posts" …)` before `create table "posts"`, statement one,
`relation "posts" does not exist`. `down` had the mirror fault — `drop table "posts"` while
`comments` still referenced it is `2BP01`. So `foreignKeyPlan` collects every key into a bucket of
its own, merged into the plan **after** every table statement; `down` is reversed as a whole, so the
drops pushed last there come out first. No topological sort and **no cycle error** *for adds*: two
tables referencing each other cannot be expressed inline in any order, and separate constraints need
no order at all. Dropping is not symmetrical and does need one — the paragraph below. The same call site answers the other half — a `references()` added to a column that
already exists now emits its `add constraint`, where before `up` came out **empty**, `x db gen`
wrote no file, and `x verify`'s drift step stayed red forever with `x db gen "…"` as a fix that did
nothing.

**Dropping a table has its own bucket, emitted BEFORE the table statements — the mirror image of
the one above, `As of 2026-08-23`.** `--allow-destructive` emitted a bare `drop table "authors";`
with every `alter table … drop constraint` appended AFTER it, so dropping a table another entity
`references()` was `2BP01 cannot drop table authors because other objects depend on it` — during
`ROLE=migrate` in the release phase, with the ledger recording nothing and a `down` of
`-- "<table>" cannot be restored`, i.e. nothing to reverse and a generated file to hand-edit. The
two-table case failed identically because drops came out **alphabetically**, which puts the parent
first. Two halves. `foreignKeyPlan` routes a key whose `referencedTable` is doomed into `preDrops`
instead of `constraints` — whether the entity still declares it or not, since a constraint cannot
outlive its target — and its `down` is a comment, because `add constraint` against a table no
`down` can restore is a rollback that cannot run. `drop-order.ts` orders the drops children-first
(a self-reference is not a blocker: `drop table` takes the table's own constraints with it) and
breaks a cycle between two doomed tables by dropping one inbound key first, which is the only
statement it emits. The `--allow-destructive` refusal is raised over that same ordered list, so
which table it names does not move with the alphabet.

**`foreignKeyPlan` lives in `foreign-key-plan.ts`, `As of 2026-08-23`** — split out of
`generate.ts` at the 500-line ceiling, along the seam it already drew: `generate.ts` assembles a
plan, `foreign-key-plan.ts` decides which bucket each key statement goes in, `foreign-key.ts`
writes the SQL. `Plan`, `foreignKeysOf` and `referenceParts` went with it because they are that
module's vocabulary; `snapshotOf` imports `foreignKeysOf` back, one direction only.

**`foreignKeyPlan` walks both directions, `As of 2026-08-19`.** A *removed* `references()` used to
emit nothing while the snapshot beside it recorded `foreignKeys: []` — so the orphan constraint
stayed on the database **and** the record denied one the catalog holds, which `compareForeignKeys`
can never see because it judges the declared side. **This paragraph said "that is not parity with a
removed index: a removed index leaves the snapshot correct by omission", and that was wrong** — see
`index-plan.ts` below: a removed index's snapshot lied in exactly the same way, and the arm to fix
it did not land until 2026-08-25. The drop names the
constraint **the previous snapshot recorded**, never the one this generator would have chosen — a
hand-written `fk_legacy` is `42704` under the generated spelling — and a key whose columns this
migration is dropping is skipped, because `drop column` takes the constraint with it. A key whose
`onDelete` moved is a drop **and** an add, the rebuild `redefineIndex` performs for the parts of an
index Postgres cannot alter in place.

**`on delete` reaches the SQL, `As of 2026-08-19`.** `entity()` has carried
`references(() => orgs.id, { onDelete: 'cascade' })` since 1.0, it type-checked, and the clause it
produced was `references "orgs" ("id");` — a declared cascade the database refused the delete
under instead. It was lost twice over: `describeColumn` renders `references` as the flat string
`"orgs.id"`, which has no room for it, and `ReferenceDescription` had no field for it either. Both
carry it now, `addForeignKey` writes it out, and a rule Postgres does not have is `X_INVARIANT`
rather than spliced DDL — the discipline `createIndex` already applies to an index naming no column.

**`entity-shape.ts` holds the three `*Like` interfaces**, split out of `generate.ts` for the line
ceiling and along the seam the tier already draws: they are the structural mirror of
`@ultimat3/entity`'s description, which is how a snapshot crosses tier 2 → tier 1 with no import.
`ColumnDescriptionLike.onDelete` is optional for exactly that reason — a description written before
the field existed still satisfies the shape — and `ColumnDescriptionLike.generated` is optional for
the same one.

**`snapshot-json.ts` writes the sidecar's bytes, and they must be a fixed point of Biome.** A
scaffolded app's `lint` step is `biome check .` over `"includes": ["**"]`, and `.sql`/`.hash` are
types Biome does not process — so the `.snapshot.json` is the first migration artefact lint ever
sees. `JSON.stringify(value, null, 2)` is not that fixed point: Biome collapses `["id"]` onto one
line and `JSON.stringify` never does, so `x db gen` wrote a file the app's own gate rejected — axiom
3, inverted. Two rules, measured against 2.5.5 and encoded in `print`: an **object** keeps the
source's shape, so emitting every non-empty one broken is stable by construction; an **array**
collapses when every element is already on one line and the line fits, *counting the trailing
comma*, at `<= 100`. `snapshot-json.test.ts` proves it by running the repo's own `biome format` over
the output and demanding no change — a pinned expected string could not have caught the boundary,
and the naive spelling is asserted to fail the same check so the test cannot pass by doing nothing.

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
tool legitimately show `x_users` — only drift wants the whole namespace gone. That last sentence is
a *reservation*, not a description, `As of 2026-08-24`: nothing outside this package imports
`introspect()` today, and `schema.describe` (`@ultimat3/mcp`'s `dev-server.ts`) answers from the
entity registry.

**`app-relation.ts` is the other half, and it is ownership, never a name — issue #340,
`As of 2026-08-24`.** `pg_stat_statements` is a view an extension owns, the CNPG/RDS/Supabase
default puts it in `public` of every database, and the drift audit after `ROLE=migrate` reported it
as `unexpected-table` with `x db gen "add pg_stat_statements"` as the fix — so every deploy of the
demo app failed terminally for 16 hours, and following the fix would have written an extension's
internal view into the app's migration set. `nonAppRelations(client, schema)` names what
`introspect()` must not see, and `introspect()` merges it into `excluded` **unconditionally**: an
explicit `exclude` replaces the `x_migrations` default, never this set, because an extension's
relations are not app schema in any deployment and that is not a caller's to switch off.

Two disqualifications, one question. **Extension ownership is read out of `pg_depend`**
(`deptype = 'e'`, `refclassid = 'pg_extension'`) — Postgres' own record, and the only rule that
generalises: a `pg_*` prefix would have covered the reported view and missed `postgis`'
`spatial_ref_sys`, `timescaledb`'s catalog, and `pg_stat_statements`' own `pg_stat_statements_info`
sibling, which is a real `relkind = 'r'` table. **A view, a materialised view and a foreign table
are not tables**, whoever made them: measured on PGlite, a plain `create view` reaches
`information_schema.columns` while the index query already fences on `relkind = 'r'`, so one arrived
as a table with columns, no primary key and no indexes — a `TableDescription` that cannot be true,
and a finding no author could clear because no snapshot records a view. Excluding by NAME is safe
because `pg_class` names are unique within a namespace.

Nothing else in the audit had the same hole. An extension cannot own a **column** of a table it does
not own — `alter extension … add` has no `COLUMN` form — so `unexpected-column` is unreachable that
way. **Types and enums** are never compared (`compareTable` reads nullability and existence, never
the type). **Indexes and foreign keys** are judged on the declared side only, so an extension's
index on an app table was already silent. `introspect-embedded.test.ts` proves the predicate against
a real catalog by writing the exact `pg_depend` row `create extension` writes; a recording client
can only pin the SQL text, which is what `app-relation.test.ts` does.

The `X_DB_DRIFT` rendering in `drift.ts` and the title in `DB_ERROR_TITLES` are pinned by the
framework contract and duplicated in `@ultimat3/entity`. Change them together or not at all.
`errors.ts` registers `DB_ERROR_TITLES` **unconditionally**, in one call, and that is deliberate:
a presence guard would turn "a second package claims one of db's codes" from an
`X_ERROR_CODE_DUPLICATE` at import into whichever module loaded first deciding the title. Entity
borrows `X_DB_DRIFT` and declares no title for it, for the same reason.

**This package owns no "is this SQL a write?" lexer, `As of 2026-08`, and must not grow one back.**
`readonly.ts` held one — `inspectStatement`/`assertReadOnly`/`readOnly(client)`, a regex-gated
`DbClient` wrapper on the public API — with **zero callers** in the framework or in either tracked
app. It was the weakest of the three the framework had shipped — a 22-word list matched with `\b…\b`
against blanked text, so it judges statement keywords and nothing else: `select pg_sleep(60)`,
`select pg_read_file('/etc/passwd')`, `select pg_advisory_lock(1)`, `select set_config(…)` and any
writing function call all read as reads, because `_` is a word character and the keyword never
stands alone. `@ultimat3/mcp`'s guard refuses each by called-function prefix. And it was the copy an
app author would find first, because it was the one on a public API. Deleted
with `readonlyViolation()` and `X_READONLY_VIOLATION`. The two layers that remain are the ones the
server enforces or a real parser decides: `readOnlyQuery()` (`BEGIN READ ONLY` + statement timeout,
layer 2) under `ensureReadOnlyRole()` (a `NOLOGIN` SELECT-only role, layer 1), with
`@ultimat3/mcp`'s `assertReadOnlyQuery` as layer 3. `errors.test.ts` pins `DB_OWNED_ERROR_CODES`,
so re-adding the code is a failing test; a second keyword list is not something a test can see, so
it is this line's job to refuse it.

**`readOnlyQuery` takes ONE statement**, refused through `statementsOf` before the transaction
opens (`X_SQL_UNSAFE`, `multipleStatements`). This is not a second mutating-keyword scan — it is a
different question, and the one the layer's own guards depend on: the statement is *spliced* into
`DECLARE … CURSOR FOR`, and only the first command of that text is bounded by the `SET LOCAL
statement_timeout` set moments earlier, so `select 1; set statement_timeout = 0` undid the guard
while `guards` went on reporting `timeout:5000ms`. `BEGIN READ ONLY` still held, so this was a
defeated layer reported as an engaged one rather than a write — and a guard list that lies is worse
than a guard list that is short. `statementsOf` is the package's one splitter, so a `;` inside a
literal, a comment or a dollar-quoted body stays data. **And the splice takes the splitter's
answer, `As of 2026-08-23`** — `statements[0]`, never the caller's text with a trailing `;` chopped
off it by a regex. That second answer only saw a `;` at the very END: `select 1; -- note` is one
statement to the splitter and does not end in `;`, so it reached the `DECLARE` whole and Postgres
answered `cannot insert multiple commands into a prepared statement`, uncoded, out of the path
whose whole job is bounding the read. The uncursored path still sends the caller's text
byte-for-byte, because it splices nothing.

`readonly-role.ts` and `readonly-query.ts` are layers 1–2 of that tool's defence-in-depth: a
`NOLOGIN` Postgres role (`ensureReadOnlyRole`) and a per-statement `BEGIN READ ONLY` + statement
timeout (`readOnlyQuery`). Only layer 1 degrades: `ensureReadOnlyRole` returns `null` on a missing
permission and leaves reporting the degraded layer to the caller. **`readOnlyQuery` throws** — a
failed reservation (`X_DB_UNAVAILABLE`), `SET LOCAL ROLE`, transaction command or the statement
itself all reach the caller, and every caller must handle that. Layers 3–4 (pre-parse scan, MCP
policy) live in `@ultimat3/mcp`, which must still never import this package — the CLI wires the
two together.

**`libpq-options.ts` merges the framework's `options` into the operator's, and `connectionUrl` may
not `set` that key again.** `DATABASE_URL` is the operator's file: `url.searchParams.set('options',
…)` REPLACED whatever they had written, and only on the roles whose `statementTimeoutMs` is
non-zero — so `?options=-c search_path=app` survived on `migrate` and `replicator` and was dropped
on `web`, `sync`, `worker` and `scheduler`, i.e. the role that runs the migrations and the role that
serves the traffic looked at different schemas with nothing reporting it. Precedence is **the
framework wins on the names it sets, the operator keeps every other flag**, and it is enforced by
removing those names from the operator's tokens before appending, never by position: "the last `-c`
wins" is backend argument-order behaviour nobody here measured. The bound is emitted for all six
roles including the two whose value is `0` — `0` is `migrate` saying it may take as long as it
takes, and left unsaid an `alter database … set statement_timeout` on the server kills the one role
that must outlive it. The splitter honours libpq's backslash escape, so a `search_path=two\ words`
survives the round trip whole.

- **Every numeric option this package bounds anything with is screened, `As of 2026-08-26`** —
  through core's `finiteCount`, which borrows `X_INVARIANT` as this package already does.
  `replicaClient`'s `breakerFailures` and `breakerCooldownMs` (a breaker is two comparisons and
  nothing else: `failures >= NaN` never opens it, `monotonic() < NaN` never parks it, so every read
  keeps going to the replica that is failing), `migrate`'s `lockWaitMs` (`NaN - elapsed <= 0` is
  false and `Bun.sleep(NaN)` does not sleep — a tight spin re-taking `pg_try_advisory_lock`, not an
  unbounded wait) and `readonlyQuery`'s `timeoutMs`, plus `client.ts`'s pool profile. The last one
  is a **behaviour change**: it used to normalise `NaN` to the default silently, so an agent read
  ran under a ceiling nobody wrote. Only an explicit `0` disables that layer, which is why its floor
  is 0 and not 1.

- **`client.ts` reached the 500-line ceiling on 2026-08-26, and shed the five jobs that were not
  "open a connection and send a statement".** `pool-profile.ts` owns the five numbers a pool runs
  on — the per-role table, `DATABASE_POOL_MAX` and the screen every merged profile passes;
  `connection-url.ts` builds the connection string (the libpq `options` merge and the
  `application_name` label); `bun-sql.ts` declares the slice of `Bun.SQL` this package uses and
  looks the global up lazily;
  `pool-reserve.ts` is `reserve()` under the acquire deadline; `db-health.ts` is `checkDb`, the
  `/readyz` report. `client.ts` keeps connecting, the client object and the ambient `db()` —
  and it still opens no socket at import, because `bunSqlFactory()` is reached from inside
  `connect()`. The **statement funnel** left with it on the same day, once the 500-line ceiling
  turned out not to be the bound this package is held to: `packages/db/src/**/*.ts` carries a
  path instruction of 200, and 263 lines is over it. `statement-funnel.ts` is `sendOn`/`runOn`
  plus the two shape helpers (`rowsOf`, `affectedBy`) — the seam this file already documents, and
  the one piece of `createPostgresClient` that closed over none of its state, so the move is a
  cut and a paste with no signature invented for it. Nothing outside this package imported any of
  the four, so no test's imports moved and no assertion changed. **The public surface did not move**: `src/index.ts` exports every one of those
  names from its new module, so `@ultimat3/db` is byte-identical to what it was. The same day,
  `drift.test.ts` split three ways along the three questions it was asking — `drift.test.ts`
  (tables and columns), `drift-index.test.ts` and `drift-ledger.test.ts` (what the migrations
  declare, and the post-migrate check) — over one shared `drift-fixtures.ts`, which
  `drift-foreign-key.test.ts` now imports instead of carrying its own byte-identical copy.

- **`DATABASE_URL`'s SCHEME is screened at boot, `As of 2026-08-26`** (issue #367). `new URL()`
  accepts a scheme-less connection string — `db.internal:5432/app` parses with `db.internal:` as
  the SCHEME and `5432/app` as the path — so `connectionUrl` saw a well-formed url and handed it
  on. Measured on bun 1.4.0, `Bun.SQL` then reads it as host `db.internal`, port 5432, database
  `app` and opens a Postgres pool on it, so the first symptom is a connect failure at the first
  QUERY, in another process phase, worded by the driver and naming neither the variable nor the
  missing `postgres://`. `POSTGRES_SCHEMES` is closed at **`postgres:` and `postgresql:`** —
  measured, not assumed: those two answer `adapter: 'postgres'`, while `pg:`, `tcp:` and
  `postgresql+ssl:` are refused by the driver itself (`Unsupported protocol: … Supported adapters:
  "postgres", "sqlite", "mysql", "mariadb"`), so excluding them costs a capability nobody has. The
  direction that matters is the one the driver ACCEPTS: `mysql:`, `mariadb:`, `sqlite:` and
  `file:` open a **different engine** and every statement generated here is Postgres. A
  **behaviour change**, not a defect repair — it narrows what the framework accepts, which is why
  it was deferred out of #364.
  **The received scheme is deliberately never echoed**, and this is the one refusal in the package
  that withholds the actionable token. `URL` reads the first token as the scheme, and for the value
  this exists for that token is the HOST (`db.internal:`); one dashboard field over
  (`app:hunter2@db.internal/app`) it is the USERNAME. Naming "the scheme" therefore puts a host or
  a credential in the boot log and the `--json` payload, where the logger has no key left to redact
  it by. The REQUIRED scheme is a constant and carries the whole instruction, and `describeValue`
  still keeps the shape, so an empty variable is told apart from a truncated one.
  `connection-url.test.ts` asserts the absence, so echoing it back is a failing test.

- **`unexpectedTable`'s `fix:` no longer names `x db gen`, `As of 2026-08-26`** (issue #345). That
  command diffs the ENTITY REGISTRY against the newest snapshot, and a table nothing declares is on
  neither side of it — so the diff came back empty, the generator's empty-diff branch writes NO
  file, and the reader had nothing to run and the same finding on the next deploy. The two edits
  that do resolve it are named instead: a `create table if not exists` in a migration (which
  `x db migrate` then accepts, through `@ultimat3/cli`'s `acceptCreatedTables`), or `psql … drop
  table` for a table nothing owns. No migration PATH is named — where an app keeps its migrations is
  the CLI's fact. `X_DB_DRIFT` is a shipped code and is unchanged; only this `fix:` text moved.

- **A name a `fix:` puts in a command is screened ONCE, by `shellInertIdentifier()` (`sql.ts`),
  `As of 2026-08-26`.** `identifier()` answers about SQL and cannot close this: it refuses `"`,
  `\` and whitespace and **accepts** a backtick and a `$` — `SAFE_IDENTIFIER` allows `$` on its
  fast path — which are exactly the two characters a shell substitutes inside DOUBLE quotes. A
  `fix:` is pasted into a shell at least as often as into a psql session, so a column named
  `$(id)` inside `x db gen "add $(id)"` RUNS `id` the moment its reader pastes the line, and a
  screen reusing `identifier()` unchanged ships a green suite over a live command-execution hole.
  It began as a private `writableName` in `drift-findings.ts` and was promoted rather than copied:
  three copies of a string-literal escape shipped here once and two were wrong the same way
  (`scripts/sql-literal-copies.ts`). Callers **degrade to prose** — the argument to `x db gen` is a
  migration DESCRIPTION, not an identifier, so no quoted form makes a hostile name safe to pass,
  and the name is read off `cause`/`meta` instead. Every benign rendering is byte-identical: the
  screen sits on the refusal branch alone, because roughly ten pages across `packages/cli`,
  `packages/core`, `wiki/` and `docs/` quote `x db gen "add <name>"` verbatim.

- **`dbDrift()` lives in `drift-errors.ts` and not in `errors.ts`, for exactly the reason
  `dependent-view.ts` states.** Its `fix:` needs `shellInertIdentifier` and `sql.ts` imports
  `errors.ts`, so keeping the constructor there is an import cycle around the module whose
  evaluation REGISTERS every code. `dependent-view.ts` avoided the same cycle by handing
  `errors.ts` a finished string; that is not available here, because `dbDrift(table, column)` is
  public API shipped since 1.0 and its signature cannot change. So the constructor moved instead,
  the way `migration-errors.ts` and `invariant-errors.ts` did — `X_DB_DRIFT` is still declared,
  titled and registered in `errors.ts`, and `src/index.ts` still exports the same name, so the
  public surface is byte-identical. `@ultimat3/entity`'s mirror screens through the **same**
  export across the tier seam (tier 2 → tier 1), which is what keeps the "keep in sync" comment on
  both declarations true; `packages/entity/src/errors.test.ts` asserts the two texts are equal,
  so a one-sided edit is a failing test rather than a comment nobody read.

- **A JS array bound as a parameter is rendered here, because `Bun.SQL` does not render it,
  `As of 2026-08-26`** (issue #384). `Bun.SQL`'s positional form serialises an array by JOINING ITS
  ELEMENTS WITH COMMAS, so `unsafe('select $1::text[]', [['x', 'y']])` sends the string `x,y` and
  Postgres answers `22P02 malformed array literal: "x,y"` — measured on bun 1.4.0 against Postgres
  17. **Three shipped statements bind an array and all three failed**: `@ultimat3/jobs`' `SQL_CLAIM`
  (the whole loop of every `ROLE=worker` container the framework produces, so a real deployment
  claimed nothing and every job sat in its queue), `SQL_OUTBOX_RELEASE` (the relay giving an
  unpublished batch back) and `@ultimat3/notify`'s `SQL_NOTIFY_INBOX_MARK_READ`.
  `array-parameter.ts` is the encoder and `sendOn` (`statement-funnel.ts`) is the one caller — this
  driver's only `unsafe` call, so one encoder is every caller fixed and a helper each site imports
  is three chances to forget and a fourth site tomorrow that does (axiom 1).

  **Why nothing caught it, and why the repair test is in `@ultimat3/cli`.** `pglite.ts` is a
  separate driver that encodes an array correctly, and `x dev` runs the embedded default — so the
  framework's own dev loop is blind by construction and only a container with `DATABASE_URL` ever
  meets the failure. Every other test of those three statements runs against a recording executor
  and asserts their SQL as TEXT, which cannot see whether a parameter PARSES;
  `grep -rln '\.claim(' --include=*.live.test.ts packages/` answered ONE file before this landed.
  `packages/db/src/array-parameter.live.test.ts` pins the grammar against a real server — and
  asserts the RAW array is still refused, so deleting the encoder fails rather than passing on any
  driver that happens to encode. `packages/cli/src/pg-array.live.test.ts` is the composition test:
  it is in `cli` because nothing else can see all three — this package is tier 1 and may not import
  `jobs` (3) or `notify` (4), and neither of those can build a db-backed `PgExecutor` — so
  `pgExecutorFor(createPostgresClient(...))`, the executor every booted role actually gets, is the
  only place the three real statements meet the real driver.

  Three grammar rules earn their line. **`NULL` bare is the array null and `"NULL"` is the
  four-character string**, so a JS `null` renders bare and a queue really spelled `NULL` must not
  become one. **Quoting is by content, not by type** — a comma, a brace, a quote, a backslash,
  surrounding whitespace or the empty string, which unquoted is not an element at all. **A
  `Uint8Array` is BYTEA and is deliberately not an array**: `Array.isArray` answers `false` for a
  typed array, which is behaviour this relies on rather than a case it writes. **A RAGGED nest is
  REFUSED**, never rendered — Postgres has no jagged array and `{{a,b},{c}}` is the same `22P02`,
  measured on 17 beside the rectangular `{{a,b},{c,d}}` that parses, so a literal this module is
  willing to emit is one the server is willing to read. `X_INVARIANT` through core's `assert`, the
  code this package already borrows for a value this build cannot honour; mixed depth (`{a,{b,c}}`)
  is caught by the same guard, which a rule comparing row LENGTHS alone would let through. And the
  common path allocates nothing — one `some` over a short list, then the caller's own array by identity, because
  every statement the framework runs passes through here and almost none binds an array (axiom 6).

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
