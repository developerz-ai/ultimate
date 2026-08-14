# Scheduled tasks

A `task` is a cron trigger that enqueues jobs. It never does work itself.

v1.1.0 `As of 2026-08`. Stable API — semver from here ([Upgrading](Upgrading)).

## The canonical shape

```ts
// task (cron)
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  // The occurrence, never the wall clock: a catch-up tick runs long after the instant it fires
  // for, and a payload read off `Date.now()` there is silently for the wrong day.
  enqueue: (occurrenceMs) => [[sendDigest, { occurrenceMs }]],
});
```

## A task only enqueues

If it has a handler body, it is a [job](Jobs-And-Workflows), not a task.

| Concern | Where it lives |
|---|---|
| When to fire | `task.cron` + `task.tz` |
| What to enqueue | the `enqueue` field — `(occurrenceMs) => [[jobRef, input], …]` |
| The work | the `job`'s `run` |
| Retries, steps, concurrency, rate limits | the `job` |
| Idempotency | the `job`'s `idempotencyKey` — this is what absorbs a double fire |
| Observability of the run | the job's spans and `x jobs show <id>` |

`enqueue` must be cheap and synchronous-shaped: build inputs, return the list. Fanning out per tenant is a job that enqueues children, not a loop with a DB read inside `enqueue`.

```ts
export const rotateApiKeys = task({
  cron: '15 2 * * 1',
  tz: 'Europe/Berlin',
  enqueue: () => [[fanOutKeyRotation, {}]],
});
```

## The fluent surface

Every projection is a method on the task — `nightlyDigest.enqueue()`, never `runTask(nightlyDigest)` — and every declared field is lifted onto it. A task has no `.def`.

| Member | Is | Rule |
|---|---|---|
| `nightlyDigest.entries(occurrenceMs?)` | the `[[jobRef, input], …]` pairs this task fires — the handle's read of the declared `enqueue` field | built **for that occurrence**, not for "now" — a catch-up dispatch runs long after the instant it fires for, and a payload derived from the wall clock there is silently for the wrong day. Defaults to now, the honest answer for the two callers that have no occurrence: a manual `enqueue()` and `describe()` |
| `.enqueue(options?)` | fire the declared entries immediately | the backfill and "run it again" path — no scheduler, no leader, no tick. Goes through the **same facade `<job>.enqueue` uses**, so it joins the caller's transaction on the same terms. Returns one `{ job, result }` per entry |
| `.describe()` | the manifest row | `kind`, `name`, `cron`, `tz`, `catchUp`, `maxCatchUp`, `jobs` — the job names, in declaration order, because a task's entries are a sequence and not a set |
| `.kind` `.name` `.cron` `.tz` `.catchUp` `.maxCatchUp` | the declaration, lifted | readable, and already resolved: `kind` is `'task'`, `catchUp` defaults to `'skip'`, `maxCatchUp` to `10` |

A task reaches its jobs only through its own entries, and those entries carry job **handles**, never job names. So the scheduler dispatches with `<job>.idempotencyKeyFor(input)` and `<job>.retry.attempts` read off the handle — a task never restates a job's retry policy and never resolves a job by string.

Manual `enqueue()` and a scheduled tick differ in exactly one place: the key. A tick's is occurrence-scoped, `<task>:<occurrenceMs>:<the job's own key>`, so two schedulers or a retried tick cannot double-fire that occurrence. `enqueue()` uses the job's plain key, because a manual run has no occurrence to scope to — and scoping it to whichever occurrence it happened to land in is the one thing that would make a backfill dedupe against a real tick.

## Fields

| Field | Required | Rule |
|---|---|---|
| `cron` | yes | standard 5-field expression. No seconds field, no `@hourly` aliases — one way to write it |
| `tz` | yes | explicit IANA zone (`'UTC'`, `'Europe/Berlin'`, `'America/New_York'`). Omitting it is a compile error |
| `enqueue` | yes | `(occurrenceMs) => [[jobRef, input], …]`. Zero or more pairs; an empty list is a valid no-op tick. Read back through the handle as `entries()`, never as `.enqueue` — that name on the handle is the *fire* method |
| `catchUp` | no — default `'skip'` | what to do when the scheduler was down across one or more occurrences. `'skip'` collapses them into one dispatch for the **latest** missed occurrence and drops the older ones, `'run-once'` fires a single catch-up for the **earliest** missed one, `'run-all'` fires one per missed occurrence |
| `maxCatchUp` | no — default `10` | how many occurrences one tick walks forward from the last fire. Bounds `'run-all'` directly, and caps the lookback for every policy |
| `name` | no | the export name, stamped by `defineApi({ tasks: [scheduledTasks] })`. A module nobody hands over keeps `anonymous-task-<n>`; a definition carrying its own `name:` keeps that |

Nothing else. There is no `timeout`, no `retry`, no `concurrency` on a task — those belong to the job it enqueues. No `queue` either: the queue is the job's, and a per-call override rides on the fire, as `<task>.enqueue({ queue })`.

## `tz` is required for a reason

| Without explicit tz | Consequence |
|---|---|
| Server-local time | the schedule silently moves when the container's `TZ` changes or a region differs |
| Fixed offset (`+02:00`) | drifts by an hour twice a year against "3am local" |
| DST spring-forward gap | a `2:30` local tick has no instant — the framework fires it at the zone's next valid instant |
| DST fall-back overlap | a `1:30` local tick occurs twice — the framework fires it **once**, on the first occurrence |

**`tz` is checked against the runtime's own IANA database, not merely for non-emptiness** `As of 2026-08`. The declaration asks `Intl.DateTimeFormat` to resolve the zone, and `Intl` carries the runtime's copy of the tz database — the only check that can tell `America/Bogota` from `Bogota`. So a non-empty string is not a timezone:

```
X_INVARIANT: task "nightlyDigest" has tz "Bogota", which is not a zone in the IANA tz database
fix: use the full zone id on task("nightlyDigest"), e.g. tz: 'America/Bogota' — list the valid
     ones with: bun -e "console.log(Intl.supportedValuesOf('timeZone').join('\n'))"
