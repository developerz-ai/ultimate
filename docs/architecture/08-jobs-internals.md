# Jobs internals

Postgres queue by default, one driver interface, durable steps. Why an outbox and why the step is the retry unit: [`../idea/04-jobs.md`](../idea/04-jobs.md). How `enqueue` joins the request transaction: [`06-data-layer.md`](./06-data-layer.md).

## Step executor — memoized replay

`run()` is re-entered from the top on every attempt. Completed steps are **not re-executed** — their stored results are returned.

Sketch of `createStepRunner` ([`packages/jobs/src/steps.ts`](../../packages/jobs/src/steps.ts)) —
the shape, not the source:

```text
// one responsibility: replay a run deterministically
createStepRunner(options) => {
    async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
      assertUniqueStepName(jobId, name);              // X_STEP_DUPLICATE
      if (name in memo) return memo[name] as T;       // replay: no call, no side effect
      const result = await fn();                      // executed once, ever
      await driver.steps.put({ runId, name, status: 'completed', output: result }, by); // durable, fenced
      memo[name] = result;
      return result;
    },
    async sleep(duration: string): Promise<void> {
      const key = `sleep:${duration}`;
      if (key in memo) return;
      await driver.steps.put({ runId, name: key, status: 'sleeping', wakeAt }, by);
      await driver.sleepUntil(jobId, addDuration(now(), duration));
      throw StepSuspension;                           // releases the worker; no held connection
    },
}
```

| Property | Detail |
|---|---|
| Memo load | `driver.steps.list(runId)` once per attempt, before `run()` is entered |
| Persist-before-return | a step's result is durable before the next line executes. A crash between them replays that step, never skips it |
| `step.sleep` | persists a wake time and throws `SUSPEND`. The job resumes **in a fresh process** — `'3d'` is safe, no timer in memory, no connection held |
| `step.waitForEvent(name, { match, timeout })` | same suspension mechanism; resumes with the event payload or `null` on timeout |
| Step names | unique and stable within a job. Renaming invalidates the stored result — the step re-runs. `x verify` fails duplicate names in one `run` |
| Replay observability | a replayed step emits a span with `replayed=true`, never a fake execution |
| Retry unit | the **step**. A failure in `nudge` replays `provision` and `welcome-email` from storage in microseconds and retries only `nudge` |

Worked trace for the canonical job:

| Attempt | `provision` | `welcome-email` | `sleep 3d` | `nudge` |
|---|---|---|---|---|
| 1 | executed | executed | suspends | — |
| 2 (after wake) | memo | memo | memo | executed → fails |
| 3 (backoff) | memo | memo | memo | executed → ok |

`provision` ran once. That is why an onboarding flow can retry on day 3 without re-provisioning or re-emailing.

## Driver interface

One interface, four implementations — three for production plus `memory`, which is the one every framework test and `x dev` run against. **Job code never changes.**

Six required methods, the `steps` store, and three optional members. A driver that ships none of the three is still a working queue: `introspect` absent is `x jobs ls` with nothing to list, `backfills` absent is a `backfill()` pass that runs with no bookkeeping rather than one that is refused, and `close` absent is a driver holding nothing to hand back.

```ts
export interface JobDriver {
  readonly name: string;
  /** Step persistence lives with the queue: one store, one transaction boundary. */
  readonly steps: StepStore;
  enqueue(request: EnqueueRequest): Promise<EnqueueResult>;
  claim(options: ClaimOptions): Promise<readonly ClaimedJob[]>;
  // Each settle and renewal names its CLAIM — `{ workerId, claim }` — and answers whether it landed.
  ack(jobId: string, by: AckOptions): Promise<boolean>;
  nack(jobId: string, options: NackOptions): Promise<boolean>;
  heartbeat(jobId: string, options: HeartbeatOptions): Promise<boolean>;
  stats(): Promise<readonly QueueStats[]>;
  readonly backfills?: BackfillLedger;
  readonly introspect?: JobIntrospection;
  close?(): Promise<void>;
}
```

