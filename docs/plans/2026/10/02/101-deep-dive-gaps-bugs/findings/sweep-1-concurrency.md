# Sweep 1 — concurrency, lifecycle, failure recovery
> Re-checked in [`sweep-3-verify-backend.md`](sweep-3-verify-backend.md) — where it narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only audit at `2ea5eb17` (23.0.0), As of 2026-10.
> Axis: what happens when this is interrupted or runs twice. No live Postgres, Redis or NATS was used.
> CONFIRMED (probe) = ran on PGlite or the memory driver. CONFIRMED (reading) = both sides read.
> PLAUSIBLE = argued, needs a live service.

## High

| # | Where | Interleaving | Damage | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 1 | `packages/db/src/transaction.ts:301` | `fn` inserts A; a later statement fails and `fn` catches it; `COMMIT` on the aborted tx answers `ROLLBACK` with no error; `outcome = 'committed'`, `runCommits` fires (`:304-306`) | every write in the tx silently lost, staged `x_outbox` rows included; `onCommit` effects fire for rows that do not exist; an idempotent action settles "success" | CONFIRMED (probe, PGlite) | mark the scope aborted when a statement on the tx connection rejects outside a savepoint (`makeTx`, `:187-189`); throw at COMMIT | `packages/db/src/pglite-embedded.test.ts` (unit), `transaction.live.test.ts` (live) |
| 2 | `packages/realtime/src/use-mutation.ts:167-169`, `packages/action/src/http.ts:112` | POST commits; connection drops before the response; `useMutation` queues and replays under the same key; the server reads the key only when `idempotent: true`; `mutator()` never defaults it (`mutator.ts:172`) | the write applies twice — a toggle replayed is a visible no-op. `offline-queue.ts:104-107` states the opposite. Reference app mutators declare no `idempotent` (`examples/dummy/apps/web/app/settings/mutator.ts:30,50`, `posts/mutator.ts:23`) | CONFIRMED (reading) | default `idempotent: true` in `mutator()`, or refuse one without it at registration — the shape of `assertIdempotencyScope` (`idempotency.ts:172`) | `packages/action/src/mutator.test.ts`, `packages/realtime/src/use-mutation.test.ts` (unit); one contract test through `toRoute` |
| 3 | `packages/mail/src/mail.ts:170-177` | handler opens `withTransaction`, inserts; `send()` calls `jobDriver().enqueue` on the pool, autocommitted; a worker delivers; the handler rolls back | mail for a write that never happened; under `{ retry }` each re-run can send again. The one `driver.enqueue` site outside `jobs` | CONFIRMED (reading) | `jobsFacade().enqueue(sendMailJob, message)` (`packages/jobs/src/outbox.ts`) | `packages/mail/src/mail.test.ts` (unit), a `.job.` suite proving rollback sends nothing |
| 4 | `packages/jobs/src/driver-pg-sql.ts:89-100` (`SQL_CLAIM`), `driver-memory.ts:273` | worker claims, the body kills the process; lease lapses (30 s); the next worker re-claims and `attempt` increments; nothing compares it to `max_attempts` | one poison row kills a worker every 30 s forever, never dead-lettered | CONFIRMED (probe, memory: attempts 1..8 against `maxAttempts: 3`) | a lapsed re-claim at `attempt >= max_attempts` settles `dead` in the claim statement (`isFinalAttempt`, `retry.ts`) | `packages/jobs/src/driver-parity.test.ts` (unit), a `.job.` suite on Postgres |

## Medium

