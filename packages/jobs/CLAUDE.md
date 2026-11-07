# @ultimat3/jobs — agent notes

Tier 3. The `job` + `task` primitives, durable steps, transactional outbox, queue drivers.

## Boundary

- May import: `core`, `schema`, `entity`, `policy`, `cache`, `time` — and `db`, for
  `expectedQueryLoop` (`steps.ts` declares the per-step write one-per-step to the N+1 detector),
  `outsideTransaction` (`execute.ts`), `refuseAbandoned` (`outbox.ts`) and `withTransaction`
  (`consumer-loop.ts`: a batch and its cursor commit together) — the ONE place a client is taken
  from it, the ambient `db()`. Never `render`, `ui`. `http` only from `webhook-receiver*.ts`, for the route
  (`Route`/`Bucket` types, `DEFAULT_WEBHOOK_BODY_LIMIT`, `HttpError`, `jsonResponse`).
- Consumers: `action` (`<job>.enqueue`, via the ambient jobs facade), `cli`, `mcp`, `admin`.
- External deps: none. Postgres access goes through the injected `PgExecutor` (`@ultimat3/core`'s,
  re-exported from `index.ts`).

## Rules — registration and declarations

- **The export name IS the job/task name.** `registerJobs(module)` / `registerTasks(module)` stamp
  it onto the exported handle in place. A definition with its own `name:` keeps it (a durable queue
  key). `defineApi({ jobs, tasks })` is where a module is handed over; nothing else registers.
- The same handle under the same name is one registration; anything else on one durable name is
  `X_JOB_DUPLICATE` at the earliest decidable point (same `name:` inside `job()`/`task()`; a
  different handle, or the same handle under a second export name, at registration).
- `registerJob`/`registerJobs`/`registerTask`/`registerTasks`/`nameJobs`/`nameTasks` are NOT in
  `src/index.ts`. `register.ts` announces the registrars in core's table at import — never remove it
  (`X_REGISTRAR_MISSING`). `isJobHandle`/`isTaskHandle` are structural plus proof `job()`/`task()`
  built it.
- `idempotencyKey` is NON-OPTIONAL. **The namespace is `(name, coalesce(tenant_id, ''),
  idempotency_key)`** — the index, the conflict target (spelling the index EXPRESSION exactly) and the
  live-row lookup agree, pinned by a test; `driver-memory.ts` mirrors it. The DDL drops both
  superseded indexes.
- **JOBS DECLARE THEIR TENANT, and `executeJob` INSTALLS the context — do not re-litigate.** `tenant` is REQUIRED (`(input) => input.orgId` or `'none'`; `X_JOB_TENANT_REQUIRED` backstop). Full rule: `docs/history/jobs.md`.
- **`enqueuedBy` is ATTRIBUTION, never authority** — do not re-litigate. A job acting FOR a user takes
  the user's id in its input and re-authorises it in the body.
- `tz` is NON-OPTIONAL in `TaskDefinition`, validated by `@ultimat3/time`'s `isValidTimeZone`. A task
  never contains a handler body.
- **`stepTimeout` and `eventPoll` are declared on the job**, forwarded only by `execute.ts`, refused at
  declaration when non-positive.
- `registeredJobs()`/`registeredTasks()` sort by CODE UNITS (they reach `x.manifest.json`).
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim** (`index.test.ts`).

## Rules — the driver and SQL

- **`SQL_JOBS_TABLE` is the ONE install point** for every durable table (`x_jobs`, `x_job_*`, `x_backfills`, `x_outbox`, `x_scheduler_*`). Full rule: `docs/history/jobs.md`.
- **`claim({ queues: [] })` is REFUSED by every driver** (`assertClaimQueues`,
  `X_JOB_CLAIM_QUEUES_EMPTY`); the memory driver's reads are `async` so a refusal rejects on both.
- **`ack`, `nack`, `heartbeat` and `recordProgress` are FENCED on `state = 'running'` AND the
  CLAIM** — `{ workerId, claim }`, `claimOf(claimed)`; `x_jobs.claims` is moved by the claim and
  never reset. `heartbeat` answers a boolean, read as `held === false` (never `!held`).
