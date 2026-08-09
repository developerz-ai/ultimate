# @ultimat3/jobs — agent notes

Tier 3. The `job` + `task` primitives, durable steps, transactional outbox, queue drivers.

## Boundary

- May import: `core`, `schema`, `entity`, `policy`, `cache`, `time`. Never `http`, `render`, `ui`.
- Consumers: `action` (`ctx.jobs.enqueue`), `cli`, `mcp`, `admin`.
- External deps: none. Postgres access goes through the injected `PgExecutor`.

## Rules

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

## Files

| File | Owns |
|---|---|
| `job.ts` | the `job()` primitive + registry + the handle's fluent surface |
| `describe.ts` | the JSON projection one handle emits; `describeJobs()` is a map over it |
| `steps.ts` | `StepStore`, `StepApi`, memoized-replay executor, `StepSuspension` |
| `outbox.ts` | staging in a `Tx`, the relay, the ambient `JobsFacade` slot, outbox SQL |
| `driver.ts` | `JobDriver` contract + wire records |
| `driver-pg.ts` | default driver, real SQL constants, advisory-lock leader |
| `driver-memory.ts` | `x dev` / tests |
| `driver-redis.ts`, `driver-nats.ts` | honest `X_NOT_IMPLEMENTED` stubs |
| `retry.ts` | backoff arithmetic, dead-letter decision |
| `worker.ts` | `worker` role, claim loop, `executeJob`, drain |
| `scheduler.ts` | `task()` primitive, `scheduler` role, catch-up, leader election |
| `limits.ts` | per-tenant / per-queue / global concurrency + rate |
| `events.ts` | stored event bus for `step.waitForEvent` |
| `inspect.ts` | `--json` introspection |

## Commands

```
bun test packages/jobs
bun run --filter @ultimat3/jobs typecheck
```