| # | Where | Interleaving | Damage | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 5 | `packages/cli/src/runtime-queue.ts:174`, `framework-schema.ts:151`, DDL at `packages/jobs/src/driver-pg-ddl.ts:38,40,131,133,139,196-204` | every role boot runs `alter table … add column if not exists` (`ACCESS EXCLUSIVE`) with `lockTimeoutMs: 0`; it queues behind an open tx; every `stage()` and relay claim queues behind it | fleet-wide enqueue stall on each pod start; boot crash-loop past the 10 s statement timeout; first-deploy `23505` on racing `create table` | PLAUSIBLE | framework schema only under `ROLE=migrate`, behind `withAdvisoryLock` (`packages/db/src/migrate.ts:276`) with `SET LOCAL lock_timeout` (`:334-338`); serving roles verify | `packages/cli/src/framework-schema.live.test.ts` (live) |
| 6 | `packages/action/src/idempotency.ts:208-229`, `idempotency-postgres.ts:62-75` | reserve, handler, settle are three autocommit steps; the process dies after reserve | key answers `409 X_IDEMPOTENCY_CONFLICT (in-flight)` for 24 h; "never committed" and "committed, unsettled" are indistinguishable | CONFIRMED (reading) — a stated trade with no recovery path | settle on the handler's own tx connection (the `txExecutor` pattern of `createPgOutboxStore.stage()`); an in-flight row older than the request deadline is then reclaimable | `packages/action/src/idempotency-failure.test.ts` (unit), a live test over `postgresIdempotencyStore` |
| 7 | `packages/core/src/lifecycle.ts:392`, `packages/cli/src/role-start.ts:212`, `packages/http/src/server.ts:183-184` | readiness grace sleeps before `accept`; the worker stops claiming only in its `accept` hook (`worker.ts:418`); `drain.readinessGraceMs` reaches core only through `createServer` | worker, scheduler, sync pods claim for 5 s after SIGTERM, then abort those runs; an attempt burned per deploy | CONFIRMED (reading) | apply `drain` process-wide as `health.readiness` is (`packages/cli/src/serve-boot.ts:117`); listener-less roles stop claiming at drain start | `packages/jobs/src/worker-drain-signal.test.ts`, a `serve-boot` unit test on `ROLE=worker` |
| 8 | `packages/cache/src/fence.ts:43-44`, `redis.ts:311-335` | fence `marks` / `generation` are module state; replica A's in-flight load resolves after replica B's bust but before A processes the broadcast; A writes the stale value to Redis | stale value promoted by every replica for the full TTL when the broadcast is lost (NATS at-most-once; a failed boot subscribe at `packages/cli/src/runtime-cache.ts:185-190` is never retried) | PLAUSIBLE | a per-tag generation in Redis, bumped by the bust, compared inside the `SET` script | `packages/cache/src/redis.test.ts` over `redis-fake.ts`, two module instances (contract) |
| 9 | `packages/action/src/invoke.ts:274`, `cache-gate.ts:17-22` | `bustAfterCommit` runs when the handler returns and never consults `currentTx()`; action B called inside A's tx busts before A commits; a concurrent read refills pre-commit rows | stale rows for the TTL (60 s default, 300 s Redis). Needs app composition | PLAUSIBLE | defer to the root commit — `packages/entity/src/row-observer.ts:210-212` | `packages/action/src/cache-gate.test.ts` (unit) |

## Low

| Where | Defect | Verdict |
|---|---|---|
| `packages/jobs/src/driver-pg.ts:307-319` | `enqueue` is insert-then-lookup; if the live holder of the key acks between them the lookup finds nothing and throws `X_DRIVER_UNAVAILABLE` with a `fix:` naming `x db migrate`. Fix: retry the insert once | PLAUSIBLE |
| `packages/core/src/lifecycle.ts:398-409` | in-flight wait spends the budget → every `close` hook gets 0 ms, runs concurrently, alongside the pool release. Fix: reserve a floored slice, as `releaseBudgetMs` does | CONFIRMED (reading) |
| `packages/http/src/pipeline.ts:192` | at `X_TIMEOUT` the handler is orphaned by `Promise.race`; `done()` (`server.ts:206-214`) leaves the in-flight count; drain closes the pool under it | CONFIRMED (reading) |
| `packages/jobs/src/driver-pg-sql.ts:354` | `SQL_STEP_PUT` fenced only by the in-process signal; a stalled worker overwrites the re-claimer's step result. Fix: fence on `x_jobs.claims`, as `SQL_ACK` | PLAUSIBLE |
| `packages/jobs/src/steps.ts:334` | `await persist(failure)` unguarded; a store failure replaces the step's original error | reading |
| `packages/db/src/transaction.ts:308-315` | an ambiguous `COMMIT` rejection runs undos and drops `onCommit` for a tx that may be durable | reading |
| `packages/jobs/src/driver-pg.ts:248-254` | `requeue({ fromStep })` deletes steps then requeues in two statements | reading |
| `packages/jobs/src/scheduler.ts:326-334` | `run-once` fires then marks `at` in two steps; a crash between fires a second catch-up | reading |
| `packages/cli/src/runtime-render.ts:451-467` | static memo is check-then-act with no single-flight: N cold requests → N renders | reading |

## Not a bug (do not re-open)

- Channel frames lost during a catch-up read — `replay-gap` (`packages/realtime/src/channel-logs.ts:111-126`), `again` (`client-channels.ts:260-266`).
- Scheduler double-fire under two believed leaders — one statement fenced on the watermark.
- Outbox double-publish after a lapsed relay lease — published under the staged row's id; `release` / `markPublished` fenced on `claimed_by`.
- Single-flight caching a rejection — `packages/core/src/single-flight.ts`.
- Same-process stale fill after a bust; promotion into cleared tiers.
- Ack / nack from a worker that lost its lease — fenced on `state`, `claimed_by`, `claims`.
- Concurrent migrators — advisory lock on one pinned session.
- Concurrent duplicate idempotent requests — one `insert … on conflict`.
- Replaced client socket applying frames twice — identity guard on all three callbacks.
- Floating rejections — every `void fn()` opened catches internally. No package installs an `unhandledRejection` handler.

## Not examined — handed to sweep 2

- Realtime server: `sync-node`, `socket`, live-query fanout and window lock, presence, replicator, `pg-replication`, NATS transport; `socket-engine`; `offline-queue` drain.
- `storage`, `auth` sessions, `ai`, `pwa`, `admin`, `scraping`, `flags`, render's ISR controller, the rate-limit stores, entity repositories.
- Unverified for want of a live service: 1 on real Postgres, 4 on `SQL_CLAIM`, 5, the enqueue race, 8 on Redis, NATS redelivery.