| Driver | State | `backfills` | Trade-off |
|---|---|---|---|
| `pg` (default) | `x_jobs`, `x_job_steps`, `x_backfills`, `x_outbox`, `x_rate_buckets` | yes | outbox is free (same DB, same tx); `SKIP LOCKED` claiming; zero extra infra |
| `memory` | in-process maps, lost with the process | yes | tests and `x dev` only — nothing survives a restart, so it is never a deployment target |
| `redis` | streams + consumer groups, outbox relay in front | no | high throughput, short jobs; loses "queue state in one backup" |
| `nats` | JetStream, outbox relay in front | no | strongest delivery semantics, most operational surface. `As of 2026-08-22` `claim` throws `X_NOT_IMPLEMENTED`. There is no driver switch to answer with: `JobsConfig.driver` accepted `postgres`/`redis`/`nats`, had no reader anywhere, and boot always built the Postgres driver — so it was deleted in 5.0.0 and Postgres is simply what runs |

`x_backfills` is the odd one out: it is not queue state but the ledger of what a `backfill()` pass has already swept, hanging off `JobDriver.backfills` because it ships in the same DDL as `x_jobs` — `As of 2026-08` only the `pg` and `memory` drivers carry one, and a driver without it runs backfills with no bookkeeping rather than refusing them.

Because `steps` is a driver member, step persistence works identically on all four. Switching is the `setJobDriver(…)` call at boot plus `x jobs drain --to redis` for in-flight rows — a planned subcommand `As of 2026-10` (`PLANNED_SUBCOMMANDS`, `packages/cli/src/cmd-planned.ts`): `redis` and `nats` are stubs, so there is nowhere durable to drain to.

## The pg claim loop

`SQL_CLAIM`, [`packages/jobs/src/driver-pg-sql.ts`](../../packages/jobs/src/driver-pg-sql.ts) — one statement, abbreviated:

```sql
with picked as (
  select id, (state = 'running' and attempt >= max_attempts) as exhausted
    from x_jobs
   where queue = any($1::text[]) and run_at <= now()
     and not exists (select 1 from x_job_pauses p where p.kind = 'queue' and p.name = x_jobs.queue)
     and (state in ('ready', 'delayed', 'suspended')
          or (state = 'running' and visible_at <= now()))
   order by run_at limit $2
     for update skip locked
), buried as (          -- a lease that lapsed on the row's FINAL attempt
  update x_jobs j
     set state = case when j.name = any($5::text[]) then 'failed' else 'dead' end,
         visible_at = null, claimed_by = null, last_error = '<lease lapsed on the final attempt>'
    from picked p where j.id = p.id and p.exhausted
  returning …
), claimed as (
  update x_jobs j
     set state = 'running', attempt = j.attempt + 1, claims = j.claims + 1,
         claimed_by = $3, visible_at = now() + ($4::bigint * interval '1 millisecond')
    from picked p where j.id = p.id and not p.exhausted
  returning …
)
select … from claimed union all select … from buried
```

