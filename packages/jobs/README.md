# @ultimat3/jobs ⚙️

Durable background work. Steps that replay, a transactional outbox, and one driver interface so
a job's code never names a backend.

```ts
import { job, t } from '@ultimat3/jobs';

export const onboardOrg = job({
  input: t.object({ orgId: t.uuid }),
  idempotencyKey: ({ orgId }) => `onboard:${orgId}`,   // REQUIRED by the type
  tenant: ({ orgId }) => orgId,                       // REQUIRED by the type — or tenant: 'none'
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

## Fan-out per row is a job, not a task

A task's `enqueue` is **synchronous by design** — `(occurrenceMs) => [[job, input], …]` — and it
stays that way, `As of 2026-09-05`, for two reasons that are the same reason. `describe()` reads
`entries()` to project the task's job names into `x.manifest.json`, `/_x` and `x tasks show`, so an
`enqueue` that awaited a database would make the manifest an I/O operation; and a task that reads
the hosts table inside its tick is a task doing work, which the primitive's own header rules out.
So "one job per row" cannot be written in the task. It is written as **one fan-out job**:

```ts
import { job, t, task } from '@ultimat3/jobs';

declare const listHosts: () => Promise<readonly { readonly id: string }[]>;
declare const probe: (hostId: string) => Promise<void>;

// jobs/poll-host.ts — the unit of retry: one row
export const pollHost = job({
  input: t.object({ hostId: t.uuid, occurrenceMs: t.number.int() }),
  idempotencyKey: ({ hostId, occurrenceMs }) => `poll-host:${hostId}:${occurrenceMs}`,
  tenant: 'none',
  retry: { attempts: 3, backoff: 'exponential' },
  async run({ input }) {
    await probe(input.hostId);
  },
});

// jobs/poll-hosts.ts — the fan-out: list the rows, enqueue one child per row
export const pollHosts = job({
  input: t.object({ occurrenceMs: t.number.int() }),
  idempotencyKey: ({ occurrenceMs }) => `poll-hosts:${occurrenceMs}`,
  tenant: 'none',
  retry: { attempts: 3, backoff: 'exponential' },
  async run({ input, step }) {
    const hosts = await step.run('list', () => listHosts());
    for (const host of hosts) {
      // One step per child, keyed by the row: a replayed attempt re-enqueues nothing it already did.
      await step.run(`enqueue:${host.id}`, () =>
        pollHost.enqueue({ hostId: host.id, occurrenceMs: input.occurrenceMs }),
      );
    }
  },
});

