# 15 — owner decisions, doc drift

> Part of [`overview.md`](overview.md). Depends on: 01–14. Tier: cross-cutting.
> Section A blocks until the owner answers. Section B does not.

## A. Decisions — wire or delete. Do not guess.

| # | Question | Evidence | If "delete" | If "wire" | Row |
|---|---|---|---|---|---|
| 1 | `api/**/route.ts`: a route kind that can never register | `packages/render/src/registry.ts:41-44` vs `modes.ts:186-192`; REPRODUCED | drop `ROUTE_FILENAME.api`, the `api` branches (`packages/cli/src/live-routes.ts:186`, `site-seo.ts:123`), the surface choice, "Rule one" in `docs/architecture/12-generated-app.md:155-160`, the root `CLAUDE.md` Conventions line | plan 2026/09/22/102 slice 05 (`defineApiRoute`) | `s2-arch H1` |
| 2 | `x routes`: which table | `packages/http/src/router.ts:333-334` unread; 57 page routes listed, no API route; REPRODUCED | delete `RouteDescription`, `Server.describe()`; rewrite three fix lines (`packages/http/src/errors.ts:169,364`, `server.ts:42`) | `x routes` reads the composed served table | `s2-arch H2` |
| 3 | `channel()`: ninth primitive, or a `query` factory | `packages/realtime/src/channel-decl.ts:96`; no argued exception | — | a `PRIMITIVE_FACTORIES` row over `query`, or a written exception in `docs/history/primitive-factories.md`. Rename `notify`'s `channel()` either way | `s2-arch M2` |
| 4 | action → job: build the bridge or drop "job handle" from axiom 2 | `packages/jobs/src/register.ts:39-41` | delete `.job()`, `ActionJobHandle`, the axiom-2 words | `job()` accepts the structural handle; `agentJob`'s generic half deleted | `s1-arch #4` — **asked 2026-09-28, unanswered** |
| 5 | Redis / NATS job drivers | `packages/jobs/src/driver-redis.ts`, `driver-nats.ts`; BUILD recorded for Redis in plan 2026/10/01 notes, nothing for NATS | delete NATS stub + `--to nats` | build Redis | `s1-arch #6` — **asked, half answered** |
| 6 | `defaultTimeZone` / `defaultCurrency` | read by the validator and the layer merge only | delete keys, scaffold lines, app lines, pins | wire into `configureTime` — contradicts "no ambient default" | `s1-arch #7` — **asked, unanswered** |
| 7 | `recover: 'agent'` and scraping's tier | always throws; real floor is 4 | delete the variant + `FLOOR_ABOVE` row; scraping → tier 4; then `cli → scraping` is a downward edge and the four `cdp-shot-{a11y,keys,element,clock}.ts` are deleted in favour of scraping's (`s2-arch H3`) | ship the agent recovery | `s1-arch #5` — **asked, unanswered** |
| 8 | shipped guards: copies or mechanism | 3,275 lines per app; a guard fix never reaches an existing app | — | `guards/<name>.ts` re-exports a framework-owned module; `x doctor` compares versions | `s2-arch H4` |
| 9 | the deployed demo hand-writes auth | none of `auth`, `storage`, `notify`, `time`, `mail`, `seo` imported; an unbounded sign-in map; a cookie fallback | correct `dummy/social-media-clone/DOMAIN.md:29,81`, record the gap | adopt `defineAuth`; delete `shared/session.ts`, `app/auth/password.ts`, the session half of `service.ts`. Needs a handle-keyed `login()` | `s2-arch H5`, `s2-sec M6, L10` |
| 10 | generator layout vs reference layout | directory form vs flat files | delete the flat files in both apps | — | `s2-arch M1` |
| 11 | `pwa` push | six capabilities declared, one works; four exports unused | delete `push.ts`, four flags, `pwa.push` | `pwa.vapid` + a `notify` push channel | `s2-arch M5` |
| 12 | two public `Page` types | null-meaning differs | delete entity's `Page` and query's two aliases — next major | — | `s1-arch #3` |
| 13 | optional auth adapter methods | runtime `X_NOT_IMPLEMENTED` at major 23 | make them required — next major | — | `s1-arch #11` |
| 14 | the shipped Apple provider | needs a POST callback leg; unproven | remove from `oauth-builtins.ts` | build the form-post leg + a cookie that survives it | `s2-ja #9`, `s3-be` New 4 |
| 15 | publish gate inside the tagged ref | no rulesets; `npm-publish` has no reviewers | — | a tag ruleset or a required reviewer — **reverses the 2026-09-05 decision in root `CLAUDE.md`** | `s1-sec M10` |
| 16 | one AES key for every seal purpose | `packages/core/src/seal-keys.ts:50-59` | accept, document in `SECURITY.md` | a subkey per purpose + a re-seal path | `s1-sec L2` |
| 17 | org-wide login lockout | intended and pinned; ~20 known addresses lock an org | keep; document | a signal, not a refusal | `s1-sec M8` (narrowed) |
| 18 | vendor CDN purge drivers vs the thesis | `packages/cache/src/purge-cloudflare.ts`, `purge-fastly.ts` vs `docs/idea/00-thesis.md:101` | delete both, keep a generic webhook | amend the thesis | `s1-arch` low |
| 19 | reference-app workarounds the framework should absorb | `examples/dummy/apps/web/shared/ui-strings*.ts`, `wire.ts`, `queued-writes.ts` | — | island catalog subset; revive or re-type query dates; expose the outbox count | `s2-arch M7` |
| 20 | CLI verb unification (`list` / `ls`, `show` / `describe` / `explain`, `rm` / `drop`) | breaking | — | one verb each, with a major | `s2-arch L1` |
| 21 | runtime inside `cli`; a Postgres wire client inside `realtime` | ~5,100 and ~8,400 LOC | — | extraction — own plan | `s2-arch L7, L8` |

