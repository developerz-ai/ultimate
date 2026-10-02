# Sweep 3 — which earlier audit rows are still open

> Findings for [`../overview.md`](../overview.md). Read at `2ea5eb17` (23.0.0), As of 2026-10. No test run.
> Subject: [`../../../09/28/101-audit-bugs-and-gaps/`](../../../../09/28/101-audit-bugs-and-gaps/overview.md)
> (written against `fcfe31dc`, 22.8.2), plus the deferred rows of
> [`../../../09/22/102-downstream-app-gaps/`](../../../../09/22/102-downstream-app-gaps/) and
> [`../../../09/23/101-framework-deep-sweep/`](../../../../09/23/101-framework-deep-sweep/).
> **Its status file is accurate: slice 04 is fixed; 01, 02, 03, 06, 07 are entirely open; 05, 08, 09 open bar the rows marked.**
> That plan stays the owner of these rows — this plan does not re-plan them, it sequences against them.

## 01 — core, money, storage · all OPEN

| Row | Now at | Evidence |
|---|---|---|
| empty `ULTIMATE_CURSOR_SECRET` accepted as key | `packages/core/src/cursor.ts:52` | `configured ?? Bun.env[...] ?? DEV_SECRET` |
| `trimZeroFraction` renders `$12.5` | `packages/money/src/format.ts:154` | no `trailingZeroDisplay` |
| prefix-key raw `ENOTDIR` / `EISDIR` | `packages/storage/src/driver-local.ts:279-294` | `X_STORAGE_KEY_CONFLICT` absent from the tree |
| non-atomic `put` | `packages/storage/src/driver-local.ts:293-294` | two in-place `Bun.write` calls |
| signed URL omits disk base | `packages/storage/src/signed-url.ts:74-83` | no base in the canonical string |

## 02 — db transaction · all OPEN

| Row | Now at | Evidence |
|---|---|---|
| `COMMIT` on an aborted tx resolves | `packages/db/src/transaction.ts:301-305` | no aborted flag, no command-tag check. Re-proven by probe in [`sweep-1-concurrency.md`](sweep-1-concurrency.md) row 1 |
| swallowed `ROLLBACK TO` | `packages/db/src/transaction.ts:253` | `.catch(() => undefined)` |
| concurrent nested savepoints not serialised | `transaction.ts` (`runNested`) | no per-root turn lock |

No commit has touched `transaction.ts` since 22.0.0. `transaction-commit.test.ts` covers `onCommit` only.

## 03 — http, entity · all OPEN

| Row | Now at | Evidence |
|---|---|---|
| anonymous CSRF exemption | `packages/http/src/csrf.ts:58` | `if (input.anonymous) return { ok: true }` |
| non-http(s) scheme passthrough in `locationFor` | `packages/http/src/navigation.ts:36`, `:102` | returns `target` verbatim |
| `max-age` not a shared-cache offer | `packages/http/src/cache-policy.ts:16` | `OFFERS_SHARED` matches `public` / `s-maxage=` only |
| `setTimeout` overflow | `packages/http/src/deadline.ts:99-102`, `config.ts:261-264` | unclamped |
| array containment null parity | `packages/entity/src/containment.ts:26-29`, `:69`, `:77` | no null guard |

## 04 — jobs · all FIXED (in `beaad04a`)

| Row | Evidence |
|---|---|
| `deadLetter: false` loops forever | `packages/jobs/src/execute.ts:322-335`; `execute-retry.test.ts:139` |
| unfenced ack / nack | `driver-pg-settle-sql.ts`; `driver-parity.test.ts` |
| scheduler double-fire | `scheduler.ts:164-172` (`schedulerState.fire`) |
| relay deadline never applied | `outbox-relay.ts:202`; `outbox-relay.test.ts:214` |

## 05 — render, mcp, mail, admin

| Row | Verdict | Now at / evidence |
|---|---|---|
| admin create / update authz never sees written values | PARTLY FIXED | the cross-org case is closed twice: `withTenant` / `withoutTenant` (`packages/admin/src/crud-input.ts:44-65`), `writeOutsideScope` (`crud.ts:229,281`; `row-scope-write.test.ts`). Residual: `AdminSubject.input` (`authz.ts:33`) never filled; create decides with no row (`crud.ts:208`), update on `before` only (`:260`) |
| MCP compiles `pattern` without flags | OPEN | `packages/mcp/src/validate-args.ts:190`; `input-schema.ts:43` |
| router loads a non-http(s) URL | OPEN | `packages/render/src/navigation-rules.ts:249-250`, `navigation.ts:260`. The click-side guard (`:118`) checks protocol; the response side does not |
| `Reply-To` emitted verbatim | OPEN | `packages/mail/src/mime.ts:84`, `driver.ts:63`. Re-proven in [`sweep-1-tier-4.md`](sweep-1-tier-4.md) row 10 |