// tasks/poll-fleet.ts — the tick hands its instant to ONE job
export const pollFleet = task({
  cron: '*/5 * * * *',
  tz: 'UTC',
  enqueue: (occurrenceMs) => [[pollHosts, { occurrenceMs }]],
});
```

| Piece | Why it is this piece |
|---|---|
| the task enqueues one job | the tick stays cheap and deterministic; `describe()` names `pollHosts` and nothing else |
| the fan-out is a `job` | it reads the database, so it gets a queue row, retries, a trace and `x jobs show` — a task gets none of those |
| one `step.run` per child | at-least-once delivery would otherwise enqueue every child again on a replay; the step's name is the row's id, so the second attempt skips the ones that landed |
| the child is its own `job` | retry, concurrency and the dead-letter path are per row — one host being down must not retry the other forty. `webhook()` is the same shape: one event, one endpoint, one job |
| the child's `idempotencyKey` carries `occurrenceMs` | the same row for the same tick is one row in the queue however many times the fan-out replays |

`webhook()` below is this pattern shipped as a factory; a fleet poll, a per-tenant digest and a
per-subscriber notification are the same three files with different names.

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

## `tenant` is required by the type

The same shape, for the same class of bug. A job body runs with no request behind it, so nothing
can read the acting org off a caller — and `@ultimat3/entity`'s tenant guard derives from the
**ambient** context, so a job that declared nothing used to run with no tenant at all: a row naming
another org was refused over HTTP as `X_TENANCY_ACTOR_MISMATCH` and accepted through the queue.

```ts
tenant: (input) => input.orgId   // the run acts under this org
tenant: 'none'                   // this job belongs to no tenant
```

`executeJob` derives the org, puts it on the run's actor and installs that context, so
`ctx.actor.orgId` inside the body is the tenant the job declared — and every tenant-scoped read and
write is checked against it, exactly as it is on every other surface. `'none'` carries **no** org,
so a tenant-scoped read inside such a `job()` is `X_TENANCY_ACTOR_ORG_REQUIRED`: a job body that
genuinely spans tenants says so with `crossTenant(reason, fn)` around its own reads. (A
`backfill()` is the one exception, and it is not a loophole — its `source` is a lazy chain, so the
author has nothing to wrap and the pass opens the scope itself. See the backfill section below.)
Omitting the field is a type error, and
`X_JOB_TENANT_REQUIRED` for generated code and JS callers.

A single boot-supplied service actor would have closed the same hole with one identity for every
job in the app — which is a cross-tenant read waiting for the first job that takes an org id in its
input. The tenant is a fact about the work, so the job declares it.

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
  rate: 5,                                                 // batches/sec — the default
  tenant: 'none',                                          // every tenant — the pass scopes itself
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
| `tenant` is required, exactly as on `job()` | a backfill IS a job. `tenant: () => orgId` scopes every page to one org; `tenant: 'none'` sweeps every tenant, and the PASS opens that cross-tenant scope — `source` is a lazy chain, so the author has nothing to wrap |
| `batch` is refused at declaration | `0`, `1.5` and a `NaN` from an env var fail the build, not the fourth attempt |
| `rate` throttles, and there is no way off | a sweep shares its pool with the requests the app is still serving; to go faster raise the number |
| the pause is spent **inside** the step | a resumed attempt replays 500 checkpoints and re-pays none of their pauses |

### The throttle

`rate` is batches per second, defaulting to `DEFAULT_BACKFILL_RATE` (5) — 5,000 rows/sec at the
default batch, one statement every 200ms, so the pool spends the rest of each interval on the
app. A rate above what the batches can actually achieve produces no wait, which is why there is
no unthrottled mode to reach for: `rate: 200` is the fast sweep. Fractions are rates too
(`rate: 0.5` is one batch every two seconds), a rate that is not finite and positive is refused
where it was written, and the wait unwinds on the run's cancellation (`X_ABORTED`) rather than
sitting in a timer nobody is waiting for. `rate` is **not** part of the definition checksum, for
the reason `batch` is not: pacing is tuning, and changing it does not make a completed sweep a
different sweep.

### The `x_backfills` ledger

What has already been swept, the twin of `x_migrations`. It ships in the same DDL as `x_jobs`,
hangs off the queue driver as `driver.backfills`, and carries one row per **pass**: name,
definition checksum, status, app version, rows processed, last cursor, started/completed.

```ts
// The PASS is the no-op, never the enqueue. The one-live-run index covers `ready`/`delayed`/
// `running`/`suspended`, and a completed job is in none of them — so this creates a real job row,
// a worker runs it, it reads the ledger and reports what it found.
const again = await rewriteSlugs.enqueue({});    // → { deduped: false, … }
// the run's own result:
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

Three surfaces read it, all through one projection (`inspectBackfills()`), so none of them can
report a different number:

| Surface | Shows |
|---|---|
| `x db backfill --list` | the whole ledger, `--name` / `--status` / `--limit`, and `--json` |
| `x jobs ls` | the passes **in flight** — rows so far and cursor, beside the queue depth |
| `x jobs show <id>` | the ledger row for that run, under `backfill` (`null` for any other job) |
| `/_x` → jobs | the whole ledger plus a live count, alongside the queues and the step traces |

### What was DECLARED — the other half of the ledger

`As of 2026-08`.

The ledger says which passes have run. `registeredBackfills()` says which ones **exist**, and the
diff between them is the alarm: a sweep merged, deployed and never enqueued had no row and showed
up on no surface at all.

```ts
import { isBackfill, pendingBackfills, registeredBackfills } from '@ultimat3/jobs';

registeredBackfills();          // [{ kind: 'backfill', name, checksum, requires, environments, counts }]
isBackfill(rewriteSlugs);       // true — a plain job() is false, and so is a look-alike

pendingBackfills({ declarations, runs, environment });
// → { environment, rows, pending, orphaned }
```

`backfill()` stamps its own handle through the `origin` WeakMap `task()` already uses — an app
registers nothing, because a declaration that has to be registered a second time is a declaration
half the apps will forget. `x db backfill --pending` is the command, and it exits **non-zero** when
anything is unswept so a cron or a deploy check can read the exit code alone.

| State | Means | In `pending` |
|---|---|---|
| `pending` | declared, no row under this name | yes |
| `failed` | the newest pass failed — the queue may have dead-lettered it | yes |
| `running` | a pass is in flight | no — a check red for the whole of every sweep gets muted |
| `completed` | a completed row exists, so nothing re-runs without `--force` | no |
| `excluded` | `environments` does not include this one | no |

### Three optional declarations, all of them DATA

```ts
export const dropLegacy = backfill({
  name: 'drop-legacy',
  tenant: 'none',                              // required, exactly as on job() — see the table above
  requires: '20260814120000_add_publish_at',   // a migration id, checked against x_migrations
  environments: ['staging', 'production'],     // omitted = every environment
  count: ({ ctx }) => db.posts.where({ publishedAt: null }).count(),
  source: ({ ctx }) => db.posts.where({ publishedAt: null }),
  handle: async ({ rows }) => { /* … */ },
});
```

