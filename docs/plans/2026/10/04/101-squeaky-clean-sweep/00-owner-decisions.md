# 00 — Owner decisions

> Part of [`overview.md`](overview.md). Blocks only the rows that cite it. Everything else proceeds.
> Rows 1–21 carried from `docs/plans/2026/10/02/101-deep-dive-gaps-bugs/15-owner-decisions-docs.md` §A
> (evidence there, re-checked still present at `d7b8c7fa`). #13 is answered (required adapter methods,
> `auth/src/adapter.ts:78`). New rows from this sweep follow. As of 2026-10-04.

## Rule
An executor never guesses an owner decision. Unanswered → take the **Default** column only where one
is given; otherwise the row's work waits and the slice says so in its PR.

## Carried (plan 2026/10/02/101 §A)

| # | Question | Default if unanswered | Blocks |
|---|---|---|---|
| 1 | `api/**/route.ts` — wire or delete | none | 10 B7 |
| 2 | `x routes` table (`http/src/server.ts:143` `describe()`) | none | — |
| 3 | `channel()` — `query` factory or written exception | none | 12 |
| 4 | action → job bridge or drop "job handle" from axiom 2 (`X_ACTION_JOB_UNBRIDGED`) | none — **asked 2026-09-28** | 12 |
| 5 | Redis / NATS job drivers (all-throw stubs, `jobs/src/driver-redis.ts:40`, `driver-nats.ts:37`) | build Redis (recorded BUILD), delete NATS stub | 12 |
| 6 | `defaultTimeZone` / `defaultCurrency` (`core/src/config.ts:199-200,292`) | delete (axiom: no ambient default) | 12 |
| 7 | `recover: 'agent'` + scraping tier (`scraping/src/recover.ts:28`) | none | 12 |
| 8 | shipped guards: copies or mechanism | none | — |
| 9 | demo app hand-writes auth | none | — |
| 10 | generator layout vs reference layout | none | — |
| 11 | `pwa` push (`pwa/src/push.ts`) | none | 10e |
| 12 | two public `Page` types (`entity/src/repo.ts:75-79` vs `query/src/pagination.ts:30-50`) | delete entity's + query aliases | 12 |
| 14 | shipped Apple provider (`auth/src/oauth-builtins.ts:49`) | none | 12 |
| 15 | publish gate inside the tagged ref | keep 2026-09-05 decision | — |
| 16 | one AES key for every seal purpose | accept + document in `SECURITY.md` | — |
| 17 | org-wide login lockout | keep + document | — |
| 18 | vendor CDN purge drivers (`cache/src/purge-{cloudflare,fastly}.ts`) | none | 12 |
| 19 | reference-app workarounds (`examples/dummy/apps/web/shared/ui-strings*.ts`, `wire.ts`, `queued-writes.ts`) | none | — |
| 20 | CLI verb unification | none | 12 |
| 21 | runtime inside `cli`; Postgres wire client inside `realtime` | own plan | — |

## New (this sweep)

| # | Question | Evidence | Options | Default | Blocks |
|---|---|---|---|---|---|
| O-591 | idempotency answers at rest | `action/src/idempotency-postgres.ts:261-262` plaintext 24 h | (a) redact by key + `X_IDEMPOTENT_REPLAY_REDACTED`; (b) seal with core `seal.ts` | (a) — one redaction table | 02 D7 |
| O-492 | `x dev` error pages | `http/src/stages.ts:377-407`; wiki says both | (a) 4xx → app page, 5xx → overlay; (b) overlay always, delete `perRequest` | (a) | 05 |
| O-518 | `REPLICA IDENTITY FULL` on keyed `subscribes:` tables | `cli/src/db-subscribes.ts:80-86`, `schema-diff.ts:197` vs `wiki/Known-Gaps.md:43` | stop forcing FULL (keyed tables); migrate existing FULL → DEFAULT or leave; minor vs major | stop forcing; leave existing; **minor** | 06 |
| O-518b | `subscribes:` after #518 | since sweep 6 the field grants nothing; only its own checks read it (`cli/src/db-subscribes.ts`, `query/src/subscribes.ts`) | keep as a checked declaration / remove in 25.0.0 | keep (a refusal-backed declaration costs nothing) | 12a |
| O-506 | offline first paint | `realtime/src/boot.ts:30-48` | hold paint until booted (cap) / SW re-stamp / accept | hold paint | 09 |
| O-507 | catch-up names its writes | HTTP catch-up has no write channel | response header / snapshot field / skip | none | 09 pt 2 |
| O-491 | scaffold settings page | axiom 8 | close wontfix / switch scaffold to `ThemeToggle mode="select"` | close wontfix | 06 issue triage |
| O-355 | Bun #40579 tracking issue | upstream open; workaround is correct on its merits | close with upstream link / keep open | close | 03 |
| O-513 | CDP timeout flake tracker | instrumented (f8fa90bf, 3b76f7ba); no recurrence since 2026-09-24 | close / keep | close, reopen on a hit | 06 |
| O-615 | plan-101 tracking issue | slices 01–14 + 15B shipped in 24.0.0 | close #615 against a new "owner decisions" issue | close; new issue lists this table | — |
| O-tool | `.tool()` fate (`action/src/facade.ts:36`, `mcp-tool.ts:54` vs `mcp/src/from-action.ts:112`) | two projections disagree | return mcp's projection / delete `.tool()` | return mcp's projection | 12 |
| O-loc | locales declared twice (`core/src/config.ts:197-198,240-241` vs `defineCatalogs({ default })`) | read by `cli/src/shot-locale.ts:21`, `pwa-artifacts.ts:111` | keep `defineCatalogs`, delete config keys | delete config keys | 12 |
| O-plans | completed plan dirs in `docs/plans/` | 169 files, 1.7 MB | keep (history) / delete (git keeps them) | keep; trackers must be `complete`/`superseded` (guard 07 T10) | — |
| O-13 | reserved codes `X_SW_HAND_EDITED`, `X_SW_UNCACHEABLE`, `X_CACHE_UNTAGGED_QUERY` | `wiki/Error-Codes.md:1083-1091` | build checks / stay reserved | stay reserved | 10 B13 |
| O-win | Windows host deploys | axiom 7 vs `x build --target binary --platform bun-windows-x64` | binary-as-service supported (axiom-7 change) / Docker Desktop only (W8 = cross-compile for dev/CI) | Docker Desktop only — axiom 7 stands | 08 W8 docs |
| O-10a | admin MCP tool names (`admin.action.<name>`) | `admin/src/mcp-tools.ts:199,234` | keep / rename | keep | 10 B14 |

