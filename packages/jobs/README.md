# @ultimat3/jobs ⚙️

Durable background work. Steps that replay, a transactional outbox that is on by default,
and one driver interface so Postgres → Redis → NATS is a config line.

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

`welcome-email` fails? Attempt 2 replays `provision` **from storage** and re-sends only the
email. The 3-day sleep does not hold a process: the run suspends and the queue redelivers it.

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
| `step.run(name, fn)` | runs once ever; result persisted before the next step starts |
| `step.sleep(name, '3d')` | suspends the run, requeues it for the wake time |
| `step.sleep('3d')` | same, step name derived from the duration |
| `step.waitForEvent(name, event, { match, timeout })` | suspends until `publishEvent()` matches |

Step names are the replay key, so they must be deterministic and unique in a run — a
duplicate is `X_STEP_DUPLICATE`, not a silent overwrite. Suspension is control flow
(`StepSuspension`), never a failure: it does not burn a retry attempt.

## The transactional outbox (on by default)

```ts
await ctx.tx(async (tx) => {
  const post = await ctx.posts.publish(input.postId, tx);
  await ctx.jobs.enqueue(notifySubscribers, { postId: post.id }); // joins `tx`
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
| `worker` | `createWorker({ driver, queues, concurrency })` | per-queue pools, heartbeat, SIGTERM drain: stop claiming → finish in-flight → close |
| `scheduler` | `createScheduler({ driver, leader })` | advisory-lock leader, one dispatcher per tick, catch-up policy |

```ts
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',                      // REQUIRED — a cron without a timezone is a bug
  enqueue: () => [[sendDigest, {}]],
});
```

`tz` is required by the type. `0 3 * * *` in a DST zone runs twice or zero times on the
switch day. Catch-up after downtime is explicit: `skip` (default), `run-once`, `run-all`.

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

## Introspection

`inspectQueues`, `inspectJob` (per-step trace), `inspectDeadLetters`, `retryFromStep`,
`inspectManifest` — all `--json`-shaped, shared by `/_x`, the CLI and the MCP tools.

## Errors

| Code | Cause |
|---|---|
| `X_IDEMPOTENCY_REQUIRED` | job defined without an idempotency key (JS callers) |
| `X_STEP_DUPLICATE` | two steps share a name in one run |
| `X_JOB_DUPLICATE` | enqueue collided with a live key under `onConflict: 'error'` |
| `X_JOB_TIMEOUT` | job or required `waitForEvent` exceeded its timeout |
| `X_JOB_MAX_ATTEMPTS` | retries exhausted, job dead-lettered |
| `X_OUTBOX_NO_TX` | enqueue outside a transaction with `mode: 'required'` |
| `X_DRIVER_UNAVAILABLE` | no `DATABASE_URL` / executor for the pg driver |
| `X_NOT_IMPLEMENTED` | redis / nats driver |

## Boundary

Tier 3. Imports `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/entity`,
`@ultimat3/policy`, `@ultimat3/cache`, `@ultimat3/time`. Never HTTP, render or UI.
