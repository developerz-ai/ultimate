# 📮 Postly — the Ultimate reference app

The exact shape `x new` produces. A multi-tenant team blog: orgs, members, posts, comments,
likes, a billing plan, a nightly digest. Small enough to read in one sitting; it exercises
**all eight primitives** and every cross-cutting concern the framework claims to handle.

Ultimate's own CI runs `x verify` against this directory. If the framework regresses, this app
goes red first.

## Run it

```bash
bun install && x dev          # embedded Postgres, in-process NATS, S3 → local dir
x verify                      # the only gate: typecheck, lint, boundaries, 6 test types, budgets
x db migrate && x db seed dev # 2 orgs, 5 members across 4 timezones, 2 currencies — deterministic
```

**Seed and app share one store**, `As of 2026-08-23`. `packages/db/src/client.ts` names its driver
(`postgresDriver()`, or `memoryDriver()` under `bun test`) instead of taking `database()`'s default,
so what `x db seed dev` writes to the embedded PGlite is what the running app reads back. It did not
until then: the app took the module-private memory driver and had never read a row out of the
Postgres this line advertises (#270). Re-derive it: `x db migrate && x db seed dev` reports
`22 already stored`, and `await db.orgs.count()` against `.x/pgdata` answers **2** — it answered 0
before.

## Primitive → file

| Primitive | File | Shows |
|---|---|---|
| `entity` | [`packages/db/src/schema/plans.ts`](packages/db/src/schema/plans.ts) | `money()` column, invariant → CHECK constraint |
| `entity` | [`packages/db/src/schema/members.ts`](packages/db/src/schema/members.ts) | `tz()` + `locale()` per member, `orgId()` tenancy |
| `entity` | [`apps/web/app/posts/entity.ts`](apps/web/app/posts/entity.ts) | the feature's view schema (`PostView`) over the shared table |
| `entity` | [`packages/db/src/schema/connections.ts`](packages/db/src/schema/connections.ts) | `text().sealed()` — a credential, and the proxy exit a run leaves through, the database never holds in the clear and no serialiser carries |
| `entity` | [`packages/db/src/schema/webhook-endpoints.ts`](packages/db/src/schema/webhook-endpoints.ts) | an org's webhook receiver: the signing `secret` `.sealed()`, `disabledReason` the delivery mechanism's verdict · [`webhook-deliveries.ts`](packages/db/src/schema/webhook-deliveries.ts) is one row per attempt — Postly's own `WebhookLedger` table |
| `entity` | [`packages/db/src/schema/post-reviews.ts`](packages/db/src/schema/post-reviews.ts) | a post's one review, keyed `(orgId, postId)` so the tool that writes it is an upsert a replayed run cannot double |
| `entity` | [`packages/db/src/schema/runs.ts`](packages/db/src/schema/runs.ts) | one row per run: its job, and a `status` projected from its last phase event by the one writer of both |
| `entity` | [`packages/db/src/schema/run-events.ts`](packages/db/src/schema/run-events.ts) | one row per phase of a run; `seq` starts at 1 and the CHECK says so; `usage` is a `json()` column a schema validates |
| `policy` | [`apps/web/app/posts/policy.ts`](apps/web/app/posts/policy.ts) | `post:publish` = owns-or-org-admin, one definition, five surfaces. Both authoring forms, once each: `can()` where only an agent reads the denial, `definePolicy()` on `post:like` where a person does — same `Policy` object, and `deny:` is a message key so the refusal goes through `t()` |
| `action` | [`apps/web/app/posts/actions.ts`](apps/web/app/posts/actions.ts) | `createPost`, `publishPost`, and `summarize` — an `llm()` model call, which is an action factory rather than a ninth primitive |
| `action` | [`apps/web/app/orgs/actions.ts`](apps/web/app/orgs/actions.ts) | `inviteMember`, `upgradePlan` (minor-unit arithmetic), `grantAvatarUpload` — a presigned PUT whose key and signature are `@ultimat3/storage`'s ([`avatar.ts`](apps/web/app/orgs/avatar.ts)) |
| `action` | [`apps/web/app/settings/actions.ts`](apps/web/app/settings/actions.ts) | `savePreferences` — a one-action slice still gets an `actions.ts` |
| `action` | [`apps/web/app/runs/actions.ts`](apps/web/app/runs/actions.ts) | `startRun`, `answerPrompt`, `cancelRun` — each an MCP tool by one line, and served to machine callers under `/v1` by the bearer mount in [`api/index.ts`](apps/web/api/index.ts); `issueRunKey` mints the key |
| `policy` | [`apps/web/app/runs/policy.ts`](apps/web/app/runs/policy.ts) | rules that read `actor.orgId`, so a member, an agent and an API key pass the same predicate; `row === null` denies an answer or a cancel for a run nobody loaded |
| `mutator` | [`apps/web/app/posts/mutator.ts`](apps/web/app/posts/mutator.ts) | `likePost` — optimistic local twin, offline queue, `conflict: 'server-wins'` |
| `mutator` | [`apps/web/app/settings/mutator.ts`](apps/web/app/settings/mutator.ts) | `setTheme` (`'last-write-wins'`) and `toggleDigestOptIn` (`custom`, sticky unsubscribe) — the other two conflict strategies |
| `query` | [`apps/web/app/posts/live.ts`](apps/web/app/posts/live.ts) | `liveFeed` (`live: true`) + non-live `postBySlug` |
| `query` | [`apps/web/app/runs/live.ts`](apps/web/app/runs/live.ts) | `liveRunEvents` — a run's events in `seq` order, pushed as the job writes them |
| `job` | [`apps/web/app/orgs/jobs.ts`](apps/web/app/orgs/jobs.ts) | `onboardOrg` — durable steps + `step.sleep('3d')` |
| `job` | [`apps/web/app/posts/jobs.ts`](apps/web/app/posts/jobs.ts) | `notifySubscribers` — fanout, `concurrency: 1` (one in flight across the fleet) |
| `job` | [`apps/web/app/digest/jobs.ts`](apps/web/app/digest/jobs.ts) | `sendDigest` — 09:00 **local per member**, DST-correct, delivered one (org, zone) group at a time |
| `job` | [`apps/web/app/posts/backfills/post-excerpts.ts`](apps/web/app/posts/backfills/post-excerpts.ts) | `postExcerpts` — `backfill()` is a **job factory**, not a ninth primitive: one pass over the rows that are behind, every page in its own `step.run`, the checkpoint a cursor and never the page, the handler idempotent because `handle` is at-least-once |
| `job` | [`apps/web/app/runs/jobs.ts`](apps/web/app/runs/jobs.ts) | `syncConnection` — `scrape()` is a **job factory**: a recorded site (`fixtureBrowser`), `egress` looked up in the worker, one run per connection (`concurrency: { key, whenBusy: 'fail' }` → `X_JOB_KEY_BUSY`), a sealed stored session, a prompt a person answers mid-run over the event bus, and `onSettled` recording how each run ended and what it used |
| `action` | [`apps/web/app/posts/actions.ts`](apps/web/app/posts/actions.ts) | `summarizePosts` — `hive()`, a fan-out as one action: one `summarize` member per post, in the order asked, a foreign post failing alone · `reviewDraft` — `agent()`, a tool loop as one action, its tools the `summarize` action and `recordReview` (`idempotent: true`, an upsert) under the same actor · `reviewDraftLater` — `agentJob()`, the agent queued: `actor` re-reads the member who asked on every attempt (a served worker is nobody), and the verdict lands through `recordReview` because a queued run keeps no output · `requestPostsExport` enqueues the export below |
| `mutator` | [`apps/web/app/posts/mutator.ts`](apps/web/app/posts/mutator.ts) | `movePostStatus` — `transition()` over `posts.status`'s declared machine: one compare-and-set statement, `draft` ⇄ `scheduled`, `published` reachable only through `publishPost`; a `row:` loader so scheduling is owns-or-org-admin, as publishing is |
| `job` | [`apps/web/app/posts/jobs.ts`](apps/web/app/posts/jobs.ts) | `exportPosts` — `exportRows()`: an org's posts to CSV parts plus a manifest on the app's disk, a page at a time |
| `job` | [`apps/web/app/posts/notifiers.ts`](apps/web/app/posts/notifiers.ts) | `commentPosted` — `notifier()`: the post's author is mailed about a comment, once per comment, through the delivery ledger |
| `job` | [`apps/web/app/webhooks/jobs.ts`](apps/web/app/webhooks/jobs.ts) | `postPublishedWebhook` — `webhook()`: one signed `post.published` delivery per live endpoint of the publishing org (`ctx.webhooks.announcePublished`, from `publishPost`), the org on the input so `tenant` and both seams name it, every attempt on [`ledger.ts`](apps/web/app/webhooks/ledger.ts) over `webhook_deliveries`, and an endpoint switched off after ten failures in a row · `addWebhookEndpoint` registers one and answers its secret once |
| `job` | [`apps/web/app/mcp/jobs.ts`](apps/web/app/mcp/jobs.ts) | `purgeMcpConfirmations` — `purge()`: a month of MCP confirmations kept, the rest deleted hourly (`hourlyPurge` in `api/tasks.ts`) |
| `action` | [`packages/mcp/src/confirmations.ts`](packages/mcp/src/confirmations.ts) | `confirmAgentPublish` — `mcpConfirmations()`: an agent's `publishPost` waits for a person to view and approve that exact call |
| `task` | [`apps/web/api/tasks.ts`](apps/web/api/tasks.ts) | `nightlyDigest` cron with an explicit `tz` |
| `route` | [`apps/web/site/page.tsx`](apps/web/site/page.tsx) | `static`, `hydrate: 'never'`, 0kb JS |
| `route` | [`apps/web/site/pricing/page.tsx`](apps/web/site/pricing/page.tsx) | `isr`, money formatted at the edge |
| `route` | [`apps/web/site/blog/[slug]/page.tsx`](apps/web/site/blog/%5Bslug%5D/page.tsx) | `isr` + `prerender()` + `ld.Article` |
| `route` | [`apps/web/site/blog/page.tsx`](apps/web/site/blog/page.tsx) | `isr` list — no `feed:` key on `defineRoute`; a feed would be its own URL behind an `api/` route, not a flag on the HTML page (no feed route exists yet) |
| `route` | [`apps/web/app/posts/new/page.tsx`](apps/web/app/posts/new/page.tsx) | `ssr` + `hydrate: 'never'` — a native `<form>` posting to an action, works before hydration and with JS disabled |
| `route` | [`apps/web/app/posts/[id]/page.tsx`](apps/web/app/posts/%5Bid%5D/page.tsx) | `ssr`, fresh per request |
| `route` | [`apps/web/app/feed/page.tsx`](apps/web/app/feed/page.tsx) | `stream`, `useQuery(liveFeed)` over the page's one socket in `feed.island.tsx` + a `<Suspense>`-streamed activity badge, usable offline |
| `route` | [`apps/web/app/settings/page.tsx`](apps/web/app/settings/page.tsx) | `spa`, locale + timezone + theme pickers |
| `route` | [`apps/web/app/runs/page.tsx`](apps/web/app/runs/page.tsx) | `ssr` + the run console island: `useQuery(liveRunEvents)` in `AsyncRegion`, the prompt form, a refused run said in words, what an ended run used, every write through the typed browser client |

## Why `packages/`

Shared code lives in packages so it is reusable across `apps/web`, `apps/admin`, the `worker`
role, and a future `apps/mobile` / `apps/desktop` — **without restructuring**. The boundary is
what keeps the app scalable as it grows, and `x verify` enforces it (`X_BOUNDARY_VIOLATION`).

| Package | Owns | Never |
|---|---|---|
| [`packages/domain`](packages/domain) | types, constants, plan catalog, invariant predicates | I/O of any kind — no DB, no fetch, no `Date.now()` |
| [`packages/db`](packages/db) | `entity()` declarations, migrations, cache tags, seeds | business logic, policy decisions |
| [`packages/core`](packages/core) | business services: billing math, digest scheduling, membership | HTTP awareness, rendering, direct SQL |
| [`packages/i18n`](packages/i18n) | `en` + `es` catalogs, feature-namespaced | strings that only one surface uses |
| [`packages/ui`](packages/ui) | app components on `@ultimat3/ui`: `PostCard`, `OrgSwitcher`, `PlanBadge` | fetching, business logic, its own authz |
| [`packages/mcp`](packages/mcp) | the app's own MCP tools + prompts | a second authz system — policies are reused verbatim |

Tiers: `domain` → `db` → `core` → (`i18n`, `ui`, `mcp`) → `apps/*`. Sideways and upward imports
are build errors.

Inside `apps/web` the split is by **surface** then by **feature**:

```
apps/web/site/     static/isr, 0kb JS, SEO-critical   — cannot import app/
apps/web/app/      auth'd, stream/spa, realtime       — imports api/ types only
apps/web/api/      actions + tasks, no rendering
apps/web/shared/   tokens, policies, entity types     — leaf, importable by both
apps/web/app/<feature>/{entity,repo,service,actions,mutator,live,jobs,policy,ui}.ts
```

A primitive is registered by `defineApi()` and found by the module scan, never by its filename, so
this app's one `actions.ts` per feature and the `actions/<verb>-<name>.ts` that `x g` writes are
the same primitives in two valid module layouts — nothing enforces either ([Project
layout](../../wiki/Project-Layout.md#feature-slicing-inside-a-surface)).

## Cross-cutting checklist

| Concern | Where to look | Proof |
|---|---|---|
| **i18n** | [`packages/i18n/catalogs`](packages/i18n/catalogs) | zero hardcoded user-facing strings; `en` + `es` both complete, parity asserted in [`catalog.test.ts`](packages/i18n/src/catalog.test.ts) |
| **Dark theme** | [`apps/web/shared/global.scss`](apps/web/shared/global.scss) | every colour is `var(--color-*)`; no raw hex in any `.tsx` or `.scss`; the `:root` blocks that define those properties reach the document through [`shared/global.ts`](apps/web/shared/global.ts) |
| **Timezones** | [`packages/core/src/digest-schedule.ts`](packages/core/src/digest-schedule.ts) | member `tz` drives every `<DateTime>`; digest fires 09:00 local, DST-correct across the March/November transitions |
| **Money** | [`packages/core/src/billing.ts`](packages/core/src/billing.ts) | integer minor units, USD + EUR, arithmetic never leaves minor units, `Intl` only at the edge |
| **Offline** | [`apps/web/app/posts/mutator.ts`](apps/web/app/posts/mutator.ts) | `likePost` queues offline and reconciles; feed reads from the persisted store; [`site/offline/page.tsx`](apps/web/site/offline/page.tsx) is the required fallback |
| **Realtime** | [`apps/web/app/posts/[id]/page.tsx`](apps/web/app/posts/%5Bid%5D/page.tsx) | one record, many places — two islands read `posts:<id>` from the page's store; `useChannel(ORG_POSTS)` keeps it current, `useMutation(LIKE_POST)` writes it over HTTP |
| **Auth** | [`apps/web/app/auth/login.ts`](apps/web/app/auth/login.ts) | "log in with GitHub" is `defineAuth` + `oauthLogin`, ~12 lines; the round trip — 302 with an S256 challenge, a forged `state` refused, a session `authenticate()` resolves — is asserted in [`login.test.ts`](apps/web/app/auth/login.test.ts) against a stubbed provider, because no client id exists in CI. **Not yet reachable in a browser:** see the gotcha in [`CLAUDE.md`](CLAUDE.md) |
| **AI-first** | [`packages/mcp/src/tools.ts`](packages/mcp/src/tools.ts) | every exposed action is an MCP tool with the *same* policy; admin ships its own MCP surface |
| **Admin** | [`apps/admin/app/admin/admin.ts`](apps/admin/app/admin/admin.ts) | the whole dashboard, mounted under `/admin` by one `defineAdmin` — and the run console's operator view with no page of its own: `running` / `failed` tabs with counts, a run's events as related rows, `cancel` on a live run or a selection |
| **Prompts** | [`apps/web/app/posts/prompts`](apps/web/app/posts/prompts) | versioned `.md` artifact + typed slots + a scored eval |
| **Models** | [`apps/web/app/models.ts`](apps/web/app/models.ts) | the app registers every model it names (`registerModel`, source and date beside each number); a prompt imports the id, never spells it |

## Six test types

| Type | File |
|---|---|
| unit | [`packages/core/src/digest-schedule.test.ts`](packages/core/src/digest-schedule.test.ts), [`billing.test.ts`](packages/core/src/billing.test.ts) |
| contract | [`apps/web/app/posts/actions.contract.test.ts`](apps/web/app/posts/actions.contract.test.ts) |
| live | [`apps/web/app/posts/live.live.test.ts`](apps/web/app/posts/live.live.test.ts) |
| job | [`apps/web/app/orgs/jobs.job.test.ts`](apps/web/app/orgs/jobs.job.test.ts) |
| e2e | [`apps/web/e2e/offline-feed.e2e.test.ts`](apps/web/e2e/offline-feed.e2e.test.ts) |
| eval | [`apps/web/app/posts/prompts/summarize.eval.test.ts`](apps/web/app/posts/prompts/summarize.eval.test.ts) |

## Files you must not hand-edit

| File | Author |
|---|---|
| `x.manifest.json` | generated every build; drift fails `x verify` |
| `openapi.json` | generated from action/query declarations |
| `packages/db/migrations/*.sql` | generated by `x db gen`; edit the entity, regenerate |
