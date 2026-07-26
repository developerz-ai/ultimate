# Scheduled tasks

A `task` is a cron trigger that enqueues jobs. It never does work itself.

Pre-v1. Not production-ready.

## The canonical shape

```ts
// task (cron)
export const nightlyDigest = task({
  cron: '0 3 * * *',
  tz: 'UTC',
  enqueue: () => [[sendDigest, {}]],
});
```

## A task only enqueues

If it has a handler body, it is a [job](Jobs-And-Workflows), not a task.

| Concern | Where it lives |
|---|---|
| When to fire | `task.cron` + `task.tz` |
| What to enqueue | `task.enqueue` — returns `[[jobRef, input], …]` |
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

## Fields

| Field | Required | Rule |
|---|---|---|
| `cron` | yes | standard 5-field expression. No seconds field, no `@hourly` aliases — one way to write it |
| `tz` | yes | explicit IANA zone (`'UTC'`, `'Europe/Berlin'`, `'America/New_York'`). Omitting it is a compile error |
| `enqueue` | yes | `() => [[jobRef, input], …]`. Zero or more pairs; an empty list is a valid no-op tick |
| `queue` | no | overrides the target queue for everything this task enqueues |
| `enabled` | no — default `true` | a disabled task is still listed by `x tasks list --json`, with `nextRun: null` |

Nothing else. There is no `timeout`, no `retry`, no `concurrency` on a task — those belong to the job it enqueues.

## `tz` is required for a reason

| Without explicit tz | Consequence |
|---|---|
| Server-local time | the schedule silently moves when the container's `TZ` changes or a region differs |
| Fixed offset (`+02:00`) | drifts by an hour twice a year against "3am local" |
| DST spring-forward gap | a `2:30` local tick has no instant — the framework fires it at the zone's next valid instant |
| DST fall-back overlap | a `1:30` local tick occurs twice — the framework fires it **once**, on the first occurrence |

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
| Drain on SIGTERM | releases the leader lock immediately so the standby promotes within one lock interval |
| Durable state | none in the process. Last-tick state is a Postgres row |

That chain is the whole safety argument: **at-least-once dispatch + required job idempotency = effectively-once work.** A scheduler that guarantees exactly-once dispatch does not exist; one that guarantees never-silently-skipped does.

Role table and drain sequence: [Deployment](Deployment).

## Introspection

| Command / tool | Output |
|---|---|
| `x tasks list --json` | name, `cron`, `tz`, `enabled`, `lastRun`, `lastStatus`, **`nextRun`** (ISO 8601, UTC + the zone-local rendering) |
| `x tasks show <name> --json` | the next N fire times, the jobs it enqueues, the resolved queue |
| `x tasks run <name>` | fires one tick immediately, out of band, for verification. Dispatch only — the job still runs on a worker |
| MCP `tasks.list` | same content as `x tasks list --json`, same authz |
| `/_x` dev panel | schedule table with next-run countdown and last-tick outcome |
| `x.manifest.json` | generated `tasks` section — the build-time source of truth |

```
$ x tasks list --json
{"tasks":[{"name":"nightlyDigest","cron":"0 3 * * *","tz":"UTC",
  "enabled":true,"lastRun":"2026-07-26T03:00:00Z","lastStatus":"enqueued",
  "nextRun":"2026-07-27T03:00:00Z","enqueues":["sendDigest"]}]}
```

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
| `X_POLICY_DENIED` | the task's system actor lacks a permission the enqueued action requires | grant it explicitly; a task never bypasses [policies](Policies-And-Authz) |
| `X_DRAINING` | a tick landed while the leader was releasing its lock | none — the standby promotes and the tick fires late |

Full index: [Error codes](Error-Codes).

## Rules

- A task never contains a handler body. If it does work, it is a `job`.
- `tz` is always explicit and always IANA.
- Every job a task enqueues must be idempotent — that is what makes leader handover safe.
- Never rely on a task firing at an exact instant. Rely on it firing.
- Never use a task as a poller for something an [action](Actions) could publish. Cron is a fallback, not an event bus.
- One task per schedule. Two schedules for one job is two tasks, not a conditional inside `enqueue`.