| Element | Why |
|---|---|
| `for update skip locked` | N workers claim disjoint batches with no coordination, no advisory locks, no lost wakeups. A row locked by another worker is skipped, not waited on |
| pick, then `update … from` | claim and mark in **one statement, one round trip** — no window where a row is locked but unmarked |
| `order by run_at` | oldest due first; there is no `priority` column `As of 2026-10` |
| `run_at <= now()` | backoff, `step.sleep` and a shed all express as a future `run_at`. One mechanism |
| `attempt` incremented at claim | a worker that dies mid-run has still burned an attempt |
| `claims` incremented at claim, never reset | with `claimed_by` it is the identity every settle, heartbeat, progress write and **step write** is fenced on (`claimOf(claimed)`) |
| the `buried` arm | a `running` row is picked only with a lapsed lease; one already at `attempt >= max_attempts` is settled in the claim and never handed out, so a job that kills its worker ends after `retry.attempts` claims. `dead`, or `failed` when the caller named the job in `dropExhausted` (`retry.deadLetter: false` — the row carries no policy, the worker holds the registry). Counted in the same statement, reported through `ClaimOptions.onExhausted`; the claim round logs `jobs.claim.exhausted` and runs `onSettled` (`announceExhausted`) |
| `x_job_pauses` | a pause is a row the claim reads, never a column on `x_jobs` |
| Index | `x_jobs_claim_idx` — see `SQL_JOBS_TABLE` in `driver-pg-ddl.ts` |
| Wakeup | `LISTEN x_jobs_wake` / `x_outbox_wake` on one session per worker pod (`startQueueWake`); the enqueue and the outbox stage carry the `pg_notify`. Polling is the guarantee underneath — see [Idle cost](#idle-cost) |

## Visibility timeout

A claimed job is invisible until its lease expires. `visible_at` **is** the visibility timeout, and
there is no reaper: the claim's own predicate (`state = 'running' and visible_at <= now()`) re-takes
a lapsed row, or buries it on its final attempt.

| Rule | Detail |
|---|---|
| Default lease | `jobs.visibilityTimeoutMs`, 30s |
| Heartbeat | the worker calls `driver.heartbeat` on its heartbeat interval, pushing `visible_at` out; fenced on the claim |
| Failed renewal | one failure is not a lost lease — `jobs.heartbeat.failed` (warn) and the next try inside the same window |
| Lost lease | a whole window with no renewal landing: `jobs.lease.lost` (error) + `job_leases_lost_total{queue}`, and this worker stops renewing. Decided on the WORKER's clock from the last renewal that landed, because a hung `heartbeat` never rejects and a rejection-only check would never fire |
| Fleet slot | the same two losses, on `x_job_leases`: `jobs.worker.slot-renewal-failed` (warn) per failure, `jobs.worker.slot-lost` + `X_JOB_SLOT_LOST` at an explicit "not yours" or a whole TTL with no renewal landing |
| Step writes | `SQL_STEP_PUT` is fenced on the claim as `SQL_ACK` is: a body that outlives its lease writes nothing, `X_JOB_LEASE_LOST` |
| Cancel | `SQL_CANCEL` is fenced on the four live states — a `dead`, `failed`, `done` or `cancelled` row is refused (`X_JOB_NOT_CANCELLABLE`), never rewritten |
| SIGKILL | no heartbeat → the lease lapses → the next claim re-takes the row. Completed steps are memoized, so recovery resumes at the failed step |
| Clock | `now()` is the **database's** clock, so a skewed worker cannot steal or hold leases |
| Event clock | `step.waitForEvent` stamps a new wait from the event bus's clock (`EventLookup.now()` — the database's, on the stored bus), the clock every `published_at` is on; the bus is asked again before a wait is declared timed out, so a worker running ahead neither misses an answer nor gives up early |
| Lost-lease run | `logger.error('jobs.lease.lost', …)` (`packages/jobs/src/heartbeat.ts`); the run itself fails as `X_JOB_LEASE_LOST` |

## Scheduler leader election

`scheduler` is fixed-1 by design. Election is an **expiring row**, `createPgLeaseLeader`
([`packages/jobs/src/scheduler-pg.ts`](../../packages/jobs/src/scheduler-pg.ts)) — one row per
`lock_key` in `x_scheduler_leader`, holder plus expiry, and `acquire()` is also the renewal.

**Not `pg_try_advisory_lock`, and that is the whole point.** An advisory lock is *session*-scoped,
and the executor this package is handed is a **pool** — so the grant is held by a backend the
process cannot name on the next round. It outlives every transaction and is released only by an
explicit unlock, the pool's reset on release, or the connection dying, and the round after taking it
may run on a different connection entirely. Both endings break election: a lock stranded on a
backend nobody can release, and a lock dropped by a reset mid-round while the node still believes it
leads — a rolling update double-fires every task.
`createPgLeader` does not exist; `@ultimat3/realtime`'s `PgAdvisoryLock` solves the same problem by
owning its connection, and this package holds no wire protocol, so it solves it with a row.

