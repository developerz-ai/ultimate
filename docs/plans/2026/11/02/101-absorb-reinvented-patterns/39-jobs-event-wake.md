# 39 — A published event wakes its waiter

> Part of [`overview.md`](overview.md). Depends on: [`34-idea-jobs-event-wait.md`](34-idea-jobs-event-wait.md), same files, land after it. Tier: 3 (`jobs`), 5 (`cli`).

## Why
`step.waitForEvent` polls: each poll is a claim and a replay of the whole body. `steps.ts:185` defaults `eventPollMs` to 30 s, so a 24 h wait costs 2,880 replays, per waiter, and answers up to 30 s late. An approval flow with 10,000 open waits is 333 replays a second doing nothing. Any workflow-shaped app hits this.
Recorded objection: the statement was never run. It has been now.

## Probe, 2026-11-02, Postgres 17.4 in a throwaway container, `SQL_JOBS_TABLE` applied
One statement: insert the event, update waiters to due, notify their queues.
```
in tx 2 woken
after rollback due: false  events: 0
commit woken 2 told 1
due k/other/anyKey/otherEvent/running true false true false false
publish no-match mean ms 1.06        (200,000 parked runs, 500,000 step rows, 200 publishes)
plan: Bitmap Index Scan on x_job_steps_waiting_idx; Execution Time 0.372 ms
```
A rollback undoes both, a matching key and a keyless wait wake, another key or event does not, a running row is left alone. Without the partial index this is a scan of every step ever written. Not run: two sessions racing, the Redis driver.

## Decisions
| Question | Answer |
|---|---|
| Replays | waking is one replay. The backstop poll moves from 30 s to 15 min when the bus wakes: **2,880 → 96 per 24 h wait**, and latency falls from up to 30 s to the worker's next pass (2-5 s idle, about 0 with `LISTEN`) |
| Why keep a poll | "The poll is the guarantee, the wake an optimisation" (`jobs/CLAUDE.md`). Also what fires a timeout |
| New state, tokens, column | none. `x_job_steps.status = 'waiting'`, `event`, `correlation_key` already exist. `run_at` is the wake |
| Atomicity | same statement as the event, on `currentTx() ?? client` from 34. Rolled back together. `NOTIFY` delivers at commit only |
| Notify rule | only when `woken > 0`, per distinct queue, payload the queue name. Never unconditional (`driver-pg-wake-sql.ts:7`) |
| Who wakes | `postgresEventBus({ executor, wakes: true })`, set by `runtime-queue.ts:198` only when the driver is `postgresJobDriver`. A Redis driver with this bus finds no `x_jobs` rows, so it stays false and keeps 30 s |
| Memory bus | `wakes` false; 30 s. `x dev` and tests unchanged |
| An explicit `eventPoll` | wins, as today |
| Publish before park | runner writes `waiting`, then asks `find` once more before suspending. An event committed before that second `find` is caught; one in the round trip between it and `nack` meets `state = 'running'` and is left to the backstop. Stated bound: 15 min, rare, one statement per park |

## Files to change
- `packages/jobs/src/driver-pg-sql.ts:340` — `SQL_EVENT_PUBLISH_WAKE`, the probed statement, `published_at`, `expires_at` returned as before.
- `packages/jobs/src/driver-pg-ddl.ts:194` — `create index if not exists x_job_steps_waiting_idx on x_job_steps (event) where status = 'waiting'`, with no `;` or `'` in its comment (`driver-pg-sql.test.ts` rule; the predicate's quotes are SQL).
- `packages/jobs/src/events-pg.ts:30,76` — option, statement chosen by it, `wakes` on the bus; `events.ts:28` — `wakes?: boolean`, optional.
- `packages/jobs/src/steps.ts:185,473-484` — backstop by `events?.wakes`; second `find` after `put`, before the suspension. `execute.ts` nothing.
- `packages/cli/src/runtime-queue.ts:198` — `wakes` from the driver in hand.
- `packages/jobs/CLAUDE.md` idle-cost section, `README.md`, `wiki/Jobs-And-Workflows.md:77,160`, `docs/history/jobs.md`.

## Steps
1. Failing tests first, on Postgres (`TEST_DATABASE_URL`).
2. DDL, then statement, then runner, then boot.
3. Update `idle-cost.test.ts` only if a number moves: it should not, a publish is not idle.

## Error codes
None. A failed publish is the existing driver failure.

## Tests
- `packages/jobs/src/events-wake.live.test.ts` (pooled client, as 34's case needs): the probe's five rows; rollback leaves `run_at` and the row; `LISTEN` session gets the queue only after commit, and nothing on a no-match; two concurrent publishes for one waiter both succeed, row woken once.
- `packages/jobs/src/events-wake-race.live.test.ts`: two sessions, publish racing a park, the waiter resumes by the backstop at worst, with `eventPoll` set low to observe it.
- `packages/jobs/src/steps.test.ts`: `wakes: true` parks at 15 min, `false` at 30 s, explicit `eventPoll` wins; a timeout sooner than the backstop still parks at the timeout.
- `packages/jobs/src/events-wake.job.test.ts`: end to end through a real worker tick: resumes in one replay; replay count asserted through `replayedNames`.
- `bun test packages/jobs/src/steps.test.ts`; `bun run x -- verify --only live,job`.

## Semver
**Breaking, one row.** The new index lands in every app's committed dump, `packages/db/schema/framework/05_indexes`, so `drift` is red (`X_SCHEMA_DUMP_DRIFT`) until regenerated. Upgrading: "`x db gen`, commit `packages/db/schema/`. The Postgres bus's default poll is now 15 min; `eventPoll: '30s'` restores it." The `wakes` member is optional, with no new row state. Index build on upgrade is below.

## Done when
- A 24 h wait replays at most 96 times plus one, on a test clock.
- The probe's lines hold as tests.
- `bun run verify` and `bun run scripts/reference-app-gate.ts` green.

## Risks
- **Index build locks `x_job_steps` writes** while `SQL_JOBS_TABLE` applies it, and that install runs in a migration. Partial, so proportional to table scan time on a table with many old rows. Note for adopters in `CHANGELOG.md`; [`04-db-migration-safety.md`](04-db-migration-safety.md)'s concurrent path is the fix if a large install reports it.
- **Stamp before commit,** from 34: a wait starting inside the publisher's transaction never matches. This wake does not widen or close that; a woken run finds nothing and re-parks.
- A publish inside a long transaction holds woken rows' locks to commit. `SQL_CLAIM` skips locked rows, so workers wait, not block.
