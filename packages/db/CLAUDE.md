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

`execute()` trusts `affectedRows` only when it is `> 0`: PGlite counts MODIFIED rows, so a SELECT
that returned rows is tagged `0`, and `??` would report 0 for every read while
`PostgresClient.execute` reported the row count. A write that modified nothing returned no rows
either, so the fallback stays 0 there.

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

The `X_DB_DRIFT` rendering in `drift.ts` and the title in `DB_ERROR_TITLES` are pinned by the
framework contract and duplicated in `@ultimat3/entity`. Change them together or not at all.
`errors.ts` guards `registerErrorCodes` with `hasErrorCode` because `X_NOT_IMPLEMENTED` is core's
and `X_DB_DRIFT` is also declared by entity — registering twice throws at import.

`readOnly()` is the regex-gated client for any caller that cannot open its own transaction. The
MCP `db.query` tool does not use it — it goes through `readOnlyQuery()`, which is stronger.

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
