# Tutorial 4 — jobs, tasks and live queries

Three primitives, three rules. A `job` is durable work with memoized steps. A `task` is a cron trigger that only ever enqueues. A `query` with `live: true` is a bounded, totally-ordered read that patches per subscriber.

`As of 2026-08`. Every output on this page was executed against a `create-ultimate@1.1.0` app carrying the [tutorial 2](Tutorial-02-First-Feature) `todo` slice.

Series: [1 — first app](Tutorial-01-First-App) · [2 — first feature](Tutorial-02-First-Feature) · [3 — auth and admin](Tutorial-03-Auth-And-Admin) · **4** · [5 — deploy free](Tutorial-05-Deploy-Free) · [6 — growing up](Tutorial-06-Growing-Up)

## A durable job

`x g resource` already wrote one. Its shape is the whole contract:

```ts
export const reindexTodo = job({
  input: t.object({ id: t.uuid }),
  tenant: 'none',                              // a todo carries no org in this tutorial
  idempotencyKey: ({ id }) => `reindex-todo:${id}`,
  retry: { attempts: 5, backoff: 'exponential' },
  async run({ input, step }) {
    const row = await step.run('load', () => repo.byId(input.id));
    if (row === undefined) return { skipped: true };
    await step.run('process', async () => {
      await repo.listByOrg(row.orgId, 1);
    });
    return { skipped: false };
  },
});
```

| Field | Rule |
|---|---|
| `step.run('<name>', fn)` | each step's result is stored under its **name**. A retry replays completed steps from storage and re-executes only from the failure. Step names are stable identifiers, not labels |
| `idempotencyKey` | an at-least-once caller may enqueue twice; the work happens once |
| `retry` | per-attempt backoff, independent per step |
| `.enqueue(input)` | the **only** queue path. A job is never run inline |

The generated test pins the distant invariant rather than the happy path:

```ts
const first = await reindexTodo.enqueue({ id });
expect(first.deduped).toBe(false);
const again = await reindexTodo.enqueue({ id });
expect(again.deduped).toBe(true);
```

Rename it `reindex-todo.job.test.ts` and it runs in the gate's `job` step instead of `unit` — see [tutorial 2](Tutorial-02-First-Feature#name-the-tests-after-their-step).

Enqueue from an action and the outbox makes it transactional: the row and the job commit together, or neither does. `ctx.jobs` is the facade `<job>.enqueue()` resolves through. Full model: [Jobs and workflows](Jobs-And-Workflows).

## A scheduled task

```bash
bunx x g task daily-digest --feature todo
```

```text
  + apps/web/app/todo/tasks/daily-digest.ts
  + apps/web/app/todo/tasks/daily-digest.test.ts
  + apps/web/app/todo/jobs/daily-digest-job.ts
  + apps/web/app/todo/jobs/daily-digest-job.test.ts
```

**`--feature` is not optional at 1.1.0.** Without it the generator opens a new slice and the job it writes imports `../repo`, which does not exist there:

```text
  X_CLI_UNEXPECTED (apps/web/app/daily-digest/jobs/daily-digest-job.ts)
    cause: ResolveMessage: Cannot find module '../repo' from '…/daily-digest/jobs/daily-digest-job.ts'
```

Point `--feature` at a slice that already has a `repo.ts`, or write the repo first.

```ts
export const dailyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  enqueue: () => [[dailyDigestJob, { id: '…' }]],
});
```

| Rule | Why |
|---|---|
| a task **only** enqueues | the work is durable and retryable; a cron that did the work itself loses it on a restart |
| `tz` is required, IANA | `0 3 * * *` in `America/New_York` is a different instant before and after a DST boundary. There is no ambient default anywhere in the framework |
| one leader | leadership is a Postgres advisory lock; a second `scheduler` is a warm standby, not a duplicate |

### Registration names it

Export names become primitive names, and only `defineApi` (or `registerTasks`) stamps them. Without `apps/web/api/index.ts`:

```text
  name              cron       tz   catchUp  jobs             next
  anonymous-task-1  0 3 * * *  UTC  skip     anonymous-job-2  2026-08-12T03:00:00Z
```

With it:

```text
  name         cron       tz   catchUp  jobs            next
  dailyDigest  0 3 * * *  UTC  skip     dailyDigestJob  2026-08-12T03:00:00Z
```

```bash
bunx x tasks show dailyDigest --count 3
```

```text
  kind: task
  name: dailyDigest
  cron: 0 3 * * *
  tz: UTC
  catchUp: skip
  maxCatchUp: 10
  jobs: ["dailyDigestJob"]
  at 03:00 every day
    2026-08-12T03:00:00Z
    2026-08-13T03:00:00Z
    2026-08-14T03:00:00Z
```

Every instant renders in the task's **own** zone, never a machine-local default. Full model: [Scheduled tasks](Scheduled-Tasks).

## Inspecting the queue

```bash
bunx x jobs ls
```

```text
  0 job(s)
✓ 0 ready · 0 running · 0 delayed · 0 dead across 0 queue(s)
```

A dead job is never filtered out of view.

| Subcommand | Does |
|---|---|
| `ls` | queue depth, matching rows, and the dead-letter list |
| `show <id>` | state, attempt, every step's result, remaining retry delays |
| `retry <id> --from-step <name>` | drops that step so it re-executes; everything before it replays from storage |
| `drain --to memory\|redis\|nats` | moves `ready`/`delayed`/`suspended` jobs to another driver; enqueues on the target **before** acking the source |

The Redis and NATS **job** drivers are not in 2.0.0 — each throws `X_NOT_IMPLEMENTED` behind an interface that already ships, rather than pretending to work. Postgres is the shipped driver, and it is the one `x dev` boots.

