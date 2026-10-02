# Sweep 3 — falsification of unproven backend findings

> Findings for [`../overview.md`](../overview.md). Adversarial re-check at `2ea5eb17` (23.0.0), As of 2026-10.
> Subject: every row of the sweep-1 / sweep-2 backend files that had no probe behind it.
> Probes over memory drivers, PGlite, `pg-replication-fixture`. No docker.
> **Nothing was refuted. 11 rows gained a probe, 7 are narrowed, the rest stand on reading.**
> **Where this file narrows a row, this file wins** — the slices plan the narrowed statement.

## Verdicts

| Finding | Verdict | Evidence / corrected `file:line` |
|---|---|---|
| [`sweep-2-concurrency.md`](sweep-2-concurrency.md) 1 — ISR `attach()` never called | STANDS | the only `attach()` calls in `packages/cli/src`, `packages/render/src`, `packages/testing/src` and both tracked apps are in `packages/render/src/render-isr.test.ts`. The three `createIsrController` sites (`packages/cli/src/runtime-render.ts:432`, `serve-web.ts:150`, `cmd-dev.ts:244`) never attach. `revalidateByTags` has no caller either. Prerender / `x build` does not touch the controller |
| [`sweep-2-concurrency.md`](sweep-2-concurrency.md) 2 — replicator failure unread | REPRODUCED | `createReplicator` over `feedOver(FakeWalsender)`, `copyDone()` pushed → `stats().failure` set, `replicator.running === true`, a second `start()` answers `true`, dial count 1. `ChangeFeed` (`packages/realtime/src/changefeed.ts:50-56`) has no failure member. `registerReadinessCheck` callers: `packages/cli/src/runtime-services.ts:272,393` only |
| [`sweep-2-realtime.md`](sweep-2-realtime.md) 3 — one rejected `onChange` kills the stream | REPRODUCED | `transport.publish` rejects once, two transactions pushed → one publish call, zero after, `running` true |
| [`sweep-1-concurrency.md`](sweep-1-concurrency.md) 2 — mutator replay not idempotent | STANDS | correction: `dummy/social-media-clone/…/notifications/mutator.ts:33` does declare `idempotent: true`; the two `examples/dummy` mutator files do not |
| [`sweep-1-concurrency.md`](sweep-1-concurrency.md) 3 — mail enqueue outside the tx | STANDS | the driver's executor is the pool (`packages/cli/src/runtime-queue.ts:117-121,174-175`); only the facade's `txExecutor` consults `currentTx()` (`:178-180`). Not probeable on one PGlite session |
| [`sweep-1-concurrency.md`](sweep-1-concurrency.md) 5 — boot DDL under `lockTimeoutMs: 0` | STANDS | `packages/db/src/pool-profile.ts:54,62,70,78`. The stall is bounded by the role's `statement_timeout` (10 s web), after which boot fails. Needs live Postgres to measure |
| [`sweep-1-concurrency.md`](sweep-1-concurrency.md) 6 — in-flight idempotency key stuck 24 h | NARROWED | deliberate, argued at `packages/action/src/idempotency.ts:226-228`. A design gap, not a bug: "died before commit" and "committed, unsettled" are indistinguishable, no reclaim before the window lapses |
| [`sweep-1-concurrency.md`](sweep-1-concurrency.md) 7 — worker claims during the readiness grace | NARROWED | mechanism true (`packages/core/src/lifecycle.ts:390-393`, `lifecycle-grace.ts:13,27-30`). "An attempt burned per deploy" is wrong — a run interrupted by the drain signal is re-queued uncounted (`packages/jobs/src/worker-drain-signal.test.ts:153`). Damage: 5 s of claimed-then-aborted work; an attempt is lost only if the body ignores `ctx.signal` |
| [`sweep-1-concurrency.md`](sweep-1-concurrency.md) 8 — fence is process-local | NARROWED | true only while the broadcast is lost or late — a delivered broadcast runs `fanOut` over every tier, Redis included (`packages/cache/src/invalidate.ts:178-190`). The lost-broadcast case and the never-retried subscribe (`packages/cli/src/runtime-cache.ts:185-190`) stand |
| [`sweep-1-concurrency.md`](sweep-1-concurrency.md) 9 — nested action busts before the outer commit | STANDS | `packages/action/src` has zero references to `currentTx` / `withTransaction` |
| [`sweep-1-concurrency.md`](sweep-1-concurrency.md) lows | STANDS | `steps.ts:334` contradicts its own comment (`:324-325`); `SQL_STEP_PUT` has no `claims` predicate; the enqueue throw is `packages/jobs/src/driver-pg.ts:313-319` |
| [`sweep-1-security.md`](sweep-1-security.md) H2 — channel kept on a non-denial guard failure | REPRODUCED, trigger corrected | tenant-scoped entity on `memoryRepo`, channel `row` loader, subscribed as org A. An actor carrying **no** `orgId` → `dropped=[]`, still subscribed. An actor in **another** org → correctly dropped. Trigger is "lost the org entirely" — and sign-out, see New 1 |
| [`sweep-1-security.md`](sweep-1-security.md) M3 — dev SQL panel | STANDS | no Origin, `Sec-Fetch-Site` or Host check in `packages/cli/src/dev-dashboard.ts` or `packages/admin/src/dev/`. Low confidence on browser-side mitigations |
| [`sweep-1-security.md`](sweep-1-security.md) M8 — org-wide login lockout | NARROWED → owner decision | intended and pinned: `packages/auth/src/rate-limit.ts:31-43` argues it, `auth-lockout.test.ts:31-50,68-81` assert it. Not a defect. The membership-oracle half stands — New 3 |
| [`sweep-1-security.md`](sweep-1-security.md) M9 — MFA second leg | NARROWED | the missing leg is documented (`packages/auth/src/errors.ts:165-174`, `packages/auth/CLAUDE.md:149-154`); "without the password" does not follow from the fix text. What does: `verifyTotp` has no limiter and `login` calls `recordSuccess(account)` (`auth.ts:307`) before throwing `mfaRequired` (`:338`) — a caller holding the password guesses codes unmetered |
| [`sweep-1-security.md`](sweep-1-security.md) M10 — publish gate inside the tagged ref | STANDS | the repository has no rulesets; environment `npm-publish` has a `v*` tag deployment policy, no reviewers, admins may bypass. `.github/workflows/release.yml:117` interpolates a step output into `run:`; that job holds no `id-token` |
| [`sweep-1-security.md`](sweep-1-security.md) L1 — vector store unscoped by default | NARROWED | stated design (`packages/ai/src/vector-scope.ts:19-20`). Hardening, not a contract violation |
| [`sweep-1-security.md`](sweep-1-security.md) L2 — one AES key for every purpose | STANDS | `packages/core/src/seal-keys.ts:50-59`; purpose is in the AAD and IV derivation (`seal.ts:83-98`), not the key. Hardening |
| [`sweep-2-jobs-auth.md`](sweep-2-jobs-auth.md) 9 — the shipped Apple provider | STANDS | plus a second half: `packages/auth/src/oauth-route.ts:316-317` reads `state` / `code` from `searchParams` only; `:354,361` register GET only |
| [`sweep-2-jobs-auth.md`](sweep-2-jobs-auth.md) lows | STANDS | all read, none refuted |
| [`sweep-2-realtime.md`](sweep-2-realtime.md) 10 — `channelTopics` keyed by client sid | REPRODUCED | add sid A and sid B for one channel, drop A → `socket.topics` empty while B is "held". 20,000 adds with fresh sids: all accepted, heap +43.5 MB |
| [`sweep-2-realtime.md`](sweep-2-realtime.md) 11 — DELETE under default replica identity | REPRODUCED (function level) | `updatesFor` with a params channel: full `before` → one `remove`; key-only `before` → zero updates, nothing logged. `x db gen` grants FULL only to live-query `subscribes:` tables (`packages/cli/src/db-subscribes.ts:1-3`) |
| [`sweep-1-tiers-2-3.md`](sweep-1-tiers-2-3.md) 7 — duplicate `register()` code | REPRODUCED | memory → `X_AUTH_WRITE_FAILED`; `BuiltinAdapter` over PGlite → `X_DB_UNIQUE_VIOLATION` |
| [`sweep-1-tiers-2-3.md`](sweep-1-tiers-2-3.md) 10, 12 | STANDS | 12: the refusal's cause and fix are wrong for a numeric id (`packages/realtime/src/errors.ts:311-312`) |
| [`sweep-2-entity-http-action-query-policy.md`](sweep-2-entity-http-action-query-policy.md) 9 — `transition()` requires a uuid | STANDS | `packages/action/src/transition.ts:118` vs `:53` |
| same file, low — `job-handle.ts:54` | NARROWED | the jobs dedupe index includes the tenant (`packages/jobs/src/driver-pg-sql.ts:56`); only the actor is absent — ordinary job dedupe |
| same file, low — `decisions.ts:84` | NARROWED | `memoryDecisionSink` has no production caller |
| [`sweep-2-admin-testing-scraping-scripts.md`](sweep-2-admin-testing-scraping-scripts.md) 8 — audit screen tenancy | REPRODUCED | an org-A actor with `audit:read` opens `/admin/audit` → 200, HTML contains an org-B actor id. `packages/admin/src/screen-system.tsx:18` passes `{ limit }` only; `audit-pg.ts:107` would honour `orgId` |
| [`sweep-1-tier-5-scripts.md`](sweep-1-tier-5-scripts.md) 3 — datetime truncated on edit | REPRODUCED | `…T10:20:45.123Z`, title-only edit → `…T10:20:00.000Z` stored, an `update` audit entry with a diff |
| [`sweep-1-tiers-0-1.md`](sweep-1-tiers-0-1.md) 12 — AVIF offered by default | STANDS | no in-repo caller of `responsiveImage` |
| [`sweep-1-tiers-0-1.md`](sweep-1-tiers-0-1.md) lows | `array-parameter.ts:37` REPRODUCED; `grant.ts:91` STANDS (`grant.test.ts:187,218` pin the wrong name); `driver-s3.ts:161` STANDS |
| [`sweep-2-core-db-schema.md`](sweep-2-core-db-schema.md) lows | `locale-tags.ts:19-21` REPRODUCED; `secrets-errors.ts:81` STANDS |
| [`sweep-2-concurrency.md`](sweep-2-concurrency.md) 6, 9, 11 | STANDS | 11: `packages/admin/src/batch.ts:288` `crypto.randomUUID()` per call; job key `batchId:index` (`batch-job.ts:120`) |

