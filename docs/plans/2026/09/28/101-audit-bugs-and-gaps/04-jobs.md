# 04 — jobs: retry, lease, scheduler

> Part of [`overview.md`](overview.md). Depends on: 02 (only for the scheduler's transactional fire). Tier: 3.

> **Done, 2026-10-01** — all four steps, under
> [plan 2026/10/01/101](../../../10/01/101-platform-readiness-for-big-systems/overview.md) slices 05–06
> and their follow-ups:
>
> | Step | Where |
> |---|---|
> | 1 terminal drop | `nack({ fail })` → row `failed`, outcome `dropped`; `packages/jobs/src/execute-retry.test.ts`, `driver-settle-parity.test.ts` |
> | 2 owner fence | `ack` / `nack` fenced on the claim (`claimOf(claimed)`, `x_jobs.claims`), which also closes a same-worker re-claim; `driver-parity.test.ts` on both drivers |
> | 3 atomic fire | `SchedulerState.fire` / `SQL_SCHEDULER_FIRE`, the watermark as fence; the scheduler tests |
> | 4 relay deadline | bound late, the worker's `DrainBudget` shape; `outbox-relay.test.ts` |
>
> `execute.ts` does not pre-check `heartbeat.lost()` (step 2's last sentence): the fenced settle
> matches nothing and is logged `jobs.settle.unowned`.

## Files to change
| File | Defect | Verdict |
|---|---|---|
| `packages/jobs/src/execute.ts:235` | `retry: { deadLetter: false }` exhausted → nack `{ deadLetter: false, delayMs: 0 }`, no park → both drivers set `'ready'` (`driver-memory.ts:283`, `driver-pg.ts:339`) → **runs forever**, attempt counter climbs, logs `dead-lettered` each time | CONFIRMED, critical |
| `packages/jobs/src/driver-pg-sql.ts:102-118` (`SQL_ACK`, `SQL_NACK`), `driver.ts:219-220` | settle filters `state = 'running'` only, not `claimed_by`. Lease lapses → B claims → A unwinds with `LeaseLostError` → A's nack resets B's run → C claims → J runs twice concurrently; A's ack can mark B's run `done` | CONFIRMED, high |
| `packages/jobs/src/scheduler.ts:198-209` | enqueue then `markFired`; if `markFired` rejects / process dies / job 2 of N fails, watermark untouched → next round re-enqueues. Partial unique index (`driver-pg-ddl.ts:67-69`) covers live states only → fires twice once job 1 is `done`. Comment at `:202` is wrong | CONFIRMED (read), med |
| `packages/jobs/src/outbox-relay.ts:157-160` | SIGTERM `stop(deadlineAt)` joining a manual `stop()` never applies its deadline → wedged `claim()` blocks shutdown | CONFIRMED (read), low |

## Steps
1. **Terminal drop.** Add a nack outcome that maps an exhausted non-dead-lettered job to `'failed'` (already in `JOB_STATES`/`REQUEUEABLE_STATES`) in both drivers. `execute.ts` sends it when `!decision.retry && !decision.deadLetter`. Log outcome `dropped`, not `dead-lettered`.
2. **Owner fence.** `ack`/`nack` take `workerId`; SQL adds `and claimed_by = $n` (pattern: `SQL_HEARTBEAT`, `driver-pg-sql.ts:142`). Memory driver same. `execute.ts` skips settle when `heartbeat.lost()`. A settle that matches 0 rows is logged, not thrown.
3. **Atomic fire.** Enqueue all jobs of an occurrence + `markFired` in one transaction on the executor (pattern: outbox row staged on caller's connection, `outbox-pg.ts`). Fix the `:202` comment.
4. **Relay deadline.** Bind the deadline late like `scheduler.ts:412` / `worker.ts:348`.

## Tests
- `packages/jobs/src/execute-retry.test.ts:127` — assert row state `failed` after exhaustion and that `claim()` returns nothing; add a row to `driver-settle-parity.test.ts`.
- `packages/jobs/src/driver-parity.test.ts` — stale owner's ack/nack is a no-op after re-claim; `worker-soak.job.test.ts` (opt-in `.job`) for the real interleaving.
- `packages/jobs/src/scheduler.test.ts` — `markFired` rejects once → exactly one job per occurrence.
- Relay drain unit test — manual stop then `stop(deadline)` resolves by the deadline with a never-settling `claim`.
- `bun test packages/jobs`

## Not a bug (don't reopen)
- memory vs pg claim/ack/nack/cancel/requeue/stats parity (except the above); backoff/jitter/retry-after clamp; worker drain vs claim round; heartbeat expiry; `x jobs drain` leases before ack.

## Done when
- Tests above fail on `fcfe31dc`, pass after; `bun run verify` `unit` + `job` green.
- `x jobs list --json` and admin job views show `failed` rows (check, don't assume).