| Property | Detail |
|---|---|
| Held for | `ttlMs`, default `DEFAULT_LEADER_TTL_MS` = 30s, against a 1s tick. Comfortably longer than the tick, or a slow round loses the lock mid-dispatch |
| Renewal | the scheduler's per-round `acquire()`. It both extends the lease and answers the round the node stops being leader |
| Holder identity | a per-process uuid, never a hostname a pod reuses |
| A non-leader | stays a warm standby and never dispatches. It reports **no** readiness — the `scheduler` role opens no HTTP socket at all, only the metrics listener on `DEFAULT_METRICS_PORT` (`packages/cli/src/metrics-endpoint.ts:22-26`) |
| Crash | the lease is reclaimed by expiry, with nothing to clean up — the one property the advisory lock had, and one a plain `insert … on conflict do nothing` would not |
| Single node | `soleLeader()`, which acquires unconditionally |
| Missed tick | decided against the durable watermark in `x_scheduler_state` (`pgSchedulerState`), per `catchUp` — `skip` (default), `run-once` or `run-all` bounded by `maxCatchUp` |
| Double fire during handover | absorbed by the enqueued job's `idempotencyKey` |
| `replicator` | a second container never double-delivers: it stays up, `/readyz` 503, and asks for the lock again on a backoff until the holder goes. Only `x dev --role replicator` refuses, with `X_REPLICATOR_SLOT_HELD` |

`task` only enqueues. A `task` with a handler body is a rejected design — if it does work, it is a `job` ([`../idea/02-primitives.md`](../idea/02-primitives.md)).

## Idempotency is a type requirement

```ts
export const onboardOrg = job({
  input: t.object({ orgId: t.uuid }),
  tenant: ({ orgId }) => orgId,                       // REQUIRED by the type
  idempotencyKey: ({ orgId }) => `onboard:${orgId}`,   // REQUIRED by the type
  retry: { attempts: 5, backoff: 'exponential' },
  async run({ input, step, ctx }) {
    const org = await step.run('provision', () => ctx.orgs.provision(input.orgId));
    await step.run('welcome-email', () => ctx.mail.send(welcomeEmail, org));
    await step.sleep('3d');
    await step.run('nudge', () => ctx.mail.send(nudgeEmail, org));
  },
});
```

`idempotencyKey` is a non-optional property of `JobDef<I>`. Omitting it is a **compile error** — a runtime duplicate-charge incident becomes a red squiggle. Rationale: at-least-once is the only honest guarantee any queue provides, and "remember to add a key" is exactly the instruction an agent drops under pressure.

| Behavior | Rule |
|---|---|
| Enforcement | unique partial index `x_jobs_name_tenant_idempotency_live_idx` on `(name, coalesce(tenant_id, ''), idempotency_key)` over the four LIVE states (`ready`, `delayed`, `running`, `suspended`) |
| Duplicate enqueue with a live key | the insert conflicts; `enqueue` returns the existing handle, no new row, no error |
| Key must be | deterministic from `input` only. No timestamps, no randomness, no `ctx`. **A convention, not a rule** — `As of 2026-08` nothing checks it: no code, no step, no lint. A non-deterministic key is a duplicate charge the unique index cannot see |
| Uniqueness window | `retention` per queue; default 24h after terminal state |
| Non-idempotent external call inside a step | pass the provider's idempotency header keyed `${jobId}:${stepName}` |

## Limits and concurrency

Two layers. `createLimiter` counts in ONE process; `job.concurrency` is held across the fleet.

```ts
export const syncCrm = job({
  input: t.object({ orgId: t.uuid, accountId: t.uuid }),
  tenant: ({ orgId }) => orgId,
  idempotencyKey: ({ accountId }) => `crm-sync:${accountId}`,
  concurrency: { key: ({ accountId }) => accountId, limit: 1, whenBusy: 'fail' },
  retry: { attempts: 3 },
  queue: 'integrations',
  async run({ input, step, ctx, finalAttempt }) { /* ... */ },
});
```

