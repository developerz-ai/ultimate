# 39 — Durable compensation and at-most-once steps

> Part of [`overview.md`](overview.md). Depends on: [`06-jobs-step-semantics.md`](06-jobs-step-semantics.md), [`34-idea-jobs-event-wait.md`](34-idea-jobs-event-wait.md), same file. Tier: 3 (`jobs`), 5 (`cli`).

## Why
Charge, reserve, ship: the third fails for good, and the first two must be undone. The obvious spelling is wrong today. `try { await step.run('charge', …); await step.run('ship', …) } catch { await step.run('refund', …) }` refunds on attempt 1 of a retryable failure, before the retry that charges from replay and ships. Guarding with `finalAttempt` (`execute.ts:259`) misses a crash on the final attempt: the claim buries the row (`SQL_CLAIM`, `attempt >= max_attempts`) and no body runs. So a money bug passes every test but the outage. Likewise a vendor call with no idempotency key: at-least-once replays it after a crash, and there is no way to say "never twice".
Recorded objections: a new row state across three drivers, and unclear `once` semantics. Answers below: compensation adds no state, and `once` has one rule.

## Decisions: compensation
| Question | Answer |
|---|---|
| Declaration | `step.run(name, fn, { compensate: (output, { signal }) => … })`, and `job({ compensates: true })`. Using the first without the second is refused at the call |
| How it knows what to undo | the body replays from the top, so each `step.run` re-registers its closure. No closure is stored, and determinism is already every body's rule |
| When | failed for good only: `!decision.retry` (`execute.ts:369`). Never for a cancel, a drain or a suspension |
| Order, durability | LIFO. Each runs as ordinary step `compensate:<name>`, so a replay skips what ran. No new status, table or driver method |
| The durable decision | step `unwinding` is written before the first compensator. Seen on hydration, the run is in unwind mode whichever attempt it is on, so `x jobs retry` continues the unwind instead of running forward |
| A crash on the final attempt | `compensates: true` enqueues `max_attempts = attempts + 2` while `isFinalAttempt` keeps reading `handle.retry`. The claim re-offers a lapsed row; an attempt past `retry.attempts` is unwind mode: replay until the first incomplete step, which throws a private sentinel (the `StepSuspension` shape), then unwind. Burial now means two crashes during unwinding, and the row is `dead` with `unwinding` visible |
| A compensator fails | one try per attempt; retried by attempts left; then dead-lettered `X_JOB_COMPENSATION_FAILED` naming the step. `x jobs retry` resumes |
| What the operator sees | the original failure stays `last_error`; `x jobs show` lists `compensate:*` from the steps it already reads |
| A job without `compensates` | no path changes: `max_attempts`, claim, executor identical |
| Reserved names | `unwinding` and `compensate:*` are the framework's. `steps.ts` refuses them on `run`, `sleep` and `waitForEvent` for every job, so a job gaining `compensates` later cannot collide with a step it already wrote |
| A workflow engine, a ninth primitive | no. An option on `step.run` |

## Decisions: `once`
| Question | Answer |
|---|---|
| Declaration | `step.run(name, fn, { once: true })` |
| The one rule | a `started` row is persisted before `fn`. Any replay finding `started` or `failed` without `completed` stops with terminal `X_STEP_OUTCOME_UNKNOWN`: a crash or a throw both leave "did it happen?" unanswered, and only a person or the vendor can answer |
| Resolving | `x jobs resolve-step <jobId> <step> --ran --output '<json>'` writes `completed`; `--not-ran` writes `cleared`, which re-runs. Then `x jobs retry` |
| New statuses | `started`, `cleared` in `STEP_STATUSES` (`steps.ts:33`). Pass-through on all three stores: `status` is `text` with no CHECK, the Redis hash holds JSON, memory a record. `isStepStatus` narrows the read |
| With `compensate` | legal. Unwinding meets an unknown `once` step and stops, dead-lettered with both named: undoing something that may not have happened is the operator's call |
| Drain | an abort mid-`once` is an unknown outcome like any other |

