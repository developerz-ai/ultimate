# 09 — Missing surfaces + doc drift

> Part of [`overview.md`](overview.md). Depends on: owner decisions in overview *Risks*; 04 for jobs rows. Tier: 0–5 + docs.

Rule: a promise in `docs/idea/` or `wiki/` is either built or deleted in the same diff. No row stays "promised, absent".

## A. Owner-decision rows (build or delete — ask first)
| Gap | Evidence | Build path | Delete path |
|---|---|---|---|
| MCP `jobs.list`/`jobs.status`/`jobs.retry`/`tasks.list` promised, absent (dev server has `jobs.inspect`, `queue.depth`) | `docs/idea/04-jobs.md:150`, `02-primitives.md:248,304`, `wiki/Scheduled-Tasks.md:119` vs `packages/mcp/src/dev-server.ts:214-226` | tools over `listJobs`/`inspectJob`/`retry` + `tasks-facts.ts` | remove 4 doc promises |
| Plain action → job handle (axiom 2 projection) | `docs/idea/02-primitives.md:57` vs `jobs/src/register.ts:41` (`X_ACTION_JOB_UNBRIDGED`); only `agentJob()` bridges | `actionJob(handle)` factory, add to `PRIMITIVE_FACTORIES` | correct the doc; axiom 2 list in CLAUDE.md loses "job handle" |
| Redis/NATS drivers all `X_NOT_IMPLEMENTED`; `x jobs drain --to redis\|nats` can't move a job | `jobs/src/driver-redis.ts:40,66`, `driver-nats.ts:37,63`, `cli/src/cmd-jobs.ts:80-96`, `wiki/CLI-Reference.md:937`, `docs/idea/04-jobs.md:129` | implement against driver parity suite | delete factories + `drain`; move to `PLANNED_COMMANDS` |
| `AppConfig.defaultTimeZone`/`defaultCurrency` read by nothing | `core/src/config.ts:194-195`, pin `scripts/lib/config-reader-pins.ts:25-28`, `http/src/context.ts:200` reads `configureTime` instead | wire into `configureTime` at boot | delete keys from config, scaffold (`scaffold-repo.ts:198`), both apps, and pin rows |
| Locales declared twice | `core/src/config.ts:192-193` vs `i18n/src/define-catalogs.ts:56`; `cmd-shot.ts:452`, `cmd-i18n.ts:188` read config, `prerender.ts:184` reads catalogs | — | delete `AppConfig` keys; CLI reads `localeConfig()` |
| `recover: 'agent'` always throws | `scraping/src/recover.ts:27` + its `FLOOR_ABOVE` row | ship | delete option + row |

## B. Reserved error codes with no thrower (build the check)
- `X_CACHE_UNTAGGED_QUERY`, `X_SW_HAND_EDITED`, `X_SW_UNCACHEABLE` — `wiki/Error-Codes.md:1013-1015`, `docs/idea/08-pwa-offline.md:3,47`. Build-time checks; untagged-query first.

## C. Factories unexercised
- 9 of 11 `PRIMITIVE_FACTORIES` (`core/src/registrar.ts:61-71`) absent from both tracked apps: `transition`, `agent`, `agentJob`, `hive`, `exportRows`, `purge`, `webhook`, `notifier`, `scrape`. One idiomatic use each in `examples/dummy/`; add a guard test that every factory is used in dummy.
- `dummy/social-media-clone` has no `*.e2e.test.ts` — add one smoke test.

## D. Doc drift (docs-author work)
| Fix | Where |
|---|---|
| Move fixed rows to Closed (generator counts, `.env.example` drift, ISR key, two-platform deploy proof) | `wiki/Known-Gaps.md:39,41,45,65` |
| Tier-3 local-first shipped in 21.0.0 | `wiki/Known-Gaps.md:68`, `docs/idea/21-the-range.md:124` |
| M6 cell says e2e "pinned red" — table is empty | `docs/idea/14-roadmap.md:22` vs `scripts/lib/gated-apps.ts:34` |
| M9 ✅ "branch environments" — only DB half exists | `docs/idea/14-roadmap.md:25`, `docs/idea/09-ai-first.md:174-182` |
| MCP tool table: `tests.run` → `verify.run`; `budgets.report` unbuilt | `docs/idea/09-ai-first.md:16,21` |
| `x jobs` index row missing `cancel` | `wiki/CLI-Reference.md:45` |
| Retired codes under a "Retired" heading | `wiki/Error-Codes.md:273,295,409,411,526-527` |
| Verify first, then close: scraping proxy, tx-aware cache bust (`scrape-run.ts:137-144`, `action/src/invoke.ts:266`) | `wiki/Known-Gaps.md` |

## Tests
- Section A/B/C rows each ship with their own test; D: `bun run scripts/guards-doc.ts --check`, `doc-commands` guard, `bun run manifest`.

## Done when
- No doc promises a surface that `grep` can't find in code; `bun run verify` `drift`, `manifest`, `roadmap` steps green.
