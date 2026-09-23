# @ultimat3/jobs — agent notes

Tier 3. The `job` + `task` primitives, durable steps, transactional outbox, queue drivers.

## Boundary

- May import: `core`, `schema`, `entity`, `policy`, `cache`, `time` — and `db`, for
  `expectedQueryLoop` ONLY: `steps.ts` declares the per-step write one-per-step to the N+1
  detector there, and no client is ever taken from it. Never `http`, `render`, `ui`.
- Consumers: `action` (`<job>.enqueue`, via the ambient jobs facade), `cli`, `mcp`, `admin`.
- External deps: none. Postgres access goes through the injected `PgExecutor`.

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
  `runWithContext`; `'none'` STRIPS the org (fail-closed). A boot-supplied service actor was rejected.
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

- **`SQL_JOBS_TABLE` is the ONE install point** for every durable table (`x_jobs`, `x_job_steps`,
  `x_backfills`, `x_outbox`, `x_scheduler_state`, `x_scheduler_leader`, `x_job_leases`,
  `x_job_events`). A shipped table grows by `alter table ... add column if not exists`. Its comments
  carry NO apostrophes and NO semicolons (`dev-queue.ts` splits on `;`; `driver-pg-sql.test.ts` checks
  quote parity).
- **`claim({ queues: [] })` is REFUSED by every driver** (`assertClaimQueues`,
  `X_JOB_CLAIM_QUEUES_EMPTY`); the memory driver's `claim`/`list`/`deadLetters` are `async` so a
  refusal rejects on both.
- **`ack` and `nack` are FENCED on `state = 'running'`** — that is what makes cancellation possible.
  `heartbeat` answers a boolean, read as `held === false` (never `!held`).
- **A driver's semantics are pinned in ONE test beside the pg statement** (`driver-parity.test.ts`):
  list order, the `attempt` floor, `SQL_LEASE_RENEW` fencing on `expires_at > now()` and `holder`,
  `SQL_STATS` one bucket per row.
- **No read returns a WHOLE row** — `driver-pg-sql.test.ts` scans every production file here
  (discovered, comments stripped) for `select *`/`returning *`.
- Drivers implement the six `JobDriver` methods plus optional `introspect`, `backfills`, `leases`. New
  capabilities go behind the interface. `inspect.ts` returns plain JSON for CLI, `/_x` and MCP.
- Step results are persisted BEFORE the step returns. All time is epoch ms from an injected `Clock`
  (`nowMs()` in `clock.ts`).
- **`createPgLeader` is correct only on a DEDICATED connection**; boot uses `createPgLeaseLeader`.
- `driver-redis.ts` / `driver-nats.ts` are honest `X_NOT_IMPLEMENTED` stubs.

## Rules — numbers and limits

- **Every numeric knob is refused when not FINITE** — core's `finiteOption()` (a bound) and
  `finiteCount()` (a count, caller's minimum); `worker-options.ts` is where `createWorker` reads them.
  **`bun run finite-bounds` is a floor, never proof**: `createLimiter`'s five numbers (`perTenant`,
  `perQueue`, `global`, `ratePerTenant.limit` / `.windowMs`) are screened with min 0 (zero is a HARD
  STOP). **A row count is `finiteCount` (min 0)** for driver parity (`list`, `deadLetters`, the
  backfill ledger's `list`, `assertClaimBounds`).
- **`WorkerOptions.concurrency` is read by OWN key** — a queue named `constructor`
  (`worker-slots.test.ts`).
- **`job.concurrency` is enforced by `JobDriver.leases`** (one row per held slot in `x_job_leases`);
  `limits.ts` is the per-process fast path. No lease store + a declared `concurrency` makes `start()`
  throw `X_JOB_CONCURRENCY_UNENFORCEABLE`.
- **`limits.ts`'s per-tenant state is BOUNDED**: a zero counter is deleted; `starts`/`refusals` swept
  and capped at `DEFAULT_MAX_LIMIT_TENANTS`, evicting the LEAST throttled first. `LimitSnapshot.tracked`
  publishes both sizes.
- **`clock.ts`'s conversion is `finiteDurationMs(duration, subject, option)`**: floor `finiteOption`
  (negative and zero are shipped behaviour), `subject`/`option` REQUIRED, and `Finite` in the name for
  the ratchet. `duration-bounds.test.ts`. `parseDuration` and `nextCronOccurrence` are normalised in
  one place each (`finiteDurationMs`, `defaultCronResolver`).

## Rules — the worker and the scheduler

- **One enqueue implementation**: `jobsFacade()`; the only other `driver.enqueue` sites are the outbox
  relay and the scheduler. `handle.as(actor, input)` QUEUES; `executeJob` is the one execution path.
- The scheduler's key is occurrence-scoped (`task:occurrenceMs:jobKey`); `task.enqueue()` uses the
  job's plain key.
- **TWO shutdown hooks per worker, one per PHASE**: `accept` is `stopAccepting()` (flip state, clear
  the poll timer, abort held runs); `close` is the teardown. `stop()` hands both back in a `finally`;
  `start()` refuses while draining.
- **A claimed job is counted with core's `beginWork()`**, so the drain's in-flight phase does the
  waiting. **The teardown's wait is bounded on SIGTERM** (`settleAllBy` in `drain-wait.ts`,
  `jobs.worker.drain-abandoned`) and unbounded on a manual `stop()`. A worker always reaches `'stopped'`;
  `state` is set in the `finally`. **One teardown, joined.**