| Field | Rail | Enforced where |
|---|---|---|
| `requires` | `X_BACKFILL_MIGRATION_PENDING` — the migration is not applied | `x db backfill`, which is where `x_migrations` is readable; this package holds no `@ultimat3/db` dependency and will not grow one to read a ledger |
| `environments` | `X_BACKFILL_ENVIRONMENT` | **the pass** (`backfillPass`) — the rail, because `.enqueue()` from app code reaches no command — and again in `gateBackfill()` as the CLI's pre-check, so `x db backfill` refuses before it queues work that would only dead-letter |
| `count` | `X_BACKFILL_STALLED` — the source ran out and this still matches rows | the pass, once, after the last batch |

`environments` ships as declared data and never as a hardcoded "cleanups are production": a staging
rehearsal is correct practice, so which deploys a sweep belongs to is the app's convention and this
is only the mechanism carrying it. There is deliberately **no** `dependsOn` graph over other
backfills — the real dependency is almost always "after code tolerating both shapes is serving",
which the framework cannot observe.

`count` is the same predicate `source` selects on, counted. It is what makes a dry run honest and
"did it converge" arithmetic: a pass that exhausts its source while `count()` still answers above
zero has two predicates that disagree, which is an authoring bug and not something a retry fixes.
Its result is parsed rather than trusted — a non-negative safe integer or `X_INVARIANT`, because
`NaN > 0` and `-1 > 0` are both false and would complete the sweep the detector exists to fail.

### Running one

```
x db backfill --pending --json          # declared minus completed; non-zero when anything is unswept
x db backfill drop-legacy               # DRY RUN — --write is never implied
x db backfill drop-legacy --write       # gate, then enqueue; the workers sweep
x db backfill --all --write             # every pending one, isolated per name
x db backfill drop-legacy --write --force   # a completed name, again, into a NEW ledger row
```

`--write` **enqueues**; it never runs the pass inline, because the queue is a job's execution
surface. That is what makes the `backfill` deploy role a trigger rather than a gate: it runs after
the new pods serve, puts the sweeps on the queue and exits, and a slow UPDATE never holds a release
open against a database still serving the previous build. `--all` isolates per name and continues
past a failure, so one wedged cleanup cannot block every later one forever.

## Retention sweeps are jobs too

`purge()` is the **second factory over `job()`**, and it exists because three framework stores
shipped a `purgeExpired()` with no caller — `x_idempotency`, `x_rate_limit` and the auth pair each
kept every row they ever took. `x_rate_limit` takes one upsert per HTTP request the web role
serves, assets included, so its growth follows total traffic and not traffic that hit a limit.

```ts
import { DEFAULT_PURGE_CRON, purge, task } from '@ultimat3/jobs';

declare const store: { purgeExpired(nowMs: number): Promise<number> };

export const sweep = purge({
  name: 'x.purge',
  // Read once per ATTEMPT, never captured: a host declares the sweep at boot, and some of the
  // stores behind it are built later.
  targets: () => [{ name: 'x_rate_limit', purgeExpired: (nowMs) => store.purgeExpired(nowMs) }],
});

export const hourly = task({
  name: 'x.purge.hourly',
  cron: DEFAULT_PURGE_CRON,
  tz: 'UTC',
  enqueue: () => [[sweep, {}]],
});
```

| Rule | Why |
|---|---|
| `PurgeTarget` is structural | the stores live in `@ultimat3/action`, `@ultimat3/http` and `@ultimat3/auth`; importing them would put the HTTP pipeline on this package's graph |
| one `step.run` per target | a killed attempt resumes at the table it stopped on, not at the first |
| one clock reading per pass | `postgresRateLimitStore.purgeExpired(nowMs)` needs the CALLER's clock — the server's read a 20,000,000-second refill against a frozen one and deleted a live bucket |
| at least once is safe here | a replayed delete removes rows that are already gone, and a row a purge deleted answers exactly as one that was never there |
| two targets under one name | `X_INVARIANT`, before the first delete — `step.run` would raise `X_STEP_DUPLICATE` after one table was already empty |

`@ultimat3/cli`'s boot declares both halves over the three tables it owns, so an app gets the sweep
without writing any of the above. It needs a `worker` to run it and a `scheduler` to fire it: a
deployment with neither has no background work at all, and this is one more thing it does not do.

## Exporting a large dataset is a job too

`exportRows()` is a factory over `job()` that streams a paged read to object storage with a
resumable cursor. It exists for one reason: `const all = await repo.all(); await disk.put(key,
csv(all))` works on 200 rows and OOM-kills the pod on two million.

