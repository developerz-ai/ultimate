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
- **The idempotency namespace is `(name, idempotency_key)`, never the key alone** (`As of
  2026-08`). It was the key alone, and that is silent data loss with no error anywhere: two jobs
  that derive the same natural key from the same input — `sendWelcomeEmail` and
  `provisionWorkspace` both keyed `user:${id}` — shared one namespace, so the second enqueue hit
  `on conflict do nothing`, fell through to `SQL_FIND_LIVE_BY_KEY`, found the FIRST job's row and
  returned `{ id: <A's>, deduped: true }`. The workspace was never provisioned and `x jobs ls`
  showed one healthy job. Three places have to agree and a test pins them together: the index, the
  conflict target, and the live-row lookup. `x_jobs` SHIPPED, so the DDL `drop index if exists`es
  the old one — left in place it would keep enforcing exactly the collision this fixes. The
  scheduler's occurrence key already prefixes the task name and is unaffected.
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
- **One shutdown hook per worker, and `stop()` is what hands it back.** `start()` keeps the
  unregister `onShutdown` returns; the teardown releases it in a `finally`, so a close that threw
  still gives it up. Discarding it was a hook per `start()` — the `start()` guard reads a
  standstill, so start -> stop -> start stacked a second registration retaining a stopped
  worker's driver, and the next process-wide drain ran all of them. `start()` refuses while
  draining for the same reason: a claim loop back on a driver the drain is about to close.
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
  dispatching" means this round too. Same hook rules as the worker: one `onShutdown` at the
  `accept` phase while it runs, handed back in the teardown's `finally` so a `release()` that
  threw still gives it up, `isLeader` cleared there too because a lock this process could not
  hand back is never treated as still held.
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
- **`handle` is AT LEAST ONCE, and the ordering that makes it so is deliberate.** The body runs
  inside the step and the record is written after it returns, so an attempt killed, cancelled or
  lease-expired between the two hands that page to the next attempt — which is why the doc comment,
  the CHANGELOG, `CLAUDE.md` and `x g backfill`'s generated source all say the handler must be
  idempotent. Never invert it: checkpointing first would report a page as swept that nobody wrote,
  and a lost page is unrecoverable where a repeated one is the handler's problem.
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
- Suspension is control flow: `StepSuspension` -> `nack({ countsAsAttempt: false })`.
  Never log it as an error, never let it burn an attempt.
- Step results are persisted BEFORE the step returns. Keep it that way or replay breaks.
- All time is epoch ms from an injected `Clock`, read via `nowMs()` in `clock.ts`.
- Drivers implement exactly the six `JobDriver` methods plus optional `introspect`, `backfills`
  and `leases`. New capabilities go behind the interface, never as a driver-specific export.
- `inspect.ts` returns plain JSON-serialisable objects — CLI, `/_x` and MCP share them.
- **`x jobs cancel` binds to `cancelJob(driver, id, reason?)`, which REFUSES rather than answering
  a silent no-op.** An operator cancelling a 40M-row sweep has to know whether they stopped it or
  missed it, so a finished job is `X_JOB_NOT_CANCELLABLE` and a driver with no `cancel` is too.
- **The scheduler asks `leader.acquire()` EVERY round, not only while it thinks it is not the
  leader.** A lease-backed election expires, so `acquire()` is its renewal and a cached
  `isLeader = true` would keep dispatching past a lease another node already took. `soleLeader`
  answers true every time and `createPgLeader` holds its grant behind an internal flag, so the
  extra call is a no-op for both — the flag also stops Postgres refcounting a second advisory
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

`driver-pg.ts`'s `PgExecutor` (`:38-41`) is a two-method duck-typed interface — this package still
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
| `backfill.ts` | `backfill()` — a factory over `job()`: the declaration, its checksum and its input |
| `backfill-pass.ts` | one pass: the batched iteration, its cursor checkpoints and its ledger row |
| `backfill-ledger.ts` | `x_backfills` — the contract, `BACKFILL_STATUSES`, the checksum, the verdict, the memory ledger |
| `backfill-registry.ts` | what was DECLARED: the `origin` stamp, `isBackfill`, `registeredBackfills` |
| `backfill-gate.ts` | may this sweep run here and now — environment, `requires`, already-applied |
| `backfill-pending.ts` | declared minus completed, per environment: the alarm `--pending` reads |
| `backfill-rate.ts` | the `rate` throttle: batches/sec as an interval, and the cancellable wait |
| `backfill-inspect.ts` | the ledger projected for `x db backfill`, `x jobs`, `/_x` and MCP |
| `register.ts` | `registerJobs`/`registerTasks` over a module namespace + the registrar announcements |
| `describe.ts` | the JSON projection one handle emits; `describeJobs()` is a map over it |
| `steps.ts` | `StepStore`, `StepApi`, memoized-replay executor, `StepSuspension` |
| `outbox.ts` | staging in a `Tx`, the relay, the ambient `JobsFacade` slot |
| `outbox-pg.ts` | `createPgOutboxStore` — `stage()` on the caller's OWN connection, claim on the pool |
| `leases.ts` | `LeaseStore` — fleet-wide slots, the memory one, `jobLeaseKey` |
| `metrics.ts` | `queue_oldest_ready_seconds` and `queue_dead_jobs`, the two alertable gauges |
| `scheduler-pg.ts` | `pgSchedulerState` (the durable watermark) + `createPgLeaseLeader` |
| `events-pg.ts` | `createPgEventBus` — `step.waitForEvent` across processes |
| `driver.ts` | `JobDriver` contract + wire records |
| `driver-pg.ts` | default driver, real SQL constants, advisory-lock leader |
| `driver-pg-ddl.ts` | `SQL_JOBS_TABLE` + `SQL_OUTBOX_TABLE` — the schema the driver installs. Whichever file holds the DDL is the one whose comments may carry no `;` and no `'` |
| `driver-pg-rows.ts` | a Postgres row → a wire record: `JobRow`/`StepRow`/`BackfillRow` and their mappings |
| `driver-memory.ts` | `x dev` / tests |
| `driver-redis.ts`, `driver-nats.ts` | honest `X_NOT_IMPLEMENTED` stubs |
| `retry.ts` | backoff arithmetic, dead-letter decision |
| `execute.ts` | `executeJob` — one claimed job run and settled, and the run's deadline/cancel |
| `heartbeat.ts` | one claimed job's lease: the renewal interval and the loss it reports |
| `worker.ts` | `worker` role, claim loop, drain |
| `worker-fleet-slots.ts` | the fleet slot an in-flight job holds — take, renew, hand back. The claim loop asks "may I start this one?"; this answers it across the fleet |
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