## 06 — cli · all OPEN

| Row | Now at |
|---|---|
| handoff forwards no signals | `packages/cli/src/bin.ts:27-33` |
| e2e all-skipped stays green | `packages/testing/src/test-types.ts:144-150` |
| `x new --dir` / `--dry-run` summary | `packages/cli/src/cmd-new.ts:221,223,266`, `messages.ts:176` |
| dev-lock empty-file race | `packages/cli/src/dev-lock.ts:261-276`, `:352` |

## 07 — release, CI, guards · all OPEN

| Row | Now at |
|---|---|
| publish order alphabetical within a tier | `scripts/lib/workspaces.ts:141`, `.github/workflows/release.yml:247`. Re-proven in [`sweep-1-tier-5-scripts.md`](sweep-1-tier-5-scripts.md) row 6 |
| release gate waits only on the `verify` job | `.github/workflows/release.yml:144` |
| `tests` corpus misses `packages/*/e2e/**` | `scripts/lib/corpus.ts:24`, `scripts/skip-if-cleanup.ts:61` |
| `--workers` garbage and positionals ignored | `scripts/lib/verify-args.ts:91-93` |
| demo retags `:latest` every run | `.github/workflows/deploy-social-demo.yml:144,157` |
| tag refs, not SHAs | `.github/workflows/wiki.yml:24`, `.github/actions/setup/action.yml:101` |

## 08 — architecture dedup

| # | Row | Verdict | Now at |
|---|---|---|---|
| 1 | xxHash32 ×3 | OPEN | `packages/render/src/render-static.ts:36`, `packages/cli/src/site-assets.ts:73`, `revalidated-response.ts:28` |
| 2 | four HTML escapers | OPEN | `packages/http/src/html-render.ts:11`, `packages/mail/src/html.ts:14`, `packages/cli/src/cmd-shot-matrix.ts:97`, `packages/admin/src/dev/server.ts:88` |
| 3 | `readCookie` ×2 | OPEN | `packages/auth/src/session.ts:284`, `packages/http/src/locale.ts:44,52` |
| 4 | two public `Page` types | OPEN, changed | field names converged in 22.11.0; two types remain, null-meaning differs |
| 5 | `fnv1a` ×2, llm cache keyed on it | OPEN | `packages/ai/src/embeddings.ts:107`, `packages/flags/src/bucket.ts:17`, `packages/ai/src/llm-cache.ts:122` |
| 6 | hand-written sideways-edge prose | OPEN | `docs/architecture/02-boundaries.md:28`, `llms.txt:56`, `packages/scraping/CLAUDE.md:24-25`; truth `scripts/lib/tiers.ts:43-48` |
| 7 | step-name subsets typed `string` | OPEN | `packages/cli/src/cmd-build.ts:233`, `verify-run.ts:175` |
| 8 | stale `createOpfsLocalStore` comments, unused `NotImplementedError` | PARTLY FIXED | remaining: `packages/cli/src/templates/scaffold-repo.ts:180`, `packages/realtime/src/errors.ts:409` |

## 09 — gaps and docs

