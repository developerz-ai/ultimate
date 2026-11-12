# @ultimat3/jobs — agent notes

Tier 3. The `job` + `task` primitives, durable steps, transactional outbox, queue drivers.
A rule or row marked `†` has its full text in [`docs/history/jobs-rules.md`](../../docs/history/jobs-rules.md).

## Boundary

- May import: `core`, `schema`, `entity`, `policy`, `cache`, `time` — and `db`, for
  `expectedQueryLoop` (`steps.ts`, the per-step write to the N+1 detector), `outsideTransaction`
  (`execute.ts`), `currentTx` (`events-pg.ts`), `refuseAbandoned` (`outbox.ts`) and
  `withTransaction` (`consumer-loop.ts`: a batch and its cursor commit together) — a client is
  taken from it in ONE place, the ambient `db()`. Never `render`, `ui`. `http` only from `webhook-receiver*.ts`, for the route
  (`Route`/`Bucket` types, `DEFAULT_WEBHOOK_BODY_LIMIT`, `HttpError`, `jsonResponse`).
- Consumers: `action` (`<job>.enqueue`, via the ambient jobs facade), `cli`, `mcp`, `admin`.
- **Installers are on `@ultimat3/jobs/adapter`, never the `.` barrel** (`adapter.test.ts`):
  `installJobDriver`/`installEventBus` + resets, the port interfaces, the errors a driver throws.
  An app swaps a port in `apps/<app>/runtime.ts`; a `fix:` names that line, never an installer.
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
  `src/index.ts`, and there is no `./loader` subpath (action's and query's have one, for `x`'s
  module scan): jobs and tasks reach their registries only through core's registrar table. `register.ts` announces the registrars in core's table at import — never remove it
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
- **`ack`, `nack`, `heartbeat`, `recordProgress` are FENCED on `running` AND the claim**
  (`claimOf(claimed)`); read `heartbeat` as `held === false`. †
- **A driver's semantics are pinned beside the pg statement** (`driver-parity*.test.ts`);
  `driver-*-fixture.ts` scenarios run on memory AND Postgres.
- **The claim BURIES a lease that lapsed on the final attempt** (`dead`, or `failed` under
  `dropExhausted`); the worker calls `announceExhausted`. †
- **`cancel` is fenced on `LIVE_STATES`.** **`requeue`** refuses (`X_JOB_NOT_FOUND`, not requeueable,
  duplicate), then ONE statement. **`enqueue` inserts twice at most.** **`BulkResult.remaining` is
  what a second call would move.**
- **`enqueueMany` is one statement per `ENQUEUE_CHUNK` (1,000)**; `JobDriver.enqueueMany` is
  REQUIRED; every refusal precedes the first write. †
- **No read returns a WHOLE row** — `driver-pg-sql.test.ts` scans every production file here
  (discovered, comments stripped) for `select *`/`returning *`.
- Drivers: `JobDriver` + optional `introspect`/`backfills`/`leases`; `redisJobDriver`
  (`@ultimat3/jobs/redis`) is one Lua script per operation — a change lands in memory, pg AND Lua. †
- **`demand` is the seventh method, required**; a draining worker's `queue_demand` goes to 0.
- **The claim SEEKS** (`SQL_CLAIM`); correct only because a claim autocommits. It hands each row its steps; an IDLE loop's claim (`SQL_CLAIM_IDLE`, `onEmpty`) also says when the next row is due, and the loop rests on it, ≤ 60 s, in 2 s slices that re-read the wake (`worker-idle.test.ts`).
- Step results are persisted BEFORE the step returns, and it returns what it persisted: `jsonForm` (`steps-output.ts`), typed `StepOutput<T>`, one stringify + parse per EXECUTED step. Full rule: `docs/history/jobs.md`.
- A `step.run` output past a DECLARED `stepOutputMax` (JSON bytes) is `X_STEP_OUTPUT_TOO_LARGE`, terminal. Undeclared, past `STEP_OUTPUT_MAX_BYTES` (256 KiB) it is logged once per job and step (`jobs.step.output-too-large`, same code) and stored — refusal by default waits for `next`. A waited event is not measured — its payload is the publisher's.
- **`postgresLeader` is correct only on a DEDICATED connection**; boot uses `postgresLeaseLeader`.
- **Debounce, expiry, backlog are driver contract** (`job-driver-checks-enqueue.ts`,
  `-debounce.ts`, all three drivers): `onConflict: 'replace'` is its own statement
  (`SQL_ENQUEUE_REPLACE`), fenced by request order (`debounced_id`, the request's uuidV7 — a repeat
  publish never restores old input or starts a stale run); the claim settles an expired NEVER-CLAIMED
  row (`attempt = 0`) `failed`/`JOB_EXPIRED`; a requeue clears expiry and `settle_owed`;
  `backlog(queue, cap)` counts no further than `cap`, `holds` probes a key once full. Refused in any
  batch (`assertEnqueueMany`).