## New, found while verifying

| # | Where | Finding |
|---|---|---|
| 1 | `packages/realtime/src/channel-authz.ts:25-29` | **sign-out keeps the channel too.** The `row` loader runs under the node context when the actor is `null`; `onActorChange(socket, null)` returned `dropped=[]` — the tenant-scoped read threw before the policy ran. Widens security H2. Whether the grant sweep ever passes a null actor (rather than evicting) was not traced |
| 2 | `wiki/Known-Gaps.md:42`, `packages/realtime/README.md:625` | both say a keyed table does not need `REPLICA IDENTITY FULL` — true for live queries, false for a channel with params (it silently loses deletes). Acknowledged only in a code comment (`channel-records.ts:24-25`) |
| 3 | `packages/auth/src/auth-lockout.test.ts:49` | `X_ACCOUNT_LOCKED`'s `cause` contains the org id — once an org is locked, a login attempt for any member's address confirms membership. Whether `cause` is served on this status over HTTP was not checked |
| 4 | `packages/auth/src/oauth-route.ts:316-317,354,361` | the Apple gap needs a POST leg and a handshake cookie that survives it, not only `response_mode` |
| 5 | `packages/storage/CLAUDE.md:19` | also names `createUploadGrant`; the export is `grantUpload` |

## Not reached

- [`sweep-2-concurrency.md`](sweep-2-concurrency.md) lows (storage, scraping, pwa, entity, admin crud).
- [`sweep-1-concurrency.md`](sweep-1-concurrency.md) "reading" lows: `pipeline.ts:192`, `transaction.ts:308-315`, `driver-pg.ts:248-254`, `scheduler.ts:326-334`, `runtime-render.ts:451-467`.
- [`sweep-2-realtime.md`](sweep-2-realtime.md) PLAUSIBLE lows; [`sweep-1-security.md`](sweep-1-security.md) L4–L10.
- `contract-test.ts:76-86`, `aggregate.ts:85-86`, `openapi.ts:80-93`.
