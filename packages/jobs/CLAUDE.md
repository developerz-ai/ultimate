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
- `tz` is NON-OPTIONAL in `TaskDefinition`, and checked against the runtime's IANA database —
  a non-empty string is not a timezone. A task never contains a handler body.
- **One enqueue implementation.** Everything (`handle.enqueue`, `handle.as`, `task.enqueue`)
  goes through `jobsFacade()`; the only other `driver.enqueue(...)` call sites are the outbox
  relay and the scheduler's occurrence dispatch. Never add a third.
- `handle.as(actor, input)` QUEUES. A job's execution surface is the queue, so it must never
  run the handler inline — `worker.ts`'s `executeJob` is the one execution path.
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
  it. The promise is cleared as it settles — a close that threw is retryable, not replayed.
- Suspension is control flow: `StepSuspension` -> `nack({ countsAsAttempt: false })`.
  Never log it as an error, never let it burn an attempt.
- Step results are persisted BEFORE the step returns. Keep it that way or replay breaks.
- All time is epoch ms from an injected `Clock`, read via `nowMs()` in `clock.ts`.
- Drivers implement exactly the six `JobDriver` methods plus optional `introspect`.
  New capabilities go behind the interface, never as a driver-specific export.
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
| `register.ts` | `registerJobs`/`registerTasks` over a module namespace + the registrar announcements |
| `describe.ts` | the JSON projection one handle emits; `describeJobs()` is a map over it |
| `steps.ts` | `StepStore`, `StepApi`, memoized-replay executor, `StepSuspension` |
| `outbox.ts` | staging in a `Tx`, the relay, the ambient `JobsFacade` slot, outbox SQL |
| `driver.ts` | `JobDriver` contract + wire records |
| `driver-pg.ts` | default driver, real SQL constants, advisory-lock leader |
| `driver-memory.ts` | `x dev` / tests |
| `driver-redis.ts`, `driver-nats.ts` | honest `X_NOT_IMPLEMENTED` stubs |
| `retry.ts` | backoff arithmetic, dead-letter decision |
| `worker.ts` | `worker` role, claim loop, `executeJob`, drain |
| `scheduler.ts` | `task()` primitive + registry + `registerTask`, `scheduler` role, catch-up, leader election |
| `limits.ts` | per-tenant / per-queue / global concurrency + rate |
| `events.ts` | stored event bus for `step.waitForEvent` |
| `inspect.ts` | `--json` introspection |

## Commands

```
bun test packages/jobs
bun run --filter @ultimat3/jobs typecheck
```
