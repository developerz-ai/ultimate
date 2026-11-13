# 18 — The three tracked apps: adopt every mechanism this plan ships

> Part of [`overview.md`](overview.md). Depends on: [`05`](05-entity.md), [`07`](07-auth-policy.md), [`09`](09-jobs.md), [`10`](10-realtime.md), [`13`](13-cli-exercise-verify.md). Tier: apps (`examples/dummy`, `dummy/social-media-clone`, `dummy/docs-site`).

The reference app is what agents copy. A hand-rolled loop there is a pattern in every adopter six weeks later.

## Findings

| ID | Sev | Status | App | Where | Finding | Fix |
|---|---|---|---|---|---|---|
| A1 | P1 | confirmed (schema dump) | demo | `dummy/social-media-clone/packages/db/migrations/20260824215827_rename_ordered_and_partial_indexes.sql:5-11` | 7 duplicate indexes in production: the rename migration created the hashed names and never dropped the old `*_idx` (likes, media, messages, notifications, posts ×2, users). Every write pays both | one migration: `drop index concurrently` × 7. The rail that would have caught it: an index in the dump that is in neither the snapshot nor the declarations → `X_DB_INDEX_UNDECLARED` in `packages/cli/src/schema-dump-drift.ts` (the `drift` step) |
| A2 | P1 | confirmed (`$describe()`) | both | `likes_post_id_idx` duplicates the primary key `(post_id, user_id)`; `participants_conversation_id_idx` likewise; the reference app: likes, comments, run_events, webhook_deliveries | redundant foreign-key indexes | after [`05`](05-entity.md) E9: `x db gen --drop-redundant`, one migration per app; `bun run schema-dumps` |
| A3 | P1 | confirmed (read) | demo | `apps/web/app/messages/service.ts:67` | `/messages` reads the latest message per thread in a loop: 4 + N statements, up to 54 | `latestBy` / `preload(…, { perParent: 1 })` ([`05`](05-entity.md) E5) |
| A4 | P1 | confirmed (read) | both | demo `app/notifications/repo.ts:65`, `app/tasks/jobs/sweep-orphan-media.ts:34`, `app/tasks/repo.ts:130`; reference `app/posts/backfills/post-excerpts.ts:64` | four per-row write loops (≤ 50, 1,000, 5 × 1,000 statements) under `expectedQueryLoop` | chain `update`/`delete` and `updateMany` ([`05`](05-entity.md) E1, E2); delete the four `expectedQueryLoop` waivers |
| A5 | P2 | confirmed (read + the partial-index rule) | demo | `apps/web/site/feed/repo.ts:27-33`, `app/dashboard/repo.ts:55`; `packages/db/src/schema/posts.ts:41-46` | The feed index is partial on `audience = 'public'`; the query filters only `deleted_at is null` and applies visibility in JS after a ×3 over-fetch. Postgres cannot use the index: a sequential scan and a sort per feed read | `policy.scope` ([`07`](07-auth-policy.md) P1) puts the viewer's predicate in SQL; the existing partial index then serves the anonymous feed. Delete the over-fetch |
| A6 | P2 | confirmed (exercise: 13 statements) | reference | `apps/web/app/posts/repo.ts:291-298` | `likePost` locks the row, runs `COUNT(*)`, writes the count back | `countedIn` once [`05`](05-entity.md) E10 makes trigger writes visible to the row observer |
| A7 | P2 | confirmed (boot log) | reference | `apps/web/app/auth/login.ts`, `demo-actor.ts`; `apps/web/runtime.ts` | Every request is served as a declared demo viewer (a warning on every boot); the `oauthLogin` start/callback routes are declared and tested, not mounted | mount them, `configureAuthenticator`, delete the demo actor |
| A8 | P3 | confirmed | demo | `apps/web/app/tasks/jobs.test.ts`, `app/messages/live.test.ts` | 0 `live` and 0 `job` tests: its jobs, retries and live thread run only on the memory driver, and both steps skip | `sweep-orphan-media.job.test.ts`, `reset-demo.job.test.ts`, `live-thread.live.test.ts`; both steps join its floor ([`13`](13-cli-exercise-verify.md) X8 would flag it) |
| A9 | P3 | confirmed (production pod logs) | demo | `dummy/social-media-clone/production-env.ts:50` | `auth.captcha.unverified` warned by all five roles on every boot (11 rollouts in 12 h) | `bootWarning({ roles: ['web'] })` ([`14`](14-cli-commands-upgrade.md) U7) |
| A10 | P3 | confirmed | reference | `apps/web/app/**/feed.island.tsx:108`, `run-console.island.tsx:199` | hand-written `onCleanup(() => handle.release())` | delete after [`10`](10-realtime.md) R7 |
| A11 | P3 | confirmed | docs site | `dummy/docs-site/apps/web/shared/docs.ts:58` | `corpus ??= load()` keeps a rejected load forever | `retryMemo`, as the CLI uses |
| A12 | P3 | — | all three | `x.verify.json`, `exercise.ts` | new floor, statement budgets, route loads ([`13`](13-cli-exercise-verify.md)) | every route `load` exercised; no budget override without a `why`; `unprovenMax: 0` |
| A13 | P3 | — | reference | pairs of task + job | hand-written schedule + job pairs | `cronJob` ([`09`](09-jobs.md) J13): the reference app shows the factory, not the pair |

