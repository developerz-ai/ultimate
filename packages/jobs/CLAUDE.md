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
- **`x_backfills` is what has already been SWEPT, and the step checkpoints are where a pass
  resumes. Never the other way round.** The ledger row (`backfill-ledger.ts`) is a report an
  operator reads and the record that a completed name is done; the checkpoints are written in step
  with the work. A resume driven off `last_cursor` would be a second answer to "where were we"
  against a row that is not transactional with the rows it describes. Keyed by RUN, not by name,
  because `force` writes a NEW row rather than editing the one it reruns — history, not an edit of
  it. Only `completed` blocks: a `running` row is this pass resuming or one holding the single live
  idempotency key, a `failed` one is an attempt the queue is about to retry, and `start()` puts an
  adopted row back to `running` keeping the `started_at` the PASS began at. A moved checksum WARNS
  and still does not run — it hashes `source` and `handle`'s source text with a `\u0000` between
  them (raw concatenation would hash a boundary, not a pair), and a bundler moves that text without
  a line of behaviour changing, which is why `@ultimat3/db`'s `auditLedger` may throw on the same
  fact and this may not. `force` is the only override, and it rides the input rather than the
  idempotency key: one live pass per name, forced or not, or "kick it again" becomes a second
  writer on one table.
- **The ledger hangs off the queue driver (`driver.backfills`), optional like `introspect`.**
  `x_backfills` ships in `SQL_JOBS_TABLE`, so a ledger a pass cannot write is a queue it could not
  have been claimed from — and `dev-queue.ts` applies that one constant, so `x dev` and production
  create the same table. A driver that ships none (`driver-redis`, `driver-nats`, a hand-rolled
  one) runs backfills with NO bookkeeping rather than refusing them: nothing blocks a completed
  name there, and that degradation is the price of one install point.
- Suspension is control flow: `StepSuspension` -> `nack({ countsAsAttempt: false })`.
  Never log it as an error, never let it burn an attempt.
- Step results are persisted BEFORE the step returns. Keep it that way or replay breaks.
- All time is epoch ms from an injected `Clock`, read via `nowMs()` in `clock.ts`.
- Drivers implement exactly the six `JobDriver` methods plus optional `introspect` and
  `backfills`. New capabilities go behind the interface, never as a driver-specific export.
- `inspect.ts` returns plain JSON-serialisable objects — CLI, `/_x` and MCP share them.
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
| `backfill-ledger.ts` | `x_backfills` — the contract, the checksum, the verdict, the memory ledger |
| `register.ts` | `registerJobs`/`registerTasks` over a module namespace + the registrar announcements |
| `describe.ts` | the JSON projection one handle emits; `describeJobs()` is a map over it |
| `steps.ts` | `StepStore`, `StepApi`, memoized-replay executor, `StepSuspension` |
| `outbox.ts` | staging in a `Tx`, the relay, the ambient `JobsFacade` slot, outbox SQL |
| `driver.ts` | `JobDriver` contract + wire records |
| `driver-pg.ts` | default driver, real SQL constants, advisory-lock leader |
| `driver-memory.ts` | `x dev` / tests |
| `driver-redis.ts`, `driver-nats.ts` | honest `X_NOT_IMPLEMENTED` stubs |
| `retry.ts` | backoff arithmetic, dead-letter decision |
| `execute.ts` | `executeJob` — one claimed job run and settled, and the run's deadline/cancel |
| `heartbeat.ts` | one claimed job's lease: the renewal interval and the loss it reports |
| `worker.ts` | `worker` role, claim loop, drain |
| `task.ts` | the `task()` primitive + registry + the handle's surface + `registerTask` |
| `scheduler.ts` | `scheduler` role: the dispatch round, catch-up, leader election, the drain |
| `limits.ts` | per-tenant / per-queue / global concurrency + rate |
| `events.ts` | stored event bus for `step.waitForEvent` |
| `inspect.ts` | `--json` introspection |

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
