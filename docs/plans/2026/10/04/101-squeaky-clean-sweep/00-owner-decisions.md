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
| O-win | Windows host deploys | axiom 7 vs `x build --target binary --platform bun-windows-x64` | binary-as-service supported / Docker Desktop only (W8 = cross-compile for dev/CI) | supported — `--target binary` already ships for Linux | 08 W8 docs |
| O-10a | admin MCP tool names (`admin.action.<name>`) | `admin/src/mcp-tools.ts:199,234` | keep / rename | keep | 10 B14 |

## Step
Coordinator opens one GitHub issue "Owner decisions (plan 2026/10/04/101)" holding this table, links it
from #615, closes #615 (O-615). Each answer is recorded in the issue and in `status.yml` `notes`.
