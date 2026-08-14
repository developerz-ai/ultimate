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
x db seed dev                 # 2 orgs, 5 members across 4 timezones, 2 currencies — deterministic
```

## Primitive → file

| Primitive | File | Shows |
|---|---|---|
| `entity` | [`packages/db/src/schema/plans.ts`](packages/db/src/schema/plans.ts) | `money()` column, invariant → CHECK constraint |
| `entity` | [`packages/db/src/schema/members.ts`](packages/db/src/schema/members.ts) | `tz()` + `locale()` per member, `orgId()` tenancy |
| `entity` | [`apps/web/app/posts/entity.ts`](apps/web/app/posts/entity.ts) | the feature's view schema (`PostView`) over the shared table |
| `policy` | [`apps/web/app/posts/policy.ts`](apps/web/app/posts/policy.ts) | `post:publish` = owns-or-org-admin, one definition, five surfaces |
| `action` | [`apps/web/app/posts/actions.ts`](apps/web/app/posts/actions.ts) | `createPost`, `publishPost`, and `summarize` — an `llm()` model call, which is an action factory rather than a ninth primitive |
| `action` | [`apps/web/app/orgs/actions.ts`](apps/web/app/orgs/actions.ts) | `inviteMember`, `upgradePlan` (minor-unit arithmetic), `grantAvatarUpload` — a presigned PUT `@ultimat3/storage` keys and signs ([`avatar.ts`](apps/web/app/orgs/avatar.ts)) |
| `action` | [`apps/web/app/settings/actions.ts`](apps/web/app/settings/actions.ts) | `savePreferences` — a one-action slice still gets an `actions.ts` |
| `mutator` | [`apps/web/app/posts/mutator.ts`](apps/web/app/posts/mutator.ts) | `likePost` — optimistic local twin, offline queue |
| `query` | [`apps/web/app/posts/live.ts`](apps/web/app/posts/live.ts) | `liveFeed` (`live: true`, `persist: true`) + non-live `postBySlug` |
| `job` | [`apps/web/app/orgs/jobs.ts`](apps/web/app/orgs/jobs.ts) | `onboardOrg` — durable steps + `step.sleep('3d')` |
| `job` | [`apps/web/app/posts/jobs.ts`](apps/web/app/posts/jobs.ts) | `notifySubscribers` — fanout, per-tenant concurrency |
| `job` | [`apps/web/app/digest/jobs.ts`](apps/web/app/digest/jobs.ts) | `sendDigest` — 09:00 **local per member**, DST-correct, delivered one (org, zone) group at a time |
| `task` | [`apps/web/api/tasks.ts`](apps/web/api/tasks.ts) | `nightlyDigest` cron with an explicit `tz` |
| `route` | [`apps/web/site/page.tsx`](apps/web/site/page.tsx) | `static`, `hydrate: 'never'`, 0kb JS |
| `route` | [`apps/web/site/pricing/page.tsx`](apps/web/site/pricing/page.tsx) | `isr`, money formatted at the edge |
| `route` | [`apps/web/site/blog/[slug]/page.tsx`](apps/web/site/blog/%5Bslug%5D/page.tsx) | `isr` + `prerender()` + `ld.Article` |
| `route` | [`apps/web/site/blog/page.tsx`](apps/web/site/blog/page.tsx) | `isr` list + RSS/Atom/JSON feed from one declaration |
| `route` | [`apps/web/app/posts/new/page.tsx`](apps/web/app/posts/new/page.tsx) | `stream` + `hydrate: 'never'` — a native form posting to an action |
| `route` | [`apps/web/app/posts/[id]/page.tsx`](apps/web/app/posts/%5Bid%5D/page.tsx) | `ssr`, fresh per request |
| `route` | [`apps/web/app/feed/page.tsx`](apps/web/app/feed/page.tsx) | `stream`, `useLiveFeed()`, usable offline |
| `route` | [`apps/web/app/settings/page.tsx`](apps/web/app/settings/page.tsx) | `spa`, locale + timezone + theme pickers |

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

## Cross-cutting checklist

| Concern | Where to look | Proof |
|---|---|---|
| **i18n** | [`packages/i18n/catalogs`](packages/i18n/catalogs) | zero hardcoded user-facing strings; `en` + `es` both complete, parity asserted in [`catalog.test.ts`](packages/i18n/src/catalog.test.ts) |
| **Dark theme** | [`apps/web/shared/global.scss`](apps/web/shared/global.scss) | every colour is `var(--color-*)`; no raw hex in any `.tsx` or `.scss`; the `:root` blocks that define those properties reach the document through [`shared/global.ts`](apps/web/shared/global.ts) |
| **Timezones** | [`packages/core/src/digest-schedule.ts`](packages/core/src/digest-schedule.ts) | member `tz` drives every `<DateTime>`; digest fires 09:00 local, DST-correct across the March/November transitions |
| **Money** | [`packages/core/src/billing.ts`](packages/core/src/billing.ts) | integer minor units, USD + EUR, arithmetic never leaves minor units, `Intl` only at the edge |
| **Offline** | [`apps/web/app/posts/mutator.ts`](apps/web/app/posts/mutator.ts) | `likePost` queues offline and reconciles; feed reads from the persisted store; [`site/offline/page.tsx`](apps/web/site/offline/page.tsx) is the required fallback |
| **Realtime** | [`apps/web/app/feed/page.tsx`](apps/web/app/feed/page.tsx) | tier 3 — `useLiveFeed()` (bound once with `liveHookFor`) is a Solid signal, patched per row |
| **AI-first** | [`packages/mcp/src/tools.ts`](packages/mcp/src/tools.ts) | every exposed action is an MCP tool with the *same* policy; admin ships its own MCP surface |
| **Admin** | [`apps/admin/src/index.ts`](apps/admin/src/index.ts) | the whole dashboard, 20 lines of `defineAdmin` |
| **Prompts** | [`apps/web/app/posts/prompts`](apps/web/app/posts/prompts) | versioned `.md` artifact + typed slots + a scored eval |

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
| `apps/web/public/sw.js` | generated from the route table (`X_SW_HAND_EDITED`) |
| `packages/db/migrations/*.sql` | generated by `x db gen`; edit the entity, regenerate |
