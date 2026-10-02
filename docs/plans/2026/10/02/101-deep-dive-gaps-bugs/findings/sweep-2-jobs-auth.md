# Sweep 2 — jobs and auth (files sweep 1 left unread)
> Re-checked in [`sweep-3-verify-backend.md`](sweep-3-verify-backend.md) — where it narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only hunt at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: `packages/jobs/src` — worker, outbox, backfill, pg driver, operator surface, leases,
> heartbeat, events, wake, purge, job. `packages/auth/src` — OAuth, jwks, id-token, password, verify,
> workload, revocation, kdf-gate, policy-bridge.
> CONFIRMED = a probe ran (memory driver or PGlite). PLAUSIBLE = from reading only.

## High

| # | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 1 | `packages/jobs/src/worker-loop.ts:64-73` | a pass that rejects never resets `delayMs`; the only raise is `loop.passed()` on the last line of `claimRound` (`worker.ts:241`), after `driver.claim` (`worker.ts:150`) | one `signalEnqueued` or freed-slot `kick` during a database outage → `arm()` re-arms at 0 forever, logging `jobs.worker.tick-failed`. 452 rounds in 500 ms from a 250 ms floor | CONFIRMED | reset the wait in the catch, as `outbox-relay.ts:253-256` does (`backoff.next(true)`) | `packages/jobs/src/worker-loop.test.ts` |
| 2 | `packages/jobs/src/steps.ts:391-398`, `events-pg.ts:113-122`, `driver-pg-sql.ts:306-315` | `step.waitForEvent` compares the worker's process clock with the database's `published_at`; `EventLookup` has no `now()`; nothing calls `bus.now()`. Contract: `events.ts:35-39`, `packages/jobs/CLAUDE.md` "the event bus has ONE clock" | a worker N ms ahead of Postgres never matches an event published within N ms after the wait began — the run sits until its timeout (24 h default). PGlite, runner +5 s, event 6 ms later → `suspended` again | CONFIRMED | take a new wait's `startedAt` from the bus (`now()` on `EventLookup`, clock as fallback) | `packages/jobs/src/events-pg.live.test.ts`, a skewed-clock case in `steps.test.ts` |
| 3 | `packages/jobs/src/driver-pg-sql.ts:129-135`, `driver-memory.ts:183-197` | `cancel` refuses only `done` — rewrites a `dead`, `failed` or `cancelled` row. Contract: `introspection.ts:192-196`, `inspect.ts:240-244` | `cancelJob(driver, <dead id>, 'oops wrong id')` → `dead / "card declined"` becomes `cancelled / "oops wrong id"`; `deadLetters()` 1 → 0. Both drivers | CONFIRMED | fence on live states `('ready','delayed','running','suspended')`; memory uses `LIVE_STATES` (`driver-memory.ts:51`) | `packages/jobs/src/driver-parity.test.ts` |

## Medium

| # | Where | Defect | Failing input → wrong output | Verdict | Test |
|---|---|---|---|---|---|
| 4 | `packages/jobs/src/events-pg.ts:62-70` | `purgeExpired()` on the pg event bus has no production caller; `publish` never calls it (memory does, `events.ts:84`); `packages/cli/src/runtime-purge.ts` has no `x_job_events` target while `runtime-queue.ts:186` installs this bus by default | `x_job_events` only grows. The defect `purge.ts:8-12` was written to end. Fix: register a `PurgeTarget` | CONFIRMED | `packages/jobs/src/events-pg.live.test.ts`, `packages/cli/src/runtime-purge.test.ts` |
| 5 | `packages/jobs/src/introspection.ts:71` | cursor pattern accepts a non-uuid id the pg statement then casts | `list({ after: '123:not-a-uuid' })` → memory `[]`, pg `X_DB_STATEMENT_FAILED [22P02]`; contract says `X_JOB_PAGE_INVALID` | CONFIRMED | `packages/jobs/src/operator-surface-fixture.ts` |
| 6 | `packages/jobs/src/driver-memory.ts:149-153` vs `driver-pg.ts:229-235` | `requeue` of an unknown id: memory `X_INVARIANT`, pg `X_DRIVER_UNAVAILABLE` | fix: one dedicated refusal beside `JobNotRequeueableError` (`errors-requeue.ts`) | CONFIRMED | `packages/jobs/src/driver-parity.test.ts` |
| 7 | `packages/jobs/src/driver-memory-operator.ts:171-177` | `requeueMany` spends `MAX_BULK_ROWS` on rows it then skips; comment `:103-104` and `SQL_JOB_REQUEUE_MANY` say otherwise | 1000 dead rows with a held key + 1 free → memory `{affected: 0, remaining: 1001}`, pg `{affected: 1, remaining: 1000}` | CONFIRMED | `packages/jobs/src/operator-surface-fixture.ts` |
| 8 | `packages/jobs/src/outbox.ts:219-222` (`EnqueueOptions.runId`) | memory accepts any string `runId`; pg casts to uuid | `enqueue({ runId: 'order-42' })` → memory ok, pg raw `22P02`; `backfills.list` the same. Fix: validate once in the facade | CONFIRMED | `packages/jobs/src/outbox-run-id.test.ts` |
| 9 | `packages/auth/src/oauth-builtins.ts:42-58` | the shipped Apple provider probably cannot complete a login: the provider requires `response_mode=form_post` when a scope is requested; the built-in asks `['name','email']`, `beginOAuth` (`oauth.ts:94-102`) never sets it, both descriptors are GET, and `oauth-cookie.ts:181-182` notes the `SameSite=Lax` cookie would not reach a POST | the authorize request is refused | PLAUSIBLE, medium — from the provider's documentation, not run | `packages/auth/src/oauth-route.test.ts` |