- **SIGTERM reaches the job**: the worker's one `AbortController` (`drainSignal`) is composed into every
  run (`worker-run.ts`); `stopAccepting(reason)` aborts it with `JobDrainedError` (`X_DRAINING`). A
  drained attempt settles as **`interrupted`** (`nack`, `countsAsAttempt: false`, no park, no dead
  letter), read off the SIGNAL. `WorkerStats.interrupted`; `worker-drain-signal.test.ts`.
- **The drain waits out the claim round it races** — `tick()` registers its round in `rounds`
  synchronously with its guard.
- **A fleet slot is taken INSIDE a `try`, released AWAITED, and a renewal answering `false` CANCELS the
  run** (`X_JOB_SLOT_LOST`, read as `renewed !== false`).
- **The run's signal is a controller this worker owns** (`run-signal.ts`), never `AbortSignal.any`.
- **A lease is HELD, not owned** (`heartbeat.ts`): one failed renewal is `jobs.heartbeat.failed`; a
  whole window without one landing is `jobs.lease.lost` + `recordLeaseLost(queue)`, measured on this
  process's clock, asked both sides of the call.
- **A renewal is decided against `stopped()`** (`renewal-timer.ts`, re-read after every await); the
  interval is `unref`ed.
- **Settlement is not part of the retry decision**: `driver.ack` sits after the `try`.
- **The retry decision reads the ERROR** (`retry-classification.ts` composes around `nextRetry`;
  `nextRetryForError` is `execute.ts`'s only caller). **`classifyThrown` never reads `error.retry`
  alone** — core's `declaredErrorRetry(code)`. `retry-after` reuses the nack delay
  (`meta.retryAfterSeconds`, clamped). The verdict is published (`stop`, `stopReason`,
  `recordedFailure`).
- **The backoff arithmetic is core's** (`backoffDelay` via `backoffDelayMs`), `jitter: true` = EQUAL.
  `RetryPolicy`, `DEFAULT_RETRY`, `retrySchedule()` unchanged; `BackoffStrategy` aliases core's
  `BackoffCurve`. `retry-core-parity.test.ts`. **`classifyThrown` / `statedDelayMs` are core's,
  re-exported** (pinned by identity).
- **The claim loop re-arms on the PASS, never the jobs**; `tick()` resolves with that pass's executions.
- **A deadline CANCELS, then fails the attempt**, never the reverse (`raceTimeout`, `withStepTimeout`);
  the attempt is cancelled in `executeJob`'s `finally`.
- **A cancelled runner writes NOTHING** — `put()` in `steps.ts` is the one fence (`X_ABORTED`);
  `jobs.timeout.abandoned` names an uncooperative body. `executeJob` reads `ctx.signal` defensively.
- **`traceparent` is stamped at ENQUEUE time, in `outbox.ts`**, and an empty `spanId` sends none.
- **The scheduler runs one dispatch round at a time**; every other `tick()` joins it; `stop()` waits it
  out before `leader.release()`. Same two-hook rule; an ABANDONED round does not release
  (`jobs.scheduler.drain-abandoned`). **It asks `leader.acquire()` every round AND before every task**
  (`stillLeading()`).
- **`run-once` fires ONE catch-up** (marks `at`); `skip` fires the true latest missed occurrence
  (`latestOccurrenceBy`, bisection).
- **Every timer body catches before it finalises** (`void work().catch(log).finally(...)`).
- **Suspension is control flow, and a SHED is not a suspension**: `StepSuspension` →
  `nack({ countsAsAttempt: false, park: true })`; a shed is `countsAsAttempt: false` without `park`,
  stays `ready`, logs `jobs.worker.shed` (no `last_error`). `driver-parity.test.ts`.
- **A run's acquisitions are handed back even when the wiring throws** (`worker-run.ts`: `context()`
  above the heartbeat; `createRunSignal` and `fleetSlots.startRenewal` inside the `try`).