```ts
import type { ReadBuilder } from '@ultimat3/entity';
import { exportRows, t } from '@ultimat3/jobs';
import { formatMoney, type Money } from '@ultimat3/money';
import { disk } from '@ultimat3/storage';
import { formatDate, instant } from '@ultimat3/time';

interface Order {
  readonly id: string;
  readonly placedAt: Date;
  readonly total: Money;
}

// The app's own chain: `source` takes whatever `db.orders.where(…)` answers.
declare const db: {
  readonly orders: { where(filter: { readonly orgId: string }): ReadBuilder<Order> };
};

export const exportOrders = exportRows({
  name: 'orders.export',
  input: t.object({ orgId: t.string, exportId: t.string }),
  // The security boundary of the whole feature — an export concentrates one tenant's rows into a
  // single downloadable object.
  tenant: ({ orgId }) => orgId,
  prefix: ({ orgId, exportId }) => `exports/${orgId}/${exportId}`,
  source: ({ input }) => db.orders.where({ orgId: input.orgId }),
  format: 'csv',
  columns: ['id', 'placedAt', 'total'],
  row: (order) => ({
    id: order.id,
    // A date gets its zone and a Money its currency HERE, where the app knows which it means.
    // `instant()` is the check that turns a stored `Date` into one nothing can format zone-less.
    placedAt: formatDate(instant(order.placedAt), { locale: 'en', zone: 'UTC' }),
    total: formatMoney(order.total, 'en'),
  }),
  sink: disk('exports'),   // a StorageDriver already IS an ExportSink
});
```

The artifact is one object per page plus a manifest:

```
exports/<orgId>/<exportId>/part-00000.csv
exports/<orgId>/<exportId>/part-00001.csv
exports/<orgId>/<exportId>/manifest.json
```

| Rule | Why |
|---|---|
| one object per PAGE, never one per export | `put()` buffers by construction — its own header says the server-side path "is for objects that FIT IN MEMORY" — so a single-object export holds the whole dataset, which is the failure this exists to prevent |
| the part key is the page INDEX | so a page that runs twice REWRITES its part. At-least-once needs no idempotency argument about your rows here: a duplicate part cannot be expressed |
| a step persists the CURSOR and two counters | never the page — `steps.ts` retains a completed step's output for the whole run, so checkpointing rows keeps every exported row until the job ends |
| every line ends in a newline, header in part 0 only | `cat part-*` is one valid file, which is what makes the parts an artifact rather than fragments |
| `maxPartBytes` is a heap bound, not a file-size preference | one page is encoded whole before it is written; `X_EXPORT_PART_TOO_LARGE` names the `batch` to lower |
| a `row()` key `columns` does not carry is REFUSED | both encoders would drop it in silence, and `row: (r) => ({ ...r })` picks up every column the entity gains from the next migration on |
| csv cells leading `=`, `+`, `-`, `@`, TAB or CR are neutralised | Excel, Sheets and LibreOffice EVALUATE them, so a user-named record is code execution in the reviewer's spreadsheet. Strings only — a negative number stays a number |
| the manifest COUNTS parts, never lists them | `exportPartKey(prefix, i, format)` rebuilds every key, and a list is the one thing in the pass that would grow with the export |
| `tenant: 'none'` gets no cross-tenant escape | `backfill()` does (`backfill-scope.ts`) because its lazy chain leaves an author nothing to wrap. An export does not, and the difference is the direction of the data: a sweep rewrites rows under audit, an export writes every tenant's rows into one downloadable object |
| `rate` has no default, unlike a backfill's | a backfill competes for WRITE capacity on rows the app is still serving; an export is a bounded read somebody is usually waiting for. Declare it for an export big enough to matter to the pool |

`ExportSink` is a seam and not a `@ultimat3/storage` import, for the reason `PurgeTarget` is one:
this package holds no storage dependency, and taking one so a queue could name a disk would put the
object store on tier 3's import graph.

## Outbound webhooks are jobs too

`webhook()` is a factory over `job()` and delivers **one event to one endpoint**. Retry with
backoff, disable-after-N and the ledger are all per-endpoint facts, so the endpoint is the unit: a
job that fanned out inside one body would retry every subscriber because one of them was down.
**Which endpoints exist is the app's** — the fan-out is your own `for` loop over your own
subscription table, one `enqueue` per endpoint.

```ts
import { memoryWebhookLedger, webhook } from '@ultimat3/jobs';

declare const db: {
  endpoints: { byId(id: string): Promise<{ id: string; url: string; secret: string } | null> };
  events: { byId(id: string): Promise<{ topic: string; body: string } | null> };
};

export const deliver = webhook({
  name: 'partner.webhooks',
  tenant: 'none',
  // Read once per ATTEMPT and never checkpointed: the endpoint carries a secret, and a step's
  // output is written to `x_job_steps`.
  endpoint: ({ endpointId }) => db.endpoints.byId(endpointId),
  event: ({ eventId }) => db.events.byId(eventId),
  ledger: memoryWebhookLedger(), // dev only — a bounded ring in one heap
  disableAfter: 10,
});

// The fan-out is yours, because the subscription table is yours.
declare function subscribersOf(topic: string): Promise<readonly { id: string }[]>;
declare const event: { readonly id: string };

for (const endpoint of await subscribersOf('orders.paid')) {
  await deliver.enqueue({ endpointId: endpoint.id, eventId: event.id });
}
```

