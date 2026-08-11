# Jobs and workflows

Durable background work, optionally multi-step. Postgres queue by default. `idempotencyKey` is required by the type. Drivers swap without touching job code.

v1.1.0 `As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)).

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

## The fluent surface

Every projection is a method on the job — `onboardOrg.enqueue({ orgId })`, never `enqueueJob(onboardOrg, input)` — and every declared field is lifted onto it. A job has no `.def`.

| Member | Is | Rule |
|---|---|---|
| `onboardOrg.enqueue(input, options?)` | the enqueue | resolves the ambient jobs facade, so it **joins the caller's transaction** when the app installed the outbox. One call site works in a request handler, a job, a script and a test |
| `.as(actor, input, options?)` | the same enqueue, on someone's behalf | fills `tenantId` from the actor's org, so per-tenant concurrency and rate limits apply. `null` — or an actor with no org — leaves `tenantId` unset: the limiter's own shared bucket, not a fake org id on the row. It **queues; it never runs inline** |
| `.run(args)` | the handler itself | the worker calls it. App code does not — see below |
| `.parse(raw)` | the payload check | a raw queue payload against the declared `input` |
| `.idempotencyKeyFor(input)` | the dedupe key | whatever the declared `idempotencyKey` returned. An empty string throws `X_INVARIANT` at the call — an empty key makes every enqueue look like a duplicate of every other |
| `.describe()` | the manifest row | `name`, `input` (vendor tag only), `queue`, `retry: { attempts, backoff }`, `steps` |
| `.kind` `.name` `.queue` `.retry` `.concurrency` `.timeoutMs` `.input` | the declaration, lifted | readable, and already **resolved**: `kind` is `'job'`, `queue` is `'default'` when undeclared, `retry` carries the framework defaults merged underneath, `timeoutMs` is `timeout` normalized to ms |

**One enqueue implementation.** `<job>.enqueue`, `<job>.as` and a [task](Scheduled-Tasks)'s own `enqueue()` all resolve the same ambient facade; the only other calls into a driver's `enqueue` are the outbox relay and the scheduler's occurrence dispatch. So "does this join the transaction?" has one answer for every enqueue an app writes, and there is no second path to forget about.

`run` is on the handle and is still not yours to call. The worker's `executeJob` is the one execution path, and it owns the attempt counter, the step store, the timeout and the lease — none of which a direct call carries. That is also why `.as()` queues: on an [action](Actions) `.as()` *runs* the mutation as that actor, on a job it *enqueues* as that actor. Same word, and the difference is the primitive's execution surface, not an inconsistency.

`describe().steps` is **empty by design**. Step names are chosen inside `run()` at execution time, so they are not statically knowable — the steps a run actually recorded come from the run itself, via `x jobs show <id> --json`. `x.manifest.json`, the `/_x` jobs panel and the MCP dev server read one list, and that list is a map over each handle's own `describe()` — so the list and a single job can never disagree. `name` is the export name, stamped by `defineApi({ jobs: [postJobs] })` — the same call that names actions and queries. A module nobody hands over keeps `job()`'s positional `anonymous-job-<n>`, on the queue row and in `x.manifest.json`. A definition carrying its own `name:` keeps it: the name is a durable queue key, so queued and dead-lettered rows survive a renamed export.

## Transactional outbox by default

`<job>.enqueue` inside an [action](Actions) writes the job row in the **same transaction** as the business write — the handle resolves the ambient jobs facade, the one `ctx.jobs` names. Commit *is* the enqueue.

```ts
async handle({ input, ctx }) {
  const post = await ctx.posts.publish(input.postId);              // INSERT/UPDATE
  if (input.notify) await notifySubscribers.enqueue({ postId: post.id });  // same tx
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

One interface. **Job code never changes.** Step persistence hangs off the same object (`steps`), so it is identical on every implementation.

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
  readonly introspect?: JobIntrospection;
  close?(): Promise<void>;
}
```

Two implementations ship in 1.0.0. Two more are **v2** — interface-complete stubs, so an app typechecks against them, and every method throws `X_NOT_IMPLEMENTED` with a runnable `fix:` rather than silently dropping a job.

| Driver | Status `As of 2026-08` | When | Trade-off |
|---|---|---|---|
| `postgres` (default) | **shipped** | always, up to ~thousands of jobs/sec. `x dev` runs it too, against the embedded PGlite | outbox is free (same DB, same tx); `SELECT ... FOR UPDATE SKIP LOCKED` claiming; zero extra infra |
| `memory` | **shipped**, not a `jobs.driver` value | tests and fixtures — reached through `createMemoryDriver()`, and as `x jobs drain --to memory` | in-process; nothing survives a restart |
| `redis` | **v2 — throws `X_NOT_IMPLEMENTED`** | high-throughput, short jobs | would need the outbox relay; loses "queue state in one backup" |
| `nats` | **v2 — throws `X_NOT_IMPLEMENTED`** | very high fanout, multi-region, JetStream retention | strongest delivery semantics, most operational surface |

`jobs.driver` in `app.config.ts` accepts `'postgres' | 'redis' | 'nats'` — and only `'postgres'` runs. Setting it to `redis` or `nats` typechecks and boots, then throws on the first enqueue: deliberate, and why the stubs exist instead of an absent export.

`x jobs drain --to <driver>` moves in-flight rows between drivers, and `--to memory` is the only target that completes today: `--to redis` and `--to nats` construct the target and fail on the first enqueue with `X_NOT_IMPLEMENTED`. The cross-driver migration procedure is v2 — see [Upgrading](Upgrading).

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
| MCP dev tools | `jobs.inspect` (definitions, retry policy, steps) and `queue.depth` (pending/running/failed per queue) — scope `dev:read`, never reachable in `ROLE=web` |
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
| `X_FORBIDDEN` | the job's actor fails the originating action's policy | grant the permission, or enqueue as a system actor |
| `X_NOT_IMPLEMENTED` | the `redis` or `nats` driver was reached — both are v2 | set `jobs.driver: 'postgres'` in `app.config.ts` (it is already the default) |

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
