---
title: Jobs
menu: true
nav: Jobs
description: A Postgres queue with a transactional outbox, durable steps, and an idempotency key that the type system refuses to let you forget.
lede: Postgres queue by default. Durable steps. `idempotencyKey` required by the type. Drivers swap without touching job code.
updated: 2026-08-10
---

## Transactional outbox by default

`ctx.jobs.enqueue` inside an action writes the job row **in the same transaction as the
business write**.

```ts
async handle({ input, ctx }) {
  const post = await ctx.posts.publish(input.postId);              // INSERT/UPDATE
  if (input.notify) await ctx.jobs.enqueue(notifySubscribers, { postId: post.id });  // same tx
  return post;
}
```

| Bug class removed | How it happens without an outbox |
|---|---|
| **Ghost job** | enqueue succeeded, transaction rolled back → worker processes a post that does not exist |
| **Lost job** | transaction committed, broker `publish` failed → the email is never sent and nothing logs an error |
| **Double side effect** | retry of the whole handler re-enqueues → two welcome emails |
| **Ordering inversion** | worker reads the row before the writer's commit is visible → "record not found", then a retry storm |

Commit is the enqueue. There is no window in between, and no compensating-action code for an
agent to forget to write. External brokers do not get exempted: the outbox table is still the
transactional record and a relay moves committed rows onto the broker.

## Durable steps

```ts
// job
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

| API | Semantics |
|---|---|
| `step.run(name, fn)` | executes `fn` once ever. Result persisted under `(jobId, name)`. On replay, returns the stored result without calling `fn` |
| `step.sleep(duration)` | persists a wake time, releases the worker, and the job resumes in a fresh process. No held connection, no timer in memory. `'3d'` is safe |
| `step.waitForEvent(name, { match, timeout })` | suspends until a matching event arrives (webhook, another action, a user click) or the timeout fires. Returns the event payload or `null` |

**The step is the retry unit, not the job.** A failure in `nudge` re-enters `run`, replays
`provision` and `welcome-email` from storage in microseconds, and retries only `nudge`. Step
names must be unique and stable within a job; `x verify` fails on duplicates
(`X_JOB_DUPLICATE_STEP`).

## Idempotency is in the type signature

```ts
idempotencyKey: ({ orgId }) => `onboard:${orgId}`,   // REQUIRED by the type
```

Omitting it is a compile error, not a lint warning. At-least-once delivery is the only honest
guarantee any queue provides, so every handler must be replay-safe — and "remember to add a
key" is exactly the instruction an agent drops under pressure.

| Behavior | Rule |
|---|---|
| Duplicate enqueue with a live key | second enqueue returns the existing job handle, no new row |
| Key uniqueness window | retention policy per queue; default 24h after terminal state |
| Key must be | deterministic from `input` only. No timestamps, no random, no `ctx` |
| Non-idempotent external call inside a step | wrap with the provider's idempotency header, keyed off `${jobId}:${stepName}` |

Corollary: durable business state lives in your tables, never only in the queue payload. A
payload is a pointer, not a record — `{ orgId }`, not `{ org: { …30 fields } }`.

## Concurrency and rate limits

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

| Control | Meaning | Enforced by |
|---|---|---|
| `concurrency.limit` | max simultaneous runs sharing a key | advisory lock / lease count in the driver |
| `rateLimit` | max starts per window per key | token bucket row, checked at claim time |
| `queue` | named pool; the `worker` role runs one pool per config | `WORKER_QUEUES=default,integrations` |
| `retry.attempts` / `backoff` | `'exponential'`, `'linear'` or `'fixed'`, jittered | driver scheduler |
| terminal failure | after `attempts`, moves to dead-letter with the full step trace | `x jobs retry <id>` replays from the failed step |

A rate-limited or concurrency-blocked job is deferred, never dropped — it stays queued with a
later `runAt`.

## One driver interface

| Driver | Status | When | Trade-off |
|---|---|---|---|
| `pg` (default) | shipped | always, up to the throughput a single Postgres sustains | outbox is free (same DB, same tx); `SELECT … FOR UPDATE SKIP LOCKED` claiming; zero extra infra |
| `memory` | shipped | `x dev` and tests | the same claim/ack/nack path as `pg` — visibility timeout, idempotency dedupe, dead-letter — with zero infrastructure |
| `redis` | v2 | high-throughput, short jobs | needs the outbox relay; loses "queue state in one backup" |
| `nats` | v2 | very high fanout, multi-region, JetStream retention | strongest delivery semantics, most operational surface |

`redis` and `nats` are **interface-complete and not implemented** in 1.0.0. Every method raises
`X_NOT_IMPLEMENTED` — an app can be written and typechecked against the interface, and nothing is
ever dropped silently. Getting off a stub is one command: `x jobs drain --to memory --json`. Which
driver the app runs on afterwards is a config line, not the drain — see below.

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

Switching drivers is a config line — `jobs: { driver: 'postgres' }` in `app.config.ts` — plus a
migration of in-flight rows (`x jobs drain --to memory|redis|nats`, `--dry-run` for the plan).
Because `saveStep` / `loadSteps` are driver methods, step persistence works identically on every
driver. **Job code never changes.** Draining *to* `redis` or `nats` moves nothing until those
drivers land in v2: the stub's `enqueue` raises `X_NOT_IMPLEMENTED` per record, `x jobs drain`
reports each one in `findings` and exits non-zero, and every leased job goes back to the source
without burning an attempt.

## Scheduling

```ts
// task (cron)
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  enqueue: () => [[sendDigest, {}]],
});
```

The `scheduler` role is a fixed single instance elected by a Postgres advisory lock. A missed
tick fires late rather than being skipped, and the enqueued job's idempotency key absorbs a
double-fire during leader handover.

## Observability

| Surface | Contents |
|---|---|
| `/_x` dev panel | queue depth per queue, in-flight, failed, step timeline per job |
| `x jobs ls --json` / `x jobs show <id> --json` | machine-readable state, step results, next retry |
| MCP tools | `jobs.list`, `jobs.status`, `jobs.retry` — same authz as the actions |
| OpenTelemetry | one span per job, one child span per step, trace linked to the enqueuing request |

Errors follow the contract: `X_JOB_STEP_FAILED`, `X_JOB_NO_IDEMPOTENCY_KEY`,
`X_JOB_DUPLICATE_STEP` — each with a `fix:` command.