- **A driver's semantics are pinned beside the pg statement** (`driver-parity*.test.ts`);
  `driver-*-fixture.ts` scenarios run on memory AND Postgres.
- **The claim BURIES a lease that lapsed on the final attempt** (`attempt >= max_attempts`): `dead`
  in `SQL_CLAIM` — `failed` for a name in `ClaimOptions.dropExhausted` (`retry.deadLetter: false`)
  — counted, never returned; the worker's round hears `onExhausted` and calls `announceExhausted`.
- **`cancel` is fenced on `LIVE_STATES`.** **`requeue`** refuses (`X_JOB_NOT_FOUND`, not requeueable,
  duplicate), then ONE statement. **`enqueue` inserts twice at most.** **`BulkResult.remaining` is
  what a second call would move.**
- **`enqueueMany` is one statement per `ENQUEUE_CHUNK` (1,000)** (`job-enqueue-many.ts`;
  `SQL_ENQUEUE_MANY`: `SQL_ENQUEUE`'s conflict target and id fence, one wake per queue); skipped rows
  are answered by ONE `SQL_ENQUEUE_MANY_RESOLVE`, a row neither answers goes back through `enqueue`.
  **`JobDriver.enqueueMany` is REQUIRED** and opens with `assertEnqueueMany` (no `onConflict:
  'error'` in a batch, `X_INVARIANT`); Redis's `REDIS_ENQUEUE_MANY` shares `enqueue_one` with
  `REDIS_ENQUEUE`. `OutboxStore.stageMany`/`markPublishedMany` are OPTIONAL: absent, a loop. Every
  refusal precedes the first write; `refuseAbandoned()` before every direct chunk. `runAt` crosses
  as `numeric` then `bigint`: a fractional ms rounds, never a `22P02`.
- **No read returns a WHOLE row** — `driver-pg-sql.test.ts` scans every production file here
  (discovered, comments stripped) for `select *`/`returning *`.
- Drivers: the `JobDriver` methods plus optional `introspect`, `backfills`, `leases`; new
  capabilities go behind the interface. **`redisJobDriver`** (`@ultimat3/jobs/redis`, off the
  barrel) is one Lua script per operation: a semantic change lands in memory, pg AND the scripts.
  Its client is core's `redisClient()`, never `Bun.redis`; `ERR_REDIS_CONNECTION_CLOSED` is
  `X_DRIVER_UNAVAILABLE` at once (`typedRefusals`), never a wait.
- **`demand` is the seventh method, required**; a draining worker's `queue_demand` goes to 0.
- **The claim SEEKS** (`SQL_CLAIM`); correct only because a claim autocommits.
- Step results are persisted BEFORE the step returns, and it returns what it persisted: `jsonForm` (`steps-output.ts`), typed `StepOutput<T>`, one stringify + parse per EXECUTED step. Full rule: `docs/history/jobs.md`.
- **`postgresLeader` is correct only on a DEDICATED connection**; boot uses `postgresLeaseLeader`.

## Rules — numbers and limits

- **Every numeric knob is refused when not FINITE** (`finiteOption()`, `finiteCount()`, read in `worker-options.ts`); `bun run finite-bounds` is a floor. Full rule: `docs/history/jobs.md`.
- **`WorkerOptions.concurrency` is read by OWN key** (`worker-slots.test.ts`); `maxInFlight` BEFORE
  the claim, its count back with the lease, before the `kick` (history).
- **`job.concurrency` is enforced by `JobDriver.leases`** (one row per held slot in `x_job_leases`);
  `limits.ts` is the per-process fast path. No lease store + a declared `concurrency` makes `start()`
  throw `X_JOB_CONCURRENCY_UNENFORCEABLE`.
- **`concurrency` is resolved ONCE** (`concurrency.ts`): a number, or `{ key, limit, whenBusy }` per key. Full rule: `docs/history/jobs.md`.
- **`whenBusy: 'fail'` refuses only on EVIDENCE another run holds the key** (`LeaseStore.holders`,
  required): a run meets its own leftover slot. The refusal is `nack({ fail, countsAsAttempt:
  false })` → `failed`, outcome `refused` (`worker-key-busy.ts`), never `executeJob`.
- **A key underivable at claim is `SlotGrant` `undecidable`** → `executeJob({ refusal })`: the
  ATTEMPT fails, never the round.
- **`finalAttempt` is `isFinalAttempt(handle.retry, attempt)`**, REQUIRED on `JobRunArgs`.

## Rules — the worker and the scheduler

- **One enqueue implementation**: `jobsFacade()` owns `enqueue` AND `enqueueMany`, over the row
  builders in `enqueue-record.ts`, which the relay shares; the only other `driver.enqueue` sites are
  the outbox relay and the scheduler. `handle.as(actor, input)` QUEUES; `executeJob` is the one execution path.
- The scheduler's key is occurrence-scoped (`task:occurrenceMs:jobKey`); `task.enqueue()` uses the
  job's plain key.
- **TWO shutdown hooks per worker, one per PHASE**: `accept` is `stopAccepting()` (flip state, clear
  the poll timer, arm the drain cut-off — it aborts nothing); `close` is the teardown. `stop()` hands both back in a `finally`;
  `start()` refuses while draining.
- **A claimed job is counted with core's `beginWork()`**: the drain's in-flight phase waits. The
  teardown's wait is bounded on SIGTERM (`drain-wait.ts`), unbounded on `stop()`; one teardown, joined.
- **A deploy lets a running job FINISH**: SIGTERM only stops claiming. `drainSignal` aborts
  (`X_DRAINING`) at `deadlineAt − margin` (`worker-drain-cutoff.ts`), then held claims go back
  uncounted (`worker-held.ts`). Settles **`interrupted`**; `docs/history/jobs.md`, "Drain, 2026-10".
- **`X_RATE_LIMITED` defers uncounted** (`rateLimitDeferralMs`).
- **The drain waits out the claim round it races** — `tick()` registers its round in `rounds`
  synchronously with its guard.
- **A fleet slot is taken INSIDE a `try`, released AWAITED, and HELD, not owned**: `false`, or a TTL
  with no renewal landing, CANCELS the run (`X_JOB_SLOT_LOST`); held per job id as a LIST.
- **The run's signal is a controller this worker owns** (`run-signal.ts`).
- **A lease is HELD, not owned** (`heartbeat.ts`): one failed renewal warns; a whole window without
  one landing is `jobs.lease.lost`, on this process's clock, asked both sides of the call.
- **A renewal is decided against `stopped()`** (`renewal-timer.ts`, re-read after every await); the
  interval is `unref`ed; every renewal is armed through `WorkerOptions.schedule`.
- **Settlement is not part of the retry decision**: `driver.ack` sits after the `try`.
- **The retry decision reads the ERROR, on core's backoff curve** (`retry-classification.ts`,
  `backoffDelayMs`): `docs/history/jobs.md`, "Moved 2026-10-01 — retry and bounds".