| Control | Mechanism | On breach |
|---|---|---|
| `concurrency: 4` / `concurrency: { key, limit }` | one row per HELD SLOT in `x_job_leases`, taken after the claim by `SQL_LEASE_ACQUIRE` — the `(lease_key, slot)` primary key serialises two workers. Lease key `job:<name>`, or `job-key:<encoded name>:<key(input)>` for a keyed cap. TTL is the worker's `visibilityTimeoutMs`, renewed on the heartbeat interval. There is no `concurrency_key` column and no count inside the claim | `whenBusy: 'wait'` (default, and always for a plain number): nacked back `ready`, attempt uncounted. `whenBusy: 'fail'`: settled `failed` with `X_JOB_KEY_BUSY`, body never run — unless the only holder is this run's own earlier claim (`SQL_LEASE_HOLDERS`), which waits |
| `createLimiter({ perTenant, perQueue, global, ratePerTenant })` | three `Map`s in the worker's heap (`limits.ts`). **Per process**: multiplied by the replica count. `ratePerTenant` stamps a START and the stamp is a reservation: a lease handed back for a run that never started (`Lease.abandon()` — shed over `job.concurrency`, refused by its key) takes its stamp with it. There is no `rateLimit:` on a job and no `x_rate_buckets` table, `As of 2026-10` | handed straight back: `ready`, attempt uncounted, `jobs.worker.shed` |
| `queue` | named pool; `WORKER_QUEUES=default,integrations` selects pools per replica | a queue with no worker is visible in `x jobs ls --json`, not silently stalled |
| `retry.attempts` / `backoff` | `'exponential' \| 'linear' \| 'fixed'`, in the driver scheduler. The curve is `@ultimat3/core`'s `backoffDelay` since 2026-08-23; what stays here is `DurationInput` (`'30s'`), the `DEFAULT_RETRY` fallbacks, and this package's public `jitter: boolean` | after `attempts`, dead-letter with the full step trace |
| `retry.jitter` | **equal** jitter — half fixed, half rolled — and `true` by default. Never `full`: a job that has already failed twice must not be handed a near-zero wait | a burst of failures retries spread out rather than in lockstep |
| the thrown code's `retry` classification | `nextRetryForError` (`packages/jobs/src/retry-classification.ts`), read at `execute.ts` before the attempt count | a **`terminal`** code stops on the attempt that failed — the remaining attempts are a queue slot and a provider bill. `retry-after` replaces the delay, clamped by `maxDelay`, never the ceiling. An **unclassified** code takes exactly the path it took before the reader existed |
| Dead letter | `state='dead'`, steps retained | `x jobs retry <id>` replays **from the failed step**, memo intact |

A limited job is **deferred, never dropped** — `whenBusy: 'fail'` is the one declared exception, and it leaves a `failed` row, never nothing. Dropping is a data-loss decision disguised as backpressure.

## The operator surface

`JobIntrospection` (`packages/jobs/src/introspection.ts`) is the whole of what an operator may ask; both drivers implement every member and `operator-surface-fixture.ts` runs one assertion set over both.