## Decisions (2026-10-07)

The owner delegated every open row to the coordinator; each row below is the decision, recorded
2026-10-07 against `d4842fae5` (25.1.0). Class: **a** resolved · **b** decide-only · **c** decide +
small work (done in sweep 14) · **d** large or breaking work (its own issue). #709 is the
26.0.0 breaking batch; #710 holds the decided features.

### Carried

| # | Class | Decision | Evidence / where |
|---|---|---|---|
| 1 | c + d | **Delete** the `api/**/route.ts` file kind: `api/` holds the action and query projections (`defineApi`) and nothing else; a wire format an action cannot speak goes in `runtime.routes`. Docs done in sweep 14; the type tail (`ROUTE_FILENAME.api`, the `api` branches in `cli/src/live-routes.ts`, `site-seo.ts`, `render/src/modes.ts`) built in #709 | `render/src/registry.ts:46-50`, `render/src/modes.ts:187-192` |
| 2 | c + d | **`x routes` prints the served table**: pages, mounts and the `/api/*` action and query routes, so `--surface api` means something. Done in sweep 14; `ServerHandle.describe()` (no non-test caller) deleted in #709 | `cli/src/cmd-routes.ts:4-8`, `http/src/server.ts:145,309`, `http/src/errors.ts:136` |
| 3 | c | **A written exception**, not a ninth primitive and not a `query` factory: a channel is realtime's delivery mechanism for entity change records and presence under a policy. Done in sweep 14 (`docs/history/primitive-factories.md`). notify's `channel` → `deliveryChannel` landed in 25.0.0 | `realtime/src/channel-decl.ts`, CHANGELOG 25.0.0 #32 |
| 4 | b | **Keep "job handle" in axiom 2.** The bridge exists: `agentJob(action, { tenant, retry, actor })` takes any action, and `X_ACTION_JOB_UNBRIDGED`'s fix names it. No rename | `action/src/job-handle.ts:16-31`, `jobs/src/errors.ts:247-248` |
| 5 | a + d | Stubs deleted in 25.0.0 (CHANGELOG #15). **Build the Redis job driver** (the Default) as a feature in #710 | `wiki/Known-Gaps.md` drift fixed in sweep 14 |
| 6 | a | Deleted in 25.0.0 (CHANGELOG #2); refused by name | `core/src/config-removed.ts:33-42` |
| 7 | d | **Delete `recover: 'agent'` and `AgentRecovery`; move `scraping` to tier 4** and drop its `FLOOR_ABOVE` row. A recover hook is a function; an app wraps `llm()` itself (axiom 8). Built in #709 | `scraping/src/recover.ts:28-45`, `scripts/lib/tiers.ts:82-86` |
| 8 | c | **Shipped guards stay copies the app owns** (axiom 8); `x doctor` also lists a shipped guard whose content differs from the current template, with the command that refreshes it. Done in sweep 14 | `cli/src/doctor-guards.ts:17-23` |
| 9 | c + d | **The demo adopts `@ultimat3/auth`** (needs a handle-keyed `login()`), built in #710. `DOMAIN.md` corrected in sweep 14 | `dummy/social-media-clone/apps/web/app/auth/` |
| 10 | d | **The generator's directory form is the one layout** (`<slice>/actions/<name>.ts`), both apps migrated, a guard refusing a sibling `X.ts` + `X/`. Built in #710 | `cli/src/api-registration.ts:24`, `docs/architecture/12-generated-app.md:126` |
| 11 | d | **Wire push**: a `pwa.vapid` key, a subscription action, a notify `deliveryChannel`, VAPID + RFC 8291 on WebCrypto (no dependency). Built in #710 | `pwa/src/service-worker.ts:163`, `cli/src/sw-artifacts.ts:222-228` |
| 12 | a | One `Page`, core's — 25.0.0 (CHANGELOG #7, #11) | `core/src/cursor-page.ts:18` |
| 13 | a | Adapter methods required — answered before this sweep | `auth/src/adapter.ts:75-79` |
| 14 | d | **Remove `APPLE_PROVIDER` from the built-ins**: it cannot complete a sign-in (GET-only callback, Apple POSTs). An app registers its own with `registerOAuthProvider`. Built in #709 | `auth/src/oauth-builtins.ts:42-64`, `oauth-route.ts:407,414` |
| 15 | a | Keep the 2026-09-05 decision | root `CLAUDE.md` |
| 16 | c | **Accept one master key**, documented in `SECURITY.md` in sweep 14 | `core/src/seal-keys.ts:46-59` |
| 17 | c | **Keep the org-wide lockout**, documented in `SECURITY.md` in sweep 14 | `auth/src/auth.ts:145-149` |
| 18 | c | **Keep the purge drivers; amend the thesis**: an env-selected adapter to a vendor HTTP API is not a platform primitive (same as `sesMailDriver`). Done in sweep 14 | `cache/src/purge-*.ts`, `docs/idea/00-thesis.md` |
| 19 | c + d | **The framework absorbs the workarounds.** Outbox count (replaces `shared/queued-writes.ts`) done in sweep 14; query date revival and the island catalog subset built in #710 | `examples/dummy/apps/web/shared/` |
| 20 | d | **One verb each**: `list`, `show <one>` (replaces `describe`), `explain` only for "why", `delete` (replaces `rm`). No aliases. Built in #709 | `x jobs ls`/`rm`, `x actions describe` |
| 21 | b | **No extraction now**: each has one consumer, and `Bun.sql` speaks no replication protocol. Revisit on a second consumer (axiom 9) | `realtime/src/pg-*.ts` (~10.1k LOC) |

### New

| # | Class | Decision | Evidence / where |
|---|---|---|---|
| O-591 | a | (a) redaction kept — 25.0.0 (CHANGELOG #13) | `action/src/errors-idempotency.ts:186` |
| O-492 | a | (a) 4xx → app page, 5xx → overlay — 25.0.0 | `http/src/stages.ts:376-392` |
| O-518 | a | Default taken — 25.0.0 | CHANGELOG 25.0.0 `cli` (#518) |
| O-518b | a | Keep `subscribes:` as a checked declaration (Default); 25.0.0 shipped it | `query/src/subscribes.ts` |
| O-506 | a | Hold paint (Default) — 25.0.0 | CHANGELOG 25.0.0 (#506) |
| O-507 | b | **Skip**: a channel catch-up names no writes; a pending write settles on its own HTTP answer. Reopen on an observed repro | `realtime/src/client-channels.ts` `#read` |
| O-491 | a | Closed wontfix (Default) | #491 |
| O-355 | a | Closed (Default) | #355 |
| O-513 | a | Closed, reopen on a hit (Default) | #513 |
| O-615 | a | #615 closed; #648 holds this table | #648 |
| O-tool | a | **Deleted `.tool()`** rather than the Default: `toolFrom` is the one projection — 25.0.0 (CHANGELOG #10) | `action/src/facade.ts:6-7` |
| O-loc | a | Config keys deleted (Default) — 25.0.0 | `@ultimat3/i18n/app-catalogs` |
| O-plans | a | Keep (Default); every tracker `complete`/`superseded`, held by `scripts/plan-status.ts` | `docs/plans/**/status.yml` |
| O-13 | a | Stay reserved (Default) | `wiki/Error-Codes.md` "Not thrown yet" |
| O-win | a | Docker Desktop only; axiom 7 stands (Default) | `wiki/Deployment.md` |
| O-10a | a | Keep `admin.action.<name>` (Default) | `admin/src/mcp-tools.ts:210,247` |

**#655 closed 2026-10-07** (dependabot's Postgres 18 bump): a Postgres major is a planned
migration, never a bot bump — 18 moved `PGDATA`, so an existing dev volume needs `pg_upgrade`.
Dependabot ignores Postgres majors.

## Step
Coordinator opens one GitHub issue "Owner decisions (plan 2026/10/04/101)" holding this table, links it
from #615, closes #615 (O-615). Each answer is recorded in the issue and in `status.yml` `notes`.
