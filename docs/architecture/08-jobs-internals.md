# Jobs internals

Postgres queue by default, one driver interface, durable steps. Why an outbox and why the step is the retry unit: [`../idea/04-jobs.md`](../idea/04-jobs.md). How `enqueue` joins the request transaction: [`06-data-layer.md`](./06-data-layer.md).

## Step executor — memoized replay

`run()` is re-entered from the top on every attempt. Completed steps are **not re-executed** — their stored results are returned.

```ts
// packages/jobs/src/step-executor.ts — one responsibility: replay a run deterministically
export function createStep(jobId: JobId, memo: Record<string, unknown>, driver: JobDriver) {
  return {
    async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
      assertUniqueStepName(jobId, name);              // X_JOB_DUPLICATE_STEP
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
      throw SUSPEND;                                  // releases the worker; no held connection
    },
  };
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

One interface, three implementations. **Job code never changes.**

```ts
export interface JobDriver {
  enqueue(job: JobRef, input: unknown, opts: EnqueueOpts, tx?: Tx): Promise<JobId>;
  claim(queue: string, limit: number): Promise<ClaimedJob[]>;
  heartbeat(id: JobId): Promise<void>;
  complete(id: JobId, result: unknown): Promise<void>;
  fail(id: JobId, err: SerializedError, retryAt: Date | null): Promise<void>;
  saveStep(id: JobId, name: string, result: unknown): Promise<void>;
  loadSteps(id: JobId): Promise<Record<string, unknown>>;
  sleepUntil(id: JobId, at: Date): Promise<void>;
}
```

| Driver | State | Trade-off |
|---|---|---|
| `pg` (default) | `x_jobs`, `x_job_steps`, `x_outbox`, `x_rate_buckets` | outbox is free (same DB, same tx); `SKIP LOCKED` claiming; zero extra infra |
| `redis` | streams + consumer groups, outbox relay in front | high throughput, short jobs; loses "queue state in one backup" |
| `nats` | JetStream, outbox relay in front | strongest delivery semantics, most operational surface. `As of 2026-07` `claim` throws `X_NOT_IMPLEMENTED` with `fix: set jobs.driver = "pg" in app.config.ts` |

Because `saveStep`/`loadSteps` are driver methods, step persistence works identically on all three. Switching is a config line plus `x jobs drain --to redis` for in-flight rows.

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
| Long step | heartbeats keep it alive; a step exceeding `maxStepMs` is killed and retried, never left leased forever |
| SIGKILL | no heartbeat → the lease expires → the reaper requeues. Completed steps are memoized, so recovery resumes at the failed step |
| Clock | `now()` is the **database's** clock, so a skewed worker cannot steal or hold leases |
| Reaped job | logged with `X_JOB_LEASE_EXPIRED` and the attempt count; repeated reaping is the signal for a stuck external call |

## Scheduler leader election

`scheduler` is fixed-1 by design. Election is a **session-level Postgres advisory lock**, so a crash releases it automatically — no TTL, no heartbeat table, no split brain from a paused process.

```sql
SELECT pg_try_advisory_lock(hashtext('ultimate:scheduler'));   -- true = leader
```

| Property | Detail |
|---|---|
| Held for | the process's DB session lifetime. Connection dies → lock released by Postgres |
| A non-leader | reports `/readyz` **not ready** by design and stays a warm standby; it never dispatches |
| Handover | the leader releases on SIGTERM (drain step 4), so the standby promotes within one lock-retry interval (default 5s) |
| Missed tick | fires **late** rather than being skipped |
| Double fire during handover | absorbed by the enqueued job's `idempotencyKey` |
| `replicator` | same mechanism, key `ultimate:replicator:<db>`; a second instance exits non-zero with `X_REPLICATOR_SLOT_HELD` rather than double-delivering |

`task` only enqueues. A `task` with a handler body is a rejected design — if it does work, it is a `job` ([`../idea/02-primitives.md`](../idea/02-primitives.md)).

## Idempotency is a type requirement

```ts
export const onboardOrg = job({
  input: t.object({ orgId: t.uuid }),
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
| Key must be | deterministic from `input` only. No timestamps, no randomness, no `ctx` — checked by `x verify` (`X_JOB_KEY_NONDETERMINISTIC`) |
| Uniqueness window | `retention` per queue; default 24h after terminal state |
| Non-idempotent external call inside a step | pass the provider's idempotency header keyed `${jobId}:${stepName}` |

## Per-tenant limits

Declared per job, enforced per tenant, so one noisy customer cannot starve the rest.

```ts
export const syncCrm = job({
  input: t.object({ orgId: t.uuid }),
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
| `X_JOB_NO_IDEMPOTENCY_KEY` | runtime guard behind the compile-time requirement | add `idempotencyKey` to the job |
| `X_JOB_KEY_NONDETERMINISTIC` | key derived from time/randomness/`ctx` | derive it from `input` only |
| `X_JOB_DUPLICATE_STEP` | two `step.run` calls with the same name in one `run` | rename one step |
| `X_JOB_STEP_FAILED` | a step exhausted its attempts; `data.step` names it | `x jobs retry <id> --from <step>` |
| `X_JOB_LEASE_EXPIRED` | a claimed job's lease expired and it was requeued | raise `leaseMs` or split the step |
| `X_JOB_QUEUE_UNKNOWN` | `queue` not present in `WORKER_QUEUES` anywhere | add the queue to a worker role |
| `X_NOT_IMPLEMENTED` | a driver path with no implementation yet | `set jobs.driver = "pg" in app.config.ts` |