- **`step.run` hydrates the run's steps from ONE `store.list(runId)`**; `sleep` and `waitForEvent`
  record replays through `trace()`. **`claimName` reads a Set**; `usedNames()` keeps
  `MAX_TRACE_NAMES` (200).
- **`x jobs cancel` binds to `cancelJob(driver, id, reason?)`, which refuses** a finished job or a
  driver with no `cancel` (`X_JOB_NOT_CANCELLABLE`).

## Rules — the outbox

- **The relay drains in two phases** (`accept` clears the interval; `close` awaits the pass under
  `settleAllBy`), its timer `unref`ed. **`relay.stop()` JOINS the pass in flight.**
- **The claim is a LEASE in one statement** (`claimed_at`/`claimed_by` stamped in the locking CTE;
  outer `order by staged_at, id`). `OutboxStore.release` (optional) hands back a failed batch.
  `outbox-claim.test.ts` pins both stores.
- **The lease is fenced on every mutation** (`and claimed_by = $n`; `OutboxRecord.claimedBy`);
  `markPublished` also requires `published_at is null`. A token-less call is unfenced in memory and
  fenced on this relay's id in pg (`outbox-pg.ts` says so). `id` (UUIDv7) is the tiebreak.
- **`claimLeaseMs` is normalised in ONE place** (`outbox-lease.ts`, `resolveClaimLeaseMs`,
  `X_INVARIANT` at construction).
- **The memory outbox store DELETES a published row** (`retained()` is the seam).

## Rules — factories over `job()`

- **`backfill()`**: a step persists the CURSOR and a count, never the page; step names are positional
  (`batch:<index>`), so `handle` gets no `step`; the iteration is rebuilt when `batches.cursor`
  disagrees with the checkpoint; a read-back checkpoint is checked. **`handle` is AT LEAST ONCE** (it
  runs before its checkpoint) — never invert. **A REPLAYED batch writes no ledger row.**
- **A `backfill()` declaring `tenant: 'none'` gets the cross-tenant scope, and nothing else does**
  (`backfill-scope.ts`, `withBackfillScope`): only on the pass's own actor, for the pass's life;
  `runWithContext` outside `crossTenant`. `backfill-tenancy.test.ts` drives `executeJob`.
- **`x_backfills` is what was SWEPT; the checkpoints are where a pass resumes**. Keyed by RUN; only
  `completed` blocks; `start()` clears `completed_at` on an adopted row. A moved checksum warns and
  does not run; `force` rides the input.
- **The throttle is spent INSIDE the batch's `step.run`** (`backfill-rate.ts`, `createPacer` asserts
  its own rate).
- **A backfill STAMPS its own handle** (`stampBackfill`, not exported); `registeredBackfills()` derives
  from `registeredJobs()`.
- **The ledger says what RAN, the registry what EXISTS, `backfill-pending.ts` is the diff**;
  `isPendingBackfillState` is shared with `x db backfill --all`.
