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
      await driver.saveStep(jobId, name, result);     // durable before returning
      memo[name] = result;
      return result;
    },
    async sleep(duration: string): Promise<void> {
      const key = `sleep:${duration}`;
      if (key in memo) return;
      await driver.saveStep(jobId, key, true);
      await driver.sleepUntil(jobId, addDuration(now(), duration));
      throw StepSuspension;                           // releases the worker; no held connection
    },
}
```

| Property | Detail |
|---|---|
| Memo load | `driver.loadSteps(jobId)` once per attempt, before `run()` is entered |
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
  ack(jobId: string): Promise<void>;
  nack(jobId: string, options: NackOptions): Promise<void>;
  heartbeat(jobId: string, options: { readonly visibilityTimeoutMs: number }): Promise<void>;
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

Because `steps` is a driver member, step persistence works identically on all four. Switching is a config line plus `x jobs drain --to redis` for in-flight rows.

## The pg claim loop

```sql
-- packages/jobs/src/drivers/pg/claim.sql
WITH claimed AS (
  SELECT id
  FROM x_jobs
  WHERE queue = $1
    AND state = 'ready'
    AND run_at <= now()
  ORDER BY priority DESC, run_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE x_jobs j
SET state       = 'running',
    lease_until = now() + ($3 || ' milliseconds')::interval,
    attempt     = j.attempt + 1,
    worker_id   = $4,
    claimed_at  = now()
FROM claimed c
WHERE j.id = c.id
RETURNING j.id, j.name, j.input, j.attempt, j.tenant_id, j.trace, j.idempotency_key;
```

| Element | Why |
|---|---|
| `FOR UPDATE SKIP LOCKED` | N workers claim disjoint batches with no coordination, no advisory locks, no lost wakeups. A row locked by another worker is skipped, not waited on |
| CTE then `UPDATE ... FROM` | claim and mark in **one statement, one round trip** — no window where a row is locked but unmarked |
| `ORDER BY priority DESC, run_at` | fair within a queue; deterministic in tests |
| `run_at <= now()` | backoff, `step.sleep`, and rate-limit deferral all express as a future `run_at`. One mechanism, three features |
| `attempt` incremented at claim | a worker that dies mid-run has still burned an attempt, so a poison job cannot loop forever |
| Partial index | `CREATE INDEX ON x_jobs (queue, priority DESC, run_at) WHERE state = 'ready'` — the ready set stays small even with millions of terminal rows |
| Wakeup | `LISTEN x_jobs_ready` + `NOTIFY` on post-commit outbox release; polling is the fallback (`pollInterval`, default 1s), never the primary path |

## Visibility timeout

A claimed job is invisible until its lease expires. `lease_until` **is** the visibility timeout.

```sql
-- reaper, runs on every worker tick
UPDATE x_jobs
SET state = 'ready', run_at = now(), lease_until = NULL, worker_id = NULL
WHERE state = 'running' AND lease_until < now()
RETURNING id, name, attempt;
```

| Rule | Detail |
|---|---|
| Default lease | 30s, `leaseMs` per job for long steps |
| Heartbeat | the executor calls `driver.heartbeat` on an interval of `leaseMs / 3`, extending `lease_until` |
| Failed renewal | one failure is not a lost lease — `jobs.heartbeat.failed` (warn) and the next try inside the same window |
| Lost lease | a whole window with no renewal landing: `jobs.lease.lost` (error) + `job_leases_lost_total{queue}`, and this worker stops renewing. Decided on the WORKER's clock from the last renewal that landed, because a hung `heartbeat` never rejects and a rejection-only check would never fire |
| Long step | heartbeats keep it alive; a step exceeding `maxStepMs` is killed and retried, never left leased forever |
| SIGKILL | no heartbeat → the lease expires → the reaper requeues. Completed steps are memoized, so recovery resumes at the failed step |
| Clock | `now()` is the **database's** clock, so a skewed worker cannot steal or hold leases |
| Reaped job | `logger.error('jobs.lease.lost', …)` (`packages/jobs/src/heartbeat.ts:71`); the run itself fails as `X_JOB_LEASE_LOST`. Repeated reaping is the signal for a stuck external call |

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
| `replicator` | a second instance exits non-zero with `X_REPLICATOR_SLOT_HELD` rather than double-delivering |

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
| Enforcement | unique partial index: `CREATE UNIQUE INDEX ON x_jobs (idempotency_key) WHERE state <> 'done'` |
| Duplicate enqueue with a live key | the insert conflicts; `enqueue` returns the existing handle, no new row, no error |
| Key must be | deterministic from `input` only. No timestamps, no randomness, no `ctx`. **A convention, not a rule** — `As of 2026-08` nothing checks it: no code, no step, no lint. A non-deterministic key is a duplicate charge the unique index cannot see |
| Uniqueness window | `retention` per queue; default 24h after terminal state |
| Non-idempotent external call inside a step | pass the provider's idempotency header keyed `${jobId}:${stepName}` |

## Per-tenant limits

Declared per job, enforced per tenant, so one noisy customer cannot starve the rest.

```ts
export const syncCrm = job({
  input: t.object({ orgId: t.uuid }),
  tenant: ({ orgId }) => orgId,
  idempotencyKey: ({ orgId }) => `crm-sync:${orgId}`,
  concurrency: { key: ({ orgId }) => orgId, limit: 2 },
  rateLimit:   { key: ({ orgId }) => orgId, limit: 60, per: '1m' },
  queue: 'integrations',
  async run({ input, step, ctx }) { /* ... */ },
});
```

| Control | Mechanism | On breach |
|---|---|---|
| `concurrency.limit` | lease-count check at claim: `COUNT(*) WHERE state='running' AND concurrency_key = $k` inside the claim transaction | row is **deferred** — `run_at = now() + jitter`, still queued |
| `rateLimit` | token bucket row in `x_rate_buckets`, refilled by elapsed time, decremented at claim | deferred with `run_at = bucket.next_refill` |
| `queue` | named pool; `WORKER_QUEUES=default,integrations` selects pools per replica | a queue with no worker is visible in `x jobs ls --json`, not silently stalled |
| `retry.attempts` / `backoff` | `'exponential' \| 'linear' \| 'fixed'`, jittered, in the driver scheduler | after `attempts`, dead-letter with the full step trace |
| Dead letter | `state='dead'`, steps retained | `x jobs retry <id>` replays **from the failed step**, memo intact |

A limited job is **deferred, never dropped**. Dropping is a data-loss decision disguised as backpressure.

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
