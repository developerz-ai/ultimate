# 02 — A finished scope refuses writes

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 0 (`core`), 1 (`db`), 2 (`entity`), 3 (`action`, `jobs`).

## Why
Two reproduced write-after-the-end holes, real pipeline against real Postgres 2026-11-02:

| Probe | Printed |
|---|---|
| deadline 30 ms, tx sleeps 120 ms | `504 X_TIMEOUT` at 42 ms; 0 rows then; 2 rows after the orphan settled; 4 after one unkeyed resend |
| `Promise.all` sibling fails, other sibling writes through `db()` 30 ms later | tx `rolled back: TypeError`; straggler `landed`; 1 row after rollback, on Postgres AND PGlite |

The second is the worse one: a dead `DbTx` falls through `held` to the pool (`db/src/client.ts:142`), so a write meant for a rolled-back unit of work autocommits. `db()` answers that dead handle (`db/src/client.ts:264`), so every repository takes this path.
Scope of the first: the typed client never auto-resends an unkeyed mutation (`action/src/client.ts:154`), and a keyed retry is already correct (409 until the orphan settles, then a replay; a reclaimed reservation fences its settle, `action/src/idempotency.ts:286-293`). The duplicate needs a person or an agent reading `X_TIMEOUT`'s `retryable` (`core/src/error-retry.ts:41`).

## Decisions
| Question | Answer |
|---|---|
| Which aborts refuse | a signal aborted with a CODED reason: `X_TIMEOUT`, or a job's `X_ABORTED` / `X_DRAINING` / `X_JOB_TIMEOUT` / `X_JOB_SLOT_LOST` / `X_JOB_LEASE_LOST`. Somebody was already answered, or another attempt owns the run |
| A client hang-up | no refusal. Bun aborts it with an uncoded `AbortError` (measured); nobody was told anything, and a click followed by a navigation must keep landing. Cooperative `throwIfAborted` is unchanged |
| Where | `withTransaction`, the `DbTx` handle, entity's write path, the enqueue facade. **Never `runOn`**: `settleFailure` (`action/src/idempotency.ts:330`) and the step write that `writesThrough` allows (`jobs/src/steps.ts:257`) both send past the abort through that funnel |
| The one escape | `runToCompletion(fn)`: a scope with a FRESH non-aborted signal and no deadline, built by `withChildContext`'s path so managed services rebuild over it. `abandonment()` then reads `ctx.signal` and has no special case; `retry()` and `outbound()` inside the scope keep working |
| A keyed action | runs in that scope. The orphan finishing is what makes its replay answer success. An aborted `ctx.signal` would fail its vendor call, `settleFailure` (`action/src/idempotency.ts:276`) would run, and the key would replay a failure |
| `withTransaction` around `withIdempotency` (`action/src/idempotency-tx-fixture.ts:109`) | the COMMIT sits OUTSIDE that scope. So `withIdempotency` marks the open root `completing` through db's `completeTransaction()`, straight after a reservation it created; a marked root's statements and COMMIT skip the abandonment check. The settle rides that COMMIT, so one mark decides both |
| Cost of the escape | a keyed handler's raw `fetch` to a hung host has no deadline left: bounded by `outbound()`'s own `deadlineMs` ([`11`](11-core-outbound.md)), the statement timeout and the drain budget. `beginWork` keeps it counted. The socket is still answered at the deadline (`http/src/pipeline.ts:201`) |
| What is thrown | the signal's reason, the same object. No wrapper, no new code for this half |