## Files to change
- `packages/jobs/src/steps.ts:33,96-120,294-368` — options, statuses, reserved names, registration, `unwind()`, unwind mode; `steps-suspension.ts` — sentinel.
- `packages/jobs/src/execute.ts:260,369-395` — call `runner.unwind()` before the nack when failed for good; handle the sentinel.
- `packages/jobs/src/job.ts:125,281` — `compensates`; `outbox.ts:294,341` — `maxAttempts` with the margin; `retry.ts:85` — `isUnwindAttempt`, beside `isFinalAttempt`.
- `packages/jobs/src/errors.ts`, `introspection.ts`, `driver-memory-operator.ts`, `driver-pg-operator.ts`, `driver-redis*.ts` — `resolveStep`, one `StepStore.put`, fenced to a non-running job.
- `packages/cli/src/cmd-jobs*.ts` — `resolve-step`, `--json`; `wiki/CLI-Reference.md`.
- `examples/dummy/apps/web/app/*/jobs/` — one job, since this is primitive-level. `wiki/Jobs-And-Workflows.md`, `wiki/Error-Codes.md`, `packages/jobs/{README,CLAUDE}.md`, `docs/history/jobs.md`. `90-deferred.md`'s row via the coordinator.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_JOB_COMPENSATION_FAILED` (terminal, off-socket) | a compensator exhausted its attempts, or met an unknown `once` | fix it, then `x jobs retry <id>`: completed compensators replay |
| `X_STEP_OUTCOME_UNKNOWN` (terminal, off-socket) | a `once` step started and never completed | check the vendor, then `x jobs resolve-step <id> <step> --ran --output '<json>'` or `--not-ran`, then `x jobs retry <id>` |
| `X_JOB_DECLARATION_INVALID` (existing) | `compensate` without `compensates: true`; a step named `unwinding` or `compensate:*` | add it to the `job()`; rename the step |

`bun run new-error-code <CODE> --package jobs --title '…' --cause '…' --fix '…' --off-socket`, then register `terminal`.

## Tests
- `packages/jobs/src/step-compensate.test.ts` (`runJobs`): attempt 1 fails retryably, no compensator runs, attempt 2 succeeds: the `try/catch` bug absent. Terminal failure: LIFO, once each. Failed compensator resumes on retry; completed not re-run. A body's `step.run('unwinding', …)` and `step.run('compensate:x', …)` refused.
- `packages/jobs/src/step-compensate.job.test.ts` (real driver): lease lapses on the final attempt, the claim re-offers, unwind runs, row ends `dead` with the original error. Two lapses bury it.
- `packages/jobs/src/step-once.test.ts`: first run writes `started` before `fn` (assert order); crash replay raises the code without calling `fn`; throw likewise; both resolutions.
- `driver-parity.test.ts`, `driver-redis*.test.ts`: new statuses round-trip, `resolveStep` parity. `bun test packages/jobs/src/step-compensate.test.ts`

## Semver
**Breaking, two rows.** `STEP_STATUSES` is exported (`jobs/src/index.ts:342`) and gains `started`, `cleared`, so `StepStatus` widens and an exhaustive `switch` stops compiling. `unwinding` and `compensate:*` become reserved. Upgrading: "Handle `started` and `cleared` in a `switch` over `StepStatus`. Rename a step called `unwinding` or `compensate:*`." The options are additive.

## Done when
- A forced crash on the final attempt still runs compensators, on Postgres.
- A `once` step never runs twice without a person's command.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.

## Risks
- A body that branches on non-step state can register different closures on replay. Same rule as every replay; stated in the wiki.
- `max_attempts` margin shows in `x jobs show`: label it.
- **Not run as a probe:** this design is from source reads. The `.job` test is the proof; if a lapsed row cannot be re-offered as drafted, the crash row reverts to dead-letter visible and the slice says so.
