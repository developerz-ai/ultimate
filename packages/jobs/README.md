# @ultimat3/jobs ⚙️

Durable background work. Steps that replay, a transactional outbox that is on by default,
and one driver interface so Postgres → Redis → NATS is a config line.

```ts
import { job, t } from '@ultimat3/jobs';

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

`welcome-email` fails? Attempt 2 replays `provision` **from storage** and re-sends only the
email. The 3-day sleep does not hold a process: the run suspends and the queue redelivers it.

## The handle is the surface

```ts
await onboardOrg.enqueue({ orgId });              // joins the ambient transaction
await onboardOrg.as(ctx.actor, { orgId });        // same, tenantId stamped from the actor
onboardOrg.describe();                            // the manifest row for this job
await nightlyDigest.enqueue();                    // fire a task's entries now
nightlyDigest.describe();                         // { kind: 'task', cron, tz, jobs, … }
```

| Member | On | Behaviour |
|---|---|---|
| `enqueue(input, options?)` | `JobHandle` | queues through `jobsFacade()`; joins the caller's `tx` when the outbox is installed |
| `as(actor, input, options?)` | `JobHandle` | enqueue on behalf of an actor — fills `tenantId` from `actor.orgId` so per-tenant limits apply |
| `describe()` | `JobHandle` | the `JobDescriptor` the manifest, `/_x` and MCP read |
| `entries()` | `TaskHandle` | the declared `[job, input]` pairs |
| `enqueue(options?)` | `TaskHandle` | fires every declared entry now, one result per entry |
| `describe()` | `TaskHandle` | `TaskDescriptor` — cron, tz, catch-up, jobs in declaration order |

## The export name is the job's name

```ts
export const api = defineApi({
  jobs: [postJobs, orgJobs],     // module namespaces, never a list of name strings
  tasks: [scheduledTasks],
});
```

`defineApi` hands each module to `registerJobs`/`registerTasks`, which stamp the export name
onto **the handle the module exported** and re-key the registry — `import { onboardOrg }` is the
object `enqueue()` routes through after boot, not a renamed copy of it. Hand nothing over and a
job keeps the positional name `job()` gave it: `anonymous-job-2` on the queue row, in
`x.manifest.json` and in every dead-letter trace, appearing in no source file.

A definition that sets `name:` keeps it. A job name is the durable queue key that queued,
retrying and dead-lettered rows already carry, so renaming an export must never move where they
are delivered — `@ultimat3/mail`'s `mail.send` relies on exactly that.

Registering the same handle twice is one registration seen twice, because `defineApi` and the
framework's module scan both reach the same declaration file. Everything else that puts two
things on one durable name is `X_JOB_DUPLICATE`, refused at the earliest point it is decidable:

| Collision | Refused at |
|---|---|
| two definitions setting the same `name:` | `job()` / `task()`, before either can seat the other out |
| two different handles under one export name | `defineApi` |
| one handle exported twice (`export { notify as a, notify as b }`) | `defineApi` — the second alias would move the queue key |

`registerJobs`/`registerTasks` are internal: `defineApi` reaches them through core's registrar
table, and they are not part of this package's public API. There is one way to register.

`.as()` **queues**; it never runs the handler inline. A job's execution surface is the queue,
so an inline run would be a second execution path next to the worker's — with no retry, no
dedupe and no dead letter. Its idempotency key is the job's own, so a manual `task.enqueue()`
and the scheduler's occurrence-scoped fire stay distinct rows on purpose.

With no facade installed, `enqueue` publishes straight to `jobDriver()`; with none of those
either, it is `X_DRIVER_UNAVAILABLE` at the call, not a silently dropped job.

## `idempotencyKey` is required by the type

Not a convention, not a lint rule — a non-optional field on `JobDefinition`. Queues deliver
at least once (partition, lease expiry, outbox replay), so every job is asked "have you
already run?" whether or not its author thought about it. Optional means the answer is
usually "nobody thought about it", and the bug — two charges, two welcome emails, two
provisioned orgs — shows up in production under load and never in a test. There is no way
to define a job in Ultimate that cannot be deduped.

## Durable steps

| Call | Behaviour |
|---|---|
| `step.run(name, fn)` | runs once ever; result persisted before the next step starts. `fn` receives an `AbortSignal` |
| `step.sleep(name, '3d')` | suspends the run, requeues it for the wake time |
| `step.sleep('3d')` | same, step name derived from the duration |
| `step.waitForEvent(name, event, { match, timeout })` | suspends until `publishEvent()` matches |

Step names are the replay key, so they must be deterministic and unique in a run — a
duplicate is `X_STEP_DUPLICATE`, not a silent overwrite. Suspension is control flow
(`StepSuspension`), never a failure: it does not burn a retry attempt.

## Backfills are jobs

`backfill()` is a **factory over `job()`**, not a ninth primitive — one pass over every row a
chain matches, with the retry policy, the queue, the cancellation and the dead-letter path a job
already has.

```ts
import { backfill } from '@ultimat3/jobs';
import { db } from '@postly/db';

