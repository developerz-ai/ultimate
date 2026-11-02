# 34 — An event wait: atomic answer, parsed payload

> Part of [`overview.md`](overview.md). Depends on: [`06-jobs-step-semantics.md`](06-jobs-step-semantics.md), same file, land after it. Tier: 3 (`jobs`), 5 (`cli`).

## Why
Guarantee, from a typed-effect library's durable deferred: an answer belongs to the unit of work that gave it and is decoded by a declared schema. Two holes, each probed 2026-11-02:
- **A rolled-back answer still resumes the run.** `cli/src/runtime-queue.ts:198` builds the bus on the pool; the outbox beside it takes `currentTx()` (`:193`). Real Postgres: `withTransaction` publishes, then throws. Printed: `after rollback, waiter finds: {"payload":{"by":"ada"},…}`. An approval the business rule refused pays the invoice.
- **The payload is a cast.** `waitForEvent<T>` (`jobs/src/steps.ts:116`) returns `hit.payload as T` (`:438`). Published `{ amount: 'twelve' }`, typed `{ amount: number }`: printed `"twelve" string`. The type is whatever the waiter wrote; publisher and waiter are usually different files.

## Decisions
| Question | Answer |
|---|---|
| New wait primitive, tokens, a workflow engine | no. Same step, same bus, same `x_job_events` |
| Optional `schema` | no. Optional is a convention; required is one spelling, and no call site in either tracked app exists to migrate |
| Bad payload | terminal, not skipped: skipping hides the publisher's bug until the timeout |
| Publish after commit via `onCommit` | no. A crash between commit and insert loses the answer; `publish` also answers its own stamps, which a deferred write cannot |
| Waking a parked run at commit | cut from this slice. A run keeps polling at 30 s; latency to resume is unchanged |
| Compensation, `step.once` | still killed, [`90-deferred.md`](90-deferred.md): no new adopter evidence |

## Files to change
- `packages/cli/src/runtime-queue.ts:198` — `postgresEventBus({ executor: dbExecutor(() => currentTx() ?? client) })`, the same expression as `:193`.
- `packages/jobs/src/steps.ts:96-120` — `WaitForEventOptions<S>` with a required `schema: S`; `waitForEvent<S extends StandardSchemaV1>(name, event, options): Promise<InferOutput<S> | undefined>`.
- `packages/jobs/src/steps.ts:411-438` — `validateAsync` on the stored payload, on a hit and on a replay, so both attempts see one value. The stored form stays raw. `waitForEvent`'s `T` goes.
- `packages/jobs/src/errors.ts` — the code, classified `terminal`.
- `packages/jobs/src/steps.test.ts:195,219`, `step-options.test.ts`, `steps-event-clock.test.ts`, `events-pg.job.test.ts` — pass a schema.
- `packages/jobs/src/type-pins.ts` — return type follows the schema; a missing `schema` fails to compile.
- Docs: `wiki/Jobs-And-Workflows.md:77,160`, `wiki/Error-Codes.md`, `wiki/Upgrading.md`, `packages/jobs/README.md:189,639`, `packages/jobs/CLAUDE.md`. `:160` also gains one line: `'wait'` holds the cap and states no order, a later enqueue can start first. Probe: `created,paid,cancelled` enqueued, `created,cancelled,paid` ran. A per-key queue needs a stored key and a new claim path on three drivers; no adopter asked.

## Steps
1. `bun run new-error-code X_JOB_EVENT_INVALID --package jobs --title 'a waited event failed its schema' --cause '…' --fix '…' --off-socket`, registered `terminal`.
2. Failing tests first, below.
3. Boot executor. Then the schema.
4. Issues only in the error, never the payload: an event can carry anything (`formatIssues`).
5. Regenerate `framework.manifest.json` once; the coordinator owns it.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_JOB_EVENT_INVALID` | the event found for `step.waitForEvent` fails the wait's `schema`, on a hit or a replay | make the publisher of `<event>` send what the wait's schema declares, or widen that schema; `x jobs retry <id>` once fixed |

## Tests
- `packages/jobs/src/events-pg.job.test.ts`: publish inside a rolled-back `withTransaction` on a pooled client, `find` answers `undefined`. Fails today. On the embedded single-session database a statement runs inside the open transaction anyway, so this case needs `TEST_DATABASE_URL`: put it in a `.live.test.ts`, which is the only suite that can fail on it.
- `steps.test.ts`: a bad payload raises the code with `stoppedBy: 'terminal'`, the error text holds no payload value; first run and replay `toEqual`.
- `bun test packages/jobs`; `bun run x -- verify --only live,job`.

## Semver
Breaking. Upgrading: `schema` is required on `step.waitForEvent`, and `<T>` is gone: pass a schema. `publishEvent` inside a transaction now commits and rolls back with it.

## Done when
- The rollback probe prints `undefined`.
- A wrong payload fails with the code on attempt 1; no cast remains at `steps.ts:438`.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.

## Risks
- **Stamp before commit.** `published_at` is the statement's time. A wait that begins between publish and commit compares later than the stamp and never matches; the window is the length of the publishing transaction. `required: true` surfaces it as `X_JOB_TIMEOUT`. Today's autocommit has no such window, and it has the rollback hole, which is worse.
- **Not run:** the Redis driver.
