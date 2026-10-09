# Jobs and workflows

Durable background work, optionally multi-step. Postgres queue by default. `idempotencyKey` is required by the type. Drivers swap without touching job code.

`As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)).

Two factories return a `job` rather than a ninth primitive, so everything on this page applies to both: `backfill()` ([Migrations and backfills](Migrations-And-Backfills)) and `scrape()` ([Scraping](Scraping)).

## The canonical shape

```ts
// job
export const onboardOrg = job({
  input: t.object({ orgId: t.uuid }),
  tenant: ({ orgId }) => orgId,               // the org this run acts as
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
| `onboardOrg.enqueue(input, options?)` | the enqueue | resolves the ambient jobs facade, so it **joins the caller's transaction** when the app installed the outbox. One call site works in a request handler, a job, a script and a test. Answers `{ id, runId, deduped }` — the job's own ids, allocated when the row is staged, so an action can name the run it started without leaving the transaction. `options.runId` names the run instead: a lowercase uuid, or the enqueue is refused with `X_ID_INVALID` before anything is staged or queued |
| `.as(actor, input, options?)` | the same enqueue, on someone's behalf | fills `tenantId` from the actor's org, so per-tenant concurrency and rate limits apply. `null` — or an actor with no org — leaves `tenantId` unset: the limiter's own shared bucket, not a fake org id on the row. It **queues; it never runs inline** |
| `.run(args)` | the handler itself | the worker calls it. App code does not — see below |
| `.parse(raw)` | the payload check | a raw queue payload against the declared `input` |
| `.idempotencyKeyFor(input)` | the dedupe key | whatever the declared `idempotencyKey` returned. An empty string throws `X_INVARIANT` at the call — an empty key makes every enqueue look like a duplicate of every other |
| `.concurrencyKeyFor(input)` | the concurrency key | `concurrency.key(input)` for a keyed cap, `undefined` otherwise. An empty or non-string key, or one over 200 characters, throws `X_JOB_DECLARATION_INVALID` — the enqueue asks it first, so the refusal reaches the caller |
| `.describe()` | the manifest row | `name`, `input` (JSON Schema), `queue`, `retry: { attempts, backoff }`, `steps`, `idempotent`, `concurrency: { limit, keyed, whenBusy } \| null`. Never a key: both keys are computed from an input, so they are app data |
| `.kind` `.name` `.queue` `.retry` `.concurrency` `.whenBusy` `.timeoutMs` `.stepTimeoutMs` `.eventPollMs` `.input` | the declaration, lifted | readable, and already **resolved**: `kind` is `'job'`, `queue` is `'default'` when undeclared, `retry` carries the framework defaults merged underneath, `concurrency` is the cap as a number whichever way it was declared (`whenBusy` is set exactly when it is per key), and `timeout` / `stepTimeout` / `eventPoll` are normalized to ms. `stepTimeout` is a ceiling on **one** `step.run`, distinct from `timeout`'s ceiling on the whole job; `eventPoll` is how often `step.waitForEvent` looks. Both were implemented and unreachable until 2.0.0 — a non-positive value is refused at declaration, because `<= 0` reads as "no ceiling" |

**One enqueue implementation.** `<job>.enqueue`, `<job>.as` and a [task](Scheduled-Tasks)'s own `enqueue()` all resolve the same ambient facade; the only other calls into a driver's `enqueue` are the outbox relay and the scheduler's occurrence dispatch. So "does this join the transaction?" has one answer for every enqueue an app writes, and there is no second path to forget about.

`run` is on the handle and is still not yours to call. The worker's `executeJob` is the one execution path, and it owns the attempt counter, the step store, the timeout and the lease — none of which a direct call carries. That is also why `.as()` queues: on an [action](Actions) `.as()` *runs* the mutation as that actor, on a job it *enqueues* as that actor. Same word, and the difference is the primitive's execution surface, not an inconsistency.

`describe().steps` is **empty by design**. Step names are chosen inside `run()` at execution time, so they are not statically knowable — the steps a run actually recorded come from the run itself, via `x jobs show <id> --json`. `x.manifest.json`, the `/_x` jobs panel and the MCP dev server read one list, and that list is a map over each handle's own `describe()` — so the list and a single job can never disagree. `name` is the export name, stamped by `defineApi({ jobs: [postJobs] })` — the same call that names actions and queries. A module nobody hands over keeps `job()`'s positional `anonymous-job-<n>`, on the queue row and in `x.manifest.json`. A definition carrying its own `name:` keeps it: the name is a durable queue key, so queued and dead-lettered rows survive a renamed export.

## Transactional outbox by default

`<job>.enqueue` inside an [action](Actions) writes the job row in the **same transaction** as the business write — the handle resolves the ambient jobs facade, the one `ctx.jobs` names. Commit *is* the enqueue.

```ts
async handle({ input, ctx }) {
  const post = await ctx.posts.publish(input.postId);              // INSERT/UPDATE
  if (input.notify) await notifySubscribers.enqueue({ postId: post.id, orgId: post.orgId });  // same tx
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
| `step.run(name, fn)` | executes `fn` once ever. Result persisted under `(jobId, name)`. On replay, returns the stored result without calling `fn`. `fn` receives an `AbortSignal` — this step's ceiling and the run's cancellation, whichever fires first |
| `step.sleep(duration)` | persists a wake time, releases the worker, and the job resumes in a fresh process. No held connection, no timer in memory. `'3d'` is safe |
| `step.waitForEvent(name, event, { match, timeout })` | suspends until a matching event arrives (webhook, another action, a user click) or the timeout fires. Returns the event payload, or `undefined` on a timeout. "After the wait began" is read off the event bus's own clock — the database's, on the stored bus — so a worker whose clock runs ahead still sees an event published a moment later |

**The step is the retry unit, not the job.** A failure in `nudge` re-enters `run`, replays `provision` and `welcome-email` from storage in microseconds, and retries only `nudge`. That is why an onboarding flow can retry on day 3 without re-provisioning or re-emailing.

| Step rule | Enforcement |
|---|---|
| Names unique within one `run` | `X_STEP_DUPLICATE` at `x verify` |
| Names stable across deploys | renaming a step invalidates its stored result — it re-runs |
| Step results must be serializable | persisted through the driver's `steps` store (`StepStore.put`) |
| No step inside a loop with a computed name | non-deterministic names break replay; enumerate them |
| Non-idempotent external call inside a step | wrap with the provider's idempotency header, keyed off `${jobId}:${stepName}` |

## The deadline cancels

A job's `timeout` aborts `ctx.signal` **before** it fails the attempt. The order is the whole point: failing the attempt re-queues the job, another worker claims it within milliseconds, and a body still running past that moment is a second copy of one job writing into the same run.

```ts
run: async ({ input, ctx, step }) => {
  const res = await fetch(url, { signal: ctx.signal });      // stops at the deadline
  throwIfAborted(ctx);                                       // or check it in a long loop
  await step.run('save', (signal) => save(res, { signal })); // the step's own ceiling too
},
```

`ctx.signal` is the same seam an [action](Actions) reads, composed with the caller's own — there is nothing jobs-specific to learn, and a job whose caller went away is cancelled for that reason too.

**SIGTERM fires it too** (`As of 2026-09-07`). The moment the process starts draining, the worker aborts `ctx.signal` on every job it holds with `X_DRAINING` — naming the worker and the signal — and then gives the body the drain's budget to unwind in. A body that stops is **interrupted**, not failed: the job goes straight back to the ready bucket with the attempt uncounted, so `attempts: 1` survives a rollout and the worker replacing this one claims it at once. The verdict is read off the signal, not off whatever the body threw, so an app's own error for a child the shutdown killed is an interruption too. A body that ignores the signal is waited on to the deadline and abandoned there, as before; a manual `worker.stop()` aborts nothing and waits for its work — until a SIGTERM lands on it, at which point the teardown already waiting adopts the shutdown's deadline and every held job hears the abort.

| Past the cancel | What happens |
|---|---|
| `step.run` / `step.sleep` / `step.waitForEvent` | refuse to write, raise `X_ABORTED`. A late `completed` would hand the next attempt a step it never ran; a late `failed` would erase one it did |
| a body that ignores the signal and finishes anyway | cannot be killed — nothing in JS can — so it is named: `jobs.timeout.abandoned` at `warn`, with the job and how it ended |
| a body that stops because it was cancelled | the intended end. Nothing is logged |

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
| Missing key | `X_IDEMPOTENCY_REQUIRED` at build time |

**Durable business state lives in your tables, never only in the queue payload.** A payload is a pointer, not a record. If the queue is drained, replaced, or migrated to another driver, the business must still be reconstructible from Postgres alone. So `{ orgId }`, not `{ org: {...30 fields} }`.

## Concurrency, rate limits, queues, retry

Declared per job, held across the fleet.

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

| Control | Meaning | Enforced by |
|---|---|---|
| `concurrency: 4` | max simultaneous runs of **this job**, fleet-wide | one `x_job_leases` row per **held slot**, keyed `(lease_key, slot)` — the primary key is what serialises two workers reaching for the same slot. A driver with no `LeaseStore` refuses the job at worker start (`X_JOB_CONCURRENCY_UNENFORCEABLE`) rather than capping per process |
| `concurrency: { key, limit }` | max simultaneous runs **sharing one key** — "one run per account" | the same lease rows, one set per `key(input)`. `key` answers a non-empty string of at most 200 characters; `limit` is a whole number, 1 or more |
| `concurrency.whenBusy` | what a claim over the cap does. `'wait'` (default): the run stays queued, no attempt burned. `'fail'`: the run settles **`failed`** with `X_JOB_KEY_BUSY`, its body never runs, nothing retries it, and it is not a dead letter | the worker, at claim. A plain number always waits |
| rate limits | starts per window, per tenant | `concurrencyLimiter({ ratePerTenant })` on the worker — **per process**, never a `job()` field. There is no `rateLimit:` on a job, `As of 2026-10`. A start is a body that ran: a claim handed back over `job.concurrency`, or refused by its key, spends none |
| `queue` | named pool; the `worker` role runs one pool per config (`WORKER_QUEUES=default,integrations`) | worker pool sizing, see [Deployment](Deployment) |
| `retry.attempts` / `backoff` | `'exponential' \| 'linear' \| 'fixed'` | driver scheduler |
| `retry.jitter` | **equal** jitter — half fixed, half rolled — and `true` by default. Never `full`: a job that has already failed twice must not be handed a near-zero wait | driver scheduler |
| a **`terminal`** thrown code | stops on the attempt that failed, before `attempts` is reached — the same code run again is the same answer, and the attempts left are a queue slot, a provider bill, or three more wrong passwords at a site that locks the account after three. `lastError` records `— not retried: this code is classified terminal`, so an early stop is never silent | the code's `retry` classification, `registerErrorRetry({ X_YOUR_CODE: 'terminal' })`. An **unclassified** code is unaffected |
| a **`retry-after`** thrown code | the responder's `meta.retryAfterSeconds` replaces the delay, clamped by `maxDelay` — never the attempt count | same |
| attempts exhausted | moves to dead-letter with the full step trace | `x jobs retry <id>` replays from the failed step |

A job over a tenant, queue or global cap, or over a `'wait'` concurrency cap, is **deferred, never dropped** — it stays queued with a later `runAt`. `whenBusy: 'fail'` is the one declared exception.

### One run per key

| Case under `whenBusy: 'fail'` | Answer |
|---|---|
| another run holds the key | refused: state `failed`, `lastError` carries `X_JOB_KEY_BUSY` and its fix, `x jobs retry <id>` re-queues it |
| the only holder is this run's **own** earlier claim — a retry, a `step.sleep` resume or a redelivery meeting a slot not yet released or lapsed | waits one poll. A run is never failed by its own leftovers |
| the holder's worker was killed | the key stays busy until the lease TTL (the worker's `visibilityTimeoutMs`) passes, then frees with no cleanup. There is no separate `duration`: the TTL is that bound |
| `key(input)` throws at claim | that attempt fails without the body running and takes the ordinary retry path |

Refused where it is written:

| Declaration | When | Code |
|---|---|---|
| a cap of `0`, negative, fractional, `NaN` or `Infinity` — `concurrency: 0` and `limit: 0` alike; a non-function `key`; an unknown `whenBusy` | at `job()` | `X_JOB_DECLARATION_INVALID` |
| `key(input)` answering `''`, a non-string or more than 200 characters | at that enqueue | `X_JOB_DECLARATION_INVALID` |
| any `concurrency` on a driver with no lease store | `jobWorker().start()` | `X_JOB_CONCURRENCY_UNENFORCEABLE` |

`x jobs show <id> --json` reports the key a run counts under as `concurrencyKey`; the manifest's job row carries `concurrency: { limit, keyed, whenBusy }`.

### The final attempt

`run({ finalAttempt })` is `true` when a failure of this attempt will not be retried for want of attempts — the same comparison the runner dead-letters on, so a body releases what a retry would have reused without re-deriving it from `retry.attempts`.

| It is not | Because |
|---|---|
| "this body runs at most once more" | a `terminal` code stops an earlier attempt |
| true exactly once per job | an attempt handed back uncounted — a `step.sleep`, a deploy's drain — is presented again under the same number |

## Operating a queue

Every operator capability is a member of `JobIntrospection` (`driver.introspect`), implemented by the Postgres and the memory driver alike — `x jobs`, `/_x` and the jobs dashboard every `defineAdmin()` serves at `/admin/jobs` ([Admin dashboard → The jobs dashboard](Admin-Dashboard#the-jobs-dashboard)) read nothing else. A hand-written driver implements every member; TS2741 names the one it lacks.

| Capability | Member | Bound |
|---|---|---|
| paged listing | `list({ queue, name, state, idPrefix, createdFrom, createdTo, tenantId, limit, after \| before })` — keyset, newest first: `after: jobCursor(lastRow)` is the next page, `before: jobCursor(firstRow)` the previous one; `tenantId` keeps one org's rows | `MAX_JOB_PAGE` 200 rows a page; more, or a cursor no page produced, is `X_JOB_PAGE_INVALID`; `after` with `before` is `X_INVARIANT` |
| delete | `remove(id)`; `removeMany({ state, queue?, name?, tenantId? })` | a running job is `X_JOB_NOT_REMOVABLE`; bulk touches `MAX_BULK_ROWS` 1,000 and answers `{ affected, remaining }` |
| bulk retry | `requeueMany({ state, queue?, name?, tenantId? })` | the same bound, spent only on rows it can move; a row whose key a live job holds stays and is not counted in `remaining`, so calling until it is zero ends |
| retry one | `requeue(id, { fromStep? })` — a finished job only | a live job is `X_JOB_NOT_REQUEUEABLE`, a key a live job holds `X_JOB_DUPLICATE`, an id nobody queued `X_JOB_NOT_FOUND`; `fromStep` drops that step and the later ones with the row's own move |
| cancel | `cancel(id, reason?)` — a live job only (ready, delayed, running, suspended) | a done, failed, dead or cancelled row is left as it ended; `cancelJob` / `x jobs cancel` answer `X_JOB_NOT_CANCELLABLE` |
| run a delayed job now | `promote(id)`; `promoteMany({ state, queue?, name?, tenantId? })` | only a job waiting on its `runAt` — `state` is one of `PROMOTABLE_STATES` (`delayed`, or `ready` backing off before a retry); the bulk bound as above |
| queue pause | `pauseQueue(q)` / `resumeQueue(q)` / `pausedQueues()` | a paused queue is never claimed, fleet-wide, within one poll; enqueues still land |
| task pause | `pauseTask(t)` / `resumeTask(t)` / `pausedTasks()` | on resume the task's own `catchUp` decides what it missed |
| a task's last fire | `taskFires()` — `{ task, occurrenceMs, firedAt }` per task, by name | the last occurrence that QUEUED its jobs: arming a task or skipping missed occurrences is not a fire. `MAX_TASK_FIRES` 1,000 rows |
| a task's next fire | `nextTaskRun(task, from)` — the next occurrence strictly after `from`, in the task's own zone | the scheduler's own resolver, so a dashboard and the scheduler cannot disagree; no running scheduler needed |
| who is working | `workers()` — id, host, started, queues, slots, in-flight job ids, last heartbeat | a row expires one visibility timeout after its last heartbeat: a killed worker leaves by expiry |
| history | `counters({ job, sinceMs })`, `counterTotals(sinceMs)` — `done`, `retried`, `failed`, `dead`, `durationMs` | `COUNTER_TIERS`: 1-minute buckets for 24 h, 5-minute for 7 d, 1-hour for 30 d |
| progress | `run({ progress })` → `progress(done, total, note?)`, on the row and in `x jobs show` | one write a second per run at most, and always the last before the run settles |
| how a run ended | `job({ onSettled })` — `completed` (with what `run` returned), `dead-lettered`, `dropped` or `refused`; after the row is settled, under the job's tenant, three tries of its own | at most once across a crash; a hook that keeps failing is `X_JOB_ON_SETTLED_FAILED`, logged and reported, and the row is untouched. A cancel is not a settlement: whoever cancels is the observer |

```ts
export const syncAccount = job({
  input: t.object({ accountId: t.uuid, orgId: t.uuid }),
  tenant: ({ orgId }) => orgId,
  idempotencyKey: ({ accountId }) => `sync:${accountId}`,
  retry: { attempts: 3 },
  async run({ input, step, progress, finalAttempt }) {
    const rows = await step.run('load', () => loadRows(input.accountId));
    for (const [index, row] of rows.entries()) {
      await step.run(`sync:${row.id}`, () => syncRow(row));
      progress(index + 1, rows.length);
    }
    return { rows: rows.length };
  },
  // ONE hook for every ending. `settled.result` is what `run` returned, typed from it.
  async onSettled(settled) {
    if (settled.outcome === 'completed') {
      await markAccountSynced(settled.input.accountId, settled.result.rows);
    } else if (settled.input !== undefined) {
      await markAccountBroken(settled.input.accountId, settled.code);
    }
  },
});
```

| `onSettled` | Rule |
|---|---|
| `completed` | the body returned and the ack landed. Carries `input` and `result` |
| `dead-lettered` / `dropped` | failed for good; `dropped` is a job declaring `retry.deadLetter: false`. Carries `error` (the row's `lastError`), `code` (its `X_*` code, when it has one) and `input` — `undefined` when the stored payload no longer parses |
| `refused` | `whenBusy: 'fail'` over a busy key. The body never ran; `code` is `X_JOB_KEY_BUSY` |
| never called for | a retry, a suspension, a drain, a row cancelled or removed by a caller, a settle that did not land |
| delivery | **at most once** per ending — a worker killed between the settle and the hook never runs it. What must be recorded for certain is written by the body, inside a `step.run` |
| failure | three tries back to back, then `X_JOB_ON_SETTLED_FAILED`. The job's outcome never changes |

| Fact | Detail |
|---|---|
| the counter moves in the settling statement | one round trip per settle, and a count that cannot disagree with the rows. A shed, a suspension and a drained attempt are handed back uncounted |
| `QueueStats.failed` | rows that ended `failed`: refused by a busy concurrency key, or exhausted on a `retry.deadLetter: false` job (settled `failed`, outcome `dropped` — that job used to be re-queued forever) |
| a job whose worker dies on every attempt is dead-lettered | a lease that lapses on a row's FINAL attempt is settled `dead` by the next claim itself — `lastError` says the lease lapsed — and never handed out again. It reaches the dead-letter queue after `retry.attempts` claims; it used to take a worker per visibility timeout, forever. Logged `jobs.claim.exhausted`; `onSettled` is told `dead-lettered`, and `WorkerStats.deadLettered` counts it. A job declaring `retry.deadLetter: false` is buried `failed` instead and told `dropped` — the worker names those jobs to the claim |
| settles are fenced on the claim | `{ workerId, claim }`: a body whose lease lapsed cannot settle, renew or report on the run that replaced it — whether another worker claimed it or the same one did. The miss is logged `jobs.settle.unowned` |
| `x jobs drain` (planned) | moves nothing: the subcommand exits `X_NOT_IMPLEMENTED` `As of 25.0.0` and has no body. A drain written for a future second driver settles what it moves without counting it — a moved job is not a completed one |
| a scheduled occurrence fires in one statement | the watermark and the occurrence's jobs move together, so a crash between them cannot fire it twice |
| remote "quiet this worker" | not shipped: SIGTERM drain is the mechanism, and the orchestrator owns process lifecycle |

### Idle cost and pickup latency

| Loop | Idle behaviour | Claims per idle minute |
|---|---|---|
| worker | waits `pollIntervalMs` (250 ms) while passes find work, doubling to `idlePollMaxMs` while they do not; an idle pass is one claim over every queue it serves | 12 with the wake, 30 without |
| outbox relay | `intervalMs` (200 ms) doubling to `idlePollMaxMs` | 12 with the wake, 30 without |
| scheduler | ticks every second and, with nothing due, reads no store: watermarks are held in memory while it leads and the lease is renewed every 10 s | 6 statements, for any number of tasks |

`idlePollMaxMs` defaults to 2 s, and to 5 s while the wake is proven.

**The wake.** A `worker` pod holds one `LISTEN` session (`startQueueWake`, started by the boot). The enqueue statement and the outbox stage carry a `pg_notify` — transactional, so it is delivered when the row commits and never when it rolls back — and an idle worker or relay passes at once.

| A job enqueued by | Starts after — idle worker, Postgres 17 on loopback, median / max, `As of 2026-10-01` |
|---|---|
| the same process | 10 ms / 19 ms |
| another process, direct | 8 ms / 18 ms |
| another process, through the outbox, from its commit | 9 ms / 13 ms |
| another process, with no wake | within `idlePollMaxMs` — 2 s |
| a retry or `step.sleep` the worker itself handed back | when it falls due |
| a delayed job another process queued | within `idlePollMaxMs` past its `runAt` |

| Rule | Detail |
|---|---|
| the payload is the queue name | never an id, an input or a tenant |
| at most one notification per queue per 250 ms | Postgres serialises every notifying commit behind one lock. A row its slot kept silent is found by the woken worker's next pass, one `pollIntervalMs` later — never worse than a fixed 250 ms poll |
| the poll is the guarantee | a notification is lost with the session that would have carried it; the driver re-dials and the poll covers the gap |
| the wake has to be proven | a probe sent through the pool must come back on the session: `jobs.wake.live`. If it does not — PgBouncer in `pool_mode = transaction` delivers no notification — the log says `jobs.wake.unverified` once and the ceiling stays 2 s. Give the `worker` role a direct or session-pooled `DATABASE_URL` ([`docs/ops/04-datastores.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/ops/04-datastores.md#pooling-and-the-trap-under-it)) |
| a queue pause | read by the claim statement itself, so it holds from each worker's next claim; a resume announces the queue |

## Outbound webhooks — `webhook()`

**An outbound webhook is a job: `webhook()` is a factory over `job()` that delivers one event to
one endpoint.** It brings `.enqueue()`, retry with core's backoff, the dead-letter path,
`x jobs show` and a manifest row; it adds signing, a timestamped signature, disable-after-N
consecutive failures and a ledger row per attempt (`packages/jobs/src/webhook.ts`). It never owns
the event taxonomy, which endpoints exist, or what a payload means — the fan-out is the app's own
loop over its own subscription table. Do not hand-write a delivery job.

```ts
import { memoryWebhookLedger, webhook } from '@ultimat3/jobs';

export const deliver = webhook({
  name: 'partner.webhooks',          // required: a durable queue key
  tenant: ({ orgId }) => orgId,      // the org that owns the endpoint — or 'none'
  endpoint: ({ endpointId }) => db.endpoints.byId(endpointId), // read per attempt, never checkpointed
  event: ({ eventId }) => db.events.byId(eventId),             // { topic, body }
  ledger: memoryWebhookLedger(),     // dev only — a WebhookLedger over your own table in production
  disableAfter: 10,                  // DEFAULT_WEBHOOK_DISABLE_AFTER
});

for (const endpoint of await subscribersOf('orders.paid')) {
  await deliver.enqueue({ endpointId: endpoint.id, eventId: event.id, orgId: endpoint.orgId });
}
```

| Fact | Rule |
|---|---|
| one endpoint per job | retry, backoff and disable-after-N are per endpoint; a job that fanned out inside one body would retry every subscriber because one was down |
| the signature | `x-ultimate-webhook-signature: t=<seconds>,v1=<hex hmac-sha256>` over `v1:<t>:<eventId>:<topic>:<body>`, beside `x-ultimate-webhook-id` and `x-ultimate-webhook-topic` |
| the receiving half | `verifyWebhookSignature(request, { secret })` from `@ultimat3/http` — one format module in `@ultimat3/core`, re-exported by both |
| an endpoint URL | `https://` in production; a host resolving to a loopback, private, link-local or metadata address is refused unless `allowPrivate: true` |
| a `Retry-After` | honoured: `X_WEBHOOK_DELIVERY_THROTTLED` carries `meta.retryAfterSeconds` and the nack waits it out |
| a disabled endpoint | `X_WEBHOOK_ENDPOINT_DISABLED`; re-enabling is always the app's |
| the org | `tenant: ({ orgId }) => orgId` needs `orgId` on every enqueue, and both seams are handed it. A tenant that reads no `orgId` enqueues without one, as in 25.0.0. A payload naming no org for its tenant, or an `orgId` that is not the run's org, is `X_JOB_TENANT_MISMATCH` — terminal, dead-lettered on attempt 1. Switching a live webhook to an org tenant: drain its queue first, or re-enqueue what dead-letters with its `orgId` |
| the ledger | `WebhookLedger` is a seam, not a table: retention is the app's decision. Worked example: the reference app's `apps/web/app/webhooks/ledger.ts` over its own `webhook_deliveries` |
| the attempt deadline | `timeout:` bounds one attempt and the request inside it — there is no second per-request timeout |

Full contract, every rule with its reason: [`packages/jobs/README.md` § Outbound webhooks](https://github.com/developerz-ai/ultimate/blob/main/packages/jobs/README.md#outbound-webhooks-are-jobs-too).
Codes: `X_WEBHOOK_ENDPOINT_UNKNOWN`, `X_WEBHOOK_ENDPOINT_INVALID`, `X_WEBHOOK_ENDPOINT_DISABLED`,
`X_WEBHOOK_EVENT_UNKNOWN`, `X_WEBHOOK_EVENT_INVALID`, `X_WEBHOOK_DELIVERY_FAILED`,
`X_WEBHOOK_DELIVERY_THROTTLED`, `X_WEBHOOK_DELIVERY_REJECTED` ([Error codes](Error-Codes)).

## Driver interface

One interface. **Job code never changes.** Step persistence hangs off the same object (`steps`), so it is identical on every implementation.

```ts
export interface JobDriver {
  readonly name: string;
  /** Step persistence lives with the queue: one store, one transaction boundary. */
  readonly steps: StepStore;
  enqueue(request: EnqueueRequest): Promise<EnqueueResult>;
  claim(options: ClaimOptions): Promise<readonly ClaimedJob[]>;
  /** Both settles are fenced on the CLAIMER and answer whether they landed. */
  ack(jobId: string, by: { workerId: string; durationMs?: number }): Promise<boolean>;
  nack(jobId: string, options: NackOptions): Promise<boolean>;
  heartbeat(jobId: string, options: HeartbeatOptions): Promise<boolean>;
  stats(): Promise<readonly QueueStats[]>;
  /** The `x_backfills` ledger, when the driver ships one. `postgres` and `memory` do. */
  readonly backfills?: BackfillLedger;
  /** Fleet-wide slot counting — the only thing that can enforce `concurrency` across replicas. */
  readonly leases?: LeaseStore;
  readonly introspect?: JobIntrospection;
  close?(): Promise<void>;
}
```

Three of the four optional members degrade rather than refuse: no `introspect` is `x jobs list` with nothing to list, no `backfills` is a `backfill()` pass that runs with no bookkeeping, and no `close` is a driver holding nothing to hand back.

**`leases` is the one that refuses.** The in-process limiter is a fast path over one heap and is multiplied by the replica count, so a driver with no `LeaseStore` can only hold `concurrency.limit` per process. `jobWorker().start()` therefore **throws `X_JOB_CONCURRENCY_UNENFORCEABLE`**, naming every registered job that declared `concurrency`, rather than logging a cap it cannot keep. `postgres` ships one; a driver you write yourself needs one before any job in the tree may declare `concurrency`.

Two implementations ship, `As of 25.0.0`: `postgresJobDriver()` and `memoryJobDriver()`. **Redis is not a jobs driver**, and neither is NATS: 25.0.0 deleted both all-throw stubs (`createNatsDriver` and the Redis one), whose every method raised `X_NOT_IMPLEMENTED` — an app could typecheck against a driver that could not enqueue a job. NATS stays the realtime fanout transport.

| Driver | Status `As of 25.0.0` | When | Trade-off |
|---|---|---|---|
| `postgres` (default) | **shipped** | always, up to ~thousands of jobs/sec. `x dev` runs it too, against the embedded PGlite | outbox is free (same DB, same tx); `SELECT ... FOR UPDATE SKIP LOCKED` claiming; zero extra infra |
| `memory` | **shipped**; there is no config value for any driver | tests and fixtures, through `memoryJobDriver()` | in-process; nothing survives a restart — which is why it was never a safe `x jobs drain` target |

**There is no `jobs.driver`, and 5.0.0 is where it went.** It accepted `'postgres' | 'redis' | 'nats'` and had **no reader anywhere** — boot always built `postgresJobDriver`, stated in [`packages/jobs/src/driver.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/jobs/src/driver.ts)'s own header. So setting it to `redis` changed nothing at all and you silently got Postgres, which is the more dangerous behaviour because nothing reports it. From 5.0.0 to 24.x a stale key still rode through untyped; **25.0.0 refuses it** at `defineConfig`, naming `setJobDriver`. Deleting it from `app.config.ts` is the whole of the upgrade.

**The seam that does work is `setJobDriver(driver)`** — swap the driver, zero job-code change, which is what the interface buys. `redisJobDriver()` is the second durable driver (`As of 2026-10`, #710): `setJobDriver(redisJobDriver())` on `Bun.redis`, held to the same conformance suite as Postgres, without the operator surface (`x jobs show`, `retry`, `cancel`), backfill bookkeeping or fleet-wide `concurrency` — [`packages/jobs/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/jobs/README.md#drivers) has the table. There is no NATS jobs driver.

**`x jobs drain` is planned, `As of 25.0.0`.** It exits `X_NOT_IMPLEMENTED` before the queue boots, pointing at `x jobs list --json`: with Postgres the one durable driver, there is nowhere to drain to. Its two former `--to` values, `redis` and `nats`, were all-throw stubs — until 2026-10 a drain leased the whole pending batch for five minutes, failed every enqueue and nacked it back, nothing moved, and no worker could claim those jobs meanwhile. 25.0.0 deleted the stubs and the unreachable drain body behind the planned answer. A drain that returns with a real second driver is new code, and owes the lesson of `--to memory`, a target until 2026-09: `memoryJobDriver()` is a `Map` inside the command's own process, so the drain enqueued each job into it, acked the durable row off the source, printed `ok: true`, and lost every copy when the command exited.

So there is no cross-driver migration procedure — and none is needed while `postgres` is the only driver that runs.

## Dead letter

| Stage | Behavior |
|---|---|
| Attempt `n` fails | `fail(id, err, retryAt)` with jittered backoff per `retry.backoff` |
| Attempts exhausted | row moves to dead-letter carrying the full step trace and the serialized error |
| Inspect | `x jobs show <id> --json` — step results, executions per step, next retry, the failing error |
| Replay | `x jobs retry <id>` — resumes **from the failed step**, completed steps replay from storage |
| Stop one | `x jobs cancel <id> --reason "<why>" --json` — exit 0 means it is genuinely stopped; a finished job or a driver that cannot cancel raises `X_JOB_NOT_CANCELLABLE` |
| Bulk | **not shipped.** `retry` and `cancel` each take one id positional; there is no `--failed-since` and no queue-wide replay. List first (`x jobs list --state dead --queue integrations --json`), then loop over the ids |

Draining a worker mid-job does **not** finish the current step (`As of 2026-09-07`). On SIGTERM the worker aborts each held job's `ctx.signal` with `X_DRAINING`; a body that reads it — `fetch(url, { signal: ctx.signal })`, `throwIfAborted(ctx)` between steps — is **interrupted**: the attempt is uncounted, the lease is released, and the job goes straight back to the ready bucket for the worker replacing this one. That worker resumes from the last step that **completed** — persisted steps replay from storage, the step cut short runs again from its start, and past the abort `step.run` refuses to write (`X_ABORTED`), so a half-finished step is never recorded as done. A body that ignores the signal runs until the drain deadline and is abandoned there: its lease lapses, the queue redelivers it, and the attempt is counted. Only a manual `worker.stop()` waits for the work it holds. Plan a deploy for the interruption, not for the step: keep steps short and idempotent, and pass `ctx.signal` to every outbound call.

## Observability

| Surface | Contents |
|---|---|
| `/_x` dev panel | queue depth per queue, in-flight, failed, step timeline per job, and the whole `x_backfills` ledger with a live count |
| `x jobs list --json` | one row per job: state, queue, attempts, `runAt`, idempotency key — plus the `backfill()` passes **in flight**, with rows so far and cursor |
| `x jobs show <id> --json` | machine-readable state, step results, next retry, dead-letter reason, and this run's ledger row under `backfill` when the job is a backfill |
| `x db backfill --list --json` | the whole ledger: one row per pass, newest first → [CLI reference](CLI-Reference#x-db) |
| MCP dev tools | `jobs.inspect` (definitions, retry policy, steps) and `queue.depth` (pending/running/failed per queue) — scope `dev:read`, never reachable in `ROLE=web` |
| OpenTelemetry | one span per job, one child span per step, trace linked to the enqueuing request |
| Metrics | `queue_depth{queue}`, `jobs_total{queue,outcome}`, `job_leases_lost_total{queue}` → [Observability](Observability) |

Every command supports `--json`. See [CLI reference](CLI-Reference).

**A lease that lapses is reported, never swallowed.** A worker renews the visibility window every `heartbeatIntervalMs` (default a third of the window) for as long as a job runs. One failed renewal is `jobs.heartbeat.failed` at `warn` — the window still has room for the next. A whole window with none landing is `jobs.lease.lost` at `error` plus one point on `job_leases_lost_total{queue}`: the queue is now free to hand that job to another worker while this one is still running it, which is at-least-once becoming exactly-twice. Alert on any non-zero rate. The window is measured from the last renewal that **landed**, on the worker's own clock, so a `heartbeat` that hangs is caught the same as one that rejects.

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_IDEMPOTENCY_REQUIRED` | a `job` declaration omits `idempotencyKey` | add `idempotencyKey: (input) => …` derived from `input` only |
| `X_STEP_DUPLICATE` | two `step.run` calls share a name in one `run` | rename one step; step names are the persistence key |
| `X_JOB_MAX_ATTEMPTS` | the job exhausted its retries and was dead-lettered | `x jobs show <id> --json`, then `x jobs retry <id>` — only a dead, cancelled, failed or done job can be requeued (`X_JOB_NOT_REQUEUEABLE` otherwise) |
| `X_JOB_DECLARATION_INVALID` | a `job()` declaration lacks fields every job declares — the cause names each | add the fields the fix lists |
| `X_IDEMPOTENCY_CONFLICT` | same key, different payload, or still in flight | fresh key for a different payload; otherwise retry after the first settles |
| `X_DRAINING` | the worker holding the job received SIGTERM — it is the reason on `ctx.signal`, and a body that unwinds on it is `interrupted` with the attempt uncounted | none — the job goes straight back to the queue and another worker claims it. Pass `ctx.signal` to outbound calls and `throwIfAborted(ctx)` between steps, so the body unwinds inside the drain budget instead of being killed at it |
| `X_FORBIDDEN` | the job's actor fails the originating action's policy | grant the permission, or enqueue as a system actor |
| `X_NOT_IMPLEMENTED` | introspection or the operator surface reached a driver with no `introspect` — a hand-rolled one | call `setJobDriver(postgresJobDriver({ executor }))`, or `setJobDriver(memoryJobDriver())` in a test. There is no config line to edit: `jobs.driver` was deleted in 5.0.0 because it never had a reader |

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

- Never assume a job runs once. Assume at-least-once. A `backfill()`'s `handle` is the same rule one level down: it runs *before* its checkpoint lands, so an attempt cancelled between the two hands that page to the next one — write through `upsertAll`, `updateWhere` or a statement whose second run changes nothing.
- Never put durable business state only in the payload.
- Never do slow work inline in an action — enqueue a job.
- A job never renders, redirects, or reads headers. Actor and tenant come from `ctx`.
- One `step.run` per externally-visible side effect. A step that does two things cannot be retried.
- Cron never contains a handler body — that is a [scheduled task](Scheduled-Tasks) enqueuing a job.
