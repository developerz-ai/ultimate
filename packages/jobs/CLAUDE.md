# @ultimat3/jobs — agent notes

Tier 3. The `job` + `task` primitives, durable steps, transactional outbox, queue drivers.

## Boundary

- May import: `core`, `schema`, `entity`, `policy`, `cache`, `time` — and `db`, for
  `expectedQueryLoop` ONLY: `steps.ts` declares the per-step write one-per-step to the N+1
  detector there, and no client is ever taken from it. Never `http`, `render`, `ui`.
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
- **JOBS DECLARE THEIR TENANT, and `executeJob` INSTALLS the context — do not re-litigate.**
  `tenant` is REQUIRED (`(input) => input.orgId` or `'none'`; `X_JOB_TENANT_REQUIRED` backstop).
  `executeJob` puts the derived org on the ctx's actor (`jobRunActor`, org only) and runs the body in
  `runWithContext`; `'none'` STRIPS the org (fail-closed).
  `tenantFor` is a METHOD on `JobHandle` (variance). The queue row's `tenantId` stays the ENQUEUER's
  (the limiter's bucket). `tenancy-cross-surface.test.ts` asserts HTTP and job verdicts are EQUAL.
- **`enqueuedBy` is ATTRIBUTION, never authority** — do not re-litigate. A job acting FOR a user takes
  the user's id in its input and re-authorises it in the body.
- `tz` is NON-OPTIONAL in `TaskDefinition`, validated by `@ultimat3/time`'s `isValidTimeZone`. A task
  never contains a handler body.
- **`stepTimeout` and `eventPoll` are declared on the job**, forwarded only by `execute.ts`, refused at
  declaration when non-positive.
- `registeredJobs()`/`registeredTasks()` sort by CODE UNITS (they reach `x.manifest.json`).
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim** (`index.test.ts`).

## Rules — the driver and SQL

- **`SQL_JOBS_TABLE` is the ONE install point** for every durable table (`x_jobs`, `x_job_*`, `x_backfills`,
  `x_outbox`, `x_scheduler_*`). A NEW table is also a name in
  `packages/cli/src/framework-schema.ts`. A shipped table grows by `alter table ... add column if
  not exists`. Its comments carry NO apostrophes and NO semicolons (it splits on `;`; `driver-pg-sql.test.ts` checks
  quote parity).
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
- **No read returns a WHOLE row** — `driver-pg-sql.test.ts` scans every production file here
  (discovered, comments stripped) for `select *`/`returning *`.
- Drivers implement the six `JobDriver` methods plus optional `introspect`, `backfills`, `leases`. New
  capabilities go behind the interface. `inspect.ts` returns plain JSON for CLI, `/_x` and MCP.
- Step results are persisted BEFORE the step returns. All time is epoch ms (`nowMs()`, `clock.ts`).
- **`postgresLeader` is correct only on a DEDICATED connection**; boot uses `postgresLeaseLeader`.

## Rules — numbers and limits

- **Every numeric knob is refused when not FINITE** — core's `finiteOption()` (a bound) and
  `finiteCount()` (a count, caller's minimum); `worker-options.ts` is where `createWorker` reads them.
  **`bun run finite-bounds` is a floor, never proof**: `createLimiter`'s five numbers are screened
  with min 0 (zero is a HARD STOP). **A row count is `finiteCount` (min 0)**; `retry.attempts` is one with min 1.
- **`WorkerOptions.concurrency` is read by OWN key** — a queue named `constructor`
  (`worker-slots.test.ts`).
- **`job.concurrency` is enforced by `JobDriver.leases`** (one row per held slot in `x_job_leases`);
  `limits.ts` is the per-process fast path. No lease store + a declared `concurrency` makes `start()`
  throw `X_JOB_CONCURRENCY_UNENFORCEABLE`.
- **`concurrency` is resolved ONCE** (`concurrency.ts`): a number, or `{ key, limit, whenBusy }` per
  key. The handle carries `concurrency` (the limit), `whenBusy` (set exactly when keyed) and
  `concurrencyKeyFor()` — a METHOD. Lease key `job-key:<encoded name>:<key>`; plain `job:<name>`.
  A bad cap is `X_JOB_DECLARATION_INVALID`.
- **`whenBusy: 'fail'` refuses only on EVIDENCE another run holds the key** (`LeaseStore.holders`,
  required): a run meets its own leftover slot. The refusal is `nack({ fail, countsAsAttempt:
  false })` → `failed`, outcome `refused` (`worker-key-busy.ts`), never `executeJob`.
- **A key underivable at claim is `SlotGrant` `undecidable`** → `executeJob({ refusal })`: the
  ATTEMPT fails, never the round.
- **`finalAttempt` is `isFinalAttempt(handle.retry, attempt)`**, REQUIRED on `JobRunArgs`.

## Rules — the worker and the scheduler

- **One enqueue implementation**: `jobsFacade()`; the only other `driver.enqueue` sites are the outbox
  relay and the scheduler. `handle.as(actor, input)` QUEUES; `executeJob` is the one execution path.
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
- **The run's signal is a controller this worker owns** (`run-signal.ts`), never `AbortSignal.any`.
- **A lease is HELD, not owned** (`heartbeat.ts`): one failed renewal warns; a whole window without
  one landing is `jobs.lease.lost`, on this process's clock, asked both sides of the call.
- **A renewal is decided against `stopped()`** (`renewal-timer.ts`, re-read after every await); the
  interval is `unref`ed; every renewal is armed through `WorkerOptions.schedule`.
- **Settlement is not part of the retry decision**: `driver.ack` sits after the `try`.
- **The retry decision reads the ERROR, on core's backoff curve** (`retry-classification.ts`,
  `backoffDelayMs`): `docs/history/jobs.md`, "Moved 2026-10-01 — retry and bounds".
- **The claim loop re-arms on the PASS, never the jobs**; `tick()` resolves with that pass's executions.
- **A deadline CANCELS, then fails the attempt**, never the reverse (`raceTimeout`, `withStepTimeout`);
  the attempt is cancelled in `executeJob`'s `finally`.
- **A cancelled runner writes NOTHING** — `put()` in `steps.ts` (`X_ABORTED`) — save a fenced
  `X_DRAINING` on a live attempt: a step done in the drain is recorded once. The STORE fences
  the claim (`StepFence`, `SQL_STEP_PUT` as `SQL_ACK`: `X_JOB_LEASE_LOST`). `executeJob` passes it.
- **`traceparent` is stamped at ENQUEUE time, in `outbox.ts`**, and an empty `spanId` sends none.
- **The scheduler runs one dispatch round at a time**; every other `tick()` joins it; `stop()` waits it
  out before `leader.release()`. Same two-hook rule; an ABANDONED round does not release
  (`jobs.scheduler.drain-abandoned`). `stillLeading()` is asked every round and before every task,
  and answers from memory inside `renewEveryMs`.
- **`run-once` fires ONE catch-up**: the watermark rides the fire (`ScheduledFire.watermarkMs`,
  `SQL_SCHEDULER_FIRE` `$4`), never a `markFired` behind it; `skip` fires the true latest missed
  occurrence (`latestOccurrenceBy`, bisection).
- **A lease for a run that never STARTED is `abandon()`ed, never `release()`d** — the rate stamp
  goes with it (`worker-admit.ts`). **A failed pass re-arms at the floor** (`worker-loop.ts`
  catch); `timers` is the test seam.
- **Every timer body catches before it finalises** (`void work().catch(log).finally(...)`).
- **Suspension is control flow, and a SHED is not a suspension**: `StepSuspension` →
  `nack({ countsAsAttempt: false, park: true })`; a shed is `countsAsAttempt: false` without `park`,
  stays `ready`, logs `jobs.worker.shed` (no `last_error`). `driver-parity.test.ts`.
- **A wiring throw hands back the run's holdings, and its ROW until `executeJob` starts**
  (`worker-run.ts`), as a failed shed does its job (`worker-admit.ts`).
- **`step.run` hydrates the run's steps from ONE `store.list(runId)`**; `sleep` and `waitForEvent`
  record replays through `trace()`. **`claimName` reads a Set**; `usedNames()` keeps
  `MAX_TRACE_NAMES` (200).
- **`x jobs cancel` binds to `cancelJob(driver, id, reason?)`, which refuses** a finished job or a
  driver with no `cancel` (`X_JOB_NOT_CANCELLABLE`).

## Rules — the operator surface

- **Every operator capability is a member of `JobIntrospection`** (`introspection.ts`), implemented
  by BOTH drivers, bounds as constants beside it; `operator-surface*-fixture.ts` is their parity
  suite (memory + real pg).
- **A settle answers whether it landed**; a miss is `jobs.settle.unowned`, not a throw.
- **The counter moves in the SETTLING statement** (`driver-pg-settle-sql.ts`): one-minute bucket per
  job name; `nackOutcome()` decides what a nack adds (a shed, a suspension, a drain: nothing), and
  `ack({ counted: false })` — `x jobs drain` — adds nothing. The scheduler leader folds tiers
  (`rollupCounters`), at most once a bucket.
- **`list()` is KEYSET** (`after: jobCursor(lastRow)`, newest first by `(created_at, id)`); the pg
  seek reads the cursor row's own `created_at` — the cursor's ms is rounded. A page past
  `MAX_JOB_PAGE` or a foreign cursor is `X_JOB_PAGE_INVALID`, never a bare invariant.
- **`taskFires()` is the last occurrence that DISPATCHED**, never the watermark (arming and skipping
  move that): `SQL_SCHEDULER_FIRE` writes it, `fireThroughDriver` calls `recordTaskFire`.
- **A pause is a ROW the claim reads** (`x_job_pauses`, `not exists` in `SQL_CLAIM`), never a column
  on `x_jobs`. A paused TASK keeps its watermark, so resume is its own `catchUp`.
- **An occurrence fires in ONE statement** (`SchedulerState.fire`, `SQL_SCHEDULER_FIRE`): the
  watermark is the fence, jobs insert only `where exists (select 1 from moved)`.
- **`progress()` is throttled in `progress.ts`** and flushed before every settle. **`onSettled`
  (`settled.ts`) is the ONE ending hook** — `completed`, `dead-lettered`, `dropped`, `refused` —
  AFTER a settle that LANDED, in the body's tenant scope, `ON_SETTLED_ATTEMPTS` tries, never
  rethrown, at most once across a crash. Never for a cancel, a retry or a suspension.
- **Failed for good + `deadLetter: false` is DROPPED**: `nack({ fail })`, outcome `dropped`.
- **Worker registry rows expire** (`worker-registry.ts`, TTL = visibility timeout); `stop()` forgets.

## Rules — idle cost and the wake

Long form: `docs/history/jobs.md`, "the cross-process wake".

- **An idle round touches no store.** The scheduler keeps each watermark and its next occurrence in
  memory while it leads (`known`), trusts a lease for `LeaderElection.renewEveryMs`, reads the pause
  table only when a task is DUE, and folds counters every `COUNTER_ROLLUP_INTERVAL_MS`. What makes
  the trust safe is the fire statement's watermark fence, never the lease.
- **The worker and the relay back off** (`idle-backoff.ts`): floor → doubling → the ceiling, 2 s, or
  5 s while `wakeIsLive()`. An idle worker pass is ONE claim over every queue with a free slot.
- **The poll is the guarantee, the wake an optimisation.** `startQueueWake` holds one `LISTEN`
  session and raises `enqueue-signal.ts`'s two signals; it is live only once a probe has crossed
  BOTH channels, and un-proven on every re-dial — a transaction-pooling proxy resolves a `LISTEN`
  and delivers nothing.
- **A statement decides whether it notifies** (`driver-pg-wake-sql.ts`): once per queue per
  `WAKE_SLOT_MS` for an enqueue, never behind an unclaimed row for a stage. Every notifying commit
  serialises behind ONE Postgres lock: never notify unconditionally. Payload: the queue name.
- **A wake resets the backoff**: the floor passes after it find the row a slot silenced.
- **The claim loop is ONE chain** (`worker-loop.ts`): a wake on a pass in flight sets `again`; a
  freed slot and a due retry (`JobExecution.resumeAt`) `kick` one pass, no reset.
- **`idle-cost.test.ts` / `queue-wake.test.ts` count statements per idle minute** — scheduler 6,
  worker and relay 30 with no wake, 12 with. Raising one is a regression.
- **The memory driver stores a payload's JSON form**, as pg binds it (`driver-settle-parity.test.ts`).
- **The event bus has ONE clock**: `postgresEventBus` takes no `clock`; `EventLookup.now()` is
  REQUIRED, stamps a NEW wait, and calls the TIMEOUT (asked once the runner thinks time is up).
  `purgeExpired()` is awaited and counted; `eventsPurgeTarget(bus)` is its `PurgeTarget`.

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

## Rules — factories over `job()`

Long form: [`docs/history/jobs.md`](../../docs/history/jobs.md), "Moved 2026-10-01 — factories".

- **`backfill()`**: a step persists the CURSOR and a count, never the page; step names are positional;
  **`handle` is AT LEAST ONCE** — never invert; a REPLAYED batch writes no ledger row. `tenant: 'none'`
  is the only cross-tenant scope (`backfill-scope.ts`). `x_backfills` is what was SWEPT, keyed by RUN;
  only `completed` blocks. The throttle is spent INSIDE the batch's `step.run`.
- **The ledger says what RAN, the registry what EXISTS, `backfill-pending.ts` is the diff.**
  `environments` is checked in `backfillPass()` and `gateBackfill()`; `requires` in `gateBackfill()`
  only; `count` after the last batch (`X_BACKFILL_STALLED`). `inspectBackfills()` is the ONE projection.
- **`purge()`** is the one caller of every `purgeExpired()`: one table per `step.run`, one clock
  reading per pass, duplicate names refused.
- **`exportRows()`**: one object per PAGE, named by page index; NO cross-tenant escape.
- **`webhook()`**: ONE event to ONE endpoint, no steps; each attempt but a CANCELLED one recorded
  before the throw; `ledger.isDisabled` gates the socket. **The wire format is core's.**
- A `-fixture.ts` file does not ship; `backfill-pass-fixture.ts` raises a plain `Error` subclass on
  purpose (it stands in for app code).

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
| `backfill-errors.ts` | the seven `X_BACKFILL_*` classes; the codes stay declared in `errors.ts` |
| `register.ts` | `registerJobs`/`registerTasks` over a module namespace + the registrar announcements; an `action-job` projection is `X_ACTION_JOB_UNBRIDGED` |
| `describe.ts` | the JSON projection one handle emits; `describeJobs()` is a map over it |
| `steps.ts` | `StepStore`, `StepApi`, memoized-replay executor, `StepSuspension` |
| `steps-timeout.ts` / `steps-suspension.ts` | a step's ceiling; `StepSuspension` and the timed-out marker |
| `outbox.ts` | staging in a `Tx`, the store seam, the ambient `JobsFacade` slot |
| `outbox-relay.ts` | the relay: the poll timer, one pass, and its TWO shutdown hooks |
| `outbox-pg.ts` | `postgresOutboxStore` — `stage()` on the caller's OWN connection, claim on the pool |
| `outbox-lease.ts` | the claim lease's one definition and its one normalisation, for both stores |
| `leases.ts` | `LeaseStore` — fleet-wide slots, the memory one, `jobLeaseKey` |
| `concurrency.ts` | `job.concurrency` as declared, resolved once: `KeyedConcurrency`, `WhenBusy`, the declaration and key refusals |
| `errors-concurrency.ts` | every concurrency refusal's class; codes stay in `errors.ts` |
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
| `execute.ts` / `run-deadline.ts` | `executeJob` — one claimed job run and settled; the run's deadline: cancel, then fail |
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
| `purge.ts` | `purge()` — a factory over `job()`: the retention sweep and its target seam |
| `task.ts` | the `task()` primitive + registry + the handle's surface + `registerTask` |
| `scheduler.ts` | `scheduler` role: the dispatch round, catch-up, leader election, the drain |
| `limits.ts` | per-tenant / per-queue / global concurrency + rate |
| `events.ts` | stored event bus for `step.waitForEvent` |
| `inspect.ts` | `--json` introspection |
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

Which `-fixture.ts` harness each suite shares, and what each `.job.` suite proves:
`docs/history/jobs.md`, "Moved 2026-10-01 — test harnesses".

Commands: `bun test packages/jobs` · `bun run --filter @ultimat3/jobs typecheck`.

Why each rule above is shaped the way it is: [`docs/history/jobs.md`](../../docs/history/jobs.md).