- **Redis scripts go by `EVALSHA`** (`driver-redis-eval.ts`): `EVAL` only on `NOSCRIPT`.

## Rules — numbers and limits

- **Every numeric knob is refused when not FINITE** (`finiteOption()`, `finiteCount()`, read in `worker-options.ts`); `bun run finite-bounds` is a floor. Full rule: `docs/history/jobs.md`.
- **`WorkerOptions.concurrency` is read by OWN key** (`worker-slots.test.ts`); `maxInFlight` BEFORE
  the claim, its count back with the lease, before the `kick` (history).
- **`job.concurrency` is enforced by `JobDriver.leases`** (one row per held slot in `x_job_leases`);
  `limits.ts` is the per-process fast path. No lease store + a declared `concurrency` makes `start()`
  throw `X_JOB_CONCURRENCY_UNENFORCEABLE`.
- **`concurrency` is resolved ONCE** (`concurrency.ts`): a number, or `{ key, limit, whenBusy }` per key. Full rule: `docs/history/jobs.md`.
- **`whenBusy: 'fail'` refuses only on EVIDENCE another run holds the key**
  (`LeaseStore.holders`); settled `failed`, outcome `refused`. †
- **A key underivable at claim is `SlotGrant` `undecidable`** → `executeJob({ refusal })`: the
  ATTEMPT fails, never the round.
- **`finalAttempt` is `isFinalAttempt(handle.retry, attempt)`**, REQUIRED on `JobRunArgs`.

## Rules — the worker and the scheduler

- **One enqueue implementation**: `jobsFacade()` owns `enqueue` AND `enqueueMany`, over
  `enqueue-record.ts`'s row builders; the only other `driver.enqueue` sites are the outbox relay and
  the scheduler. `handle.as(actor, input)` QUEUES; `executeJob` is the one execution path.
- The scheduler's key is occurrence-scoped (`task:occurrenceMs:jobKey`); `task.enqueue()` uses the
  job's plain key.
- **TWO shutdown hooks per worker, one per PHASE**: `accept` is `stopAccepting()` (flip state, clear
  the poll timer, arm the cut-off; aborts nothing); `close` is the teardown. `stop()` releases both
  in a `finally`; `start()` refuses while draining.
- **A claimed job is counted with core's `beginWork()`**: the drain's in-flight phase waits. The
  teardown's wait is bounded on SIGTERM (`drain-wait.ts`), unbounded on `stop()`; one teardown, joined.
- **A deploy lets a running job FINISH**: SIGTERM only stops claiming; `X_DRAINING` at
  `deadlineAt − margin`; settles `interrupted`. †
- **`X_RATE_LIMITED` defers uncounted** (`rateLimitDeferralMs`).
- **The drain waits out the claim round it races** — `tick()` registers its round in `rounds`
  synchronously with its guard.
- **A fleet slot is HELD, not owned**: a lost one CANCELS the run (`X_JOB_SLOT_LOST`). †
- **The run's signal is a controller this worker owns** (`run-signal.ts`).
- **A lease is HELD, not owned** (`heartbeat.ts`): a whole window without a renewal is
  `jobs.lease.lost`. †
