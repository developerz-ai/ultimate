# Jobs and workflows

Durable background work, optionally multi-step. Postgres queue by default. `idempotencyKey` is required by the type. Drivers swap without touching job code.

Pre-v1. Not production-ready.

## The canonical shape

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

## Transactional outbox by default

`ctx.jobs.enqueue` inside an [action](Actions) writes the job row in the **same transaction** as the business write. Commit *is* the enqueue.

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

Rolled back → the job never existed. Committed → durably queued. No window in between, no compensating-action code for an agent to forget.

External brokers are not exempted: the outbox table stays the transactional record and a relay moves committed rows onto the broker. At-least-once delivery is preserved; the atomicity is not negotiable.

## Durable steps

| API | Semantics |
|---|---|
| `step.run(name, fn)` | executes `fn` once ever. Result persisted under `(jobId, name)`. On replay, returns the stored result without calling `fn` |
| `step.sleep(duration)` | persists a wake time, releases the worker, and the job resumes in a fresh process. No held connection, no timer in memory. `'3d'` is safe |
| `step.waitForEvent(name, { match, timeout })` | suspends until a matching event arrives (webhook, another action, a user click) or the timeout fires. Returns the event payload or `null` |

**The step is the retry unit, not the job.** A failure in `nudge` re-enters `run`, replays `provision` and `welcome-email` from storage in microseconds, and retries only `nudge`. That is why an onboarding flow can retry on day 3 without re-provisioning or re-emailing.

| Step rule | Enforcement |
|---|---|
| Names unique within one `run` | `X_JOB_DUPLICATE_STEP` at `x verify` |
| Names stable across deploys | renaming a step invalidates its stored result — it re-runs |
| Step results must be serializable | persisted via the driver's `saveStep` |
| No step inside a loop with a computed name | non-deterministic names break replay; enumerate them |
| Non-idempotent external call inside a step | wrap with the provider's idempotency header, keyed off `${jobId}:${stepName}` |

## Idempotency is in the type signature

```ts
idempotencyKey: ({ orgId }) => `onboard:${orgId}`,   // REQUIRED by the type
```

Omitting it is a **compile error**, not a lint warning. At-least-once is the only honest guarantee any queue provides, so every handler must be replay-safe — and "remember to add a key" is exactly the instruction an agent drops under pressure. A required field converts a runtime duplicate-charge incident into a red squiggle.

| Behavior | Rule |
|---|---|
| Duplicate enqueue with a live key | second enqueue returns the existing job handle, no new row |
| Key uniqueness window | `retentionpolicy` per queue; default 24h after terminal state |
| Key must be | deterministic from `input` only. No timestamps, no random, no `ctx` |
| Same key, different payload | `X_IDEMPOTENCY_CONFLICT` — `idempotency key "…" was already used with a different payload` |
| Same key, still in flight | `X_IDEMPOTENCY_CONFLICT` — retry the same key after the first request settles |
| Missing key | `X_JOB_NO_IDEMPOTENCY_KEY` at build time |

**Durable business state lives in your tables, never only in the queue payload.** A payload is a pointer, not a record. If the queue is drained, replaced, or migrated to another driver, the business must still be reconstructible from Postgres alone. So `{ orgId }`, not `{ org: {...30 fields} }`.

## Concurrency, rate limits, queues, retry

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
| `queue` | named pool; the `worker` role runs one pool per config (`WORKER_QUEUES=default,integrations`) | worker pool sizing, see [Deployment](Deployment) |
| `retry.attempts` / `backoff` | `'exponential' \| 'linear' \| 'fixed'`, jittered | driver scheduler |
| terminal failure | after `attempts`, moves to dead-letter with the full step trace | `x jobs retry <id>` replays from the failed step |

A rate-limited or concurrency-blocked job is **deferred, never dropped** — it stays queued with a later `runAt`.

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