The delivery carries three headers beyond `content-type`, and the signature is over
`v1:<timestampSeconds>:<eventId>:<topic>:<body>`:

```
x-ultimate-webhook-id:        evt_01HZ
x-ultimate-webhook-topic:     orders.paid
x-ultimate-webhook-signature: t=1700000000,v1=<hex hmac-sha256>
```

The receiving half is `verifyWebhookSignature(request, { secret })` in `@ultimat3/http`. The format
itself — the canonical string, the mac and the header names — is **one module in `@ultimat3/core`**
(`webhook-signature.ts`), re-exported by both packages and re-declared by neither: this package
signs, `http` verifies, and neither may import the other, so the one copy lives at the tier both
can reach. Same argument `timing-safe-equal.ts` makes for itself.

| Rule | Why |
|---|---|
| the timestamp is **inside** the mac | a captured delivery re-dated to slip back into a receiver's freshness window no longer verifies |
| the timestamp is SEND time, not event time | a retry three days later signs again now, so the window measures the request rather than the age of the fact |
| `:` is refused in an id or a topic | one mac over `v1:t:evt:01HZ:orders.paid:<body>` would otherwise authenticate two different id/topic splits — the same delivery under a label the sender never wrote |
| the endpoint's own `headers` merge **under** the framework's | an endpoint row that could set `x-ultimate-webhook-signature` is an endpoint row that can forge one |
| `redirect: 'manual'` | following a 3xx would re-POST a body signed for one host to whatever the receiver named |
| the endpoint is never checkpointed | a `step.run` output lands in `x_job_steps`, and the endpoint carries the secret |
| every attempt is recorded **before** the throw | a failure the ledger cannot see is a failure the consecutive count cannot see, which is an endpoint that never gets disabled |
| a `Retry-After` the receiver names is honoured | `X_WEBHOOK_DELIVERY_THROTTLED` carries `meta.retryAfterSeconds`, which the nack waits out (clamped by `retry.maxDelay`) rather than guessing a curve against an answer it already has |
| re-enabling is always yours | an endpoint the framework un-disabled on its own is a retry loop with no end |
| `WebhookLedger` is a seam, not a table | retention is seven years for one business and thirty days for the next, so shipping a schema would ship one of those answers |

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

Three ceilings, declared on the job and nowhere else (`As of 2026-08` — `stepTimeout` and
`eventPoll` had been implemented in the step runner since 1.0 with no declaration able to reach
them, so no `job()` could ask for either):

| Field | Bounds | Absent |
|---|---|---|
| `timeout` | the whole attempt — aborts `ctx.signal`, then fails it | no attempt deadline |
| `stepTimeout` | ONE `step.run` — aborts that step's signal, then fails the step | no per-step ceiling |
| `eventPoll` | how long a `step.waitForEvent` parks between polls | 30s |

A zero or negative `stepTimeout` / `eventPoll` is refused at declaration, the way `concurrency: 0`
is: `withStepTimeout` reads `<= 0` as "no ceiling at all", which is the opposite of what the author
wrote.

## The transactional outbox

