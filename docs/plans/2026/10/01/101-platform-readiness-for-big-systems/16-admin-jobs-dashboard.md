# 16 — Admin: the jobs dashboard, built with Ultimate

> Part of [`overview.md`](overview.md). Depends on: 06, 13, 14, 15. Tier: 5.

Rule: the production jobs dashboard is an admin surface made of the framework's own primitives —
queries, actions, policies, `@ultimat3/ui`. It is the admin package's first real consumer of
slices 13–15, and nothing in it is a mechanism an app could not use for its own screens.

Evidence: the admin declares a `jobs` route with permission `job:list`
(`packages/admin/src/admin.ts:233-237`) and nothing renders it; the only jobs UI is the dev
panel, which refuses production (`packages/admin/src/dev/server.ts:62-71`) and prints JSON in a
`<pre>`. The surveyed job system mounts its dashboard in one line and operators live in it; its
front end is ~3,900 lines of hand-written pages over a hand-written API.

## Files to change
- `packages/admin/src/jobs/` (new directory, one file per screen):

| Screen | Shows | Actions | Reads (slice 06) |
|---|---|---|---|
| overview | tiles: ready, running, delayed, suspended, dead, workers, oldest-ready age; done-vs-failed chart over 1h / 24h / 7d / 30d | — | `stats()`, counters |
| queues | name, depth, latency, paused | pause, resume | `stats()`, `pauseQueue` |
| queue detail | paged jobs | remove one | paged `list` |
| running | per worker: identity, host, heartbeat age, in-flight jobs with progress | cancel a job | registry, `cancel` |
| delayed and retrying | name, next run, attempt, last error | run now, remove; one, selected, all-matching | `list`, `promote`, `removeMany` |
| dead | name, error, failed at | retry, remove; one, selected, all-matching | `deadLetters`, `requeueMany` |
| job detail | input, step trace, error and stack, progress, tenant, trace id | the owning list's actions; retry from a step | `job` |
| tasks | schedule, time zone, last and next fire, paused | pause, resume, run now | task surface |
| by job name | volume, failure rate, mean duration per name | time range | counters |
| search | by id prefix, name, state, time range | — | paged `list` |

- `packages/admin/src/admin.ts:233-237` — the `jobs` route gets its components; sub-routes
  beside it.
- `packages/admin/src/permissions.ts` — `job:list` reads; a new `job:manage` gates every action.
- `packages/mcp/` projection — the same actions and queries as tools.
- `packages/admin/src/dev/panel-jobs.ts` — the dev panel renders the same components over the
  dev driver. One jobs UI.
- `packages/i18n/src/catalogs/en.json` — every label through `t()`.

## Steps
1. Each action is an `AdminAction` (`packages/admin/src/registry.ts:155-167`) with slice 15's
   `when` and `batch`: "retry" shows on dead rows only, and the batch bar is the bulk path.
   No jobs-specific button, modal or selection code.
2. Lists use slice 14's filter bar and scopes — state tabs with counts come from `stats()`,
   which is already one query.
3. Read-only is not a mode: an actor without `job:manage` sees no action and the server refuses
   the call. The surveyed system needed a separate read-only switch because its dashboard had no
   permission model of its own.
4. Live: the overview tiles are one live `query` over `stats()` on the page's one socket; every
   other screen is a plain read with `refetch` on a declared interval (5 s lists, 30 s charts).
   No second transport, no SSE endpoint. With realtime disabled the tiles fall back to the same
   interval read.
5. Charts are `StatTile`, `BarChart`, `Sparkline` (`packages/ui/src/index.ts:63-64,198-205`).
   If one of them cannot draw a two-series time chart, extend that component; do not add a
   chart library.
6. Tenancy: an operator scoped to an org sees that org's jobs only — slice 14's `rows` over the
   job's tenant. A platform operator is the actor without that scope.
7. MCP: the tools the audit plan lists as promised and absent — list, status, retry, tasks —
   fall out of step 1 (`../../../09/28/101-audit-bugs-and-gaps/09-gaps-and-docs.md:10`). Mark
   that row done there.
8. Job input on the detail screen is what slice 06 already redacted. A sealed value or a declared
   secret never renders.
9. Measure the admin surface's JS after the screens land; raise its budget by that amount with
   the reason in the same diff.

## Tests
- `packages/admin/src/jobs/screens.test.ts`: each screen renders from a memory driver seeded with
  one job per state.
- `packages/admin/src/jobs/permissions.test.ts`: `job:list` alone sees every screen and no
  action; a forged retry is refused; an org-scoped actor never sees another org's job.
- `packages/admin/src/jobs/jobs.e2e.test.ts`: dead job → retry from the batch bar → it runs; a
  queue paused from the screen stops being claimed.
- `packages/admin/src/jobs/mcp.test.ts`: the tool list carries list, status, retry, pause.
- Command: `bun test packages/admin/src/jobs/`.

## Done when
- An app that declares `defineAdmin({ … })` has `/admin/jobs` in production with no app code.
- The dev panel and the production screen are the same components.
- Zero lines in `packages/admin/src/jobs/` call `fetch(`, open a socket or hand-write a table.