| Driver | When | Trade-off |
|---|---|---|
| `pg` (default) | always, up to ~thousands of jobs/sec | outbox is free (same DB, same tx); `SELECT ... FOR UPDATE SKIP LOCKED` claiming; zero extra infra |
| `redis` | high-throughput, short jobs | needs the outbox relay; loses "queue state in one backup" |
| `nats` | very high fanout, multi-region, JetStream retention | strongest delivery semantics, most operational surface |

Switching is a config line in `app.config.ts` plus a migration of in-flight rows (`x jobs drain --to redis`). Because `saveStep` / `loadSteps` are driver methods, step persistence is identical on all three.

## Dead letter

| Stage | Behavior |
|---|---|
| Attempt `n` fails | `fail(id, err, retryAt)` with jittered backoff per `retry.backoff` |
| Attempts exhausted | row moves to dead-letter carrying the full step trace and the serialized error |
| Inspect | `x jobs show <id> --json` — step results, executions per step, next retry, the failing error |
| Replay | `x jobs retry <id>` — resumes **from the failed step**, completed steps replay from storage |
| Bulk | `x jobs retry --queue integrations --failed-since 1h --json` |

Draining a worker mid-job is safe: it finishes the current step, persists it, and releases the lease so another worker resumes at the next step — never mid-step (`X_DRAINING` on new claims).

## Observability

| Surface | Contents |
|---|---|
| `/_x` dev panel | queue depth per queue, in-flight, failed, step timeline per job |
| `x jobs ls --json` | one row per job: state, queue, attempts, `runAt`, idempotency key |
| `x jobs show <id> --json` | machine-readable state, step results, next retry, dead-letter reason |
| MCP tools | `jobs.list`, `jobs.status`, `jobs.retry` — same authz as the actions |
| OpenTelemetry | one span per job, one child span per step, trace linked to the enqueuing request |

Every command supports `--json`. See [CLI reference](CLI-Reference).

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_JOB_NO_IDEMPOTENCY_KEY` | a `job` declaration omits `idempotencyKey` | add `idempotencyKey: (input) => …` derived from `input` only |
| `X_JOB_DUPLICATE_STEP` | two `step.run` calls share a name in one `run` | rename one step; step names are the persistence key |
| `X_JOB_STEP_FAILED` | a step exhausted its retries | `x jobs show <id> --json`, then `x jobs retry <id>` |
| `X_IDEMPOTENCY_CONFLICT` | same key, different payload, or still in flight | fresh key for a different payload; otherwise retry after the first settles |
| `X_DRAINING` | claim attempted on a worker that received SIGTERM | none — the job stays queued and another worker claims it |
| `X_POLICY_DENIED` | the job's actor fails the originating action's policy | grant the permission, or enqueue as a system actor |

Full index: [Error codes](Error-Codes). Verbatim error shapes live in each package's `src/errors.ts`.

## Testing

`x test job` — cloned DB + frozen clock.

```ts
// job test — the step guarantee, not the happy path
test('onboardOrg retries only the failed step', async ({ seed, clock, mail }) => {
  const { org } = await seed('fresh-org');
  mail.failOnce(nudgeEmail);
  await runJobs(onboardOrg, { orgId: org.id });
  clock.advance('3d');
  const trace = await runJobs.drain();
  expect(trace.steps.provision.executions).toBe(1);       // replayed from storage
  expect(trace.steps['nudge'].executions).toBe(2);        // only this one retried
});
```

Asserted by the runner: step replay, idempotency-key dedupe, retry/backoff, concurrency and rate limits, outbox atomicity on rollback. `clock.advance` drives `step.sleep` — never assert on wall-clock time. See [Testing](Testing).

## Rules

- Never assume a job runs once. Assume at-least-once.
- Never put durable business state only in the payload.
- Never do slow work inline in an action — enqueue a job.
- A job never renders, redirects, or reads headers. Actor and tenant come from `ctx`.
- One `step.run` per externally-visible side effect. A step that does two things cannot be retried.
- Cron never contains a handler body — that is a [scheduled task](Scheduled-Tasks) enqueuing a job.