## B. Doc drift — no decision needed

| Where | Fix | Row |
|---|---|---|
| `docs/idea/14-roadmap.md:18,22,25,33,44,149`, `docs/idea/16-app-targets.md:109` | M2, M6, M9 claims; "28 packages" marked historical; the missing table reference; `ui` is tier 4 | `s1-arch` drift |
| `scripts/lib/gated-apps.ts:36-43` | comment matches `{}` | `s1-arch` drift |
| `wiki/CLI-Reference.md:1126,566-570,1347` + index | worker defaults; planned-command behaviour; four build targets; `x mcp tools` | `s2-arch` drift |
| `packages/cli/src/cmd-manifest-spec.ts`, `cmd-planned.ts:21` | usage names the `openapi` flag; fix strings equal the wiki's | `s2-arch` drift |
| `wiki/PWA-And-Offline.md:274,277` | what `push` / `shareTarget` generate — follows decision 11 | `s2-arch` drift |
| `docs/architecture/02-boundaries.md:46-47` | the three checkers ship as `raw-colour`, `untranslated-string`, `unzoned-date` | `s2-arch` drift |
| `wiki/Known-Gaps.md:38,41,42,43` | ISR row closed; tx-aware bust closed when slice 06 lands; replica identity true for live queries only; `.env.example` drift stays open (`assertEnvExample` has no caller) | `s3-prior` 09 D, `s3-be` New 2 |
| `wiki/Known-Gaps.md` — new rows | S3 `maxBytes` until slice 03 lands; a query declares no output schema; outbox depth unexposed | `s2-sec M5`, `s2-arch M7` |
| `packages/realtime/README.md:625`, `packages/seo/README.md:99`, `packages/manifest/README.md:22`, `packages/storage/CLAUDE.md:19`, `packages/ui/CLAUDE.md:34`, `packages/scraping/CLAUDE.md:23-24` | each corrected to the code | various |
| `packages/realtime/src/pgoutput.ts:1` | the minimum Postgres version the `messages` option needs | `s2-rt` low |
| `SECURITY.md` | supported-version table and known-gaps list re-dated; decisions 16, 17 recorded | — |

## Steps
1. Put section A to the owner as one list. Record each answer in `status.yml` `notes` with its date; an unanswered row stays `not_started` — it does not block section B or the other slices.
2. Each "delete" answer is one PR: code, tests, docs, the guard. Each "wire" answer larger than a day becomes its own plan under `docs/plans/`, linked from `status.yml`.
3. Section B: `docs-author` style — lead with the rule, tables, `As of 2026-10`. Verify every edited claim against the tree before writing it.
4. After decisions 4, 5, 7, 12, 13 the tier table, `scripts/lib/tiers.ts`, `llms.txt` and the manifest move together: `bun run boundaries`, `bun run manifest`, `bun run scripts/llms-txt.ts --check`.

## Tests
- Deletions: typecheck + `bun run boundaries` + the guard named in the findings row.
- Docs: `bun run verify --only roadmap,manifest`; `bun run scripts/guards-doc.ts --check`; `bun run scripts/claude-md-size.ts`; `bun run changelog-check`.

## Done when
- Every section-A row has a dated answer in `status.yml`, and each answered row is landed or linked to its own plan.
- No doc in section B contradicts the tree.
- `bun run verify` green — all 20 steps; `bun run scripts/reference-app-gate.ts` green.