Checked and fine, not planned: the demo's repositories already batch names, members and authors; the reference feed is index-served by `posts(org_id, created_at, id)`; its global `posts(slug)` unique is deliberate (`posts.ts:77`); `deploy-social-demo.yml` publishes only on-main commits.

## Files to change
- `dummy/social-media-clone/packages/db/migrations/` (2 new), `packages/db/src/schema/*.ts`, `packages/db/schema/` (regenerated by `bun run schema-dumps`).
- `dummy/social-media-clone/apps/web/app/messages/{repo,service}.ts`, `notifications/repo.ts`, `tasks/repo.ts`, `tasks/jobs/sweep-orphan-media.ts`, `site/feed/{repo,service}.ts`, `site/u/service.ts`, `app/dashboard/repo.ts`, the policy that gains `scope`, `production-env.ts`; three new test files.
- `examples/dummy/apps/web/app/posts/repo.ts`, `posts/backfills/post-excerpts.ts`, `auth/*`, `apps/web/runtime.ts`, two islands, the schedule pairs; `examples/dummy/packages/db/migrations/` (1 new), `x.manifest.json` (regenerate).
- `dummy/docs-site/apps/web/shared/docs.ts`.
- `packages/cli/src/schema-dump-drift.ts`, `error-codes.ts` — the A1 rail (cli lock: schedule with [`13`](13-cli-exercise-verify.md)).
- `scripts/lib/gated-apps.ts` — stays empty; a row here is a failure of this slice.
- Coordinator only: `bun run new-error-code X_DB_INDEX_UNDECLARED --package cli … --off-socket`, `bun run schema-dumps`, each app's manifest (`x manifest --cwd <app>`), budgets (`bun run budget-raises` if a measured figure moves).

## Steps
1. A1 first and alone: it is a production fix with no framework dependency. Ships with the hotfix patch's deploy ([`01`](01-hotfix-patch.md)).
2. Then per app, one worker each (three apps, three workers): adopt in the order of the Depends line.
3. After every adoption: that app's `statements` fixture proves the count (`/messages` with 20 threads ≤ 5; `markRead` of 50 ids ≤ 2; `likePost` ≤ 4).
4. `bun run scripts/reference-app-gate.ts` after each app; `--app <dir>` while iterating.
5. Regenerate each app's `x.manifest.json` and run `x verify --only manifest,budgets --cwd <app>` before the push: the root gate misses it.

## Tests
- The statement-count fixtures in step 3, next to each repository.
- `dummy/social-media-clone/apps/web/site/feed/feed.test.ts` — a viewer with 60 hidden rows ahead of 20 visible ones gets a full page.
- `examples/dummy` e2e: a GitHub login round trip against a stub IdP.
- `packages/cli/src/schema-dump-drift.test.ts` — a dump with an extra index is red.
- Command: `bun test ./dummy/social-media-clone/apps/web/app/messages/service.test.ts`; `bun run scripts/reference-app-gate.ts`.

## Done when
- No `expectedQueryLoop` waiver in any tracked app for a shape this plan made expressible.
- Zero duplicate or prefix-redundant indexes in either schema dump.
- The demo's `pg_stat_statements` (readable after [`30`](30-infra.md) I1) shows the feed read index-served and `/messages` as a constant statement count.
- Every `expectedRed` table still empty; the app gate green on all three.