- **A renewal is decided against `stopped()`** (`renewal-timer.ts`, re-read after every await); the
  interval is `unref`ed; every renewal is armed through `WorkerOptions.schedule`.
- **Settlement is not part of the retry decision**: `driver.ack` sits after the `try`.
- **The retry decision reads the ERROR, on core's backoff curve** (`retry-classification.ts`,
  `backoffDelayMs`): `docs/history/jobs.md`, "Moved 2026-10-01 — retry and bounds".
- **The claim loop re-arms on the PASS, never the jobs**; `tick()` resolves with that pass's executions.
- **A FULL pass marks a backlog**: the next freed slot claims at once (`worker-backlog.test.ts`).
- **The scheduler runs one dispatch round at a time**; `stop()` waits it out before `leader.release()`. Full rule: `docs/history/jobs.md`.
- **`run-once` fires ONE catch-up**: the watermark rides the fire (`ScheduledFire.watermarkMs`),
  never a `markFired` behind it; `skip` fires the latest missed occurrence (`latestOccurrenceBy`).
- **A lease for a run that never STARTED is `abandon()`ed, never `release()`d**; a failed pass
  re-arms at the floor. †
- **Every timer body catches before it finalises.**
- Cancellation, deadlines, `traceparent`, suspension vs shed, wiring throws:
  `docs/history/jobs-worker-cancellation.md` (moved 2026-11-09).
- **`step.run` hydrates from ONE `store.list(runId)`**; `claimName` reads a Set. †

## Rules — long form in `docs/history/jobs.md`

- "Moved out 2026-11-03": operator verbs on BOTH drivers; an idle round touches no store.
- "Moved out 2026-11-06": `demand` with no worker registry; how the claim seeks.
- "Moved out 2026-11-07": `cancelJob`'s refusals; why a completed attempt's signal stays live.
- "Plan 101 wave 6c": compensate ONLY failed for good; `once` writes `started` BEFORE `fn`; a
  waking publish is ONE statement; payload org = enqueue org (`X_JOB_TENANT_MISMATCH`).

## Rules — the outbox

Long form: `docs/history/jobs.md`, "Moved 2026-10-01 — the outbox".

- **The relay drains in two phases**; `relay.stop()` JOINS the pass in flight. †
- **The claim is a LEASE in one statement**, fenced on every mutation (`and claimed_by = $n`);
  `claimLeaseMs` is normalised in `outbox-lease.ts`. `outbox-claim.test.ts` pins both stores.
- **The memory outbox store DELETES a published row** (`retained()` is the seam).
- **A staged row's id IS its job's id; its `runId` is allocated at stage**; a repeated publish is
  `deduped`. †
- **The relay publishes a batch in two statements** (`publishBatch`); a failure falls back to the
  row loop. †

## Rules — factories over `job()`

Long form: [`docs/history/jobs.md`](../../docs/history/jobs.md), "Moved 2026-10-01 — factories".

- **`backfill()`**: a step persists the CURSOR, never the page; **`handle` is AT LEAST ONCE**. Full rule: `docs/history/jobs.md`.
- **The ledger says what RAN, the registry what EXISTS, `backfill-pending.ts` is the diff**;
  `inspectBackfills()` is the ONE projection. †
- **`rollup()`/`refreshView()`**: ONE `upsertAll`; `rollup.job.test.ts`.
- **`purge()`** is the one caller of every `purgeExpired()`: one table per `step.run`, one clock
  reading per pass, duplicate names refused.
- **`exportRows()`**: one object per PAGE, named by page index; NO cross-tenant escape.
- **`importRows()`**: one step per PAGE, checkpointed at the BYTE OFFSET; AT LEAST ONCE per page;
  no cross-tenant escape. †
- **`webhookReceiver()`**: read under `maxBytes`, `verify` before any parse, the enqueue before the
  ack (503 otherwise); `webhookReceiverRoutes()` is what the boots mount. †
- **`cronJob()`**: `job()` + `task()` from one declaration, `.schedule` named `<name>.schedule`;
  `name` required (the scheduler keys the task by it), `input` only with `payload`.