export const rewriteSlugs = backfill({
  name: 'rewrite-slugs',                                   // REQUIRED: a durable key
  batch: 1_000,                                            // rows per statement and per step
  source: () => db.posts.where({ published: true }),
  async handle({ rows }) {
    await db.posts.upsertAll(rows.map(slugged), { onConflict: ['id'] });
  },
});

await rewriteSlugs.enqueue({});                            // it is a JobHandle
```

The source is read through `inBatches()` — one statement per page, keyset, never OFFSET — and
each page is handled inside its own `step.run`, named `batch:0`, `batch:1`, … A run killed
mid-pass therefore **resumes on the page it stopped at**: completed steps replay from storage
without a statement, and the iteration reopens at the cursor they left behind.

| Rule | Why |
|---|---|
| the checkpoint is a cursor and a count, never the page | a completed step's output is retained for the whole run — checkpointing rows would hold every processed row until the job ends |
| `handle` is given no `step` | a step name minted inside it collides with itself on batch 2 (`X_STEP_DUPLICATE`) |
| `handle` is given a `signal` | the run's deadline composed with the batch's own ceiling — hand it to whatever the body calls |
| `handle` runs at least once per page | an attempt cancelled between the last row and the checkpoint replays it — write through `upsertAll` / `updateWhere`, never `count + 1` |
| `idempotencyKey` is the backfill's name | re-enqueueing a live pass is the same pass, not a second writer on one table |
| `batch` is refused at declaration | `0`, `1.5` and a `NaN` from an env var fail the build, not the fourth attempt |

### The `x_backfills` ledger

What has already been swept, the twin of `x_migrations`. It ships in the same DDL as `x_jobs`,
hangs off the queue driver as `driver.backfills`, and carries one row per **pass**: name,
definition checksum, status, app version, rows processed, last cursor, started/completed.

```ts
await rewriteSlugs.enqueue({});                  // completed already? no-op with a report
// → { name: 'rewrite-slugs', batches: 0, rows: 0, skipped: true, previousRunId: '…' }

