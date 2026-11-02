# 15 — Remote sources and long-lived consumers, as jobs

> Part of [`overview.md`](overview.md). Depends on: [`02-db-entity-cancellation.md`](02-db-entity-cancellation.md), [`11-core-outbound.md`](11-core-outbound.md). Tier: 3 (`jobs`), tests and docs only.

## Why
One adopter hand-rolled a remote-cursor sweep (530 LOC), one a supervised consumer (830 LOC), another plans one. Both API proposals are killed; the gap is that nothing says the existing job already expresses them, and one trap is silent.
Reproduced on the memory driver:
- Consumer: `job` with `concurrency: { key, limit: 1 }` and an `idempotencyKey` per key. A re-arm while running answered `deduped:true`, same id. That is the supervisor: a `task` re-enqueueing on a cron is a no-op while live and a restart once it is not. Drain is `ctx.signal` with `X_DRAINING`, attempt uncounted (`wiki/Jobs-And-Workflows.md:382`).
- The trap: the same `enqueue` from **inside the body** also answered `deduped:true`, deduped onto the running row, so a job re-arming itself on its way out silently never runs again.
- Remote sweep: a page walk under `backfill()` ran through a structural fake source (`rows [1,2,3]`, ledger `completed`), but only by a cast, and only once per name: `jobs/src/backfill.ts:194` keys one pass per `name`, the payload carries only `force`, and the `x_backfills` row skips a completed name. A per-account remote import, the case adopters have, cannot be that. A `step.run` loop returning the cursor can (`wiki/Jobs-And-Workflows.md:218`), and `x jobs show` already reads its steps.

## Decisions
| Candidate | Outcome |
|---|---|
| `consumer()` factory | killed: second way to say keyed concurrency + task + `ctx.signal`. `ROLES` (`core/src/roles.ts:6`) stays closed |
| `backfill.source` page function | killed: one adopter, and widening `source` does not reach the per-account case without an `input` on `backfill()` and a new ledger key, a redesign for one reinvention |
| Doc recipes, pinned by tests | kept: a recipe that can rot is a claim, so each is a `.job.test.ts` |

## Files to change
- `packages/jobs/src/recipes.job.test.ts` (new) — the three behaviours, against Postgres.
- `wiki/Jobs-And-Workflows.md:122` — state the row above: a key is live while `running`, so a self-enqueue is deduped.
- `wiki/Jobs-And-Workflows.md:124-125` — correct: `X_IDEMPOTENCY_CONFLICT` is not thrown by `@ultimat3/jobs` (`grep` over `jobs/src` non-test answers nothing), and a different payload under a live key is deduped, first payload wins (reproduced: accepted).
- `wiki/Jobs-And-Workflows.md:162` — two recipes beside "One run per key": "A cursor walk over a remote API" and "A long-lived consumer".
- `packages/jobs/README.md` — one row each, linking the wiki.

## Steps
1. Cursor walk: `run({ input, step, ctx })`, a loop of `step.run('page:<i>', (signal) => …)` calling the vendor with `signal`, writing rows through an idempotent statement and returning **only** `{ cursor, rows }`, because `steps.ts` retains a step's output for the run. A vendor's cursor that expires is a coded refusal, which dead-letters with the last good cursor visible in `x jobs show`.
2. Consumer: `concurrency: { key, limit: 1, whenBusy: 'wait' }`, `idempotencyKey: consumer:<key>`, no `timeout`; body loops, and each turn writes the batch and its cursor to the app's own row in one transaction **before** it checks `ctx.signal`, never as steps (`Known-Gaps`: one step name per iteration is retained). Past `X_DRAINING`, 02 refuses the write and rolls the turn back, so the recipe must not hold work across the check; the next worker resumes from the last committed cursor. A `task` on a cron re-enqueues each key. Say: never re-arm from inside the body.
3. Pacing: `outbound()` from [`11-core-outbound.md`](11-core-outbound.md) passes `ctx.signal` and honours `Retry-After`. Recipes use it.

## Error codes
None new. `X_JOB_KEY_BUSY`, `X_DRAINING`, `X_ABORTED` existing.

## Tests
- `packages/jobs/src/recipes.job.test.ts` (Postgres, `docker/docker-compose.test.yml`):
  - re-arm from outside while running answers `deduped: true`; after settling starts a new run;
  - a self-enqueue from the body answers `deduped: true`, and no later run exists: pinned so a change here is a visible decision;
  - cursor walk killed mid-page resumes on that page, earlier pages' fetches not repeated;
  - a drain aborts a consumer body and the attempt is not counted;
  - a drain between two turns leaves the committed cursor on the last finished batch; a write attempted past `X_DRAINING` is refused, its transaction leaves no row, and the next run resumes from that cursor with no batch skipped.
- `bun test packages/jobs/src/recipes.job.test.ts`.

## Semver
minor, docs and tests only. `wiki/Jobs-And-Workflows.md:124-125` is a correction of the doc to the shipped behaviour, not a change to it.

## Done when
- The self-enqueue row is stated in the wiki and pinned by a test that fails if the dedupe window ever changes.
- `wiki/Jobs-And-Workflows.md` no longer claims a conflict error the package does not throw.
- `bun run verify` green.
