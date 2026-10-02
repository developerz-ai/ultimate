# 07 — jobs

> Part of [`overview.md`](overview.md). Depends on: 01, 02. Tier: 3. Path-disjoint from 06, 08.
> Every driver change lands in **both** drivers and in `packages/jobs/src/driver-parity.test.ts`.

## Files to change
| Where | Change | Row |
|---|---|---|
| `packages/jobs/src/driver-pg-sql.ts:89-100` (`SQL_CLAIM`), `driver-memory.ts:273` | a lapsed re-claim at `attempt >= max_attempts` settles `dead` in the claim statement (`isFinalAttempt`, `retry.ts`) | `s1-con #4` |
| `packages/jobs/src/worker-loop.ts:64-73` | reset the wait in the catch — `outbox-relay.ts:253-256` | `s2-ja #1` |
| `packages/jobs/src/steps.ts:391-398`, `events-pg.ts:113-122`, `events.ts:35-39` | a new wait's `startedAt` comes from the bus: `now()` on `EventLookup`, clock as fallback | `s2-ja #2` |
| `packages/jobs/src/driver-pg-sql.ts:129-135`, `driver-memory.ts:183-197` | `cancel` fenced on live states (`LIVE_STATES`, `driver-memory.ts:51`) | `s2-ja #3` |
| `packages/jobs/src/events-pg.ts:62-70` | an awaitable purge, registered as a `PurgeTarget` (the `cli` half is slice 12) | `s2-ja #4` |
| `packages/jobs/src/introspection.ts:71` | cursor id group is a uuid pattern | `s2-ja #5` |
| `packages/jobs/src/driver-memory.ts:149-153`, `driver-pg.ts:229-235` | one refusal for `requeue` of an unknown id, beside `JobNotRequeueableError` (`errors-requeue.ts`) | `s2-ja #6` |
| `packages/jobs/src/driver-memory-operator.ts:171-177` | `requeueMany` passes the live-holder check as `eligible` (as `promoteMany`, `:196`) | `s2-ja #7` |
| `packages/jobs/src/outbox.ts:219-222` | `runId` validated once in the facade | `s2-ja #8` |
| `packages/jobs/src/limits.ts:257-259`, `worker-admit.ts:72,109` | a "did not start" release pops the rate stamp | `s1-t23 #6` |
| `packages/jobs/src/driver-memory.ts:325-328` | `lastErrorStack: undefined` whenever `error` is present | `s1-t23 #10` |
| `packages/jobs/src/driver-pg.ts:307-319` | retry the insert once before refusing | `s1-con` low |
| `packages/jobs/src/driver-pg-sql.ts:354` (`SQL_STEP_PUT`) | fenced on `x_jobs.claims`, as `SQL_ACK` | `s1-con` low |
| `packages/jobs/src/steps.ts:334` | guard `persist(failure)` — the original error wins (comment `:324-325`) | `s1-con` low |
| `packages/jobs/src/driver-pg.ts:248-254`, `scheduler.ts:326-334` | `requeue({ fromStep })` and `run-once` each in one statement | `s1-con` low |
| `packages/jobs/src/backfill-pass.ts:167-188` | `previous.runId === runId` falls through and replays | `s2-ja` low |
| `packages/jobs/src/driver-pg-rows.ts:97,149,171`, `driver-pg-rows.test.ts:280` | table names `x_jobs`, `x_job_steps`, `x_backfills` | `s2-ja` low |
| `packages/jobs/src/driver-memory.ts:385`, `driver-pg-sql.ts:170` | `stats()` queue order by code unit / `collate "C"` | `s2-ja` low |
| `packages/jobs/src/job.ts:269-273` | `retry.attempts` an integer ≥ 1, finite | `s2-ja` gaps |
| `packages/jobs/src/introspection.ts:111-112` | `BulkResult.remaining` excludes rows the verb will always skip, or the doc stops saying "until it is zero" | `s2-ja` gaps |

## Steps
1. Poison claim: the claim statement gains a second arm — rows it would re-take at the final attempt are updated to `dead` with a fixed error text naming the lapsed lease, and are not returned. `onSettled` must still fire once: check how `packages/jobs/src/execute.ts` reports a settle the worker did not perform, and report it from the claim round.
2. Worker loop: the failing test starts a round that always rejects at a 250 ms floor, sends one wake, counts rounds in 500 ms — currently 452.
3. Event clock: the skewed-clock unit test runs a runner clock +5 s against the PGlite bus.
4. New codes: grep `packages/jobs/src/errors*.ts` first. Likely new: an unknown-job refusal for row 6. Mint with `bun run new-error-code … --package jobs`.
5. `cancel` on a dead letter currently destroys the dead-letter record — the test asserts `deadLetters()` is unchanged and `cancelJob` answers a refusal.

## Tests
- `packages/jobs/src/driver-parity.test.ts`, `worker-loop.test.ts`, `steps.test.ts`, `limits.test.ts`, `operator-surface-fixture.ts`, `outbox-run-id.test.ts`, `backfill-pass-guard.test.ts`.
- `job` suites on Postgres: the poison claim, `events-pg.live.test.ts`, the enqueue race.
- `bun test packages/jobs`

## Owned elsewhere
- `packages/mail/src/mail.ts:170-177` enqueues outside the caller's transaction (`s1-con #3`) — slice 10.
- Workers claiming during the readiness grace (`s1-con #7`) — slice 12 (`packages/cli/src/role-start.ts`) with `packages/core/src/lifecycle.ts`.
- Redis / NATS stub drivers (`s1-arch #6`), action → job (`s1-arch #4`) — slice 15.
- `worker-admit`, `worker-fleet-slots`, `worker-key-busy`, `worker-registry` are **unaudited** (`s2-ja`, last section).

## Done when
- A job whose worker dies on every attempt reaches the dead-letter queue after `maxAttempts`.
- A wake during a database outage does not spin the loop.
- `x_job_events` shrinks. `cancel` refuses every finished state.
- `bun run verify --only unit,job` green with the test services up.