- **The claim loop re-arms on the PASS, never the jobs**; `tick()` resolves with that pass's executions.
- **A deadline CANCELS, then fails the attempt**, never the reverse (`raceTimeout`, `withStepTimeout`);
  `ctx.signal` aborts unless the body completed AND its ack landed; steps fence on `ended`.
- **A cancelled runner writes NOTHING** — `put()` in `steps.ts` (`X_ABORTED`) — save a fenced
  `X_DRAINING` on a live attempt: a step done in the drain is recorded once. The STORE fences
  the claim (`StepFence`, `SQL_STEP_PUT` as `SQL_ACK`: `X_JOB_LEASE_LOST`). `executeJob` passes it.
- **A cancelled body's writes refuse too**, `enqueue` included (`outbox-abandon.test.ts`); a store is on the pool: a fenced `put` past `X_DRAINING` lands.
- **`traceparent` is stamped at ENQUEUE time, in `outbox.ts`**, and an empty `spanId` sends none.
- **The scheduler runs one dispatch round at a time**; `stop()` waits it out before `leader.release()`. Full rule: `docs/history/jobs.md`.
- **`run-once` fires ONE catch-up**: the watermark rides the fire (`ScheduledFire.watermarkMs`),
  never a `markFired` behind it; `skip` fires the latest missed occurrence (`latestOccurrenceBy`).
