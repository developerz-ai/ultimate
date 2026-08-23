# Resource management

Every database resource the framework hands out — a pooled connection, PGlite's single session
turn — is `Disposable`. Hold it with `using` or `await using` and it goes back on every exit path:
a normal return, a throw, an early `return` buried three branches deep. There is no second way to
release one.

## Why RAII here

A pinned connection that never comes back, or an advisory lock released on a different session
than the one that took it, was a real bug class — not a hypothetical one. `pg_advisory_lock` is
scoped to a Postgres **session**, not a statement: take it on a pooled handle and the pool can hand
that physical connection to someone else before the unlock runs, and the unlock lands on a session
that never held the lock. `withTransaction`'s `BEGIN` used to sit above its guarded block; a `BEGIN`
that itself rejected — a dead connection, a server in recovery — returned the pin to nobody, and on
PGlite that stranded the process's one session forever.

The fix in every one of these places is the same shape: put the resource behind a `using`
declaration that starts guarding *before* the risky call, not a hand-rolled `try`/`finally` that
only covers what someone remembered to put inside its `try`.

## The idiom

```ts
using connection = await client.reserve();
await connection.execute(sql`...`);
// released automatically here, however the block exits
```

`await using` is the same shape for a resource whose teardown is itself async. `As of 2026-08`
nothing in `@ultimat3/db` needs it — `release()` on both drivers is synchronous — but the language
feature is there for a `Disposable` whose cleanup does need to await, and this line is what to
update when the first async call site lands.

Inside the framework, three call sites hold a pin this way, all in `@ultimat3/db`:

| Site | What it pins, and why |
|---|---|
| `withTransaction` (`packages/db/src/transaction.ts`) | one connection for `BEGIN`…`COMMIT`/`ROLLBACK` — a pooled `BEGIN` landing on a different physical connection than the statements after it would not be a transaction at all |
| `readOnlyQuery` (`packages/db/src/readonly-query.ts`) | one connection for `BEGIN READ ONLY`…`ROLLBACK` — same reasoning, read-only path |
| the migration advisory lock (`packages/db/src/migrate.ts`) | one session for `pg_advisory_lock`…`pg_advisory_unlock` — the lock and the unlock must be the same session or the unlock is a silent no-op |

In each, the declaration reads `using reserved: DbConnection | undefined = isReservable(client) ? await client.reserve() : undefined;` — a connection that isn't reservable (a fake in a test, a plain
`DbClient`) disposes of nothing, which is correct: there was never a pin to give back.

## Idempotent release

`release()` — and `[Symbol.dispose]`, which is the exact same function — can be called more than
once. The second call is a no-op, never an error. This matters because a caller can hold a
`DbConnection` past a `using` scope's own disposal and call `release()` by hand; on both drivers
(`packages/db/src/client.ts` for pooled Postgres, `packages/db/src/pglite-turns.ts` for the
embedded single session) release is a `held` flag flip or a settled promise's `resolve`, neither of
which a second call can act on twice. A double release is a no-op precisely so two owners on one
exit path — `withTransaction`'s `finally` and the `using` declaration's own disposal, historically —
can never fight over who releases first.

One more consequence of the connection being `Disposable`: once `release()` has run, a *late*
statement issued on the stale handle does not silently corrupt whoever holds that physical
connection now — `client.ts` routes it back through the pool for a connection of its own instead of
running it directly. Direct execution only happens while the pin is actually held.

## What is `Disposable`

| Type | Package | Disposed by |
|---|---|---|
| `DbConnection` (`client.reserve()`'s return) | `@ultimat3/db` (`client.ts`) | `release()` / `[Symbol.dispose]` |
| `Turn` (PGlite's single-session turn queue, `queue.take()`'s return) | `@ultimat3/db` (`pglite-turns.ts`) | `release()` / `[Symbol.dispose]` |

`Turn` is the PGlite-specific version of the same problem: embedded Postgres is one session, not a
pool, so two units of work that both `BEGIN` would be sharing one transaction unless something
serializes them. `createTurnQueue()`'s `take()` hands out a `Turn`, and `using turn = await
queue.take()` gives the session back to the next waiter on every exit, exactly the shape
`DbConnection` uses.

The test double follows the same contract: `reservableOver()` (`packages/db/src/fake-reservable.ts`)
wraps any `DbClient` in a `ReservableClient` whose `reserve()` returns a connection with the same
idempotent `release()` / `[Symbol.dispose]` pairing, and counts reservations against releases — a
test proving no leak asserts `pins.reserves === pins.releases` rather than reasoning about it.

## Enforced, not documented

Per the framework's own rule that a convention which isn't a build error doesn't exist,
`packages/db/src/type-pins.ts` carries compile-time assertions — `_DbConnectionIsDisposable` and
`_TurnIsDisposable` — that fail `tsc` if `Disposable` is ever dropped from `DbConnection` or `Turn`.
It lives in `src/`, not as a `.test.ts`: `tsconfig.json` excludes test files from `tsc -b`, so a
type-level assertion written there could never fail. If a future edit quietly removes `Disposable`
from either interface, every `using` declaration built on it stops compiling as a scope-bound
resource and degrades back into a hand-rolled `try`/`finally` — silently, at every call site, unless
this pin catches it first. A regression here is a typecheck failure across `@ultimat3/db`, not a
leaked connection discovered under load.

## The same pattern outside the database

Realtime subscription handles are `Disposable` too, the same aliasing trick: `LiveHandle`
(`packages/realtime/src/client.ts`) and the callable `Unsubscribe` type both set
`[Symbol.dispose]` to the exact same function as `unsubscribe()`, so `using feed = useLive(...)`
(`packages/realtime/src/hooks.ts`) tears a subscription down on scope exit the same way a `using
connection` returns a pin — different subsystem, same idiom. See [Realtime](Realtime).

## Bounded, not disposable

Two resources have no owner to give them back, so they are bounded instead. `As of 2026-08-23`,
both mechanisms live in `@ultimat3/core`.

| Resource | Bound | What happens at the bound |
|---|---|---|
| a slot in a concurrency gate (`createFlightGate`) | `maxConcurrent` running, `maxQueued` waiting | past the queue the answer is a **refusal** — `X_FLIGHT_GATE_OVERLOADED`, 503, `Retry-After: 1`. Never a longer queue: an unbounded queue turns a load spike into a memory fault and answers it minutes late. `@ultimat3/auth` throws its own `X_OVERLOADED` through the same gate |
| a key held by an in-flight load (`createSingleFlight`) | an optional `deadlineMs` | the **key** is freed and the next caller may start its own. The work is not cancelled and no promise is rejected — the framework holds no signal that could abort a caller's function, and pretending otherwise would be a second, false promise. `createCacheStack` sets 30 s, `@ultimat3/auth`'s JWKS refresh twice its transport timeout |

A slot is handed **over** on release rather than released and re-acquired: decrementing first would
let a caller arriving in the same tick past the ceiling while a waiter's continuation is still a
queued microtask, which is how a bounded pool goes over its bound under exactly the load it exists
for.

## See also

- [Entities and migrations](Entities-And-Migrations) — the transaction and query paths these pins hold up
- [Caching and invalidation](Caching-And-Invalidation) — the load deadline on the read ladder
- [Error codes](Error-Codes)