## A live query

```ts
export const todoList = query({
  input: t.object({ orgId: t.uuid, limit: t.number.default(50) }),
  policy: canTodoRead,
  live: true,
  mcp: { expose: true, description: 'todoList — generated, edit the description' },
  sql: ({ orgId, limit }) =>
    from<Todo>('todos', () => repo.listByOrg(orgId, limit))
      .where({ orgId })
      .orderBy('createdAt')
      // The primary key last is what makes the order TOTAL: `createdAt` alone ties, and two rows
      // that tie can swap between evaluations — a bounded read then drops one and repeats the
      // other, and a live subscription patches a row it never sent.
      .orderBy('id')
      .limit(limit),
});
```

`live: true` is not free. The gate rejects it without all four:

| Requirement | Why |
|---|---|
| `orderBy` on a **total** order | the matcher decides *enters / leaves / moves within* the result from the changed row alone |
| `limit` | an unbounded result has no bounded change buffer and no bounded reconnect snapshot |
| no `now()` / `random()` | the same `(input, row)` must always yield the same membership answer |
| no cross-tenant predicate | tenancy comes from `ctx`, not from `input` — otherwise `X_FORBIDDEN` at subscribe |

The generated test asserts on the **SQL text**, because that is the contract an agent reads to self-correct:

```ts
const source = await sourceFor(target, { orgId, limit: 50 }, { actor: null, enforce: false });
const text = source.toSQL().sql.toLowerCase();
expect(text).toContain('order by');
expect(text).toContain('limit');
// "ordered" is not enough — dropping the id tiebreak leaves an ORDER BY while going
// non-deterministic under ties.
expect(text.slice(text.lastIndexOf('order by'))).toContain('id');
```

### Policy runs per row, per subscriber

Not a subscribe-time gate that then trusts the stream. The same `policy` object is re-evaluated for each delivered patch — which is why policy predicates are **synchronous**: an `await` there would be a database round trip per row per connected client.

`.tool().mutates` is `false` and `.tool().policy === todoList.policy`. A read hands rows to an agent, so MCP exposure on a query is opt-in — silence exposes nothing.

Five projections from the one declaration: HTTP `GET /_x/query/todo-list?orgId=…`, a typed client hook, the live subscription, a cache entry keyed by tenant and policy scope, and the MCP read tool. Full table: [Queries and live queries](Queries-And-Live-Queries).

## Which role runs what

```bash
bunx x dev --once --port 3100
```

```text
  roles web, sync, worker, scheduler
```

| Role | Runs | Scales on |
|---|---|---|
| `web` | HTTP: pages, actions, queries | RPS |
| `sync` | live-query websockets, on `$PORT + 1` | concurrent connections — no sticky sessions |
| `worker` | the job queue | queue depth |
| `scheduler` | cron dispatch, enqueue only | fixed 1, advisory-lock leader |
| `replicator` | logical replication → change feed | 1 per database; opt in with `--role`, needs a real Postgres with `wal_level=logical` |

`x dev` co-locates the first four in one process. Isolation is simulated, not skipped: separate ALS contexts, a real Postgres queue, a real SIGTERM drain.

## Debugging, without grep

| Question | Panel at `/_x` | CLI |
|---|---|---|
| which step failed, what is queued | `jobs` | `x jobs show <id>` |
| why did this subscriber not get the row | `live` | — |
| which clause decided, for which actor | `policy` | `x policy explain <subject>` |
| which tags would this write bust | `cache` | — |
| where did this request spend its milliseconds | `timeline` | — |

`/_x/<panel>?json=1` returns exactly what the tab draws. `live` lists the registered live queries and states plainly that no subscriber list is attached — `@ultimat3/realtime` does not retain a subscriber's matcher trace. A panel whose source is unwired says which half is missing rather than rendering an empty tab as an answer.

## Capacity, measured

**Reachability.** 50,000 real WebSocket clients against a **single** `sync` node over the in-process transport, `SIGKILL`ed with no drain: all 50,000 reconnected, 49,981 received a channel patch inside the window, first patch on the reconnected socket at p50 **54.0s** / p90 **105.5s** / max **145.7s**, and 156,851 connect attempts shed by the accept budget before any query path. Committed at [`scripts/bench/results/50k-restart.json`](https://github.com/developerz-ai/ultimate/blob/main/scripts/bench/results/50k-restart.json).

**Delivery.** A second run, 10,000 clients and a probe every 200ms, counting gaps in each client's received sequence: **1,666,882 channel patches received, 0 observed sequence gaps** ([`10k-restart-seq.json`](https://github.com/developerz-ai/ultimate/blob/main/scripts/bench/results/10k-restart-seq.json)). A first-patch timer cannot see a lost patch, which is why the second run exists — `As of 2026-08` it is the only one with delivery accounting. It says nothing about 50,000, and its zero is a lower bound: a gap needs a received frame on each side of it, so "no client observed a loss" is the claim, not "nothing was lost" ([Realtime](Realtime)).

Both are per-node recovery — neither run crossed NATS, so neither is a multi-node result nor a throughput figure. Detail and limits: [Realtime](Realtime).

Realtime tier 3 (local-first, `persist: true`) is not in 2.0.0.

## Next

[Tutorial 5 — deploy on a free tier](Tutorial-05-Deploy-Free): the scaffolded Dockerfile, `$PORT`, `0.0.0.0`, the health probes, and release-phase migrations — plus what a sleeping free instance does to the `worker` and `scheduler` roles.

Related: [Jobs and workflows](Jobs-And-Workflows) · [Scheduled tasks](Scheduled-Tasks) · [Queries and live queries](Queries-And-Live-Queries) · [Realtime](Realtime)