```ts
await ctx.tx(async (tx) => {
  const post = await ctx.posts.publish(input.postId, tx);
  await notifySubscribers.enqueue({ postId: post.id, orgId: input.orgId }); // joins `tx`
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
The relay publishes *then* marks published, so a crash re-publishes — and **that repeat is
collapsed only while the first job is still live** (`As of 2026-08`): `SQL_ENQUEUE`'s conflict
target is a partial index over `ready`/`delayed`/`running`/`suspended`, so a re-publish landing
after the first job reached a terminal state inserts a second row and the handler runs again.
**Handlers are at-least-once. Write them idempotent** — that is the standing contract, not a
caveat on this paragraph. A publish that FAILS stops the batch rather than letting later rows
overtake it: `claim()` returns rows in `staged_at, id` order — total, so two relays compose the
same batch in the same order — and an app that stages `createInvoice` then `chargeCard` in one
transaction must never have the charge run first. Set `mode: 'required'` to
make an enqueue outside a transaction an `X_OUTBOX_NO_TX` error instead of a direct publish.

**It is not on by default, and it is not on until you install it** (`As of 2026-08`). Three
things have to be true in a process:

| Step | Call |
|---|---|
| the table exists | ships in `SQL_JOBS_TABLE` — applying the queue DDL is enough |
| the facade is installed | `setJobsFacade(createJobsFacade({ store, driver }, currentTx))` |
| the relay is running | `createOutboxRelay({ store, driver }).start()` |

with `store = createPgOutboxStore({ executor, txExecutor })`. `txExecutor` is what makes it
transactional: `stage()` runs on the CALLER'S connection, never the pool. With nothing installed,
`jobsFacade()` answers a fallback whose `currentTx` is `() => undefined` and every enqueue
publishes straight to the driver — deliberate, so a script and a test enqueue with no wiring, but
it is a fallback and not the guarantee.

`claim()` is a **claim, not a read** (`As of 2026-08`). `for update skip locked` in a bare select
holds its row locks only until that statement ends — under autocommit, before `claim()` even
resolves — so two relays polling 200ms apart read the same unpublished rows and both publish them.
`SQL_ENQUEUE` collapses that repeat only while the first job is still LIVE, because its conflict
target is a partial index over the live states: a second publish landing after that job finished
inserts a second row and **the handler runs twice**. So the claim stamps `claimed_at` in the same
statement that locks the row, and that stamp is a lease — `claimLeaseMs` (a positive whole number
of ms, default 30s; anything else is `X_INVARIANT` at construction) is how long the rows of a relay
that DIED mid-batch wait before any relay may take them again. A batch a failed publish stopped is
handed back at once through `release`, so a pool blip still costs one poll interval and not a lease
window.

**Every outbox mutation is fenced on the claimant, not just the claim** (`As of 2026-08`).
`release` and `markPublished` both match on `claimed_by`, and `claim()` hands the token back on
each record as `claimedBy`. A relay that stalls past its lease wakes up owning nothing: its late
`release` would otherwise unclaim rows the relay that reclaimed them is mid-publish on (a third
relay claims and republishes them), and its late `markPublished` would retire a row nobody has
published yet — losing the job outright. Both are no-ops now, in the pg store and in the memory
store alike.

What the lease buys, precisely:

| It stops | It does not stop |
|---|---|
| two relays holding one batch — a committed row cannot be claimed twice inside its lease | the handler running twice |
| a lapsed claimant releasing or retiring a newer claimant's rows | a crash between publish and `markPublished` re-publishing after the first job is terminal |
| a relay that died mid-batch stranding its rows forever | anything a **non-idempotent** handler does on its second run |

The memory store (`createMemoryOutboxStore`, `x dev` and tests) **drops** a published row —
`retained()` is the relay's backlog, not a running total; the pg store keeps `published_at` as
the audit trail this map is not. A relay pass that throws is logged as `jobs.outbox.tick-failed`
and the loop re-arms: an unobserved rejection would end the process with rows still staged.

`relay.stop()` is **async and joins the pass in flight** — `await` it before closing the database,
the way `worker.stop()` and `scheduler.stop()` are awaited. A pass is a publish followed by a
`markPublished`, and a caller that returned between the two closed the pool under the row it was
about to mark.

## Drivers

One interface: `enqueue`, `claim` (visibility timeout), `ack`, `nack` (backoff),
`heartbeat`, `stats`, plus optional `introspect`, `backfills` and `leases`. Zero job-code change
between them — swapping is `setJobDriver(other)`, and there is **no `jobs.driver` config line**:
`JobsConfig.driver` has no reader and boot always builds `createPgDriver`.

| Driver | Status | Backing | Use |
|---|---|---|---|
| `pg` | **default** | `SELECT ... FOR UPDATE SKIP LOCKED`, a partial unique index on `(name, idempotency_key)`, lease-based leader, `x_job_leases` | zero-infra start, most apps |
| `memory` | complete | in-process maps | `x dev`, tests |
| `redis` | interface-complete, `X_NOT_IMPLEMENTED` | Streams + consumer groups | planned |
| `nats` | interface-complete, `X_NOT_IMPLEMENTED` | JetStream work queue | planned |

The pg SQL is exported verbatim (`SQL_CLAIM`, `SQL_ENQUEUE`, `SQL_NACK`, …) so an agent
debugging a stuck queue can read and run the exact statement.

## Roles

| Role | Entry | Behaviour |
|---|---|---|
| `worker` | `createWorker({ driver, context, queues, concurrency })` | per-queue pools, lease heartbeat, SIGTERM drain: stop claiming → finish in-flight → close |
| `scheduler` | `createScheduler({ driver, leader, state })` | one dispatch round at a time, catch-up policy, SIGTERM drain: stop dispatching → finish the round → release the lock |

Both roles register the same **pair** of hooks and bound the `close` half the same way. The
scheduler's abandoned case differs in one respect: a round still enqueueing keeps the lease rather
than handing it back, because promoting a standby onto an occurrence this node is mid-dispatch for
is the double-fire leader election exists to prevent. The lease row expires on its own.

The worker's drain is **two shutdown hooks**, one per phase: `accept` stops claiming and returns
immediately, `close` waits out the in-flight jobs and closes the driver. A running job is counted
with core's `beginWork()`, so the wait for it happens in the drain's own in-flight phase rather than
inside a hook — one hook doing all of it spends the whole `configureLifecycle({ deadlineMs })`
budget in `accept`, where every other role's "stop taking work" is still queued behind it.

**The `close` hook's wait is bounded by that same budget**, because nothing can kill a handler that
ignores `ctx.signal`: at the deadline the worker logs `jobs.worker.drain-abandoned`, closes the
driver and reaches `stopped`, and the job's lease lapses so the queue delivers it again — which is
what at-least-once already promises. Raise the budget past your slowest job rather than relying on
the wait: `configureLifecycle({ deadlineMs: 600_000 })`, with a `terminationGracePeriodSeconds` at
least as large. A manual `await worker.stop()` has no budget and waits as long as its jobs take.

`driver` and `context` are the two required keys on `WorkerOptions`; everything else defaults.
`context: () => Ctx` supplies the ambient `Ctx` a job run executes under — the app wires its ALS
and its tenant there, and a worker with no way to build one would run every handler as nobody.

**Pass `state` and `leader` in any real deployment.** The defaults are a `Map` and "always the
leader", and both fail silently: with no durable watermark a redeployed scheduler arms to tomorrow
and never detects the occurrence the pod it replaced dropped (`catchUp` and `maxCatchUp` are inert
— "missed" is relative to a watermark that no longer exists), and with no election a rolling
update runs two leaders.

```ts
import {
  createPgLeaseLeader,
  createScheduler,
  type JobDriver,
  type PgExecutor,
  pgSchedulerState,
} from '@ultimat3/jobs';

