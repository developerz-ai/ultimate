# Jobs

Postgres queue by default. Durable steps. `idempotencyKey` required by the type. Drivers swap without touching job code.

## Transactional outbox by default

`handle.enqueue` inside an action writes the job row **in the same transaction as the business write**.

```ts
async handle({ input, ctx }) {
  const post = await ctx.posts.publish(input.postId);              // INSERT/UPDATE
  if (input.notify) await notifySubscribers.enqueue({ postId: post.id, orgId: input.orgId });  // same tx
  return post;
}
```

One way to enqueue: the handle's own `.enqueue`. It resolves the ambient jobs facade — the same
one `ctx.jobs` names — so there is no second call form to choose between and no `tx` to thread.

| Bug class removed | How it happens without an outbox |
|---|---|
| **Ghost job** | enqueue succeeded, transaction rolled back → worker processes a post that does not exist |
| **Lost job** | transaction committed, broker `publish` failed → the email is never sent and nothing logs an error |
| **Double side effect** | retry of the whole handler re-enqueues → two welcome emails |
| **Ordering inversion** | worker reads the row before the writer's commit is visible → "record not found", then a retry storm |

With the outbox: commit is the enqueue. If the transaction rolls back, the job never existed. If it commits, the job is durably queued. There is no window in between, and no compensating-action code for an agent to forget to write.

External brokers (redis, nats) do not get exempted — the outbox table is still the transactional record, and a relay moves committed rows onto the broker. At-least-once delivery is preserved; the atomicity is not negotiable.

## Durable steps

```ts
// job
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

| API | Semantics |
|---|---|
| `step.run(name, fn)` | executes `fn` once ever. Result persisted under `(jobId, name)`. On replay, returns the stored result without calling `fn` |
| `step.sleep(duration)` | persists a wake time, releases the worker, and the job resumes in a fresh process. No held connection, no timer in memory. `'3d'` is safe |
| `step.waitForEvent(name, { match, timeout })` | suspends until a matching event arrives (webhook, another action, a user click) or the timeout fires. Returns the event payload or `null` |

**The step is the retry unit, not the job.** A failure in `nudge` re-enters `run`, replays `provision` and `welcome-email` from storage in microseconds, and retries only `nudge`. That is why an onboarding flow can retry on day 3 without re-provisioning or re-emailing.

Step names must be unique and stable within a job — renaming a step invalidates its stored result. A duplicate name in one `run` throws `X_STEP_DUPLICATE` **at run time**, not at build time: the names are produced by executing `run`, so a static scan cannot see them. `x verify`'s `job` step catches it wherever a job suite exercises the path.

## Idempotency is in the type signature

```ts
idempotencyKey: ({ orgId }) => `onboard:${orgId}`,   // REQUIRED by the type
```

Omitting it is a **compile error**, not a lint warning. Rationale: at-least-once delivery is the only honest guarantee any queue provides, so every handler must be replay-safe — and "remember to add a key" is exactly the instruction an agent drops under pressure. Making it a required field converts a runtime duplicate-charge incident into a red squiggle.

| Behavior | Rule |
|---|---|
| Duplicate enqueue with a live key | second enqueue returns the existing job handle, no new row |
| Key uniqueness window | `retentionpolicy` per queue; default 24h after terminal state |
| Key must be | deterministic from `input` only. No timestamps, no random, no `ctx` |
| Non-idempotent external call inside a step | wrap with the provider's idempotency header, keyed off `${jobId}:${stepName}` |

Corollary rule: **durable business state lives in your tables, never only in the queue payload.** A payload is a pointer, not a record. If the queue is drained, replaced, or migrated to another driver, the business must still be reconstructible from Postgres alone. So: `{ orgId }`, not `{ org: {...30 fields} }`.

## Concurrency and rate limits

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

| Control | Meaning | Enforced by |
|---|---|---|
| `concurrency.limit` | max simultaneous runs sharing a key | one `x_job_leases` row per **held slot**, keyed `(lease_key, slot)` — the primary key is what serialises two workers reaching for the same slot. A driver with no `LeaseStore` refuses the job at worker start (`X_JOB_CONCURRENCY_UNENFORCEABLE`) rather than capping per process |
| `rateLimit` | max starts per window per key | token bucket row, checked at claim time |
| `queue` | named pool; `worker` role runs one pool per config | worker pool sizing in [`11-topology.md`](./11-topology.md) |
| `retry.attempts` / `backoff` | `'exponential' \| 'linear' \| 'fixed'`, jittered | driver scheduler |
| terminal failure | after `attempts`, moves to dead-letter with the full step trace | `x jobs retry <id>` replays from the failed step |

A rate-limited or concurrency-blocked job is **deferred, never dropped** — it stays queued with a later `runAt`.

## Driver interface

One interface, three implementations. **Job code never changes.**

| Driver | When | Trade-off |
|---|---|---|
| `pg` (default) | always, up to ~thousands of jobs/sec | outbox is free (same DB, same tx); `SELECT ... FOR UPDATE SKIP LOCKED` claiming; zero extra infra |
| `redis` | high-throughput, short jobs | needs the outbox relay; loses "queue state in one backup" |
| `nats` | very high fanout, multi-region, JetStream retention | strongest delivery semantics, most operational surface |

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

Switching is a config line in `app.config.ts` plus a migration of in-flight rows (`x jobs drain --to redis`). Because `saveStep` / `loadSteps` are driver methods, step persistence works identically on all three.

## Scheduling

```ts
// task (cron)
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  enqueue: () => [[sendDigest, {}]],
});
```

A `task` only enqueues. The `scheduler` role is a fixed single instance elected by an expiring row in `x_scheduler_leader` — never an advisory lock, which is session-scoped and dies with a pooled connection; a missed tick fires late rather than being skipped, and the enqueued job's idempotency key absorbs a double-fire during leader handover.

## Observability

| Surface | Contents |
|---|---|
| `/_x` dev panel | queue depth per queue, in-flight, failed, step timeline per job |
| `x jobs ls --json` / `x jobs show <id> --json` | machine-readable state, step results, next retry |
| MCP tools | `jobs.list`, `jobs.status`, `jobs.retry` — same authz as the actions |
| OpenTelemetry | one span per job, one child span per step, trace linked to the enqueuing request |

Errors follow the contract: `X_JOB_MAX_ATTEMPTS`, `X_IDEMPOTENCY_REQUIRED`, `X_STEP_DUPLICATE`, each with a `fix:` command. The full table is [`../architecture/08-jobs-internals.md`](../architecture/08-jobs-internals.md).