- **A lease for a run that never STARTED is `abandon()`ed, never `release()`d** — the rate stamp
  goes with it (`worker-admit.ts`). **A failed pass re-arms at the floor** (`worker-loop.ts`
  catch); `timers` is the test seam.
- **Every timer body catches before it finalises.**
- **Suspension is control flow, and a SHED is not a suspension**: `StepSuspension` →
  `nack({ countsAsAttempt: false, park: true })`; a shed is `countsAsAttempt: false` without `park`,
  stays `ready`, logs `jobs.worker.shed` (no `last_error`). `driver-parity.test.ts`.
- **A wiring throw hands back the run's holdings, and its ROW until `executeJob` starts**
  (`worker-run.ts`), as a failed shed does its job (`worker-admit.ts`).
- **`step.run` hydrates the run's steps from ONE `store.list(runId)`**; `sleep` and `waitForEvent`
  record replays through `trace()`. **`claimName` reads a Set**; `usedNames()` keeps
  `MAX_TRACE_NAMES` (200).

## Rules — long form in `docs/history/jobs.md`

- "Moved out 2026-11-03": operator verbs on BOTH drivers; an idle round touches no store.
- "Moved out 2026-11-06": `demand` with no worker registry; how the claim seeks.
- "Moved out 2026-11-07": `cancelJob`'s refusals; why a completed attempt's signal stays live.
- "Plan 101 wave 6c": compensate ONLY failed for good; `once` writes `started` BEFORE `fn`; a
  waking publish is ONE statement; payload org = enqueue org (`X_JOB_TENANT_MISMATCH`).

## Rules — the outbox

Long form: `docs/history/jobs.md`, "Moved 2026-10-01 — the outbox".