| Capability | Mechanism | Statement |
|---|---|---|
| paged listing | keyset on `(created_at, id)`, newest first, over `x_jobs_created_idx`. The cursor is `<createdAt ms>:<id>`; the seek reads the cursor row's own `created_at`, because the ms is rounded | `SQL_JOB_LIST` |
| settle + history | `ack` / `nack` are fenced on `state = 'running'`, `claimed_by` AND the claim's ordinal (`x_jobs.claims`, moved by `SQL_CLAIM`, never reset) — a worker that takes back its own lapsed job has the same id as the body still unwinding. The same statement upserts the job's one-minute bucket in `x_job_counters`; an ack with `counted: false` (`x jobs drain`) skips it | `SQL_ACK`, `SQL_NACK` |
| renewal + progress | fenced the same way, so the superseded body's heartbeat answers `false` and its run is cancelled | `SQL_HEARTBEAT`, `SQL_JOB_PROGRESS` |
| last fire | `x_scheduler_state.fired_occurrence_at` / `fired_at`, written by the firing statement. The watermark beside them also moves on an arming and a skipped catch-up, which are not fires | `SQL_SCHEDULER_FIRE`, `SQL_TASK_FIRES` |
| counter tiers | 1-minute for 24 h → 5-minute for 7 d → 1-hour for 30 d. The scheduler leader folds once a minute; delete-and-insert in one statement, so two nodes folding move each bucket once | `SQL_COUNTER_FOLD`, `SQL_COUNTER_DROP` |
| queue / task pause | one row in `x_job_pauses (kind, name)`. The claim excludes a paused queue with `not exists`; the scheduler skips a paused task and leaves its watermark | `SQL_PAUSE`, `SQL_CLAIM` |
| bulk | one CTE each: select up to 1,000, act, and count what matched before the act | `SQL_JOB_REQUEUE_MANY`, `SQL_JOB_REMOVE_MANY` |
| worker registry | `x_job_workers`, rewritten on the heartbeat interval, expired by `expires_at` | `SQL_WORKER_ANNOUNCE`, `SQL_WORKERS` |
| progress | `x_jobs.progress` (jsonb), throttled in the runner to one write a second, fenced on the claimer | `SQL_JOB_PROGRESS` |
| atomic fire | the watermark upsert is the fence; the occurrence's jobs insert `where exists (select 1 from moved)` | `SQL_SCHEDULER_FIRE` |

Measured on the embedded Postgres, `As of 2026-10-01` (3,000 settles, median of three runs on a loaded machine): `ack` 0.72 ms → 1.39 ms, a counted `nack` 1.01 ms → 1.39 ms, an uncounted one (a shed) 1.20 ms. One round trip before and after.

## Idle cost

Measured on a production app `As of 2026-10-01`: an idle scheduler with ~35 tasks sent ~70 statements a second and an idle worker pod 9–13. Counted per idle minute by `packages/jobs/src/idle-cost.test.ts` and `queue-wake.test.ts`:

| Loop | Fixed poll | Backoff, no wake | Backoff, proven wake | How |
|---|---|---|---|---|
| scheduler, 35 tasks | 4,321 | 6 | 6 | watermarks and each task's next occurrence held in memory while leading; the lease trusted for `renewEveryMs` (TTL / 3); the pause table read only when a task is due; the counter fold every ten minutes |
| worker, 2 queues | 480 | 30 | 12 | `idle-backoff.ts`: 250 ms doubling to 2 s, or to 5 s while `wakeIsLive()`; an idle pass is one `SQL_CLAIM` over every queue with a free slot, `limit` = the fewest free |
| outbox relay | 300 | 30 | 12 | the same backoff from 200 ms |

The lease is not what makes a trusted window safe: `SQL_SCHEDULER_FIRE` moves the watermark and queues the occurrence's jobs in one statement, so two nodes that both believe they lead queue it once.

### The wake

| Piece | Mechanism |
|---|---|
| session | `@ultimat3/db`'s `client.listen(channel, onNotify, onListening)`: one connection beside the pool (`Bun.SQL.listen`; PGlite's own under `x dev`). The driver re-dials a session that died and `onListening` fires again |
| listener | `startQueueWake({ listener, executor })`, started by the boot for the `worker` role. A notification becomes `signalEnqueued(queue)` or `signalStaged(true)` — the signals a local enqueue already raises |
| proof | after every (re-)listen a probe is sent through the POOL; the wake is live once it has come back on both channels. Not proven within 5 s: `jobs.wake.unverified`, once |
| enqueue | `SQL_ENQUEUE` notifies the queue name unless another row of that queue was created in the same 250 ms slot, or the row is due more than 1 s out |
| stage | `SQL_OUTBOX_STAGE` notifies — at COMMIT, never on rollback — unless a committed row is already waiting unclaimed |
| woken loop | passes now, then at its floor again: that second pass finds the row a slot kept silent |