| Section | Row | Verdict | Evidence |
|---|---|---|---|
| A | MCP job tools | FIXED | `packages/admin/src/jobs/mcp.test.ts` |
| A | plain action → job | OPEN | `packages/jobs/src/register.ts:39-41`; `docs/idea/02-primitives.md:57` |
| A | Redis / NATS drivers | OPEN | `packages/jobs/src/driver-redis.ts:36-41`; `packages/cli/src/cmd-jobs.ts:65` |
| A | `defaultTimeZone` / `defaultCurrency` unread | OPEN | `packages/core/src/config.ts:185-186,228-229,271-272` |
| A | locales declared twice | OPEN, half moved | `config.ts:183-184` remain; the CLI now reads `localeConfig().fallback` (`packages/cli/src/app-load.ts:257`) |
| A | `recover: 'agent'` always throws | OPEN | `packages/scraping/src/recover.ts:40-44`; `scripts/lib/tiers.ts:82-86` |
| B | three reserved codes with no thrower | OPEN | `wiki/Error-Codes.md:1050-1052` |
| C | factories absent from tracked apps | OPEN, 8 remain | `scrape` now used (`examples/dummy/apps/web/app/runs/jobs.ts:72`) |
| C | demo app has no e2e test | OPEN | no `*.e2e.test.ts` under `dummy/social-media-clone` |
| D | generator counts; `x jobs` index `cancel`; scraping proxy | FIXED | `wiki/Known-Gaps.md:112,113`, `wiki/CLI-Reference.md:45` |
| D | `.env.example` drift "→ Closed" | row was wrong — the gap is real | `assertEnvExample` (`packages/core/src/env-example.ts:124`) has no caller; do not close it |
| D | ISR key | doc stale | code fixed (`packages/cli/src/runtime-render.ts:316`); still Open at `wiki/Known-Gaps.md:38` |
| D | tier-3 local-first shipped | HALF | still wrong at `docs/idea/21-the-range.md:124` |
| D | roadmap M6, M9 | OPEN | `docs/idea/14-roadmap.md:22,25` |
| D | MCP tool table | HALF | `verify.run` (`packages/mcp/src/dev-server.ts:324`) missing from `docs/idea/09-ai-first.md` |
| D | retired codes under a heading | OPEN | `wiki/Error-Codes.md:422,424` |
| D | tx-aware cache bust | OPEN, true | `wiki/Known-Gaps.md:41`. Same defect as [`sweep-1-concurrency.md`](sweep-1-concurrency.md) row 9 |

## Plan 2026/09/22/102 — still not landed

Only slice 05 step 1 (`bodyBytes()`) is done.

| Slice | Still absent |
|---|---|
| 01 | `serializeSetCookie`, audit types in core, `signAwsRequest`, `t.json()` |
| 02 | `addPlainMonths`, `addMonthsInZone`, `plainDateRange`; `isHoliday` still `holidays.includes` (`packages/time/src/business.ts:33`) |
| 03 | `retention` / `legalHold`, `driver-s3-put.ts` |
| 04 | `appendOnly` |
| 05 | `defineApiRoute`, `verifyHmacSignature`, `setCookie`, `clearCookie`. **The Set-Cookie merge bug is live: `packages/http/src/stages.ts:449` (`response.headers.set` in a loop)** |
| 06 | `audit` option on `query` |
| 07 | `mcp.surfaces`, `onAudit`, `McpRequestFacts`, `mcpConfirmations` |
| 08 | a second mail transport driver, `retainMime`, `DeliveryEvent` |
| 09 | a current model row, a `'never'` thinking rule, provider `models`, document / image blocks |
| 10 | `adminMcp()` still resolves `scopes: new Set()` (`packages/admin/src/mcp.ts:441`); no `readonly` admin action |
| 11 | `api/**/route.ts` exports unmounted (see [`sweep-2-architecture.md`](sweep-2-architecture.md) H1); `ai.mcp.path` still in config (`packages/core/src/config.ts:297`) |
| 12 | scaffold rows a–h: no `cli.new.renamed`; scaffold imports `../post/repo` (`scaffold-dashboard-example.ts:38`); `DEFAULT_DEV_ROLE = 'admin'` (`scaffold-auth.ts:45`); `runAsUser: 65532` (`scaffold-helm.ts:46`); no `--runner` / `--publish` |
| 13 | the planned Known-Gaps rows; a "not mounted" warning in `packages/http/README.md` |

## Plan 2026/09/23/101 — deferred rows

| Row | State |
|---|---|
| 18 l (the four majors of plan 102) | not done |
| demo realtime | done |
| measuring dynamic SSR routes | unverified |
| `scripts/` −1k LOC | missed; non-test `scripts/**/*.ts` is 26,389 lines |
| captcha secret | required outside local (`dummy/social-media-clone/production-env.ts:49-52`); sealing is a human step |

## Owner decisions that plan was waiting on

| Decision | Decided since? | Evidence |
|---|---|---|
| `defaultTimeZone` / `defaultCurrency`: delete or wire | no | keys, pins, scaffold unchanged |
| locales: `AppConfig` vs `defineCatalogs` | not recorded; the code drifts toward `defineCatalogs` | `packages/cli/src/app-load.ts:257` |
| Redis / NATS drivers: build or delete | partly — BUILD recorded for Redis; nothing for NATS | plan 2026/10/01 `status.yml` notes; nothing built |
| `actionJob()` vs correct the doc | no | — |
| `recover: 'agent'`: ship or delete | no | plan 2026/10/01 notes list it open |
| CSRF fix as a major | no | 23.0.0 shipped without the fix |
