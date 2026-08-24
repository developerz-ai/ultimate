# @ultimat3/jobs — agent notes

Tier 3. The `job` + `task` primitives, durable steps, transactional outbox, queue drivers.

## Boundary

- May import: `core`, `schema`, `entity`, `policy`, `cache`, `time`. Never `http`, `render`, `ui`.
- Consumers: `action` (`<job>.enqueue`, via the ambient jobs facade), `cli`, `mcp`, `admin`.
- External deps: none. Postgres access goes through the injected `PgExecutor`.

## Rules

- **The export name IS the job/task name.** `registerJobs(module)` / `registerTasks(module)`
  stamp it onto the handle the module exported and re-key the registry, so
  `import { sendInvite }` is the object the queue routes to after boot — never a renamed copy.
  A definition that supplied its own `name:` keeps it: a job name is a durable queue key that
  queued, retrying and dead-lettered rows already carry.
- **`defineApi({ jobs, tasks })` is where a module is handed over.** Nothing else registers.
  A job module no call reaches keeps the positional `anonymous-job-<n>` — a name that appears
  in no source file, on every queue row and in every dead-letter trace.
- The same handle under the same name is one registration seen twice (`defineApi` and the
  framework's module scan both reach the same declaration file), not a collision. Everything
  else that puts two things on one durable name is `X_JOB_DUPLICATE`, refused at the earliest
  decidable point: two definitions sharing a `name:` collide inside `job()`/`task()`, and a
  DIFFERENT handle — or the SAME handle under a second export name — collides at registration.
  A handle exported twice matters because the rename is in place: the last alias would silently
  move the queue key that queued rows were written to.
- `registerJob`/`registerJobs`/`registerTask`/`registerTasks`/`nameJobs`/`nameTasks` are NOT in
  `src/index.ts`. `defineApi` reaches them through core's registrar table; exporting them would
  be a second registration path that bypasses `defineApi`'s own result.
- `registerJobs`/`registerTasks` are announced in core's registrar table at import
  (`register.ts`). Never remove the announcement: `defineApi({ jobs })` would then throw
  `X_REGISTRAR_MISSING` — `@ultimat3/action` is on this tier and cannot import this package.
- `isJobHandle`/`isTaskHandle` are structural: `kind` plus proof `job()`/`task()` built it.
  A look-alike never registers. Deliberately not a registry lookup — the registry is what
  registration rewrites.
- `idempotencyKey` is NON-OPTIONAL in `JobDefinition`. Never relax it, never default it.
- **The idempotency namespace is `(name, coalesce(tenant_id, ''), idempotency_key)`, never the key
  alone and never name-only** (`As of 2026-08`). Two rounds of the same defect, and both are silent
  data loss with no error anywhere.

  It was the key alone: two jobs deriving the same natural key from the same input —
  `sendWelcomeEmail` and `provisionWorkspace` both keyed `user:${id}` — shared one namespace, so
  the second enqueue hit `on conflict do nothing`, fell through to `SQL_FIND_LIVE_BY_KEY`, found
  the FIRST job's row and returned `{ id: <A's>, deduped: true }`. The workspace was never
  provisioned and `x jobs ls` showed one healthy job.

  Then it was name-only, while the row already carried `tenant_id` as `$9` of the same insert.
  Every natural key the docs suggest is unique only WITHIN a tenant — `` `invoice:${input.invoiceId}` ``,
  `` `order:${input.orderNumber}` `` — so tenant B enqueuing while tenant A held that key deduped
  into tenant A's row: B's work never ran AND B's caller received A's job id, which is valid on
  every id-addressed surface (`cancelJob(driver, jobId)` takes an id with no tenant predicate, so
  an app wiring the returned id to a cancel button gave B cancellation of A's job). The sibling
  projection in `@ultimat3/action` (`idempotency-key.ts`) had folded the actor's org in all along.
  `coalesce`, not the bare column: a null `tenant_id` compares unequal to every other null under a
  unique index, so a tenantless queue would lose its dedupe entirely — all tenantless rows share
  one namespace instead, which is what they had before tenancy existed.

  Three places have to agree and a test pins them together: the index, the conflict target, and the
  live-row lookup. The conflict target must spell the index EXPRESSION exactly —
  `(name, (coalesce(tenant_id, '')), idempotency_key)` — or Postgres cannot infer the index at all.
  `driver-memory.ts` mirrors it with `(record.tenantId ?? '')`, which is the parity that turned a
  gap into a confirmed one rather than catching it. `x_jobs` SHIPPED, so the DDL
  `drop index if exists`es BOTH superseded indexes — each is strictly narrower than its successor,
  so either left in place would keep enforcing exactly the collision this fixes. The scheduler's
  occurrence key already prefixes the task name and is unaffected.
- **`SQL_JOBS_TABLE` is the ONE install point, and every durable table this package owns is in
  it** (`As of 2026-08`): `x_jobs`, `x_job_steps`, `x_backfills`, `x_outbox`, `x_scheduler_state`,
  `x_scheduler_leader`, `x_job_leases`, `x_job_events`. Four of those were subsystems that shipped
  fully built with no table behind them — the outbox, the scheduler's watermark and leader,
  `job.concurrency`, and `step.waitForEvent`'s bus — and the outbox's DDL sat in its own exported
  constant that no boot code applied, which is exactly how it came to be documented and never
  created. A shipped table is extended with `alter table ... add column if not exists`, never by
  editing its `create`: `create table if not exists` is a no-op against a database that already
  has the table, so a column added only there reaches new installs and nothing else. Comments in
  that constant carry NO apostrophes and NO semicolons — `dev-queue.ts` splits it on `;` and
  `driver-pg-sql.test.ts` checks quote parity, neither of which can tell prose from a literal.
- **`claim({ queues: [] })` is REFUSED by every driver, `As of 2026-08-24`.** It used to mean two
  different things: EVERY queue on `driver-memory.ts` (`wanted.size === 0 ||`) and the `default`
  queue on `driver-pg.ts` (`queues.length > 0 ? queues : [DEFAULT_QUEUE]`), with `ClaimOptions.queues`
  documenting neither — so the memory driver every test in this repo runs against and the pg driver
  production runs against answered one question two ways. Nothing reached it (`createWorker` passes
  exactly ONE queue per pass, which is what keeps a slow queue from starving the others), so it could
  only ever be found by an embedder, in production. Both meanings are silently wrong in the other's
  deployment: claiming every queue is a worker taking work it was never configured for, claiming
  `default` is a worker that drains nothing and reads as an idle queue. `assertClaimQueues` in
  `driver.ts` is the one refusal (`X_JOB_CLAIM_QUEUES_EMPTY`), called by both drivers, and
  `driver-memory.ts`'s `claim` is `async` so an empty list REJECTS on both rather than throwing
  synchronously on one — a sync throw out of a method typed `Promise<…>` is itself a divergence.
  **Breaking**: `driver-pg.test.ts` was leaning on the pg default and now names its queue.
- **`ack` and `nack` are FENCED on `state = 'running'`, and that fence is what makes cancellation
  possible** (`As of 2026-08`). Without it the only way to stop a runaway pass was
  `UPDATE x_jobs SET state='dead'`, which the worker's next settle wrote straight over. Same fence
  in `driver-memory.ts`. `heartbeat` answers a BOOLEAN for the same reason: no row matched means
  this process no longer owns the job, and `heartbeat.ts` turns that into an abort on
  `LeaseHeartbeat.signal`, which `worker.ts` folds into the `Ctx` — so `x jobs cancel` reaches a
  job that is already running, and `steps.ts`'s `put` fence refuses everything it writes after.
  Read as `held === false`, never `!held`: a driver written before the return value existed
  resolves `undefined`, and treating that as a loss would cancel every job on every renewal.
- **`job.concurrency` is enforced by `JobDriver.leases`, and `limits.ts` is NOT a fleet gate.**
  `limits.ts` is three `Map`s in one heap — `perTenant: 2` on twenty pods is forty concurrent
  runs, and `ratePerTenant`'s window resets on every deploy. That is the fast path and it is
  correct as such; the docstring that called `global` a "fleet-wide ceiling for this worker
  process" was two numbers in one sentence and the code always meant the second. The fleet gate is
  one row per HELD SLOT in `x_job_leases`, where the `(lease_key, slot)` primary key is the
  serialisation — nothing reads a count and then acts on it. A driver with no lease store makes
  `createWorker().start()` THROW `X_JOB_CONCURRENCY_UNENFORCEABLE` when a registered job declares
  `concurrency`: a documented guarantee that silently does nothing is the worst of the three
  options, and refusing is what axiom 3 asks for.
- **`enqueuedBy` is ATTRIBUTION, never authority — decided 2026-08, do not re-litigate.** Both
  answers were defensible. Impersonating the enqueuer at claim time gives correct authz and is
  rejected because a job that sleeps three days, or dead-letters and is retried next quarter, then
  acts as somebody whose role, org membership or employment has changed since. So the row carries
  who asked, for audit, and the body is explicitly system-authority — which is how
  `docs/idea/02-primitives.md` already frames a job. A job that must act FOR a user takes that
  user's id in its INPUT and re-authorises it in the body, where the check is visible in review.
- **JOBS DECLARE THEIR TENANT, and `executeJob` INSTALLS the context — decided 2026-08, do not
  re-litigate.** Two halves of one defect, and neither works alone.

  The defect: `executeJob` built a `Ctx` and handed it to `handle.run({ ctx })` as a PARAMETER —
  `runWithContext` appeared nowhere in this package. `@ultimat3/entity`'s tenant guard derives from
  `tryUseContext()` (`tenancy.ts:152`), not from the ctx it is given, so inside a job body
  `actorTenant` answered `undefined`, `scopedPlan` derived no predicate, `verifyScope` returned
  early and `assertRowTenant` could not fire. Proven, same entity, same actor, same call:
  `HTTP surface, write naming another org -> X_TENANCY_ACTOR_MISMATCH` /
  `JOB surface -> ACCEPTED`. Reachable by any app routing user input into a job — which is what the
  bullet above tells an author to do — and by every `backfill()` sweep. Both halves are pinned by
  `tenancy-cross-surface.test.ts`, which asserts the two surfaces' verdicts are EQUAL rather than
  asserting each one separately: that equality is the only shape of test that could have caught it.

  **`tenant` is REQUIRED on `JobDefinition`**, as `(input) => input.orgId` or the explicit
  `tenant: 'none'`. The type is the first rail and `X_JOB_TENANT_REQUIRED` (`assertJobTenant`) is
  the runtime backstop for generated code and JS callers — the shape `idempotencyKey` already has.
  `executeJob` derives the org through `handle.tenantFor(input)`, puts it on the ctx's actor
  (`jobRunActor`, which changes the ORG and nothing else — the identity stays whatever
  `WorkerOptions.context()` wired, so this grants no authority) and runs the body inside
  `runWithContext`. `'none'` STRIPS the org rather than inheriting the worker's, so a tenant-scoped
  read inside such a job is `X_TENANCY_ACTOR_ORG_REQUIRED` — fail-closed, intended, and not to be
  weakened; a sweep that genuinely spans tenants says so with `crossTenant(reason, fn)`.

  **A boot-supplied service actor was considered and REJECTED.** It closes the same hole and is one
  identity for every job in the app — so the first job that takes an org id in its input reads and
  writes another tenant's rows with the framework's blessing, which is precisely the cross-tenant
  hole this closes. The tenant is a fact about the WORK, so it is declared per job, from the payload
  the author already had to pass. A default was rejected for the same reason in both directions:
  `'none'` silently reopens the hole, and inheriting the worker's org is the shared identity again.
  `tenantFor` is a METHOD on `JobHandle`, never a `readonly tenant: JobTenant<I>` field — a
  function-typed property is contravariant in its parameter, so the field would stop
  `JobHandle<OrgInput>` being assignable to `AnyJobHandle` and break the registry.
  **The queue row's `tenantId` is unchanged**: it comes from the ENQUEUER's actor and is the
  limiter's bucket, never re-derived from the payload (`limits.ts`'s header rule). Two different
  questions — "whose rate budget does this enqueue spend" and "whose rows may this run touch".
- **A `backfill()` declaring `tenant: 'none'` gets the cross-tenant scope, and NOTHING else does**
  (`As of 2026-08`). The one exception to the bullet above, and it is forced rather than chosen.

  `source` hands back a LAZY chain, so every page's plan is built inside the iteration
  (`backfill-pass.ts`'s `iterate()`) — after the declaring frame has closed — and
  `@ultimat3/entity` applies `scopedPlan` at plan-build time (`plan.ts:111`). An app author holding
  a `ReadBuilder` therefore has nothing to wrap in `crossTenant(reason, fn)`: only the pass is
  positioned to open it. Without it, `tenant: 'none'` made a sweep over a tenant-scoped entity fail
  on page ONE with `X_TENANCY_ACTOR_ORG_REQUIRED` — the docstring told authors to do something the
  API cannot express. `backfill-tenancy.test.ts` drives the real surface (`executeJob`, not
  `backfillPass` by hand — the shared fixture calls it directly and so runs with no ambient context
  at all, which is why no existing backfill test could see this).

  **A backfill that declared a real `tenant` never gets it.** Granting the escape to a tenanted
  sweep is granting it to every backfill in the app, which is the opposite of what declaring a
  tenant means; the negative is pinned by two tests that fail the moment the guard in
  `withBackfillScope` is dropped. The reason string is derived and names the backfill, because it
  lands in the audit trail and `X_TENANCY_CROSS_DENIED` renders it — "backfill" alone would read
  identically for every sweep in the app.

  **The capability is granted on the PASS's actor, not on the worker's — and that is the decision.**
  Minting a worker identity carrying `tenancy:cross` at boot (`packages/cli/src/dev-roles.ts`
  builds that context) would hand it to every job that worker claims, including a plain
  `job({ tenant: 'none' })` that declared no sweep, and would move the decision into deployment
  config where no reviewer sees it — one identity serving every job, which is the shape this whole
  change exists to remove. Here it is bounded four ways: only `backfill()`, only on an explicit
  `tenant: 'none'`, only for the duration of that pass, and only on a context that dies with it.
  **So `dev-roles.ts` needs no change**, and no framework role's actor carries `tenancy:cross`.
  `runWithContext` goes OUTSIDE `crossTenant`, never the reverse: the capability is proved against
  the ambient actor at the call and again for every plan built inside. Nesting is safe — an app
  `handle` opening its own `crossTenant` replaces the reason and re-proves a capability the actor
  already holds — so an app that wraps its own body does not fight the pass.
- **`limits.ts`'s per-tenant state is BOUNDED, and a counter at zero is DELETED** (`As of 2026-08`).
  `bump(…, -1)` wrote `0` and kept the key, `refusals` cleared only on a matching acquire, and
  `starts` kept an array per tenant — four permanent entries per org in a process that never
  restarts, which self-service org creation turns into a leak. Zero and absent already answer
  identically (`?? 0`), so the counters drop to nothing with the run; `starts` and `refusals` are
  swept (a spent window and a refusal past `REFUSAL_TTL_MS` are indistinguishable from missing) and
  then capped at `DEFAULT_MAX_LIMIT_TENANTS`. The eviction order is `@ultimat3/http`'s
  `memoryRateLimitStore`'s and must stay it: the LEAST throttled window goes first, because
  discarding a full one hands that tenant a free rate reset. `LimitSnapshot.tracked` publishes both
  sizes so the bound is assertable rather than assumed.
- **`traceparent` is stamped at ENQUEUE time, in `outbox.ts`, and nowhere else.** The relay runs
  after commit in its own timer with no request span in scope, so a trace read there would be
  nobody's. A `currentSpanContext()` recovered from a `Ctx` has an empty `spanId`, which renders an
  all-zero parent every collector rejects — that case carries no header rather than a broken one.
- `tz` is NON-OPTIONAL in `TaskDefinition`, and validated by `@ultimat3/time`'s `isValidTimeZone`
  — never a local `Intl` probe, which accepts `'+02:00'`, a "zone" with no DST rules at all. A
  non-empty string is not a timezone. A task never contains a handler body.
- **One enqueue implementation.** Everything (`handle.enqueue`, `handle.as`, `task.enqueue`)
  goes through `jobsFacade()`; the only other `driver.enqueue(...)` call sites are the outbox
  relay and the scheduler's occurrence dispatch. Never add a third.
- `handle.as(actor, input)` QUEUES. A job's execution surface is the queue, so it must never
  run the handler inline — `execute.ts`'s `executeJob` is the one execution path.
- The scheduler's key is occurrence-scoped (`task:occurrenceMs:jobKey`) and `task.enqueue()`'s
  is the job's plain key. Deliberate: the first stops two schedulers double-firing a tick, the
  second is a manual run with no occurrence to scope to.
- **TWO shutdown hooks per worker — one per PHASE — and `stop()` is what hands both back**
  (`As of 2026-08-23`). `accept` is `stopAccepting()`: flip the state, clear the poll timer, return.
  `close` is the teardown: wait out the rounds and the in-flight jobs, close the driver.

  It was ONE hook, at `accept`, doing all of it — so a single 10-minute job spent the entire drain
  deadline inside the phase whose whole purpose is to be over immediately, and every hook behind it
  was invoked with **0 ms** left: `@ultimat3/http`'s "stop listening" and `listenSyncNode`'s
  `stopAccepting` are both `accept` hooks, so the pod went on serving requests and upgrading
  websockets for the whole of the drain the load balancer had already been told about. Reproduced —
  4 hooks started, none finished.

  `start()` keeps both unregisters; the teardown releases them in a `finally`, so a close that threw
  still gives them up. Discarding them was a hook per `start()` — the `start()` guard reads a
  standstill, so start -> stop -> start stacked a second registration retaining a stopped worker's
  driver, and the next process-wide drain ran all of them. `start()` refuses while draining for the
  same reason: a claim loop back on a driver the drain is about to close.
- **A claimed job is counted with core's `beginWork()`, so the DRAIN does the waiting**
  (`As of 2026-08-23`). The wait for in-flight jobs belongs to the phase between `accept` and
  `inflight`, which exists for exactly this and is where `@ultimat3/http` already puts a request —
  not to a hook, where one role's work starves every other role's teardown. `/readyz`'s `inflight`
  becomes truthful on a worker node as a consequence.
- **The teardown's wait is BOUNDED on the SIGTERM path and unbounded on a manual `stop()`**
  (`As of 2026-08-23`). The `close` hook is handed `ShutdownReason.deadlineAt` and passes it to
  `settleAllBy` (`drain-wait.ts`); a manual `stop()` passes nothing and waits as long as its
  jobs take, because a caller that asked has no budget to spend. Nothing in JS can kill a body that
  ignores `ctx.signal`, so the unbounded version was a teardown that never returned: the driver was
  never closed, `state` never left `'draining'`, and the memoised `stopping` promise every later
  `stop()` joins never settled — `x dev`'s role rollback awaits that promise. Abandoning the wait
  costs a lapsed lease and a job the queue delivers again, which is what at-least-once already
  promises; `jobs.worker.drain-abandoned` names it, with the `configureLifecycle({ deadlineMs })`
  raise as its fix. **A worker always REACHES `'stopped'`**, which is what makes `stop()`'s
  `state === 'stopped'` early return an answer rather than a wedge.
- **One teardown, joined.** `stop()` shares the in-flight teardown promise, so a SIGTERM landing
  on a manual stop waits out the same in-flight jobs instead of closing the driver underneath
  it. The promise is cleared as it settles, so a worker that started again tears down again
  rather than joining one that settled a lifetime ago. A close that threw still stopped the
  worker — the failure goes back on the promise the caller awaited, not into a second teardown.
- **The drain waits out the claim round it races, then the jobs.** `tick()` registers its round
  in `rounds` in the same synchronous step as its guard, so a round is either refused by a drain
  already under way or visible to every drain that starts after it. Guarding on entry alone was
  not enough: a round parked in `driver.claim()` adds to `inFlight` AFTER a drain that only
  snapshots `inFlight` has decided there is nothing to wait for, and `close()` then lands under a
  live job. The round re-reads the state before each queue — "stop claiming" means this round
  too — and what it already holds runs to the end.
- **A fleet slot is taken INSIDE a `try`, and a renewal answering `false` CANCELS the run**
  (`As of 2026-08`). Two halves of one guarantee, and each was a way for `job.concurrency` to be a
  number the framework prints and does not hold.

  `fleetSlots.acquire()` is a WRITE to `x_job_leases`, so a failover, a pool timeout or a `57P01`
  rejects it — and it sits between `limiter.tryAcquire` and the `.finally` that releases what that
  returned. The in-process slot was burned permanently: four rejections on a concurrency-4 worker
  and the role claims nothing again for the life of the process, with `jobs.worker.tick-failed` and
  a climbing `queue_depth` as the only symptoms. The `catch` releases the lease and rethrows; the
  claimed row goes back to the queue by its visibility timeout, as it does for any round that dies.

  `fleetSlots.release(jobId)` is AWAITED in the settle's `.finally`, never `void`ed: the slot is a
  DELETE in `x_job_leases`, so a fire-and-forget one was still on the wire when the teardown's
  `allSettled` returned and `driver.close()` took the connection out from under it — the row then
  held its slot for a full TTL, and a `concurrency: 1` job was unclaimable by the pod replacing this
  one for a whole visibility window after every deploy. `release` swallows its own failures, so
  awaiting it cannot turn a finished job into a rejected one.

  `LeaseStore.renew` answering `false` means the row is another holder's — two runs live under a cap
  of one — and it was discarded by `.catch(noop)`. It now stops the timer, logs
  `jobs.worker.slot-lost` and aborts the run through `X_JOB_SLOT_LOST`. Its own code, not
  `X_JOB_LEASE_LOST`: those are different rows on different clocks, and the queue can still consider
  this worker the owner of the JOB while another one is running under the same cap. Read as
  `renewed !== false` for the reason `heartbeat` reads `held === false` — a store from before the
  return value resolves `undefined`, and treating that as a loss would cancel every job on every
  renewal. **The heartbeat cannot cover for this**: it renews `x_jobs.visible_at`, a different row,
  and knows nothing about `x_job_leases`.
- **The run's signal is a controller this worker owns, never `AbortSignal.any`** (`As of 2026-08`).
  `run-signal.ts` composes the caller's `Ctx.signal` and the heartbeat's into one controller, and
  `worker-run.ts` disposes it in the same `finally` that stops the timers. `AbortSignal.any` cannot
  be undone, which cost twice: an app whose `WorkerOptions.context()` carries a process-lifetime
  signal accumulated one composite per job run, and nothing could abort the result — so a lost fleet
  slot had no way to reach the body running under it.
- **A lease is HELD, not owned, and losing one is said out loud.** `heartbeat.ts` renews the
  window `claim()` bought and decides between two facts: one failed renewal is not a lost lease
  (`jobs.heartbeat.failed`, warn — the window has room for the next), a window that passes with
  nothing landing is (`jobs.lease.lost`, error, plus `recordLeaseLost(queue)`). `.catch(() =>
  undefined)` made both look like a healthy run while the queue re-delivered the job. The window is
  measured on THIS process's clock from the last renewal that LANDED, never against
  `claimed.visibleAt` — that is the driver's clock, and comparing the two makes every lease
  decision a function of skew. Expiry is asked BOTH SIDES of the call: before, because a heartbeat
  hung on a dead connection never rejects, and after, because a renewal that SUCCEEDS past its own
  window would otherwise restart the clock on a lease the queue already re-delivered — the loss
  hidden inside the call meant to prevent it. A renewal that lands after the loss does not revive
  it either, because that window is somebody else's now.
- **Settlement is not part of the retry decision.** `executeJob`'s `driver.ack` sits AFTER the
  `try/catch/finally`, so only the body's own rejection can reach the retry branch. An `ack` that
  fails — a pool timeout, a reset on that one statement — is a job that finished and could not say
  so, not a job that failed: nacking it re-runs completed work and records `retried` in
  `jobs_total{outcome}` for a failure that never happened. It propagates instead, and the worker's
  `jobs.worker.settle-failed` plus the lapsing lease are the honest answer.
- **The retry decision reads the ERROR as well as the attempt count — added 2026-08.**
  `executeJob` decided a retry from `nextRetry(handle.retry, attempt)` alone, so every `terminal`
  classification in the framework was decorative on the job path: an `X_SCRAPE_AUTH_FAILED` from a
  rotated password burned the whole policy, which at a site that locks an account after three wrong
  passwords makes the framework's retry the thing that destroys the account.
  `retry-classification.ts` composes AROUND `nextRetry` — the backoff arithmetic stays in one
  place — and `nextRetryForError` is the only caller `execute.ts` has.

  **`classifyThrown` must never read `error.retry` on its own.** That field is
  `init.retry ?? retryFor(code)` and `retryFor` FAILS CLOSED, so every unclassified `UltimateError`
  already carries `terminal`; reading it would dead-letter the first attempt of every job in every
  app whose codes nobody has classified. Hence core's `declaredErrorRetry(code)`, which answers
  `undefined` where `retryFor` answers the default — and hence the one case that is knowingly
  under-read: an instance `retry: 'terminal'` on an UNREGISTERED code is indistinguishable from the
  default and is treated as unclassified. Register the code; that is the one way.
  `retry-after` reuses the delay the nack already takes (`meta.retryAfterSeconds`, clamped by the
  policy's `maxDelay`) rather than a second suspension mechanism — `StepSuspension` stays the only
  way to park a run, and unlike a suspension a retry-after DOES burn an attempt, because the work
  failed. The ceiling outranks every classification but `terminal`.

  **The verdict is published, not inferred**: `jobs.attempt.failed` and `reportError` carry
  `stop`, `JobExecution` carries `stopReason`, and `recordedFailure` appends the terminal verdict to
  the nack's `error` — `lastError` is the ONE failure field a row has, so without it `x jobs show`
  renders a dead letter at attempt 1 of 5 as a silent early stop.
- **The backoff arithmetic is `@ultimat3/core`'s, and `retry.ts` is the option names over it**
  (`As of 2026-08-23`). `backoffDelayMs` is `backoffDelay({ curve, jitter, base, max, attempt })`
  with this package's spellings applied on the way in — `DurationInput` through `toMs`, the
  `DEFAULT_RETRY` fallbacks, and `jitter: boolean` mapped to `'equal' | 'none'`. **EQUAL, never
  `full`**: `jitter: true` here has meant half-fixed-half-random since it shipped, and `full`
  would hand a job that already failed twice a near-zero wait. The public `RetryPolicy`,
  `DEFAULT_RETRY` and `retrySchedule()` are unchanged — a declared `retry: { attempts: 5 }` is
  durable API — and `BackoffStrategy` is now an ALIAS of core's `BackoffCurve` rather than a second
  spelling of the same three names. `retry-core-parity.test.ts` is the pin: 13,824 comparisons
  across every curve, base, cap, attempt and roll, plus the 1-based attempt and the clamp-before-
  jitter. Never re-derive a delay here — four packages shipped four curves, which is why core has
  one — `bun run flight-copies` is the guard, and it refuses a second curve-and-jitter function
  anywhere in `packages/*/src`, matched on the literal shape rather than the name.
- **`classifyThrown` / `statedDelayMs` are core's, RE-EXPORTED, not copied** (`As of 2026-08-23`).
  They moved down to `packages/core/src/error-retry.ts` beside the table they read.
  `retry-classification.test.ts` pins them by IDENTITY (`toBe`), not by agreement: two functions
  that answer alike today are two that can drift, and the rule that must never drift is the one
  above — an unregistered code carrying `terminal` reads as UNCLASSIFIED.
- **The claim loop re-arms on the PASS, never on the jobs.** A slot belongs to its own job and is
  free the moment it settles, so `claimRound` starts what it claimed and returns the promises —
  ending the pass on `Promise.allSettled([...inFlight])` made the pool as slow as its slowest
  member and left every OTHER queue unasked behind it. `tick()` still resolves with the executions
  THAT pass started (never the whole pool), which is what tests drive. Nothing awaits a job promise
  in the timer path, so the loop observes each one itself: unobserved is an unhandled rejection,
  and `jobs.worker.settle-failed` is where a job that could not be settled with the driver becomes
  visible.
- **`state` is set in the teardown's `finally`, never after the close.** A `driver.close()` that
  threw pinned it at `'draining'`: `stats()` reported a drain that had finished and `start()`,
  which leaves only `'idle'` or `'stopped'`, refused that worker for the life of the process.
- **A deadline CANCELS, then fails the attempt — never the other way round.** `executeJob` owns
  an `AbortController` per attempt and hands its signal to the body as `ctx.signal` (composed
  with the caller's, never replacing it) and to the step runner. `raceTimeout` aborts before it
  rejects because the caller nacks on that rejection and the queue hands the job straight to
  another worker: rejecting first is one job running twice. Same order in `withStepTimeout` for
  `stepTimeoutMs`. The attempt is also cancelled in `executeJob`'s `finally`, so a step a handler
  left in flight cannot write into the run its successor owns.
- **A cancelled runner writes NOTHING, and `put()` in `steps.ts` is the one place that is
  enforced.** Every `store.put` goes through it; aborted means `X_ABORTED` instead of the write,
  and refusing the write is what unwinds a body that ignores the signal. The failure branch of
  `step.run` checks the same flag directly rather than writing through `put`: the caller has to
  see the original error, never one raised by the bookkeeping. Nothing in JS can kill an
  uncooperative body — `jobs.timeout.abandoned` (warn) names it instead.
- `Ctx.signal` is non-optional in the type, and `executeJob` still reads it defensively:
  `@ultimat3/http`'s `asCtx` casts a request context across the seam without one, and a job that
  crashed on a missing field is worse than a job with no caller to follow.
- **One dispatch round at a time, and `stop()` is what waits for it.** The scheduler's timer
  re-arms on the round it just finished (never a fixed `setInterval` period) and every other
  caller of `tick()` JOINS the round in flight rather than opening a second one. Two rounds read
  the same `lastFiredAt`, walk the same occurrences and dispatch them both: the occurrence key
  deduped the jobs, so all that showed was a re-marked watermark, occurrences reported as
  dispatched that were never enqueued, and a `run-all` catch-up interleaved with itself. `stop()`
  waits that round out BEFORE `leader.release()` — a lock handed back mid-dispatch promotes a
  standby onto an occurrence this node is still enqueueing for, which is the double-fire leader
  election exists to prevent — and the round re-reads the drain state before each task, so "stop
  dispatching" means this round too. Same hook rules as the worker, `As of 2026-08-23`: **TWO**
  `onShutdown` registrations — `accept` stops dispatching and returns, `close` waits the round out
  and releases the lease under the deadline it is handed (`settleAllBy`) — both handed back in the
  teardown's `finally` so a `release()` that threw still gives them up, `isLeader` cleared there
  too because a lock this process could not hand back is never treated as still held. **An
  ABANDONED round does not release**: it is still enqueueing, so handing the lock over is that same
  double-fire delivered by the shutdown, and a lease row expiring on its own is the safe end —
  `jobs.scheduler.drain-abandoned` is the line that says so.
- **`backfill()` is a FACTORY over `job()`, never a ninth primitive.** Same rule `llm()` follows
  in `@ultimat3/ai`: a new capability arrives as a factory over an existing primitive, so a
  backfill inherits `.enqueue()`, the retry policy, the cancellation, the dead-letter path and
  its manifest row instead of re-declaring them. Three things in `backfill.ts` are load-bearing
  and none is an implementation detail: a step's persisted output is the CURSOR and a row count
  and never the page, because `steps.ts` retains a completed step's output for the whole run and
  a page there is every processed row held until the job ends; step names are positional
  (`batch:<index>`) so the next attempt mints the same key the last one wrote, which is also why
  `handle` is handed no `step` — a name minted inside a per-batch body collides with itself on
  batch 2; and the iteration is rebuilt whenever `batches.cursor` disagrees with the checkpoint,
  because `retryFromStep` re-opens ONE step in the middle of a finished run and the cursor then
  jumps over a page the live iteration never read. A checkpoint READ back is checked rather than
  trusted — `step.run` replays it through an unchecked `as T`, and an absent cursor is not `null`,
  so the pass would silently reopen the source at the top and walk the whole table again.
- **`purge()` is a FACTORY over `job()` too, and it is the ONE caller every `purgeExpired()` in
  the framework was missing** (`As of 2026-08-22`). Three stores shipped one —
  `postgresIdempotencyStore` (`x_idempotency`), `postgresRateLimitStore` (`x_rate_limit`) and
  `postgresAuthLimiter` (`x_auth_failures`/`x_auth_lockouts`) — each documented as "an app runs
  this from a `task`", and a task only ENQUEUES, so there was no job for one to enqueue and every
  row written was a row kept. `x_rate_limit` takes one upsert per HTTP request the web role serves,
  assets included.

  `PurgeTarget` is STRUCTURAL (`{ name, purgeExpired(nowMs) }`) for the reason `PgExecutor` is: two
  of those three packages are below this one and one is beside it, and a sweep that needed their
  types would put the HTTP pipeline on this package's import graph. `targets()` is a THUNK, read
  once per attempt: a host declares the sweep at boot and the auth limiter does not exist yet —
  `defineAuth` builds it when the app's modules import. One table per `step.run`, so a killed
  attempt resumes at the table it stopped on; a purge is idempotent by nature, so the replay that
  at-least-once guarantees deletes rows that are already gone. **One clock reading for the whole
  pass**, handed to every target: `postgresRateLimitStore.purgeExpired(nowMs)` requires the
  CALLER's clock, and reading the server's computed a 20,000,000-second refill against a frozen
  test clock and deleted a bucket holding 0 of 4 tokens — a free limit reset, handed out by the
  cleanup. Two targets under one name are refused (`X_INVARIANT`) before the first delete rather
  than discovered as `X_STEP_DUPLICATE` after one table is already empty.

  It declares no schedule of its own: `DEFAULT_PURGE_CRON` is the hourly cron a host's `task()`
  uses, and `@ultimat3/cli`'s `dev-purge.ts` is the one that declares both halves at boot.
- **`handle` is AT LEAST ONCE, and the ordering that makes it so is deliberate.** The body runs
  inside the step and the record is written after it returns, so an attempt killed, cancelled or
  lease-expired between the two hands that page to the next attempt — which is why the doc comment,
  the CHANGELOG, `CLAUDE.md` and `x g backfill`'s generated source all say the handler must be
  idempotent. Never invert it: checkpointing first would report a page as swept that nobody wrote,
  and a lost page is unrecoverable where a repeated one is the handler's problem.
- **A REPLAYED batch writes no ledger row** (`As of 2026-08-23`). `ledger.progress` sits outside
  `step.run` — it has to, the ledger is not transactional with the steps — so a resumed pass
  re-issued one `x_backfills` UPDATE per already-completed batch before it read a single new row:
  4,800 statements on a 5M-row sweep killed at batch 4,800, on every attempt, inside the visibility
  lease the heartbeat is renewing. The flag is set INSIDE the step body, because that is the only
  thing that can tell a replay from a run — `step.run` answers the same shape either way. Nothing is
  lost: the value is ABSOLUTE, so the first batch that does run reports every replayed one behind
  it, and `finish` writes the total regardless.
- **`x_backfills` is what has already been SWEPT, and the step checkpoints are where a pass
  resumes. Never the other way round.** The ledger row (`backfill-ledger.ts`) is a report an
  operator reads and the record that a completed name is done; the checkpoints are written in step
  with the work. A resume driven off `last_cursor` would be a second answer to "where were we"
  against a row that is not transactional with the rows it describes. Keyed by RUN, not by name,
  because `force` writes a NEW row rather than editing the one it reruns — history, not an edit of
  it. Only `completed` blocks: a `running` row is this pass resuming or one holding the single live
  idempotency key, a `failed` one is an attempt the queue is about to retry, and `start()` puts an
  adopted row back to `running` keeping the `started_at` the PASS began at and CLEARING
  `completed_at` — `finish` stamps that column for `failed` as well as for `completed`, and all
  four surfaces project it, so a retried run that kept it renders as running with a completion time
  in the past. A moved checksum WARNS
  and still does not run — it hashes `source` and `handle`'s source text with a `\u0000` between
  them (raw concatenation would hash a boundary, not a pair), and a bundler moves that text without
  a line of behaviour changing, which is why `@ultimat3/db`'s `auditLedger` may throw on the same
  fact and this may not. `force` is the only override, and it rides the input rather than the
  idempotency key: one live pass per name, forced or not, or "kick it again" becomes a second
  writer on one table.
- **The throttle is spent INSIDE the batch's own `step.run`, and that is the whole of it.**
  `backfill-rate.ts` owns one pacer per declaration (`rate`, batches/sec, default 5); the wait is
  the first statement of the step body, never around it. Outside the step, an attempt resuming at
  batch 500 would replay 500 completed checkpoints — which run no body and touch no database — and
  still pay the full throttle of everything it had already done before reading a new row. The
  pacer takes the step's `signal` and rejects `X_ABORTED` both before the wait and after it, for
  the reason `execute.ts` cancels before it rejects: the wait's sleeper settles early on abort, so
  what it means is "the wait is over", never "the slot arrived". Built once at declaration, like
  the checksum: the interval belongs to the table and the pool, not to whichever attempt holds the
  run. `rate` is deliberately NOT in the checksum, for the reason `batch` is not. `createPacer` is
  exported, so it asserts the rate itself rather than trusting `backfill()` to have done it: `0`
  makes the interval `Infinity`, which the timer clamps to about a millisecond — an unvalidated
  zero is "no throttle at all", the one setting this module exists to make unreachable.
- **A backfill STAMPS its own handle; an app registers nothing** (`As of 2026-08`). `backfill-registry.ts` is the
  `origin` WeakMap `task.ts` already uses, not a second mechanism — `stampBackfill` is called by
  `backfill()` and is deliberately **not** in `src/index.ts`, for the reason `registerJob` is not:
  a second way to claim backfill-hood would let a plain `job()` inherit the pending diff, the gate
  and the deploy trigger it was never declared for. `registeredBackfills()` is derived from
  `registeredJobs()` and never from a registry of its own — a backfill IS a job, and two registries
  disagreeing about one name would be two answers to "does this pass exist". Requiring an app to
  call `registerBackfill()` was rejected outright: that coupling is what axiom 8's extension model
  refuses, and a declaration an app has to declare twice is one half the apps will forget.
- **The ledger says what RAN; the registry says what EXISTS; `backfill-pending.ts` is the diff**
  (`As of 2026-08`).
  That diff is the whole defect this subsystem had: `inspectBackfills` and `x db backfill --list`
  both read `x_backfills`, so a sweep merged and never enqueued had no row and was invisible on
  every surface. `pendingBackfills()` takes `BackfillProgress` rows — the one projection, never the
  driver's own `BackfillRun` — and `pending` deliberately excludes `running` (a pass in flight is
  progress, and a check red for the duration of every sweep gets muted within a week) and
  `excluded` (a declaration this environment may not run is not drift). Which states count is
  `isPendingBackfillState`, exported and read by `x db backfill --all` too: that selection used to
  be `report.pending.includes(row)`, an object-identity test that held only because the diff
  filters the array it returns — one `map` away from `--all` finding zero targets and exiting 0.
- **`requires` / `environments` / `count` are DATA on the declaration, and each is enforced where
  the fact it needs is readable** (`As of 2026-08`). Three fields, three boundaries, and only
  `environments` is checked twice — deliberately:

  | Field | Checked in | Checked again in | Why there |
  |---|---|---|---|
  | `environments` | `backfillPass()`, ahead of the ledger open | `gateBackfill()`, for the CLI | the pass is the RAIL — app code calling `.enqueue()` never passes through a command, and a check only the CLI holds is a convention, not a build error (axiom 3). The gate's copy is a PRE-CHECK, so `x db backfill` refuses before it queues work that would only dead-letter |
  | `requires` | `gateBackfill()`, CLI only | — | `x_migrations` is `@ultimat3/db`'s, and this package holds no dependency on it; growing one so a tier-3 queue could read a migration ledger is the import this file refuses |
  | `count` | `backfillPass()`, once, after the last batch | — | it needs the pass's own `ctx` and only means anything once the source is exhausted |

  Refusing in the pass leaves NO ledger row — the check is ahead of `ledger.start` — so a
  wrong-environment enqueue never claims a sweep started. `count` is the same predicate `source`
  selects on, so a source that ran out while the count still matches rows means the two disagree:
  `X_BACKFILL_STALLED`, thrown inside the `try` so the ledger records `failed` and no completed row
  stops the next deploy re-running it. Its RESULT is parsed, never trusted — `NaN > 0` and `-1 > 0`
  are both false, so an unchecked bad number reads as "converged" and writes exactly the completed
  row the detector exists to prevent. Never a hardcoded "cleanups are production" and never a
  per-cleanup `dependsOn` graph: the real dependency is "after code tolerating both shapes is
  serving", which the framework cannot observe.
- **`gateBackfill()` RETURNS its refusal, it does not throw one.** `x db backfill --all` isolates
  per name and continues past a failure — a thrown verdict would let one wedged cleanup block every
  later one forever. Order is the order an operator can act in: environment, then the migration it
  waits on, then whether it already ran. A live pass is judged by the ENQUEUE and not here, because
  only the enqueue can see the one live idempotency key without racing it.
- **`inspectBackfills()` is the ONE projection of the ledger, and there is no second reader.**
  `backfill-inspect.ts` maps a `BackfillRun` to a plain JSON object (epochs to ISO, absent to
  `null`) for `x db backfill --list`, `x jobs ls`, `x jobs show` and `/_x`'s jobs panel — four
  surfaces that must not disagree about how many rows a pass has swept. It reads no clock: a
  running row's elapsed time is a different number in every process that asks, so `durationMs` is
  the pass's own completed span or `null`. It answers `[]` — never a throw — for a driver with no
  ledger, because `x jobs ls` is asked about the queue and must not fail over a fact nobody asked
  for; the surface that IS asking (`x db backfill --list`) says so in its own summary. `JobTrace`
  carries `backfill` for the same reason `steps` is on it: a step trace says which batch is next,
  the ledger row says what is behind it.
- **The ledger hangs off the queue driver (`driver.backfills`), optional like `introspect`.**
  `x_backfills` ships in `SQL_JOBS_TABLE`, so a ledger a pass cannot write is a queue it could not
  have been claimed from — and `dev-queue.ts` applies that one constant, so `x dev` and production
  create the same table. A driver that ships none (`driver-redis`, `driver-nats`, a hand-rolled
  one) runs backfills with NO bookkeeping rather than refusing them: nothing blocks a completed
  name there, and that degradation is the price of one install point.
- **`run-once` fires ONE catch-up, and the watermark is what makes it one.** `dispatch()` marks
  the occurrence it ran; under `run-once` that is the EARLIEST missed one, so the next round found
  the rest still due and fired the second, then the third — 24 nightly digests a second apart after
  a day down. The branch now marks `at` after dispatching, because dropping an occurrence means
  moving past it, and `at` rather than the last element of `due`, which `maxCatchUp` truncates.
  `skip` still fires the latest occurrence WITHIN the cap rather than the true latest missed —
  named in the README, unchanged here.
- **`relay.stop()` JOINS the pass in flight, and answers a promise for it** (`As of 2026-08`). It
  cleared the interval and returned — the one loop in this package whose `stop()` did not wait out
  its own work, where `worker.stop()` waits for its rounds and `scheduler.stop()` for its dispatch.
  A SIGTERM landing between `driver.enqueue` and `markPublished` returned to a caller that then
  closed the database under the row it was about to mark. `OutboxRelay.stop(): Promise<void>` — a
  caller that does not await gets what it always got (the chain carries its own `catch`), so the
  join is only as good as the `await`. Both of `packages/cli/src/dev-roles.ts`'s paths take it
  today (`:306` returns `() => relay.stop()` so the rollback awaits it, `:356` is
  `await relay?.stop()`); this file claimed the opposite until 2026-08.
- **The outbox claim is a LEASE, and one statement is what makes it one** (`As of 2026-08`).
  `SQL_OUTBOX_CLAIM` was a bare `select ... for update skip locked` run on the POOLED executor, and
  those row locks last only for their own statement — under autocommit they are gone before
  `claim()` resolves, and `x_outbox` had no claimed column, so nothing fenced the batch at all. Two
  relays 200ms apart read the identical rows and both published them. **The idempotency key does
  not collapse that in general**: `SQL_ENQUEUE`'s conflict target is the PARTIAL index over
  `('ready','delayed','running','suspended')`, so a repeat landing after the first job reached a
  terminal state inserts a second row and the handler runs twice. The mechanism is Postgres
  semantics; the second-publish-after-terminal ordering was argued, never reproduced — say it that
  way, in a comment or a changelog. The claim now stamps `claimed_at`/`claimed_by` in the same
  statement that locks (the CTE shape `SQL_CLAIM` already used), and the outer
  `select ... order by staged_at, id` is load-bearing: `update ... returning` has no defined row
  order and the relay publishes in the order it is handed rows. `claimed_at` is a LEASE and not a
  flag — without a reclaim window a relay that died mid-batch strands its rows forever — and
  `OutboxStore.release` (optional, so a store written before this still compiles) hands back the
  batch a failed publish stopped, or one pool blip would park committed work for a whole lease
  window instead of one poll interval. `createMemoryOutboxStore` answers the SAME question, on an
  injected clock, and `outbox-claim.test.ts` pins the two side by side.
- **The lease is fenced on EVERY outbox mutation, and the sort key is TOTAL** (`As of 2026-08`).
  Two holes the first version of the lease left open, both reachable without a second relay
  process. `SQL_OUTBOX_RELEASE` and `SQL_OUTBOX_MARK_PUBLISHED` matched on `id` alone, so a relay
  that stalled past its own lease still spoke for rows another relay had reclaimed: its late
  `release` unclaimed a batch mid-publish (a third relay claims it, publishes it again — the
  duplicate the lease exists to prevent, reached the long way round) and its late `markPublished`
  retired a row nobody had published, losing the job with nothing to notice. Both now carry
  `and claimed_by = $n`, `claim()` hands the token back as `OutboxRecord.claimedBy`, and the relay
  passes it to both calls. `markPublished` also gained `published_at is null`, so the stamp is
  first-writer-wins rather than a rewrite of an audit timestamp. The memory store fences the same
  way — per CLAIM there rather than per relay, because two relays there are two `claim()` calls on
  ONE store, and a per-store id could not tell them apart. **An absent token is NOT one rule in
  both**: `createMemoryOutboxStore`'s `owns(id, undefined)` answers `true` unconditionally, so a
  caller with no token really is unfenced there — while `createPgOutboxStore` substitutes
  `claimant ?? relayId` into `SQL_OUTBOX_RELEASE` and `SQL_OUTBOX_MARK_PUBLISHED`, both of which
  carry `and claimed_by = $n`, so a token-less call fences on THIS store's relay id and no-ops
  against a row some other relay holds. `outbox-pg.ts:159-165` is the honest comment. Neither store
  refuses such a caller, which is the shared half: a caller holding no token is one written before
  the fence.
  **`order by staged_at` was not a total order**: every row staged in one transaction shares a
  `staged_at`, so the tie was the planner's to break — which rows the `limit` takes, and in which
  order they publish, differed between two relays and between two runs of one. `, id` fixes it in
  the CTE and in the projection, and needed NO DDL: `id` is a UUIDv7 minted by `uuid()`, monotonic
  and already the primary key, so the tiebreak IS stage order. `byClaimOrder` in `outbox.ts` is the
  memory store's copy of that key.
- **`claimLeaseMs` is normalised in ONE place — `outbox-lease.ts`** (`As of 2026-08`). Both stores
  call `resolveClaimLeaseMs`, which owns `DEFAULT_OUTBOX_CLAIM_LEASE_MS` and refuses anything that
  is not a positive whole number of ms with `X_INVARIANT` (the generic, no new code: same borrow
  `@ultimat3/db` makes). A memory default and a pg default that could drift are two answers to
  "how long is a claim mine for", and the shorter one publishes a row twice. `0` expires before
  `claim()` resolves and `Infinity` never expires, so both are refused at CONSTRUCTION, not at the
  first tick where the only trace is a log line.
- **A renewal is decided against `stopped()`, not only against the interval** (`As of 2026-08`).
  `renewal-timer.ts` is the one shape, read by `heartbeat.ts` and `worker-fleet-slots.ts`, and it
  exists because both files reported a LOSS for a job that had finished cleanly: `stop()` cleared
  the interval, which does nothing to the request already on the wire, so the fenced statement came
  back `false` — the row left `running` when `executeJob` acked it — and that answer took the loss
  branch. `jobs.lease.lost` at error plus `recordLeaseLost(queue)` is the one signal meaning the
  queue re-delivered a job this process was still running, so a false one is a page for a
  non-event, and the window widens exactly when the pool is slow. Re-read the flag AFTER every
  await and inside the reporter, the way `settleWithin`'s `decided` does in core. **The interval is
  `unref`ed**, like all three of `sync-node.ts`'s: it is armed from inside a job run, so a drain
  that ABANDONS the worker's hook leaves the run — and this timer — with nobody left to call
  `stop()`, and a refed interval is then the one thing holding a drained process open until the
  kubelet's SIGKILL.
- **`stepTimeout` and `eventPoll` are DECLARED on the job, and `execute.ts` is the only place they
  are forwarded** (`As of 2026-08`). `StepRunnerOptions` carried both, `withStepTimeout`
  implemented the ceiling and `steps.test.ts` exercised it by building a runner BY HAND — while the
  only production construction passed neither and `JobDefinition` had no field that could. Same
  verdict as `job.concurrency`: a documented guarantee that silently does nothing is the worst of
  the three options, so it is threaded rather than deleted. Both are refused at declaration when
  non-positive, because `withStepTimeout` reads `<= 0` as "no ceiling at all".
- **`registeredJobs()`/`registeredTasks()` sort by CODE UNITS, never `localeCompare`.** The list is
  projected by `describeJobs()` into `x.manifest.json`, which both tracked apps commit and
  `x verify`'s `drift` step diffs byte for byte; `localeCompare` with no locale argument answers
  from the runtime's ICU default and collation version. Same rule as `@ultimat3/http`'s
  `describeRoutes`, restated locally rather than imported — `http` is not below this package.
- **A driver's semantics are pinned in ONE test with the pg statement beside them.**
  `driver-parity.test.ts` asserts the memory driver's behaviour and the SQL that has to mean the
  same thing in a single test, so neither side can move alone. `introspect.list` answered
  `createdAt` ASCENDING in memory and `created_at desc` in pg — one call, two answers, and because
  the limit lands after the sort, `x jobs ls` against `x dev` paged the hundred OLDEST rows. The
  `attempt` floor is the same shape: `greatest(attempt - 1, 0)` in pg, `Math.max(0, …)` in memory,
  with the settle fence in front of both. Two more closed `As of 2026-08`, and in BOTH the memory
  driver was the correct side:
  - **`SQL_LEASE_RENEW` fences on `expires_at > now()` as well as on `holder`.** The holder fence
    answers "another worker has this slot"; only the expiry fence answers "nobody has it YET". A
    lapsed slot is free for anyone's next `acquire`, so reviving it made the TTL an expiry other
    processes observed and the holder did not — and since `worker-fleet-slots.ts` reads `renew()
    === false` as `X_JOB_SLOT_LOST`, the same lapsed slot cancelled the run under `x dev` and
    silently continued in production. `createMemoryLeaseStore` has always purged on read.
  - **`SQL_STATS` puts a row in exactly ONE bucket.** `count(*) filter (where state = 'delayed' or
    run_at > now())` was every state's future row, so a `step.sleep` job counted as `suspended`
    AND `delayed` — the five buckets summed past the number of rows in the table. The memory
    driver's `if/else if` chain was always exclusive; the filter is now
    `state = 'delayed' or (state = 'ready' and run_at > now())`, which is that chain in SQL.
- **Every timer body catches before it finalises.** `worker.ts`, `scheduler.ts` and the outbox
  relay all spell `void work().catch(log).finally(...)`. The relay's missing `.catch` made a
  rejected `store.claim()` an unhandled rejection, and Bun ends the process on one — with every
  staged, unpublished row still staged.
- **The memory outbox store DELETES a published row.** `markPublished` rewriting it in place held
  every payload ever enqueued for the process's lifetime and made `claim()`/`pendingCount()` walk
  all of them each tick. `retained()` is the seam that makes the bound assertable; `published_at`
  stays a pg-only audit column.
- **`claimName` reads a Set; `usedNames()` is a bounded window.** `Array.includes` per claim made
  a `backfill()` over a million rows quadratic — 20,000 steps, ~200M string compares — and carried
  a 20,000-entry array to the end of the run. The trace keeps `MAX_TRACE_NAMES` (200), most recent,
  and duplicate detection never reads it: a name that scrolled out is still refused.
- **A `-fixture.ts` file is test material and does not ship** (`!src/**/*-fixture.ts` in `files`).
  `backfill-pass-fixture.ts` raises `BackfillHandleFailure`, a plain `Error` subclass on purpose:
  a backfill `handle` is app code and the pass propagates what it threw, so a framework code there
  would exercise a path no app takes.
- **Suspension is control flow, and a SHED is not a suspension** (`As of 2026-08`).
  `StepSuspension` -> `nack({ countsAsAttempt: false, park: true })`; never log it as an error,
  never let it burn an attempt. The two facts were ONE flag until 2026-08: a limiter shed and a
  `job.concurrency` shed both handed the job back with `countsAsAttempt: false`, and both drivers
  derived `deadLetter ? 'dead' : counts ? 'ready' : 'suspended'` — so a job that is merely WAITING
  was filed beside a 3-day sleep. `SQL_STATS` and the memory `stats()` then counted it out of
  `ready` and out of `oldest_ready_ms`, which `worker.ts` publishes as `queue_depth` and
  `queue_oldest_ready_seconds`: 20 jobs at `concurrency: 10` behind `createLimiter({ global: 1 })`
  read as a depth of 10 with 19 waiting, and under sustained overload the shed fraction approaches
  100%, so the HPA signal and the "oldest job older than 5 minutes" page both go quiet exactly
  when the queue is saturated. `park` is now the state and `countsAsAttempt` is the counter, only.
  The shed also wrote `last_error = 'limited: …'`, so `x jobs show` reported a failure for a job
  that never ran — it is a `jobs.worker.shed` log field now, and `worker.ts`'s one `shed()` is
  where both sheds go. `driver-parity.test.ts` pins which bucket each lands in, in both drivers.
- **No read returns a WHOLE row, and `driver-pg-sql.test.ts` is what enforces it** (`As of
  2026-08-22`). `PgExecutor` is an injected seam over any client that speaks `(text, values)`, and a
  client with no type map decodes `timestamptz` as TEXT — so `toJobRecord`/`toStepRecord` read
  `Number('2026-01-01 00:00:00+00')` and answered `NaN`. Six statements were `select *` /
  `returning *` and shipped that way: `pgStepStore.list`, `introspect.job`, `introspect.list`,
  `introspect.deadLetters`, `introspect.requeue` and `SQL_CANCEL`. Every one of them feeds a
  surface an operator reads — `x jobs ls`, `x jobs show`, `x jobs cancel` — and `SQL_CLAIM` had
  projected epoch ms all along, so the driver disagreed with itself. The guard is a scan of every
  production file in this directory, DISCOVERED rather than listed and with comments stripped: a
  `select *` anywhere in them, in either case, is a failing test rather than a review note. It
  reads the directory because the hand-kept list it replaces had already missed one
  (`driver-pg-ddl.ts`) — a registry a new SQL source opts out of by simply not joining it is a
  guard with the shape of a rule and none of the force.
- **A run's acquisitions are handed back even when the wiring throws.** `worker-run.ts` starts the
  lease heartbeat first, so every line between it and the `try` can leak an interval renewing the
  lease of a job that never ran, with nothing left holding a reference to stop it. `context()` was
  moved ABOVE the heartbeat for that reason; `createRunSignal` and `fleetSlots.startRenewal` — the
  second an injected seam whose production implementation reaches a lease store — are INSIDE the
  `try`, with `undefined` meaning "never taken" and both handbacks idempotent.
- Step results are persisted BEFORE the step returns. Keep it that way or replay breaks.
- All time is epoch ms from an injected `Clock`, read via `nowMs()` in `clock.ts`.
- Drivers implement exactly the six `JobDriver` methods plus optional `introspect`, `backfills`
  and `leases`. New capabilities go behind the interface, never as a driver-specific export.
- `inspect.ts` returns plain JSON-serialisable objects — CLI, `/_x` and MCP share them.
- **`x jobs cancel` binds to `cancelJob(driver, id, reason?)`, which REFUSES rather than answering
  a silent no-op.** An operator cancelling a 40M-row sweep has to know whether they stopped it or
  missed it, so a finished job is `X_JOB_NOT_CANCELLABLE` and a driver with no `cancel` is too.
- **The scheduler asks `leader.acquire()` EVERY round AND before EVERY task in it, not only while
  it thinks it is not the leader.** A lease-backed election expires, so `acquire()` is its renewal
  and a cached `isLeader = true` would keep dispatching past a lease another node already took.
  Per-task as well as per-round `As of 2026-08-23`: a round walks its tasks serially with an enqueue
  per job, so a 30s lease and a slow queue leave the tail of the walk running under a lease node B
  already holds — and **the occurrence key does not absorb that**, because `SQL_ENQUEUE`'s conflict
  target is the PARTIAL index over the live states, so a second dispatch landing after that
  occurrence's job completed or dead-lettered inserts a new row and the handler runs twice. Argued
  from the index definition, not reproduced — `stillLeading()` is the one place the question is
  asked and `break` is the answer, the same shape the drain's `dispatching()` check already had.
  `soleLeader` answers true every time and `createPgLeader` holds its grant behind an internal flag,
  so the extra calls are a no-op for both — the flag also stops Postgres refcounting a second advisory
  grant that `release()`'s single unlock would never hand back.
- **`createPgLeader` is correct only on a DEDICATED connection and boot has a pool.** A
  session-level `pg_try_advisory_lock` is released when its connection returns to the pool, so
  every node reads itself as leader. `@ultimat3/realtime`'s `PgAdvisoryLock` owns its connection
  and is the shape that gets this right; this package holds no wire protocol, so it answers with a
  row that has an expiry instead — `createPgLeaseLeader`. Use that one.
- **`step.run` hydrates the run's steps from ONE `store.list(runId)` and consults it before
  `store.get`.** A `backfill()` over 5M rows at `batch: 1000` killed at batch 4,800 used to issue
  4,800 sequential `SQL_STEP_GET`s before reading a new row, re-paid on every retry and, on a slow
  pool, outrunning its own visibility timeout while the heartbeat was still renewing. Sound only
  because the `put` fence is: one attempt owns the run, so an absent name stays absent unless this
  runner writes it — every write updates the view, including the failure branch's direct
  `store.put`. `put` itself is UNCHANGED; the fence at `steps.ts` is the correctness boundary.
- **`sleep` and `waitForEvent` record a replay through `trace()`, never `replayed.push`.** `trace`
  is what enforces `MAX_TRACE_NAMES`; the raw push let a long run's replayed-name array grow
  unbounded, which is the exact leak the bound exists to prevent.
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim**, so a job/task file imports
  one package. Never wrap, spread or re-declare it: `t` delegates to `schemaProvider()` on every
  access, and a copy would freeze the provider at import time. `index.test.ts` asserts identity.

## Known coupling to other packages

`clock.ts` calls `parseDuration(str)` and `scheduler.ts` calls
`nextCronOccurrence(cron, { tz, from })`. Both are normalised in one place each
(`toMs`, `defaultCronResolver`) and the scheduler's resolver is injectable, so a signature
change in `@ultimat3/time` is a one-line fix, not a sweep.

`driver-pg.ts`'s `PgExecutor` (`:62-64`) is a one-method duck-typed interface — this package still
has no `@ultimat3/db` dependency, and nothing here knows what an observer, a span or
`expectedQueryLoop` is. But `packages/cli/src/dev-queue.ts` is the only boot code in the repo that
ever builds one, and it wraps a real `@ultimat3/db` client's `.query()` — reached by every role in
production, not just `x dev`. So a queue statement issued through the framework's own wiring does
pass through `@ultimat3/db`'s statement observer today, with no `attribution` — and `As of 2026-08`
that **is** a narrow gap here, where it was none before: `@ultimat3/entity`'s `postgresRepo` now
declares the `{entity, op}` pair through `withStatementAttribution`, so an entity read sharing the
process carries it while a claim, an ack, a nack, an enqueue or a heartbeat does not. Nothing is
wrong in this package for it — `driver-pg.ts` compiles its SQL straight against `PgExecutor` rather
than through a repository, so no frame above a queue statement has an entity to name, and a
detector reading `attribution` sees a claim loop as anonymous SQL until this package threads a pair
of its own. That is future work, deliberately not reached from the `db` side. The visibility itself
is a
property of what `dev-queue.ts` happened to hand over, never of this package's own contract — an
executor backed by something else (a raw driver, `driver-redis`, `driver-nats`) is invisible to it,
same as before this seam existed. See `packages/db/CLAUDE.md`'s `observe.ts` section for the full
picture from the other side.

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
| `outbox.ts` | staging in a `Tx`, the relay, the ambient `JobsFacade` slot |
| `outbox-pg.ts` | `createPgOutboxStore` — `stage()` on the caller's OWN connection, claim on the pool |
| `outbox-lease.ts` | the claim lease's one definition and its one normalisation, for both stores |
| `leases.ts` | `LeaseStore` — fleet-wide slots, the memory one, `jobLeaseKey` |
| `metrics.ts` | `queue_oldest_ready_seconds` and `queue_dead_jobs`, the two alertable gauges |
| `scheduler-pg.ts` | `pgSchedulerState` (the durable watermark) + `createPgLeaseLeader` |
| `events-pg.ts` | `createPgEventBus` — `step.waitForEvent` across processes |
| `driver.ts` | `JobDriver` contract + wire records |
| `driver-pg.ts` | default driver, real SQL constants, and `createPgLeader` — the advisory-lock election that is **not** what a scheduler uses; `scheduler-pg.ts` above owns the lease-row one boot wires |
| `driver-pg-ddl.ts` | `SQL_JOBS_TABLE` + `SQL_OUTBOX_TABLE` — the schema the driver installs. Whichever file holds the DDL is the one whose comments may carry no `;` and no `'` |
| `driver-pg-jobs-sql.ts` | every statement returning a whole `x_jobs` row, and the `JOB_ROW_COLUMNS` projection they share. Split off at `driver-pg-sql.ts`'s size ceiling and re-exported from it |
| `driver-pg-rows.ts` | a Postgres row → a wire record: `JobRow`/`StepRow`/`BackfillRow` and their mappings |
| `driver-memory.ts` | `x dev` / tests |
| `driver-redis.ts`, `driver-nats.ts` | honest `X_NOT_IMPLEMENTED` stubs |
| `retry.ts` | the dead-letter decision, and this package's option names over core's `backoffDelay` — no curve of its own |
| `retry-classification.ts` | the OTHER half of that decision: what the thrown error says, and the stop reason the row and the log carry |
| `execute.ts` | `executeJob` — one claimed job run and settled, and the run's deadline/cancel |
| `heartbeat.ts` | one claimed job's lease: the renewal interval and the loss it reports |
| `renewal-timer.ts` | the interval a renewal runs on, and the `stopped()` latch every branch after an await re-reads |
| `worker.ts` | `worker` role, claim loop, drain |
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