declare const driver: JobDriver;
declare const executor: PgExecutor;   // `@ultimat3/cli`'s pgExecutorFor(client)

createScheduler({
  driver,
  state: pgSchedulerState(executor),
  leader: createPgLeaseLeader({ executor }),
});
```

`createPgLeaseLeader` and not `createPgLeader`: `pg_try_advisory_lock` is scoped to a Postgres
*session*, and the executor this package is handed is a **pool** — the lock is released the moment
that connection goes back to it, so every node reads itself as leader. The lease is a row with an
expiry and needs no connection affinity. `acquire()` is also the renewal, called every round, which
is how a demoted node finds out.

```ts
import { type AnyJobHandle, task } from '@ultimat3/jobs';

declare const sendDigest: AnyJobHandle;   // the job this cron puts on the queue

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
every one of them. `maxCatchUp` (default 10) bounds the WALK for every mode, not just `run-all`:
one tick walks at most that many occurrences forward from the last fire, and the policy then
picks from what that walk found — so after a long outage `skip` fires the latest occurrence
*within the cap*, not the true latest missed.

`run-once` fires **once**, not once per tick. Dropping the rest means the watermark passes them
too, so a scheduler back up after a day down enqueues one catch-up and then waits for the next
real occurrence. It used to leave the watermark on the occurrence it had just run, which made an
hourly task fire 24 catch-ups a second apart.

## Retries

`{ attempts, backoff: 'exponential' | 'linear' | 'fixed', delay, maxDelay, jitter }`.
Equal jitter is on by default so a burst of failures does not retry in lockstep.
Exhausted jobs are dead-lettered, never dropped: `x jobs retry <id>`.

```
retrySchedule({ attempts: 5, backoff: 'exponential', delay: 1000 })
// => [1000, 2000, 4000, 8000]
```

**The error decides too, not only the attempt count** (`As of 2026-08`). `executeJob` reads the
thrown error's retry classification — `@ultimat3/core`'s `registerErrorRetry`, the same table
`--json` and an HTTP client read — and a code nobody classified keeps the attempt-count path
exactly as it had before.

| Thrown | What the queue does |
|---|---|
| a `terminal` code (`X_SCRAPE_AUTH_FAILED`, a validation fault, a permission denial) | dead-lettered on the attempt it happened, `attempt` recorded, remaining attempts unspent — a rotated password retried five times is five more wrong passwords at a site that locks the account after three |
| a `retry-after` code (`X_RATE_LIMITED`, `X_OVERLOADED`) | retried at the time the responder NAMED — `meta.retryAfterSeconds`, clamped by the policy's `maxDelay` — instead of the backoff. Still an attempt, still under the ceiling |
| a `retryable` code (`X_TIMEOUT`, `X_DRAINING`) | the backoff schedule above, unchanged |
| an **unclassified** code, or anything that is not an `UltimateError` | the backoff schedule above, unchanged. Most codes are unclassified and `retryFor` answers `terminal` for all of them, so reading that would have stopped every transient retry in every app |