- **`environments` is checked in `backfillPass()` (the rail) and `gateBackfill()` (a CLI pre-check);
  `requires` in `gateBackfill()` only; `count` in `backfillPass()` after the last batch**
  (`X_BACKFILL_STALLED`, its result parsed). `gateBackfill()` RETURNS its refusal.
- **`inspectBackfills()` is the ONE projection of the ledger**, reads no clock, answers `[]` for a
  driver with none. The ledger hangs off `driver.backfills`, optional.
- **`purge()`** is the one caller of every `purgeExpired()`: `PurgeTarget` is structural, `targets()` a
  thunk, one table per `step.run`, one clock reading for the whole pass, duplicate names refused
  (`X_INVARIANT`). `DEFAULT_PURGE_CRON`; `@ultimat3/cli`'s `dev-purge.ts` schedules it.
- **`exportRows()`**: one object per PAGE, named by page index (a rerun rewrites the same bytes); the
  interleaving assertion in `export-pass.test.ts` is the memory guard; NO cross-tenant escape; the CSV
  formula guard is on strings only.
- **`webhook()` delivers ONE event to ONE endpoint** (key `<name>:<endpointId>:<eventId>`); no steps
  (the endpoint carries the secret); the timestamp is SEND time; endpoint headers merge UNDER the
  framework's; `redirect: 'manual'`. `WebhookLedger` is a seam; every attempt is recorded before the
  throw. **The wire format is core's** (`packages/core/src/webhook-signature.ts`), re-exported.
- A `-fixture.ts` file does not ship; `backfill-pass-fixture.ts` raises a plain `Error` subclass on
  purpose (it stands in for app code).

## Known coupling

`driver-pg.ts`'s `PgExecutor` is a one-method structural interface (no `@ultimat3/db` dependency).
`packages/cli/src/dev-queue.ts` wraps a real `@ultimat3/db` client, so queue statements pass
`@ultimat3/db`'s statement observer with no `{entity, op}` attribution — future work, see
`packages/db/CLAUDE.md`'s `observe.ts` section.

## Files