The pass is pinned across three files off **one** fixture. `backfill-pass-fixture.ts` owns the
harness — a real `@ultimat3/entity` chain over a real `memoryRepo`, wrapped so statements,
iterations and closes are counted, plus `installLedger()`; `backfill-pass.test.ts` drives the
iteration and its checkpoints, `backfill-pass-ledger.test.ts` the `x_backfills` row the same pass
writes. Split at the 500-line ceiling, and shared rather than copied because two harnesses that
drifted would be two different passes agreeing only by construction. The throttle left earlier, as
`backfill-throttle.test.ts` with a fixture of its own (it needs a clock the pacer can be watched
against, which the shared harness deliberately does not have).

`*.job.test.ts` is the opt-in suite the `job` verify step runs: `replay.job.test.ts`,
`idempotency.job.test.ts` and `outbox-atomicity.job.test.ts` each prove one named guarantee (step
replay, idempotency dedupe, outbox atomicity) through a REAL worker — `start()`/`stop()` and its
own poll loop, never `tick()` driven by hand. `worker-soak.job.test.ts` runs several real workers
against one shared driver with one killed mid-job (its queue connection severed, not a clean
`stop()`) and asserts every job still reaches a terminal state and the work behind it runs exactly
once. Collected by bare `bun test`, excluded from `bun run test`.

## Commands

```
bun test packages/jobs
bun run --filter @ultimat3/jobs typecheck
```