## Low

| Where | Defect | Verdict |
|---|---|---|
| `packages/jobs/src/backfill-pass.ts:167-188` | a completed pass redelivered (died between `ledger.finish` `:285` and the ack) reports `{ skipped: true, previousRunId: <its own> }`. Fix: fall through when `previous.runId === runId` | PLAUSIBLE |
| `packages/auth/src/jwks.ts:196-213` | a 200 with an unusable body replaces a working key set with an empty one, stamped fresh; healed by the one early refresh — if that is spent (one forged `kid`), every verification fails up to 10 min | CONFIRMED (replacement); outage PLAUSIBLE |
| `packages/auth/src/oauth-exchange.ts:254-261` | the 200-with-`error` branch puts the remote `error_description` in the published cause uncapped, no `renderCauseValue`; `providerDetail` (`:127-154`) caps. 5 KB → 5089-char cause served to an anonymous caller | CONFIRMED |
| `packages/jobs/src/driver-pg-rows.ts:97,149,171` | `X_JOB_ROW_STATUS_UNKNOWN` names `ultimate_jobs`, `ultimate_job_steps`, `ultimate_backfills`; the tables are `x_jobs`, `x_job_steps`, `x_backfills`. `driver-pg-rows.test.ts:280` pins the wrong name | reading |
| `packages/auth/src/revocation.ts:89-94` | `disableUser` writes before it logs; on an adapter without `deleteSessionsForUser` the user is disabled, then `X_NOT_IMPLEMENTED` is thrown. Header `:13-16` says log first | PLAUSIBLE |
| `packages/jobs/src/driver-pg.ts:313-319` | enqueue insert-then-lookup race → `X_DRIVER_UNAVAILABLE`, fix `x db migrate` (same row as [`sweep-1-concurrency.md`](sweep-1-concurrency.md) Low 1) | PLAUSIBLE |
| `packages/jobs/src/driver-memory.ts:385` vs `driver-pg-sql.ts:170` | `stats()` orders queues by `localeCompare` vs database collation; the rule (`driver-pg-operator-sql.ts:5-6`) is `collate "C"` | reading |
| `packages/auth/src/oauth-discovery.ts:113,150` | the document's `issuer` adopted without comparing it to `input.issuer` (OIDC Discovery §4.3; header `:49-51` implies it) | low on impact |

## Gaps

- `JOB_ROW_COLUMNS` rounds `extract(epoch …) * 1000`; `SQL_EVENT_PUBLISH` floors — `list({ createdFrom: row.createdAt })` could miss the row by 1 ms. Unconfirmed without real Postgres.
- `BulkResult.remaining` (`introspection.ts:111-112`: "call again until it is zero") counts held-key rows permanently — a caller looping on it never ends. CLI and admin callers unread.
- `job.ts:269-273` checks `retry.attempts >= 1` only; `Infinity` or `1.5` reaches `$7::int` on pg.
- `verify.ts:91-109` upserts the new token before `mail.send` — a failed send invalidates the previous working link. May be intended.
- `x_outbox` published rows are never deleted — `outbox.ts:185-188` calls it a retained audit trail.

## Not a bug (do not re-open)

- Bulk `remaining` arithmetic — pg and memory equal.
- `SQL_STEPS_FROM` vs memory `fromStep`.
- Lease store parity; `jobLeaseKey` collisions.
- Counter buckets, fold and drop boundaries.
- Outbox claim order, lease boundary, fenced release / mark, repeated publish dedupe, relay reset to floor.
- Step output parity (`undefined` → `null` on both).
- Backfill resumption.
- Heartbeat arithmetic.
- `verifyIdToken` — `aud` array, `azp`, `exp` / `nbf` skew, nonce, `alg` restricted to RS256 / ES256.
- JWKS key selection; miss refresh rate limit.
- OAuth handshake — provider bound into the seal, constant-time compares, `redirect_uri` in the seal.
- `oauthProfile` subject check; password KDF burn on unknown user; `consumeVerification`.

## Still not read

- `jobs`: `worker-admit`, `worker-fleet-slots`, `worker-key-busy`, `worker-registry`, `worker-options`, `worker-queue-depth`, `worker-hand-back`, `worker-types` — keyed-concurrency admission and the queue-pause interaction with held slots are unaudited; `driver.ts:1-149`; the fixtures.
- `auth`: `oauth-paths`, fixtures.
- Test files in scope were scanned heuristically, not read.
