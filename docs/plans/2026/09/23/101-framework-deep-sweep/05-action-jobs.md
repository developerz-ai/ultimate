# 05 — action + jobs

> Part of [`overview.md`](overview.md). Depends on: 01, 03. Tier: 3.

Rule: an action error takes the same path as any other route error. A job declaration is refused
at declaration, never at the first tick. A tenant-supplied URL is screened before the first byte
leaves.

## Files to change

| # | Defect | File:line | Change | Semver |
|---|---|---|---|---|
| a | `toRoute` catches every `UltimateError` and returns `problem(error)` itself, so the `error-map` stage never sees it. Action routes lose `reportError`/`onError` on 5xx, the HTML error page and sign-in redirect for browsers, `requestId`, and `Retry-After` (`X_ACCOUNT_LOCKED`, `X_OVERLOADED`) | `packages/action/src/http.ts:106-113` | Rethrow. Write the deprecation/sunset headers onto `req.ctx.headers` before `invoke`; the `response` stage merges them into error responses too | patch |
| b | an idempotent replay returns a live value from memory but `JSON.parse(JSON.stringify(v))` from Postgres, with no re-validation. `Date` on the first call, `string` on retry, which contradicts `invoke.ts:233` | `packages/action/src/idempotency-postgres.ts:231`, `idempotency.ts:208`, `invoke.ts:233` | On `outcome.replayed`, run `validateOutput(def.output, value, name)`. Parity test over both stores | patch |
| c | `task()` never validates `cron`. One bad cron throws inside `runRound` (`scheduler.ts:264`), every round aborts, and every task stops | `packages/jobs/src/task.ts:108`, `scheduler.ts:264` | `isValidCron` at declaration, beside the `tz` check (`task.ts:118`), with `X_CRON_INVALID`. Also try/catch each task in `runRound`, logging `jobs.task.round_failed` | patch |
| d | a step replay returns different values per driver: memory keeps the reference, pg stores JSON. `waitForEvent`'s timeout replays as `null` instead of `undefined`, so `evt === undefined` is false | `packages/jobs/src/steps-memory.ts:22`, `driver-pg.ts:101` | Memory stores a JSON round-trip. Persist `waitForEvent`'s timeout as `{ timedOut: true }` and map it back to `undefined` on replay | patch |
| e | a rejecting `fleetSlots.acquire` (or `shed`→`nack`, `:204,:231`) rethrows out of `claimRound`, stranding the rest of the batch in `running` with its attempt burned | `packages/jobs/src/worker.ts:223-227` | Hand back the failed job and every job behind it with `driver.nack(id, { delayMs: pollIntervalMs, countsAsAttempt: false })` (`shed()` at `:155`), then report once | patch |
| f | webhook delivery accepts any host: loopback, RFC1918, link-local, metadata. `http:` is accepted in production, contradicting `WebhookEndpoint.url`'s doc (`:67`) | `packages/jobs/src/webhook.ts:282-313` | Resolve the host and refuse private, loopback, link-local, ULA, CGNAT and `0.0.0.0/8` via `classifyAddress()` from `@ultimat3/core` (slice 01 h). Pin the resolved IP for the connection. Refuse `http:` unless `isLocal`. Opt-out `allowPrivate: true` for dev receivers. Code `X_WEBHOOK_ENDPOINT_INVALID` (exists) | minor |
| g | a job with `idempotencyKey` but no `retry` crashes the loader with `TypeError … definition.retry.attempts`, reported as `X_CLI_UNEXPECTED`. Its fix `x doctor --json` reports something unrelated | `packages/jobs/src/job.ts:190-193` | Collect **every** missing required field in one declaration error. New code `X_JOB_DECLARATION_INVALID` with the fix `set retry: { attempts: 5, backoff: 'exponential' } on job('<name>')` | patch |
| h | `X_IDEMPOTENCY_REQUIRED`'s fix writes the positional `anonymous-job-N` into persisted keys | `packages/jobs/src/errors.ts:327`, `job.ts:183` | When the name is positional, the fix names the export (read by slice 11 b's registration) or says `register this job in apps/web/api/index.ts first`, never the counter | patch |
| i | `scheduler.stop()` has no drain budget, unlike the worker's `createDrainBudget` (`worker.ts:80,363`) (suspected) | `packages/jobs/src/scheduler.ts` `stop` | Reproduce: a manual stop and then SIGTERM. If unbounded, reuse `createDrainBudget` | patch |
| j | docs: `skip` fires "the latest occurrence within the cap", but the code bisects to the true latest. And the pg index is not the one the README states | `packages/jobs/CLAUDE.md` (run-once bullet), `packages/jobs/README.md:682,769` | Correct the prose to match `scheduler.ts:176-186,277` and `driver-pg-ddl.ts:67` | none |

## Steps
1. a first: every later action-error test depends on errors reaching `error-map`.
2. f uses `classifyAddress` from slice 01 h. Do not write a second classifier here.
3. Register `X_JOB_DECLARATION_INVALID` with `bun run new-error-code`.

## Tests
- `bun test packages/action/src packages/jobs/src`
- `action/src/http.test.ts`: an action throwing a 5xx calls `onError` once, and `accept: text/html` gets `text/html`.
- `webhook.test.ts`: each private literal gives `X_WEBHOOK_ENDPOINT_INVALID` with `sent.length === 0`.
- `worker-slots.test.ts`: every claimed row is back in `ready` at attempt 0.
- `task.test.ts`: `'61 * * * *'` throws at declaration, and a round with one bad task still fires the good one.

## Done when
- An action 5xx is reported exactly as a plain route's 5xx is.
- A webhook to `http://169.254.169.254/` never sends.
- No job declaration error surfaces as `X_CLI_UNEXPECTED`.
