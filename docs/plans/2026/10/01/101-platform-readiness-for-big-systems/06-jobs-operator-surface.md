# 06 — Jobs: what an operator needs from the queue

> Part of [`overview.md`](overview.md). Depends on: 05. Tier: 3.

Rule: every operator capability is a member of `JobIntrospection`
(`packages/jobs/src/driver.ts:184-205`) that the Postgres and memory drivers both implement. The
dashboard in slice 16 reads nothing a driver does not promise, so a future driver serves the
same screens or says which it cannot.

Evidence: a Sidekiq-compatible job system's dashboard — queues, busy, retries, scheduled, dead,
cron, metrics, search — compared member by member with this package. Present here and absent
there: cancelling a running job, durable steps, a transactional outbox, cron catch-up. Absent
here: the rows below.

## Files to change
| Capability | Today | Change |
|---|---|---|
| paged listing | `JobFilter` is queue, name, state, limit; the SQL has `limit` and no cursor (`packages/jobs/src/driver.ts:177-182`, `driver-pg-jobs-sql.ts:24-32`) | keyset `after` cursor; filter by id prefix and by time range |
| job detail | `JobTrace` omits `input` and the stack (`packages/jobs/src/inspect.ts:60-85`) | add both, `input` passed through the declared secret redaction |
| delete, bulk | no delete; retry is one row (`inspect.ts:176-186`) | `remove(jobId)`, `requeueMany(filter)`, `removeMany(filter)` — bounded per call |
| queue pause | none | `pauseQueue(name)` / `resumeQueue(name)`: a paused queue is never claimed; enqueue still works |
| run a delayed job now | `state=delayed` lists only | `promote(jobId)` |
| who is working | only `claimedBy` on a row (`driver.ts:69`) | a worker registry: identity, host, started, queues, concurrency, in-flight job ids, last heartbeat |
| history | four Prometheus series (`packages/jobs/README.md:869-876`) | per-minute counters per job name — done, failed, dead, duration sum — rolled up by the leader |
| progress | step traces only | `progress(done, total, note?)` on the run args, stored on the row |
| a job died | a gauge | `onDead?: (args) => Promise<void>` on the job declaration |
| scheduled tasks | `inspectManifest().tasks` with `nextRun` (`inspect.ts:245-252`) | pause / resume a task, fire it now, last-fire record |

Also `packages/jobs/src/driver-pg-ddl.ts` (two tables: workers, counters), the memory driver,
`packages/jobs/src/driver-parity.test.ts`, `packages/cli/src/cmd-jobs-spec.ts:16` (`x jobs` gains
`pause`, `resume`, `rm`, `promote`), `packages/jobs/README.md`, `packages/jobs/CLAUDE.md`.

## Steps
1. **First fix what the parity suite would otherwise encode.** The audit plan records two
   confirmed pg-driver defects — ack/nack not fenced on the claimer, and a scheduler double-fire
   ([`../../../09/28/101-audit-bugs-and-gaps/04-jobs.md`](../../../09/28/101-audit-bugs-and-gaps/04-jobs.md)).
   Land that slice before this one, or do it here and mark it done there.
2. Every new member goes into the parity suite for both drivers before any caller exists.
3. Bounds, stated as numbers in the declaration, never left to the caller: page size ≤ 200;
   a bulk call touches ≤ 1,000 rows and answers how many remain; counters keep 1-minute buckets
   for 24 hours, 5-minute for 7 days, 1-hour for 30 days — a fixed key count whatever the
   throughput, the shape the surveyed system uses to stay cheap at millions of jobs an hour.
4. Counters are incremented in the same statement that settles the row. A count that can
   disagree with the rows is worse than no count. Rollup is the scheduler leader's job
   (`packages/jobs/src/scheduler.ts:52-57`).
5. Worker registry rows expire by heartbeat, like leases (`packages/jobs/src/leases.ts:1-5`):
   a killed worker disappears by expiry, not by cleanup.
6. `progress()` writes at most once a second per run; the last call before settle is always
   written. No event per call.
7. `onDead` runs after the row is dead-lettered, in its own attempt budget; its failure is
   logged with a code and never resurrects the job. With slice 05's `finalAttempt` this is the
   pair every surveyed system built by hand: know the last try, react to the death.
8. Remote "quiet this worker" is out: SIGTERM drain is the mechanism
   (`packages/jobs/CLAUDE.md:102-105`), and the orchestrator owns process lifecycle (axiom 7).

## Tests
- `packages/jobs/src/driver-parity.test.ts`: each new member, both drivers.
- `packages/jobs/src/operator-surface.test.ts`: a paused queue is not claimed and still accepts
  enqueues; a keyset walk over 1,000 rows visits each once while rows are being inserted;
  `removeMany` stops at its bound and reports the remainder; counters equal the settled rows.
- `packages/jobs/src/operator-surface.job.test.ts`: the same against Postgres, plus two workers
  in the registry and one killed.
- Command: `bun test packages/jobs/src/operator-surface.test.ts packages/jobs/src/driver-parity.test.ts`.

## Done when
- `x jobs pause <queue>` stops claims fleet-wide within one poll interval; `x jobs resume` undoes it.
- `x jobs show <id> --json` carries input, stack and progress.
- `bun run manifest` records each job's `onDead` and the task pause state shape.