## Files to change
- `packages/core/src/context.ts:338` — beside `throwIfAborted`: `abandonment(): UltimateError | undefined` (the ambient signal's reason when aborted and branded) and `runToCompletion<T>(fn: () => T): T`: fresh `AbortController` signal, `deadlineAt: null`, same request id and actor. `withChildContext` (`:289`) only ever narrows, so its build splits into a private helper both call. Outside a context it just runs `fn`.
- `packages/db/src/transaction-guard.ts` — new. `refuseIfFinished(outcome)` and `refuseIfAbandoned()`, one file so `transaction.ts` stays under its ceiling.
- `packages/db/src/transaction.ts:37` — `TxState.completing: { value: boolean }`, shared by reference across nesting like `live`, new per attempt. New export `completeTransaction()`: marks the open root, a no-op outside one.
- `packages/db/src/transaction.ts:138-142` — `makeTx`'s three statement methods refuse first: closed scope, then abandonment unless `completing`.
- `packages/db/src/transaction.ts:186` — `runNested` refuses abandonment before the turn.
- `packages/db/src/transaction.ts:264,295` — `runRoot` refuses before `reserve()`, and again before `COMMIT` unless `completing`. `ROLLBACK` and `ROLLBACK TO` go on the raw connection and stay unguarded.
- `packages/db/src/transaction.ts:99` — the `currentTx()` comment: a dead handle now refuses rather than re-queues. `liveTxConnection` and the PGlite turn rules are unchanged (`pglite.test.ts:345` drives `client.query`, not the handle).
- `packages/db/src/transaction-errors.ts` — `txClosed(id, outcome)` for the new code.
- `packages/entity/src/pg-driver.ts:170` — `writing()` calls `refuseIfAbandoned()`: the one funnel for autocommit repository writes. Same check in the memory driver's writes (`write-parity.test.ts` holds them level).
- `packages/jobs/src/outbox.ts:319` — `enqueue` refuses abandonment before either path. A direct `driver.enqueue` is a write the tx guard cannot see.
- `packages/action/src/idempotency.ts:274` — for a reservation this call created: `completeTransaction()`, then `run()` inside `runToCompletion`.
- `packages/action/src/tx-scope.ts:9` — the one action file importing `@ultimat3/db`; re-exports `completeTransaction` to `idempotency.ts`.
- `packages/jobs/src/settled.ts:122` — `hook` runs inside `runToCompletion`, under `run.scope`, which also covers `unstartedRun`. `cancel.abort` in the `finally` (`execute.ts:452`) runs before the completed path's ack, so **every completed `onSettled` runs under an aborted signal today** (probe: `ctx.signal.aborted = true reason X_ABORTED`): its `fetch(url, { signal })` already fails, and with this slice its writes would too.
- `packages/core/src/error-retry.ts` — no row: `X_TIMEOUT` stays `retryable`, now true for an unkeyed write that used a transaction.
- Docs: `wiki/Entities-And-Migrations.md` (the transaction table, `:216`), `wiki/Actions.md`, `wiki/Jobs-And-Workflows.md`, `wiki/Error-Codes.md` `X_TIMEOUT` row, `wiki/Upgrading.md`; `packages/{core,db,entity,jobs,action}/CLAUDE.md` + core's and db's `README.md`. No `examples/dummy` use: `runToCompletion` is a helper, not a primitive feature.

## Steps
1. `bun run new-error-code X_DB_TRANSACTION_CLOSED --package db --title 'statement on a finished transaction' --cause '…' --fix '…' --status 500`; `errors.test.ts` pin; terminal, left unclassified like the other terminal db codes.
2. Closed-scope refusal in `makeTx`, on `outcome.value !== 'open'`: committed and rolled back alike. One rule; a statement that missed the COMMIT was not part of the unit of work either. `onCommit` effects are unaffected, `runCommits` runs outside `storage.run`.
3. `abandonment` + `runToCompletion` in core. Read `tryUseContext()` once, branded check through `isUltimateError`.
4. The guards in the transaction, in `writing()`, in `enqueue`.
5. `completeTransaction()` and the keyed path in `withIdempotency`.
6. `runToCompletion` around `onSettled`, then re-run the jobs suites: this is the one that would otherwise break apps silently.
7. `requestTimedOut`'s `fix` (`http/src/errors.ts:412`) gains a clause: a write past the deadline is refused, `runToCompletion` for work that must land. The fetch clause is [`11`](11-core-outbound.md)'s, untouched here.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_DB_TRANSACTION_CLOSED` | a statement on a `DbTx` whose scope already committed or rolled back: an un-awaited promise, a `Promise.all` loser | `await` it inside `withTransaction(fn)`; for work that must outlive the scope, wrap it in `outsideTransaction(fn)` |
| `X_TIMEOUT` (existing) | rethrown by a write past the request deadline | existing fix, reworded in step 7 |

## Tests
- `packages/db/src/transaction-closed.test.ts` (PGlite) + `.live.test.ts` (Postgres): the `Promise.all` straggler is refused and leaves 0 rows, after a rollback and after a commit. Fails today: 1 row.
- `packages/db/src/transaction-abandon.test.ts`: abort with a coded reason mid-body leaves 0 rows, `ROLLBACK` still sent; abort with an uncoded reason commits; abort between the last statement and `COMMIT` rolls back; `runToCompletion` commits.
- `packages/http/src/pipeline-orphan-write.test.ts`: 504, then 0 rows after the orphan settles. Fails today: 2 rows.
- `packages/entity/src/write-abandon.test.ts`: autocommit `insert` after abort refused on both drivers.
- `packages/core/src/run-to-completion.test.ts`: under an aborted parent, `ctx.signal` is live, `deadlineAt` null, `throwIfAborted` passes, a managed service sees the fresh signal, actor and request id kept. `retry()` inside runs every attempt.
- `packages/action/src/idempotency-orphan.test.ts`: a keyed action past its deadline whose handler passes `ctx.signal` onward still settles and replays success. Then through `txHarness` (`idempotency-tx-fixture.ts:109`), abort during `during`: COMMIT lands, `statusOf` is `settled`, the row is there, the replay answers `charged`. The same body with no key rolls back. Both on PGlite; `idempotency-postgres.live.test.ts` repeats the second.
- `packages/db/src/transaction-abandon.test.ts`: `completeTransaction()` in a nested scope marks the root; a retry attempt starts unmarked; outside a transaction it does nothing.
- `packages/jobs/src/settled-signal.test.ts`: `onSettled` after a completed run and after a timed-out one sees `ctx.signal.aborted === false`; its `withTransaction` commits. Fails today on the first assert.
- `packages/jobs/src/execute-drain.test.ts` extended: a step's fenced `put` past `X_DRAINING` still lands.
- `set -a; . docker/test-services.env; set +a; bun test packages/db packages/entity packages/jobs packages/action packages/http`

## Semver
Breaking. Upgrading entry: a write past `requestTimeoutMs` or a job's cancellation now rolls back instead of landing after the caller was answered, wrap work that must land in `runToCompletion(fn)`, which also drops the deadline for what runs inside it; a statement on a finished transaction is `X_DB_TRANSACTION_CLOSED` instead of an autocommit, `await` it or use `outsideTransaction(fn)`; `onSettled`'s `ctx.signal` is live. Added: `abandonment`, `runToCompletion`, `completeTransaction`.

## Done when
- Both probes print 0 rows after the orphan and the straggler.
- A keyed action past its deadline answers a success replay, as before, with or without a `withTransaction` around it.
- `onSettled` runs on a live signal; drain write-through tests unchanged.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.