```

It fails at declaration, not at the first tick. The alternative is what an abbreviation used to do: resolve every occurrence in UTC and run the cron five hours off, silently, forever.

Store UTC, schedule against an explicit zone, format at the edge. See [Timezones and dates](Timezones-And-Dates).

## The `scheduler` role

Fixed **1**. Cron dispatch only.

| Property | Behavior |
|---|---|
| Leader election | Postgres advisory lock. Whoever holds it dispatches |
| Second instance | a warm standby, not a duplicate. It holds no lock and dispatches nothing |
| `/readyz` on the standby | **reports not-ready, by design** — it must not receive traffic and must not look healthy to an autoscaler |
| Lock lost / cannot acquire | the process exits non-zero with a typed error rather than running degraded |
| Missed tick (leader down, node paused, clock jump) | **fires late rather than being skipped** |
| Double fire during handover | absorbed by the enqueued job's `idempotencyKey` — the second enqueue returns the existing handle, no new row |
| Drain on SIGTERM | registered at the `accept` phase: stop dispatching, wait out the dispatch round in flight, then release the lock — the standby promotes within one lock interval, and never onto an occurrence this node is still enqueueing for |
| Two dispatch rounds at once | impossible in one process. The timer re-arms on the round it finished, and any other caller joins that round instead of opening a second one over the same last-tick state |
| Durable state | none in the process. Last-tick state is a Postgres row |

That chain is the whole safety argument: **at-least-once dispatch + required job idempotency = effectively-once work.** A scheduler that guarantees exactly-once dispatch does not exist; one that guarantees never-silently-skipped does.

Role table and drain sequence: [Deployment](Deployment).

## Introspection

| Command / tool | Output |
|---|---|
| `x tasks list --json` | the descriptor — `name`, `cron`, `tz`, `catchUp`, `maxCatchUp`, `jobs` — plus the resolved **`next`** occurrence, rendered in the task's own `tz`, and its `nextMs` epoch instant. Those last two are derived, never declared fields |
| `x tasks show <name> --json` | the same, plus the cron in words (`describe`) and the next N occurrences (`--count`, default 5) |
| MCP `tasks.list` | same content as `x tasks list --json`, same authz |
| `/_x` dev panel | schedule table with next-run countdown and last-tick outcome |
| `x.manifest.json` | generated `tasks` section — the build-time source of truth |
| `<task>.describe()` | in process: `kind`, `name`, `cron`, `tz`, `catchUp`, `maxCatchUp`, and the job names it enqueues |
| `<task>.entries(occurrenceMs?)` | in process: the exact pairs that occurrence fires, inputs included — which `describe()` drops |

```
$ x tasks list --json
{"ok":true,"command":"tasks","summary":"1 task(s)","findings":[],"data":[
  {"kind":"task","name":"nightlyDigest","cron":"0 3 * * *","tz":"UTC","catchUp":"skip",
   "maxCatchUp":10,"jobs":["sendDigest"],
   "nextMs":1786503600000,"next":"2026-08-12T03:00:00Z"}]}
```

`next` carries the task's own zone offset, never a machine-local one: the same `0 3 * * *` in `America/New_York` reads `2026-03-06T03:00:00-05:00` before the spring-forward and `2026-03-09T03:00:00-04:00` after it.

## Testing

Frozen clock. `clock.advance` drives cron — never `sleep`, never wall-clock.

```ts
test('nightlyDigest enqueues one digest job per day', async ({ seed, clock }) => {
  await seed('one-org');
  clock.advance('3d');
  const trace = await runJobs.drain();
  expect(trace.enqueued(sendDigest)).toHaveLength(3);
});
```

| Asserted | Why |
|---|---|
| Tick count over an advanced window | the cron expression means what you think in the declared `tz` |
| Idempotency absorbs a replayed tick | advance to the same instant twice; the job row count must not change |
| DST boundary | advance across a spring-forward and a fall-back in the task's zone |
| `enqueue` returns the right inputs | the pairs, not the work |

Runner: `x test job` (tasks are dispatch, jobs are the assertion surface). See [Testing](Testing).

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_JOB_NO_IDEMPOTENCY_KEY` | a task enqueues a job with no idempotency key — a double fire would duplicate work | add `idempotencyKey` to the job |
| `X_FORBIDDEN` | the task's system actor lacks a permission the enqueued action requires | grant it explicitly; a task never bypasses [policies](Policies-And-Authz) |
| `X_DRAINING` | a tick landed while the leader was releasing its lock | none — the standby promotes and the tick fires late |

Full index: [Error codes](Error-Codes).

## Rules

- A task never contains a handler body. If it does work, it is a `job`.
- `tz` is always explicit and always IANA.
- Every job a task enqueues must be idempotent — that is what makes leader handover safe.
- Never rely on a task firing at an exact instant. Rely on it firing.
- Never use a task as a poller for something an [action](Actions) could publish. Cron is a fallback, not an event bus.
- One task per schedule. Two schedules for one job is two tasks, not a conditional inside `enqueue`.