| Why | Detail |
|---|---|
| a notification is throttled in the statement | Postgres serialises the commit of every transaction that issued a `NOTIFY` behind one lock held through the WAL flush. Unthrottled, an app's enqueuing commits go one flush at a time |
| the ceiling rises only on proof | PgBouncer in `pool_mode = transaction` accepts the `LISTEN` and delivers nothing. Unproven, the ceiling stays 2 s |
| the poll stays | a notification sent while the session was down is gone; a delayed job another process queued announces nothing when it falls due |

Enqueue → start on an idle worker, Postgres 17 on loopback, median / max, `As of 2026-10-01`:

| Path | Backoff, no wake | With the wake |
|---|---|---|
| same process | 7 ms / 21 ms | 10 ms / 19 ms |
| another process, direct | 1,033 ms / 1,785 ms | 8 ms / 18 ms |
| another process, through the outbox, from COMMIT | 1,275 ms / 2,008 ms | 9 ms / 13 ms |

## Where durable business state lives

**Your tables. Never only the queue payload.**

```ts
await onboardOrg.enqueue({ orgId: org.id });          // ✅ a pointer
await onboardOrg.enqueue({ org: { ...30 fields } });  // ❌ a record
```

| Consequence of a payload-as-record | Detail |
|---|---|
| Draining or migrating the queue loses business facts | `x jobs drain --to redis` must be a boring operation |
| A stale payload overwrites newer state on retry | the job re-applies values captured minutes ago |
| The truth is unqueryable | "which orgs are mid-onboarding" needs a table, not a queue scan |
| Step results are not business state either | they are a replay memo with a retention window; if a fact must survive, write it in a step |

Rule: after the queue is wiped, the business must be reconstructible from Postgres alone.

## Codes

| Code | Meaning | Fix |
|---|---|---|
| `X_IDEMPOTENCY_REQUIRED` | runtime guard behind the compile-time requirement | add `idempotencyKey` to the job definition — the factory's own fix line writes the interpolation out |
| `X_STEP_DUPLICATE` | two `step.run` calls share a name in one `run` | `rename one of them, e.g. step.run('<name>-2', ...)` — step names are the replay key |
| `X_JOB_MAX_ATTEMPTS` | the job exhausted its retries | `x jobs retry <id>` |
| `X_JOB_TIMEOUT` | the job exceeded its wall-clock limit | `raise timeout on the job definition, or split the work into step.run() calls` |
| `X_JOB_LEASE_LOST` | the queue took this job back mid-run | `x jobs show <id> --json` |
| `X_JOB_SLOT_LOST` | the fleet concurrency slot was taken by another worker | `x jobs ls --state running --json` |
| `X_JOB_NOT_CANCELLABLE` | the driver cannot cancel | `call setJobDriver(createPgDriver({ executor })) at boot, then: x jobs cancel <id> --json` |
| `X_JOB_TENANT_REQUIRED` | the job declares no tenant | `add tenant: (input) => input.orgId to the job — or tenant: 'none', which declares NO org` |
| `X_JOB_CONCURRENCY_UNENFORCEABLE` | `concurrency` declared on a driver that cannot enforce it | `remove concurrency from the job, or call setJobDriver(createPgDriver({ executor }))` |
| `X_OUTBOX_NO_TX` | `enqueue` outside a transaction | `wrap the call in ctx.tx(async (tx) => ...), or enqueue with { outbox: false }` |
| `X_DRIVER_UNAVAILABLE` | the queue driver is unreachable | the factory takes the `fix` from the driver — it names the connection to repair |
| `X_NOT_IMPLEMENTED` | a driver path with no implementation yet | `call setJobDriver(createPgDriver({ executor })) at boot` |