| File | Owns |
|---|---|
| `job.ts` | the `job()` primitive + registry + the handle's fluent surface + `registerJob` |
| `tenant.ts` | what tenant a run acts under: `JobTenant`, the declaration's backstop, the actor `executeJob` installs |
| `backfill.ts` | `backfill()` — a factory over `job()`: the declaration, its checksum and its input |
| `backfill-pass.ts` | one pass: the batched iteration, its cursor checkpoints and its ledger row |
| `backfill-scope.ts` | which sweeps run across tenants — `tenant: 'none'` only, on the pass's own actor, for the pass's own life |
| `backfill-ledger.ts` | `x_backfills` — the contract, `BACKFILL_STATUSES`, the checksum, the verdict, the memory ledger |
| `backfill-registry.ts` | what was DECLARED: the `origin` stamp, `isBackfill`, `registeredBackfills` |
| `backfill-gate.ts` | may this sweep run here and now — environment, `requires`, already-applied |
| `backfill-pending.ts` | declared minus completed, per environment: the alarm `--pending` reads |
| `backfill-rate.ts` | the `rate` throttle: batches/sec as an interval, and the cancellable wait |
| `backfill-inspect.ts` | the ledger projected for `x db backfill`, `x jobs`, `/_x` and MCP |
| `backfill-errors.ts` | the seven `X_BACKFILL_*` classes — split out of `errors.ts`, which was over the 500-line ceiling. The codes themselves stay declared in `errors.ts`: one registry, one place |
| `register.ts` | `registerJobs`/`registerTasks` over a module namespace + the registrar announcements. Skips a non-job in silence — a module namespace is full of helpers — EXCEPT an `@ultimat3/action` projection (`kind: 'action-job'`), which is `X_ACTION_JOB_UNBRIDGED` |
| `describe.ts` | the JSON projection one handle emits; `describeJobs()` is a map over it |
| `steps.ts` | `StepStore`, `StepApi`, memoized-replay executor, `StepSuspension` |
| `outbox.ts` | staging in a `Tx`, the store seam, the ambient `JobsFacade` slot |
| `outbox-relay.ts` | the relay: the poll timer, one pass, and its TWO shutdown hooks. Split off at `outbox.ts`'s 500-line ceiling |
| `outbox-pg.ts` | `createPgOutboxStore` — `stage()` on the caller's OWN connection, claim on the pool |
| `outbox-lease.ts` | the claim lease's one definition and its one normalisation, for both stores |
| `leases.ts` | `LeaseStore` — fleet-wide slots, the memory one, `jobLeaseKey` |
| `metrics.ts` | `queue_oldest_ready_seconds` and `queue_dead_jobs`, the two alertable gauges |
| `scheduler-pg.ts` | `pgSchedulerState` (the durable watermark) + `createPgLeaseLeader` |
| `events-pg.ts` | `createPgEventBus` — `step.waitForEvent` across processes |
| `driver.ts` | `JobDriver` contract + wire records |
| `driver-pg.ts` | default driver, real SQL constants, and `createPgLeader` — the advisory-lock election that is **not** what a scheduler uses; `scheduler-pg.ts` above owns the lease-row one boot wires |
| `driver-pg-ddl.ts` | `SQL_JOBS_TABLE` — the schema the driver installs, and the ONE install point: every durable table this package owns, `x_outbox` included, is declared in it. Whichever file holds the DDL is the one whose comments may carry no `;` and no `'` |
| `driver-pg-jobs-sql.ts` | every statement returning a whole `x_jobs` row, and the `JOB_ROW_COLUMNS` projection they share. Split off at `driver-pg-sql.ts`'s size ceiling and re-exported from it |
| `driver-pg-rows.ts` | a Postgres row → a wire record: `JobRow`/`StepRow`/`BackfillRow` and their mappings |
| `driver-memory.ts` | `x dev` / tests |
| `driver-redis.ts`, `driver-nats.ts` | honest `X_NOT_IMPLEMENTED` stubs |
| `retry.ts` | the dead-letter decision, and this package's option names over core's `backoffDelay` — no curve of its own |
| `retry-classification.ts` | the OTHER half of that decision: what the thrown error says, and the stop reason the row and the log carry |
| `execute.ts` | `executeJob` — one claimed job run and settled, and the run's deadline/cancel |
| `heartbeat.ts` | one claimed job's lease: the renewal interval and the loss it reports |
| `renewal-timer.ts` | the interval a renewal runs on, and the `stopped()` latch every branch after an await re-reads |
| `worker.ts` | `worker` role, claim loop, drain — and the one `AbortController` SIGTERM reaches every held run through |
| `worker-types.ts` | the worker's public contract: `WorkerOptions`, `WorkerStats`, `Worker` |
| `drain-wait.ts` | the drain's wait, shared by both roles: everything a teardown holds, settled — or abandoned at the budget the `close` hook was handed |
| `worker-run.ts` | one claimed job, wired: its heartbeat, its slot renewal, its run signal and its span, started together and handed back in one `finally` |
| `run-signal.ts` | the signal ONE run is cancelled by — composition that can be handed back, and that the worker can abort itself |
| `worker-fleet-slots.ts` | the fleet slot an in-flight job holds — take, renew, hand back. The claim loop asks "may I start this one?"; this answers it across the fleet |
| `purge.ts` | `purge()` — a factory over `job()`: the retention sweep, its structural target seam and the hourly cron a host schedules it on |
| `task.ts` | the `task()` primitive + registry + the handle's surface + `registerTask` |
| `scheduler.ts` | `scheduler` role: the dispatch round, catch-up, leader election, the drain |
| `limits.ts` | per-tenant / per-queue / global concurrency + rate |
| `events.ts` | stored event bus for `step.waitForEvent` |
| `inspect.ts` | `--json` introspection |

`backfill-pass-fixture.ts` is the one harness `backfill-pass.test.ts` and
`backfill-pass-ledger.test.ts` share. `*.job.test.ts` is the opt-in `job` step: `replay`,
`idempotency` and `outbox-atomicity` each prove one guarantee through a REAL worker, and
`worker-soak.job.test.ts` kills one worker mid-job and asserts exactly-once completion.

## Commands

```
bun test packages/jobs
bun run --filter @ultimat3/jobs typecheck
```

Why each rule above is shaped the way it is: [`docs/history/jobs.md`](../../docs/history/jobs.md).