- **`webhook()`**: ONE event to ONE endpoint; core's wire format; tenant from the input, else
  terminal `X_JOB_TENANT_MISMATCH`. †

## Files

| File | Owns |
|---|---|
| `job.ts` | the `job()` primitive + registry + the handle's fluent surface + `registerJob` |
| `tenant.ts` | what tenant a run acts under: `JobTenant`, the declaration's backstop, the actor `executeJob` installs |
| `backfill.ts` | `backfill()` — a factory over `job()`: the declaration, its checksum and its input |
| `backfill-*.ts` | one pass + cursor checkpoints, cross-tenant scope, the `x_backfills` ledger, the declared registry, the gate, pending, rate, the `inspectBackfills` projection, `X_BACKFILL_*` classes, declaration/source/reader † |
| `cron-job.ts` | `cronJob()` — a job + its `.schedule` task from one declaration |
| `consumer.ts` / `consumer-loop.ts` / `consumer-types.ts` | `consumer()` — a job + `.supervisor` task; one run's turns; the shapes |
| `consumer-registry.ts` / `-guard.ts` / `-errors.ts` | the `origin` stamp + `registeredConsumers`; the self-enqueue refusal; `X_CONSUMER_*` |
| `register.ts` | `registerJobs`/`registerTasks` over a module namespace + the registrar announcements; an `action-job` projection is `X_ACTION_JOB_UNBRIDGED` |
| `describe.ts` | one handle's JSON projection; `describeJobs()` maps it |
| `steps.ts` / `-core.ts` / `-wait.ts` / `-unwind.ts` / `step-scope.ts` | replay runner; core; `waitForEvent`; compensation; `currentStep()` |
| `steps-timeout.ts` / `-suspension.ts` | a step's ceiling; `StepSuspension`, `UnwindReached`, timeout marker |
| `steps-api.ts` / `-store.ts` / `-output.ts` | `StepApi`, `EventLookup`; `StepRecord`, `StepFence`, `StepStore`; what a step answers, `StepOutput` and `jsonForm` |
| `type-pins.ts` | compile-time pins for `StepOutput` and `waitForEvent` |
| `outbox.ts` | staging in a `Tx`, the store seam, the ambient `JobsFacade` slot |
| `outbox-relay.ts` | the relay: the poll timer, one pass, and its TWO shutdown hooks |
| `outbox-pg.ts` | `postgresOutboxStore` — `stage()` on the caller's OWN connection, claim on the pool |
| `outbox-lease.ts` | the claim lease's one definition and its one normalisation, for both stores |
| `leases.ts` | `LeaseStore` — fleet-wide slots, the memory one, `jobLeaseKey` |
| `concurrency.ts` | `job.concurrency` resolved once: `KeyedConcurrency`, `WhenBusy`, the declaration and key refusals |
| `errors-concurrency.ts` | every concurrency refusal's class; codes stay in `error-codes.ts` |
| `worker-key-busy.ts` | one run refused by its key: settled `failed`, body never run |
| `metrics.ts` | `queue_oldest_ready_seconds` and `queue_dead_jobs`, the two alertable gauges |
| `scheduler-pg.ts` | `postgresSchedulerState` (the durable watermark, the atomic fire) + `postgresLeaseLeader` |
| `events-pg.ts` | `postgresEventBus` — `step.waitForEvent` across processes |
| `driver.ts` | `JobDriver` contract + wire records |
| `driver-pg.ts` | default driver, and `postgresLeader` |
| `driver-pg-ddl.ts` | `SQL_JOBS_TABLE` — the ONE install point — and `JOBS_TABLE_STORAGE` (fillfactor 80, exported for the framework schema's drift check). Its comments carry no `;` and no `'` |
| `driver-pg-rows.ts` | a Postgres row → a wire record: `JobRow`/`StepRow`/`BackfillRow` and their mappings |
| `driver-memory.ts` / `claim-exhausted.ts` | `x dev` / tests; a buried row's log line and `onSettled` |
| `retry.ts` | the dead-letter decision; this package's option names over core's `backoffDelay`, no curve |
| `retry-classification.ts` | the other half: what the thrown error says, and the stop reason |
| `retry-jitter.ts` | `retry.jitter` refused at `job()` unless a `JitterMode` (a v30 boolean names its mapping) |
| `execute-unwind.ts` / `execute-ctx.ts` | a saga failed for good; caller ctx |
| `execute.ts` (+`-result.ts`) / `run-deadline.ts` | `executeJob`: one claimed job run and settled; its deadline: cancel, then fail |
| `heartbeat.ts` / `job-lease.ts` | one claimed job's lease: the renewal interval and the loss it reports; `args.lease`, the body's view of it |
| `renewal-timer.ts` | the renewal interval and its `stopped()` latch |
| `worker.ts` | `worker` role, claim round, drain |
| `worker-drain-cutoff.ts` / `-held.ts` / `-tally.ts` | drain cut-off · held claims · counters |
| `worker-admit.ts` | may this claimed job start: the limiter, the fleet slot, and the shed / refusal |
| `worker-registry.ts` | one worker's registry row: announce, renew (narrow unless held ids or drain moved), forget |
| `worker-types.ts` | the worker's contract: `WorkerOptions`, `WorkerStats`, `Worker` |
| `drain-wait.ts` | the drain's wait, shared by both roles |
| `worker-run.ts` | one claimed job: heartbeat, slot renewal, run signal, consumer span, `job.perform` |
| `job-instrument.ts` | the producer span + `job.enqueue` per handle enqueue; both spans' attributes |
| `run-signal.ts` | the signal ONE run is cancelled by |
| `worker-fleet-slots.ts` | an in-flight job's fleet slot: take, renew, hand back; the boot refusal |
| `worker-process-cap.ts` / `worker-claim-sweep.ts` | `maxInFlight`'s count; the pass's asks, rotated |
| `purge.ts` | `purge()` — a factory over `job()`: the retention sweep and its target seam |
| `task.ts` | the `task()` primitive + registry + the handle's surface + `registerTask` |
| `scheduler.ts` | `scheduler` role: the dispatch round, catch-up, leader election, the drain |
| `limits.ts` | per-tenant / per-queue / global concurrency + rate |
| `events.ts` / `-cursor.ts` | memory bus; the wait cursor, both buses |
| `inspect.ts` | `--json` introspection. `operatorInput`: no registered handle gives `[redacted]` whole; otherwise `redactInput(maskSensitive(handle.input, …))` |
| `inspect-operator.ts` | the verbs `x jobs` binds: remove, promote, pause, resume |
| `introspection.ts` | `JobIntrospection`, every operator type, and the bounds |
| `counters.ts` / `counter-batch.ts` | bucket arithmetic, `nackOutcome`, the memory counters; the pg driver's per-process batch, flushed every 10 s and on close |
| `driver-memory-operator.ts` / `driver-pg-operator.ts` | each driver's operator members |
| `progress.ts` / `settled.ts` / `redact-input.ts` | the progress throttle; the `onSettled` runner; a payload as an operator reads it |
| `settled-types.ts` / `driver-settle.ts` / `settle-redrive.ts` / `scheduler-upkeep.ts` | what `onSettled` is handed; the settle fence and the `onSettled` debt contract; the leader's re-drive of lost debts; the leader's cadence (counter fold, re-drive) |
| `driver-memory-settle.ts` / `driver-pg-settle-debt.ts` / `driver-redis-settle.ts` | the `onSettled` debt per driver: a map, `x_jobs.settle_owed`, the `owed` ZSET — held equal by `@ultimat3/testing`'s `SETTLE_DEBT_CHECKS` |
| `scheduler-state.ts` | `SchedulerState`, `fire`, the memory watermark |
| `scheduler-leader.ts` / `scheduler-occurrences.ts` | `LeaderElection` + `soleLeader`; which occurrences fall in a window |
| `idle-backoff.ts` / `enqueue-signal.ts` | the wait both polling loops share, and the rest (`restAfter`); the two wake signals and `wakeIsLive` |
| `queue-wake.ts` / `driver-pg-wake-sql.ts` | the `LISTEN` session and its proof; which statement notifies |
| `worker-loop.ts` | the claim loop's timer: wake, `again`, the kicks |
| `errors-operator.ts` / `errors-requeue.ts` | the operator verbs' refusals; `requeue`'s |
| `errors-tenant.ts` | `JobTenantMismatchError` |
| `errors-steps.ts` / `errors-saga.ts` / `step-resolve.ts` | step, saga + `once` refusals; `resolveStep` |
| `worker-queue-demand.ts` | the `queue_demand` gauge: `driver.demand()`, skipped on no work, 0 at the drain |
| `driver-pg-*-sql.ts` | one file per statement family: jobs rows (`JOB_ROW_COLUMNS`), operator, settle (`SQL_ACK`/`SQL_NACK`), outbox, demand (`SQL_QUEUE_DEMAND`) † |
| `driver-pg-claim-sql.ts` | `SQL_CLAIM` and why it seeks, `SQL_CLAIM_IDLE`, `pgClaim` (which one, its three kinds of answer row); `SQL_CLAIM` re-exported from `driver-pg-sql.ts` |
| `error-codes.ts` / `errors.ts` | codes, titles, their registration (`new-error-code` writes here) / the classes |
| `job-enqueue-many.ts` / `enqueue-record.ts` / `driver-pg-enqueue-many.ts` | `enqueueMany`, `MAX_ENQUEUE_BATCH`, `ENQUEUE_CHUNK`; one enqueue's row, every path; `SQL_ENQUEUE_MANY` + resolve |
| `import.ts` / `import-pass.ts` | `importRows()`: the declaration; one pass, its byte-offset checkpoints, the error report |
| `import-format.ts` / `-source.ts` / `-errors.ts` | record boundaries on bytes; the `ImportSource` seam; the `X_IMPORT_*` classes |
| `driver-redis-refusal.ts` | `typedRefusals`: a send refused for want of a connection → `X_DRIVER_UNAVAILABLE` |
| `driver-redis-eval.ts` | `evalCached`: a script by SHA-1, `EVAL` on `NOSCRIPT` |
| `driver-memory-enqueue.ts` / `driver-pg-enqueue-sql.ts` | the memory driver's enqueue, expiry and backlog; `SQL_ENQUEUE`, `SQL_ENQUEUE_REPLACE`, `SQL_BACKLOG` |
| `enqueue-backlog.ts` | `job({ maxPending })`'s refusal at enqueue, `JobBacklogFullError` (`X_JOB_BACKLOG_FULL`, 429); the per-transaction ledger of staged keys |
| `subject*.ts` | `subjectExport`/`subjectErase`; reach only via DELETED tables (README) |
| `gdpr-*.ts` | `.personalData()` coverage (thrown by `plannedSubject`, listed by `x exercise`); the erase's audit record |
| `ledger*.ts` | `ledger()`: balanced per currency, ONE step; a key is one posting per tenant, re-used with other lines `X_LEDGER_POSTING_CONFLICT` |
| `lock*.ts` | `withLock`: one `lock:<key>` slot; token = the store's `fence`; renewal as `worker-fleet-slots.ts` |
| `reindex.ts` | `reindex()`: a `backfill()` into the `searchIndex` port via `searchDocumentOf` |
| `partitions.ts` | `partitions()` + `.schedule`: db's `partitionMaintenance` per partitioned entity, job clock; `isPartitionsJob` (by identity — a `cronJob()` has the same shape) |
| `webhook-receiver.ts` / `-route.ts` / `-types.ts` / `-errors.ts` | `webhookReceiver()` and `webhookReceiverRoutes`; the route; `ReceivedEvent`, `WebhookInbound`; its three refusals |

Commands: `bun test ./packages/jobs/` · `bun run --filter @ultimat3/jobs typecheck`. Test harnesses:
history, "Moved 2026-10-01 — test harnesses".

Why: [`docs/history/jobs.md`](../../docs/history/jobs.md).