Classify your app's codes beside the module that declares them — that import IS the registration:

```
registerErrorRetry({ X_INVOICE_REJECTED: 'terminal', X_GATEWAY_BUSY: 'retry-after' });
```

Why a job stopped is on the row and in the log, never inferred: `jobs.attempt.failed` carries
`stop: 'terminal' | 'attempts-exhausted'`, `JobExecution.stopReason` carries the same, and a
terminal dead letter appends its verdict to `lastError` so `x jobs show` explains an attempt 1 of 5.

## Limits

Two layers, and the difference matters:

| Layer | Scope | Where |
|---|---|---|
| `LimitConfig` — `perTenant`, `perQueue`, `global`, `ratePerTenant` | **this process only** | `limits.ts`, three `Map`s in one heap |
| `job.concurrency` | **the fleet** | `JobDriver.leases` over `x_job_leases` |

`LimitConfig` is the fast path and is multiplied by your replica count: `perTenant: 2` on twenty
pods is forty concurrent runs, and `ratePerTenant`'s window is in memory, so a rolling restart
grants every tenant a fresh full allowance. Size it as a per-pod budget, never as a partner's
contractual rate.

`job.concurrency` is the one that is fleet-wide, and it is enforced by a row every replica can
see — one per held slot, keyed `job:<name>`, renewed by the same heartbeat that renews the
visibility lease and reclaimed by TTL when a worker is SIGKILLed. A driver with no lease store
cannot hold the cap, so `createWorker().start()` **refuses to boot**
(`X_JOB_CONCURRENCY_UNENFORCEABLE`) rather than let a documented guarantee do nothing.

Over any cap the claim is handed straight back without burning an attempt — one org's 50k-row
import cannot starve the fleet.

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

Neither fires for a job that finished (`As of 2026-08`). `stop()` is terminal for the renewal
already **on the wire**, not only for the next one: a clean completion acks the row out of
`running`, so the fenced UPDATE already in flight comes back `false` — and reported, that was
`jobs.lease.lost` at error plus the counter, a page for a non-event, on every completed job whose
pool was slow enough. The fleet slot's `jobs.worker.slot-lost` had the same shape and the same
fix (`renewal-timer.ts`).

## Introspection

`inspectQueues`, `inspectJob` (per-step trace), `inspectDeadLetters`, `retryFromStep`,
`cancelJob`, `inspectManifest` — all `--json`-shaped, shared by `/_x`, the CLI and the MCP tools.

`cancelJob(driver, id, reason?)` is the answer to a runaway pass. A queued row becomes `cancelled`
immediately; a RUNNING one stops at its next heartbeat, which no longer matches its own row and
aborts the attempt — `steps.ts` then refuses every write. `ack` and `nack` are fenced on
`state = 'running'`, so the worker that was cancelled cannot un-cancel it on the way out.

## Metrics

| Series | Kind | Answers |
|---|---|---|
| `queue_depth{queue}` | gauge | how much work is waiting — the HPA's signal |
| `jobs_total{queue,outcome}` | counter | is any of it succeeding |
| `queue_oldest_ready_seconds{queue}` | gauge | *"page if the oldest job in `payments` is older than 5 minutes"* |
| `queue_dead_jobs{queue}` | gauge | a dead-letter queue that filled overnight and stopped growing — a counter's rate is flat there |

## Trace and actor

An enqueue stamps the current span's `traceparent` onto the row, and the worker opens the job's
span as a **child** of it: a checkout trace shows the HTTP span, the action span and the charge
that ran two seconds later as one trace.

`handle.as(actor, input)` also records `enqueuedBy` — the actor's id. **Attribution, never
authority.** A job body runs with system authority; the framework does not impersonate the
enqueuer, because a job that sleeps three days or dead-letters and is retried next quarter would
act as somebody whose role, org membership or employment has changed since. A job that must act
FOR a user takes that user's id in its input and re-authorises it in the body.

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
| `X_JOB_LEASE_LOST` | the job was cancelled, or its lease lapsed and the queue re-delivered it, while this worker was still running it |
| `X_JOB_SLOT_LOST` | the fleet `concurrency` slot this run held was taken by another worker — a different row on a different clock from the lease above |
| `X_JOB_NOT_CANCELLABLE` | `cancelJob` reached a job that already finished, or a driver with no `cancel` |
| `X_JOB_CONCURRENCY_UNENFORCEABLE` | a registered job declares `concurrency` and the driver has no lease store |
| `X_NOT_IMPLEMENTED` | redis / nats driver |

## Boundary

Tier 3. Imports `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/entity`,
`@ultimat3/policy`, `@ultimat3/cache`, `@ultimat3/time`. Never HTTP, render or UI.