## Outcome (18, local)

Ships as 31.21.0. `As of 2026-11-13`, before release. `scripts/lib/gated-apps.ts` stays empty: every tracked app gates every step.

| ID | Outcome |
|---|---|
| A1 | done. The demo's seven duplicate indexes were dropped in sweep 0 (`dummy/social-media-clone/packages/db/migrations/20261111162033_drop_duplicate_pre_rename_indexes.sql`). The rail ships here: `undeclaredIndexFindings` (`packages/cli/src/schema-dump-drift.ts`) reads `05_indexes/` against the newest snapshot and the entities, `X_DB_INDEX_UNDECLARED`, fix `DROP INDEX CONCURRENTLY IF EXISTS "<name>";`. A warning on the `drift` step on `main`; `REFUSE_UNDECLARED_INDEX` (`drift-store.ts`) is the `next` switch. 0 warnings on all three apps |
| A2 | **skipped, framework gap.** `x db gen --drop-redundant` does not exist; the redundant foreign-key indexes stay until it does |
| A3 | done. `/messages` reads the latest message per thread with one `latestBy` (`messages/repo.ts`): 20 threads, 24 → 5 statements (`messages/service.test.ts`) |
| A4 | done, all four loops. `markRead` of 50 ids 51 → 2 (`notifications/repo.test.ts`); the orphan-media sweep one write per page and the reset one delete per table (`tasks/repo.test.ts`); the reference app's `post-excerpts` 30 → 1 write per page (`post-excerpts.test.ts`). No `expectedQueryLoop` waiver left in any tracked app |
| A5 | **skipped, framework gap.** `policy.scope` cannot follow an entity chain and has no OR scope, so the demo's feed visibility cannot be put in SQL. The over-fetch stays |
| A6 | done. `likes.postId` was already `countedIn`; `posts/repo.test.ts` now proves a like is ONE statement (`likePost` 3, inside the plan's 4) |
| A7 | **partial.** "Log in with GitHub" is served (`app/auth/sign-in-routes.ts` on `runtime.routes`), `app/auth/authenticator.ts` resolves the session cookie in every environment, and `endSession` revokes the session. The demo actor is not deleted: it answers only a cookie-less request under `x dev` and fails closed elsewhere, because every e2e suite signs in with it. **Owed:** the e2e round trip against an out-of-process stub IdP |
| A8 | **partial.** `sweep-orphan-media.job.test.ts`, `reset-demo.job.test.ts`, `live-thread.live.test.ts`; `live` and `job` join the demo's floor. The demo's unit coverage floor moves 76/75 → 75/73 (the job and thread suites left `unit`; reason dated in `x.verify.json`). **Owed:** a sync-node subscribe fixture, which needs the app's API imported without `seedDemo`'s side effect (`apps/web/api/index.ts:19`) |
| A9 | **skipped, framework gap.** No app-facing `bootWarning({ roles })`: an app cannot scope its own boot warning to the `web` role |
| A10 | done. The hand-written `onCleanup(() => handle.release())` is gone from `feed.island.tsx` and `run-console.island.tsx` |
| A11 | done. `retryMemo` moved from `@ultimat3/cli` to `@ultimat3/core`; the docs site's corpus reads through it (`shared/docs.ts`, `docs.test.ts`) |
| A12 | **partial.** `exercise.unprovenMax`: docs site 0, demo 0.1, reference app 0.046, each `statementsMax: 100`. **Framework gap:** per-route `defineExercise` entries (route params, actor), without which the reference app's API-calling loads stay unproven |
| A13 | **skipped.** The reference app already shows the factory (`app/digest/jobs/send-digest.ts`); the three hourly task + job pairs (`posts/tasks/hourly-likes.ts`, `runs/tasks/hourly-retention.ts`, `mcp/tasks/hourly-purge.ts`) were not converted |

**Framework gaps, for the ledger:** A2 `x db gen --drop-redundant`; A5 `policy.scope` on entity chains, and OR scopes; A9 an app-facing `bootWarning({ roles })`; A12 `defineExercise` per-route entries. Also owed: an out-of-process stub IdP for e2e (A7), one shared `OnTheWire<T>` type, and the reference app's `members.userId` / `x_users.id == members.id` identity model.
