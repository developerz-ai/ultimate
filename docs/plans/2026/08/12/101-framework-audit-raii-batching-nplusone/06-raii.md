# 06 — RAII: disposable resources

> Part of [`overview.md`](overview.md). Depends on: 01 (fixes the leaks this formalizes). Tiers: 1 (`db`), 3 (`realtime`), 5 (`testing`).

The rule: a resource is held by an `await using` / `using` declaration, never by a hand-rolled
try/finally. `tsconfig.base.json:6` already ships `ESNext.Disposable`; the repo has **zero** `using`
statements — this slice writes the first ones and makes the framework's own resource types
disposable so app code inherits the shape.

The motivating asymmetry: `packages/db/src/readonly-query.ts:84-127` holds a reserved connection
correctly (acquire + first statement inside the `try`); `packages/db/src/transaction.ts:104-123`
holds the same resource incorrectly (`BEGIN` at `:111` outside the `try`, leaking the connection —
and on PGlite, wedging the single-session turn queue at `packages/db/src/pglite.ts:167` forever).
`await using` makes the correct shape the only shape.

## Files to change

- `packages/db/src/client.ts:19-21` — `DbConnection` gains `[Symbol.dispose](): void` (alias of `release()`); `release()` made idempotent (the reserved handle at `client.ts:180-182` currently double-releases).
- `packages/db/src/client.ts:188-191` — `close()` clears `driver` in a `finally` so a rejecting close doesn't leave a half-closed pool for the next `connect()`.
- `packages/db/src/transaction.ts:96-124` — rewrite `runRoot` around `await using reserved = …`; `BEGIN` moves inside the guarded scope (fixes the critical leak). Add `.catch` to `ROLLBACK TO SAVEPOINT` at `transaction.ts:90` so a dead connection doesn't mask the original error.
- `packages/db/src/readonly-query.ts:84-127` — same conversion; behavior identical, shape now uniform.
- `packages/db/src/pglite-turns.ts` — `Turn` gains `[Symbol.dispose]` (its `release` is already idempotent by construction, `pglite-turns.ts:8-11`); `packages/db/src/pglite.ts:163-185` consumes it via `using`.
- `packages/db/src/migrate.ts:143-149` — advisory lock must be session-pinned: `await using` a reserved connection, take `pg_advisory_lock` on it, run the migration transaction on the same session, unlock on dispose. Today the lock lands on an arbitrary pooled connection and does not serialize migrators (see 01).
- `packages/realtime/src/hooks.ts:68` and the unsubscribe returns in `packages/realtime/src/client.ts:36,180,193`, `channel.ts:75,103`, `live-query.ts:226,239-241` — subscription handles become `Disposable` (unsubscribe = `[Symbol.dispose]`), so `using sub = channel.subscribe(…)` works. Keep the plain function return too only if removing it breaks the public API — otherwise replace (axiom 1).
- `packages/testing/src/fixtures.ts:123-178` — `disposerOf`/manual reverse-order loop stays as-is *unless* Bun's runtime provides `AsyncDisposableStack`; verify at implementation time, adopt only if native.
- `packages/db/src/type-pins.ts` (or create) — pin `DbConnection extends Disposable` and `Turn extends Disposable` at the type level; a regression is a typecheck failure (axiom 3).

## Steps

1. Make `release()` idempotent on the reserved handle (`client.ts:167-182`), then add `[Symbol.dispose]` to `DbConnection` and `Turn`.
2. Convert `transaction.ts` root path: reserve → `await using` → `BEGIN` inside scope → commit/rollback → dispose releases. Nested SAVEPOINT path (`runNested`, `transaction.ts:76-94`) unchanged except the `.catch` on rollback-to-savepoint.
3. Convert `readonly-query.ts` identically.
4. Re-do `migrate.ts` locking on a single reserved session; `rollback()` (`migrate.ts:202`) takes the same lock (today it takes none).
5. Make realtime subscription handles `Disposable`; update `packages/realtime/src/hooks.ts` docs comment ("caller owns unsubscribe") to the new shape.
6. Add type pins; run `bun run boundaries` (no new imports expected — `Symbol.dispose` is a language feature, tier-neutral).

## Tests

- `packages/db/src/transaction.test.ts` — new: BEGIN failure releases the connection (recording client whose `execute` rejects on `BEGIN`); double-`release()` is a no-op; nested rollback preserves the original error when the savepoint rollback also throws.
- `packages/db/src/pglite.test.ts` — new: a failed BEGIN on PGlite does not wedge the turn queue (a second statement still runs).
- `packages/db/src/migrate` live suite — two concurrent `migrate()` calls serialize (one waits); lock released after failure.
- `packages/realtime` — `using` a subscription disposes it (spy on unsubscribe).
- Commands: `bun test packages/db/src/transaction.test.ts`, `bun test packages/db`, `bun run typecheck`.

## Done when

- Zero try/finally-with-release remains in `packages/db` for connections/turns/locks (grep is clean).
- The BEGIN-failure leak and the advisory-lock defect from 01 are closed by construction and covered by failing-first tests.
- `DbConnection`/`Turn`/subscription handles are `Disposable` and type-pinned.
- `bun run verify` green.