- **The relay drains in two phases**; `relay.stop()` JOINS the pass in flight, under a `DrainBudget`
  a later shutdown binds LATE (the worker's shape); its timer is `unref`ed.
- **The claim is a LEASE in one statement**, fenced on every mutation (`and claimed_by = $n`);
  `claimLeaseMs` is normalised in `outbox-lease.ts`. `outbox-claim.test.ts` pins both stores.
- **The memory outbox store DELETES a published row** (`retained()` is the seam).
- **A staged row's id IS its job's id, and its `runId` is allocated at stage** (`x_outbox.run_id`),
  so a staged enqueue answers real ids. `SQL_ENQUEUE` inserts nothing under an id that names a
  row — a repeated publish is `deduped`, live or finished (`outbox-run-id.test.ts`).
- **The relay publishes a batch in two statements** (`publishBatch`): `driver.enqueueMany`, then
  `markPublishedMany` when the store has it; any failure drops that batch to the row loop, which
  keeps the order. `RELAY_BATCH_SIZE` (500) is measured in its doc comment.

## Rules — factories over `job()`

Long form: [`docs/history/jobs.md`](../../docs/history/jobs.md), "Moved 2026-10-01 — factories".

- **`backfill()`**: a step persists the CURSOR, never the page; **`handle` is AT LEAST ONCE**. Full rule: `docs/history/jobs.md`.
- **The ledger says what RAN, the registry what EXISTS, `backfill-pending.ts` is the diff.**
  `environments` is checked in `backfillPass()` and `gateBackfill()`; `requires` in `gateBackfill()`
  only; `count` after the last batch (`X_BACKFILL_STALLED`). `inspectBackfills()` is the ONE projection.
- **`rollup()`/`refreshView()`**: ONE `upsertAll`; `rollup.job.test.ts`.
- **`purge()`** is the one caller of every `purgeExpired()`: one table per `step.run`, one clock
  reading per pass, duplicate names refused.
- **`exportRows()`**: one object per PAGE, named by page index; NO cross-tenant escape.
- **`importRows()`**: one step per PAGE, checkpointed at the BYTE OFFSET, no carry between steps;
  `pageBytes` > `maxRecordBytes` is refused at declaration. `handle` is AT LEAST ONCE per page. The
  error report never carries the refused value. NO cross-tenant escape.
- **`webhookReceiver()`**: a plain `Route` read under `maxBytes` (core's `readWithinLimit`, never
  `bodyBytes()`); `verify` runs before any parse and answers `{ eventId, payload }` from verified
  data; the id is bounded (`WEBHOOK_EVENT_ID_PATTERN`, 422); the enqueue is `outbox: false` before
  the ack (503 otherwise); the payload is stored `.sensitive()`, never re-verified.
  `webhookReceiverRoutes()` is what the boots mount.
- **`webhook()`**: ONE event to ONE endpoint, no steps; each attempt but a CANCELLED one recorded
  before the throw; `ledger.isDisabled` gates the socket. **The wire format is core's.** An org
  tenant reads `orgId` OFF THE INPUT; none, or not the run's org: TERMINAL `X_JOB_TENANT_MISMATCH`.

## Files

| File | Owns |
|---|---|
| `job.ts` | the `job()` primitive + registry + the handle's fluent surface + `registerJob` |
| `tenant.ts` | what tenant a run acts under: `JobTenant`, the declaration's backstop, the actor `executeJob` installs |
| `backfill.ts` | `backfill()` — a factory over `job()`: the declaration, its checksum and its input |
| `backfill-pass.ts` | one pass: the batched iteration, its cursor checkpoints and its ledger row |
| `backfill-scope.ts` | which sweeps run across tenants (`tenant: 'none'` only) |
| `backfill-ledger.ts` | `x_backfills` — the contract, `BACKFILL_STATUSES`, the checksum, the verdict, the memory ledger |
| `backfill-registry.ts` | what was DECLARED: the `origin` stamp, `isBackfill`, `registeredBackfills` |
| `backfill-gate.ts` | may this sweep run here and now — environment, `requires`, already-applied |
| `backfill-pending.ts` | declared minus completed, per environment: the alarm `--pending` reads |
| `backfill-rate.ts` | the `rate` throttle: batches/sec as an interval, and the cancellable wait |
| `backfill-inspect.ts` | the ledger projected for `x db backfill`, `x jobs`, `/_x` and MCP |
| `backfill-errors.ts` | the eight `X_BACKFILL_*` classes; the codes stay declared in `error-codes.ts` |
| `backfill-definition.ts` / `backfill-source.ts` / `backfill-reader.ts` | the declaration types; exactly one of `source`/`pages`, the `<name>:<scope>` ledger key; reading either |
| `consumer.ts` / `consumer-loop.ts` / `consumer-types.ts` | `consumer()` — a job + `.supervisor` task; one run's turns; the shapes |
| `consumer-registry.ts` / `consumer-guard.ts` / `consumer-errors.ts` | the `origin` stamp + `registeredConsumers`; the self-enqueue refusal; `X_CONSUMER_*` |
| `register.ts` | `registerJobs`/`registerTasks` over a module namespace + the registrar announcements; an `action-job` projection is `X_ACTION_JOB_UNBRIDGED` |
| `describe.ts` | the JSON projection one handle emits; `describeJobs()` is a map over it |
| `steps.ts` / `-core.ts` / `-wait.ts` / `-unwind.ts` | replay runner; shared core; `waitForEvent`; compensation |
| `steps-timeout.ts` / `steps-suspension.ts` | a step's ceiling; `StepSuspension`, `UnwindReached`, timeout marker |
| `steps-api.ts` / `steps-store.ts` / `steps-output.ts` | `StepApi`, `EventLookup`; `StepRecord`, `StepFence`, `StepStore`; what a step answers, `StepOutput` and `jsonForm` |
| `type-pins.ts` | compile-time pins for `StepOutput` and `waitForEvent` |
| `outbox.ts` | staging in a `Tx`, the store seam, the ambient `JobsFacade` slot |
| `outbox-relay.ts` | the relay: the poll timer, one pass, and its TWO shutdown hooks |
| `outbox-pg.ts` | `postgresOutboxStore` — `stage()` on the caller's OWN connection, claim on the pool |
| `outbox-lease.ts` | the claim lease's one definition and its one normalisation, for both stores |
| `leases.ts` | `LeaseStore` — fleet-wide slots, the memory one, `jobLeaseKey` |
| `concurrency.ts` | `job.concurrency` as declared, resolved once: `KeyedConcurrency`, `WhenBusy`, the declaration and key refusals |
| `errors-concurrency.ts` | every concurrency refusal's class; codes stay in `error-codes.ts` |
| `worker-key-busy.ts` | one run refused by its key: settled `failed`, body never run |
| `metrics.ts` | `queue_oldest_ready_seconds` and `queue_dead_jobs`, the two alertable gauges |
| `scheduler-pg.ts` | `postgresSchedulerState` (the durable watermark, the atomic fire) + `postgresLeaseLeader` |
| `events-pg.ts` | `postgresEventBus` — `step.waitForEvent` across processes |
| `driver.ts` | `JobDriver` contract + wire records |
| `driver-pg.ts` | default driver, and `postgresLeader` |
| `driver-pg-ddl.ts` | `SQL_JOBS_TABLE` — the ONE install point. Its comments carry no `;` and no `'` |
| `driver-pg-jobs-sql.ts` | every statement returning a whole `x_jobs` row, and `JOB_ROW_COLUMNS`; re-exported from `driver-pg-sql.ts` |
| `driver-pg-rows.ts` | a Postgres row → a wire record: `JobRow`/`StepRow`/`BackfillRow` and their mappings |
| `driver-memory.ts` / `claim-exhausted.ts` | `x dev` / tests; a buried row's log line and `onSettled` |
| `retry.ts` | the dead-letter decision, and this package's option names over core's `backoffDelay` — no curve of its own |
| `retry-classification.ts` | the other half: what the thrown error says, and the stop reason |
| `execute-unwind.ts` / `execute-ctx.ts` | a saga failed for good; caller ctx |
| `execute.ts` (+`-result.ts`) / `run-deadline.ts` | `executeJob`: one claimed job run and settled; its deadline: cancel, then fail |
| `heartbeat.ts` | one claimed job's lease: the renewal interval and the loss it reports |
| `renewal-timer.ts` | the renewal interval and its `stopped()` latch |
| `worker.ts` | `worker` role, claim round, drain |
| `worker-drain-cutoff.ts` / `worker-held.ts` / `worker-tally.ts` | drain cut-off · held claims · counters |
| `worker-admit.ts` | may this claimed job start: the limiter, the fleet slot, and the shed / refusal |
| `worker-registry.ts` | one worker's registry row: announce, heartbeat, forget |
| `worker-types.ts` | the worker's public contract: `WorkerOptions`, `WorkerStats`, `Worker` |
| `drain-wait.ts` | the drain's wait, shared by both roles |
| `worker-run.ts` | one claimed job, wired: heartbeat, slot renewal, run signal, span |
| `run-signal.ts` | the signal ONE run is cancelled by |
| `worker-fleet-slots.ts` | the fleet slot an in-flight job holds — take, renew, hand back — and the boot refusal |
| `worker-process-cap.ts` / `worker-claim-sweep.ts` | `maxInFlight`'s count; the pass's asks, rotated |
| `purge.ts` | `purge()` — a factory over `job()`: the retention sweep and its target seam |
| `task.ts` | the `task()` primitive + registry + the handle's surface + `registerTask` |
| `scheduler.ts` | `scheduler` role: the dispatch round, catch-up, leader election, the drain |
| `limits.ts` | per-tenant / per-queue / global concurrency + rate |
| `events.ts` | stored event bus for `step.waitForEvent` |
| `inspect.ts` | `--json` introspection. `operatorInput`: no registered handle gives `[redacted]` whole; otherwise `redactInput(maskSensitive(handle.input, …))` |
| `inspect-operator.ts` | the verbs `x jobs` binds: remove, promote, pause, resume |
| `introspection.ts` | `JobIntrospection`, every operator type, and the bounds |
| `counters.ts` | bucket arithmetic, `nackOutcome`, the memory counters |
| `driver-memory-operator.ts` / `driver-pg-operator.ts` | each driver's operator members |
| `driver-pg-operator-sql.ts` / `driver-pg-settle-sql.ts` | their statements; `SQL_ACK` / `SQL_NACK` with the counter |
| `progress.ts` / `settled.ts` / `redact-input.ts` | the progress throttle; the `onSettled` runner; a payload as an operator reads it |
| `scheduler-state.ts` | `SchedulerState`, `fire`, the memory watermark |
| `scheduler-leader.ts` / `scheduler-occurrences.ts` | `LeaderElection` + `soleLeader`; which occurrences fall in a window |
| `idle-backoff.ts` / `enqueue-signal.ts` | the wait both polling loops share; the two wake signals and `wakeIsLive` |
| `queue-wake.ts` / `driver-pg-wake-sql.ts` | the `LISTEN` session and its proof; which statement notifies |
| `worker-loop.ts` | the claim loop's timer: wake, `again`, the kicks |
| `driver-pg-outbox-sql.ts` | the `x_outbox` statements |
| `errors-operator.ts` / `errors-requeue.ts` | the operator verbs' refusals; `requeue`'s |
| `errors-tenant.ts` | `JobTenantMismatchError` |
| `errors-steps.ts` / `errors-saga.ts` / `step-resolve.ts` | step, saga + `once` refusals; `resolveStep` |
| `worker-queue-demand.ts` | the `queue_demand` gauge: `driver.demand()`, skipped when `stats()` shows no work, retracted to 0 at the drain |
| `driver-pg-demand-sql.ts` | `QUEUE_DEMAND_ROWS` and `SQL_QUEUE_DEMAND`; the scaler fixture's `SQL_SCALER_DEMAND` reads the same predicate |
| `driver-pg-claim-sql.ts` | `SQL_CLAIM` and why it seeks; re-exported from `driver-pg-sql.ts` |
| `error-codes.ts` / `errors.ts` | codes, titles, their registration (`new-error-code` writes here) / the classes |
| `job-enqueue-many.ts` / `enqueue-record.ts` / `driver-pg-enqueue-many.ts` | `enqueueMany`, `MAX_ENQUEUE_BATCH`, `ENQUEUE_CHUNK`; one enqueue's row, every path; `SQL_ENQUEUE_MANY` + resolve |
| `import.ts` / `import-pass.ts` | `importRows()`: the declaration; one pass, its byte-offset checkpoints, the error report |
| `import-format.ts` / `import-source.ts` / `import-errors.ts` | record boundaries on bytes; the `ImportSource` seam; the `X_IMPORT_*` classes |
| `driver-redis-refusal.ts` | `typedRefusals`: a send refused for want of a connection → `X_DRIVER_UNAVAILABLE` |
| `subject*.ts` | `subjectExport`/`subjectErase`; reach only via DELETED tables (README) |
| `webhook-receiver.ts` / `-route.ts` / `-types.ts` / `-errors.ts` | `webhookReceiver()` and `webhookReceiverRoutes`; the route; `ReceivedEvent`, `WebhookInbound`; its three refusals |

Commands: `bun test packages/jobs` · `bun run --filter @ultimat3/jobs typecheck`. Test harnesses:
history, "Moved 2026-10-01 — test harnesses".

Why each rule above is shaped the way it is: [`docs/history/jobs.md`](../../docs/history/jobs.md).