await rewriteSlugs.enqueue({ force: true });     // sweeps again, into a NEW row
```

| Rule | Why |
|---|---|
| only a **completed** row blocks | a `running` row is this pass resuming, a `failed` one is an attempt the queue is about to retry |
| `force` writes a new row | reruns are history, never an edit of the row they rerun |
| a moved checksum **warns** | it hashes function source text, which a bundler moves without behaviour changing — `@ultimat3/db` throws on the same fact because SQL text is what it applied |
| the row is a report, never a resume source | where a resumed pass restarts is the step checkpoints' answer, and there is only one |
| a retry adopts its own row | `started_at` is when the pass began, not when this attempt did |
| a driver without a ledger runs the pass anyway | the same degradation `introspect` has — no bookkeeping, never a refusal |

## The deadline cancels

A job's `timeout` aborts `ctx.signal` **before** it fails the attempt, because the nack that
follows makes the job claimable by another worker — a body still running past it is a second
copy of one job.

```ts
run: async ({ input, ctx, step }) => {
  const res = await fetch(url, { signal: ctx.signal });     // stops at the deadline
  await step.run('save', (signal) => save(res, { signal })); // the step's own ceiling too
},
```

Nothing can kill a body that ignores the signal, so the durable state is fenced: past the
cancel every step write is refused with `X_ABORTED`, and a run that finishes anyway is logged
as `jobs.timeout.abandoned` — the one way to find a handler that never reads `ctx.signal`.

## The transactional outbox (on by default)

```ts
await ctx.tx(async (tx) => {
  const post = await ctx.posts.publish(input.postId, tx);
  await notifySubscribers.enqueue({ postId: post.id }); // joins `tx`
});
```

The job row is written in the **same transaction** as the business rows; a relay publishes
it after commit. The bug class this removes:

| Without an outbox | Result |
|---|---|
| enqueue, then the transaction rolls back | the job runs against rows that never existed |
| commit, then the process dies before enqueue | the job is lost, silently, forever |

Both are load-dependent, both pass every test you would write, and both produce "the email
went out but the order isn't in the database". Joining the transaction closes the window.
The relay publishes *then* marks published, so a crash re-publishes — collapsed by the
idempotency key. Set `mode: 'required'` to make an enqueue outside a transaction an
`X_OUTBOX_NO_TX` error instead of a direct publish.

## Drivers

One interface: `enqueue`, `claim` (visibility timeout), `ack`, `nack` (backoff),
`heartbeat`, `stats`. Zero job-code change between them.

| Driver | Status | Backing | Use |
|---|---|---|---|
| `pg` | **default** | `SELECT ... FOR UPDATE SKIP LOCKED`, partial unique index, advisory-lock leader | zero-infra start, most apps |
| `memory` | complete | in-process maps | `x dev`, tests |
| `redis` | interface-complete, `X_NOT_IMPLEMENTED` | Streams + consumer groups | planned |
| `nats` | interface-complete, `X_NOT_IMPLEMENTED` | JetStream work queue | planned |

The pg SQL is exported verbatim (`SQL_CLAIM`, `SQL_ENQUEUE`, `SQL_NACK`, …) so an agent
debugging a stuck queue can read and run the exact statement.

## Roles

| Role | Entry | Behaviour |
|---|---|---|
| `worker` | `createWorker({ driver, queues, concurrency })` | per-queue pools, lease heartbeat, SIGTERM drain: stop claiming → finish in-flight → close |
| `scheduler` | `createScheduler({ driver, leader })` | advisory-lock leader, one dispatch round at a time, catch-up policy, SIGTERM drain: stop dispatching → finish the round → release the lock |

```ts
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',                      // REQUIRED — a cron without a timezone is a bug
  enqueue: () => [[sendDigest, {}]],
});
```

`tz` is required by the type *and* validated against the runtime's IANA database, because a
non-empty string is not a timezone: `tz: 'Bogota'` would resolve every occurrence in UTC and
run five hours off, silently, forever. `0 3 * * *` in a DST zone runs twice or zero times on
the switch day. Catch-up after downtime is explicit: `skip` (default) fires the latest missed
occurrence and drops the older ones, `run-once` fires the earliest missed one, `run-all` fires
every one of them. `maxCatchUp` (default 10) bounds EVERY mode, not just `run-all`: one tick
walks at most that many occurrences forward from the last fire, and the policy then picks from
what that walk found — so after a long outage `skip` fires the latest occurrence *within the
cap*, and `run-once` the earliest one, not the true latest/earliest missed.

## Retries

`{ attempts, backoff: 'exponential' | 'linear' | 'fixed', delay, maxDelay, jitter }`.
Equal jitter is on by default so a burst of failures does not retry in lockstep.
Exhausted jobs are dead-lettered, never dropped: `x jobs retry <id>`.

```
retrySchedule({ attempts: 5, backoff: 'exponential', delay: 1000 })
// => [1000, 2000, 4000, 8000]
```

## Limits

Per-tenant concurrency (`tenantId` = the actor's `orgId`, carried on the queue row), a
per-queue cap and a global cap. Over a cap, the claim is handed straight back without
burning an attempt — one org's 50k-row import cannot starve the fleet.

## Leases

A claim buys `visibilityTimeoutMs` of invisibility; the worker renews it every
`heartbeatIntervalMs` (default a third of the window) for as long as the job runs. Renewal
failures are not swallowed:

| Fact | Signal |
|---|---|
| a renewal failed, the window still has room | `jobs.heartbeat.failed` (warn) |
| a whole window passed with none landing | `jobs.lease.lost` (error) + `job_leases_lost_total{queue}` |

The second one means the queue is free to hand that job to another worker while this one is
still running it — at-least-once turning into twice. Alert on any non-zero rate. The window is
measured from the last renewal that **landed**, on this process's clock, so a driver whose
heartbeat hangs is caught the same as one that rejects.

## Introspection

`inspectQueues`, `inspectJob` (per-step trace), `inspectDeadLetters`, `retryFromStep`,
`inspectManifest` — all `--json`-shaped, shared by `/_x`, the CLI and the MCP tools.

## Errors

| Code | Cause |
|---|---|
| `X_IDEMPOTENCY_REQUIRED` | job defined without an idempotency key (JS callers) |
| `X_STEP_DUPLICATE` | two steps share a name in one run |
| `X_JOB_DUPLICATE` | enqueue collided with a live key under `onConflict: 'error'`; or two different job/task handles registered under one name |
| `X_JOB_TIMEOUT` | job or required `waitForEvent` exceeded its timeout |
| `X_JOB_MAX_ATTEMPTS` | retries exhausted, job dead-lettered |
| `X_OUTBOX_NO_TX` | enqueue outside a transaction with `mode: 'required'` |
| `X_DRIVER_UNAVAILABLE` | no `DATABASE_URL` / executor for the pg driver |
| `X_ABORTED` | a cancelled attempt tried to write a step — core's code, not a second name for it |
| `X_NOT_IMPLEMENTED` | redis / nats driver |

## Boundary

Tier 3. Imports `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/entity`,
`@ultimat3/policy`, `@ultimat3/cache`, `@ultimat3/time`. Never HTTP, render or UI.
