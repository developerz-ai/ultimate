# 02 — db: transactions that lie

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 1.

## Files to change
- `packages/db/src/transaction.ts:301` — `await connection.execute(raw('COMMIT'))` then `committed = true`. Postgres answers `COMMIT` on an **aborted** tx with `ROLLBACK` and no error → `withTransaction` resolves, `onCommit` fires, 0 rows stored. CONFIRMED on PGlite, high.
  - Trigger A: body catches a failed statement (`insert(...).catch(() => undefined)`, unique-violation fallback).
  - Trigger B: two nested scopes under `Promise.all` on one root: `RELEASE x_sp_1` destroys `x_sp_2`; scope 2's `ROLLBACK TO x_sp_2` errors and is swallowed (`:253`); outer COMMIT silently rolls back everything.
- `packages/db/src/transaction.ts:253` — swallowed failure of `ROLLBACK TO`.

## Steps
1. Register `bun run new-error-code X_DB_TRANSACTION_ABORTED --package db --title 'Transaction was rolled back by the server' --fix '…'` (fix names: rethrow the inner error, or wrap the fallible statement in a nested `withTransaction`). Follow the db package's existing code naming if it differs.
2. Root state tracks "aborted": any statement error on the pinned connection sets it (hook where the tx connection executes). Before `COMMIT`, if aborted → `ROLLBACK` and throw the new code, cause = first failing statement.
3. Belt-and-braces: check the `COMMIT` command tag; `ROLLBACK` tag → same throw. (Covers drivers where step 2 misses an error path.)
4. Stop swallowing a failed `ROLLBACK TO` at `:253` — mark root aborted and rethrow.
5. Serialise nested scopes per root (a promise-chain turn lock, pattern `pglite-turns.ts`) so savepoints nest strictly LIFO.
6. `onCommit` effects must not run on either throw path — assert, don't assume.

## Tests
- `packages/db/src/transaction-commit.test.ts` (PGlite, unit): trigger A → rejects with the new code, `onCommit` not called; trigger B → rejects, rows written before nested scopes are absent and caller sees it.
- `packages/db/src/transaction.live.test.ts` (opt-in `.live`, real Postgres): same two cases.
- `bun test packages/db/src/transaction-commit.test.ts`

## Not a bug (don't reopen)
- Pool reservation deadline (`reserveWithin`) — late reservations are released.

## Done when
- Both triggers reject on PGlite and real Postgres; existing `transaction*.test.ts` still green; `bun run verify` `unit` + `live` + `errors` green.
- CHANGELOG line: code that relied on the silent resolve now throws.
