# Sweep 2 — cli runtime, build, db, doctor, MCP host (files sweep 1 left unread)

> Findings for [`../overview.md`](../overview.md). Read-only hunt at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: `packages/cli/src` outside verify / merge / shard / generate-write / api-registration / naming.
> CONFIRMED = a probe or the real command ran on a scratch app. PLAUSIBLE = from reading.

## High

| # | Where | Defect | Failing input → wrong output | Verdict | Fix direction | Test |
|---|---|---|---|---|---|---|
| 1 | `packages/cli/src/runtime-services.ts:322,323,415` | the boot derives the app root as `dirname(services.stateDir)` — wrong whenever `ULTIMATE_STATE_DIR` is set | `ULTIMATE_STATE_DIR=/tmp/x` — prescribed by `docs/ops/01-kubernetes.md:212` for `readOnlyRootFilesystem`, set by `docker/deploy-proof/run.sh:67` and the e2e step → `loadRealtimeConfig`, `loadWorkerConfig`, `loadCacheTiers` look for `/tmp/app.config.ts`, find nothing, return defaults. A declared `realtime: { enabled: false, transport: 'nats' }`, `jobs: { queues: ['mail'], concurrency: 3 }`, `cache: { tiers: ['request-memo'] }` became `enabled: true, transport: 'memory'`, `queues: []`, `['request-memo','lru']` | CONFIRMED (`resolveServices` + the three loaders) | pass `services.root`, as `:368` does for `loadInboxRetention`. Root cause shared with [`sweep-1-architecture.md`](sweep-1-architecture.md) finding 2 | `packages/cli/src/runtime-services.test.ts` |
| 2 | `packages/cli/src/prerender-out.ts:10-25` | the export directory is removed recursively when it is anything but the app root or an ancestor of it (`cmd-build.ts:274` resolves `--out` against the cwd) | `x build --target static --out apps` deleted `apps/web/site/page.tsx`; `--out .x` deleted `.x/pgdata`, the embedded dev database. Only `--out <root>` is refused | CONFIRMED (`clearPrerenderOut` on a scratch tree) | refuse an `out` inside the root that is not under `.x/` or lacks a marker the build wrote | `packages/cli/src/prerender-out.test.ts` |
| 3 | `packages/cli/src/gh-target.ts:80-88` | `x pr review` without `--pr` can never succeed — it runs `gh pr view --repo <slug> --json number`, a shape `gh` refuses before any network call | `X_PR_NOT_FOUND … argument required when using the --repo flag`. The spec's "this branch's own by default" is dead; a fake runner is why the test passes | CONFIRMED (ran it; gh 2.95.0) | drop `--repo` from the no-number lookup, or pass the current branch | `packages/cli/src/gh-target.test.ts`, asserting the argv |
| 4 | `packages/cli/src/test-select.ts:42,61` | the framework repo's own ignore list is applied at any depth, in apps too; `verify-tests.ts:185` selects through the same function | `x g resource build` → 14 of 16 generated test files never discovered; `x g resource example` → the `examples/` page tests dropped. The gate is affected, not only `x test` | CONFIRMED (`discoverTests` on a scratch tree) | anchor the ignores at the root, or apply `examples/` / `dummy/` only where there is no `app.config.ts` | `packages/cli/src/test-select.test.ts` |
| 5 | `packages/cli/src/prerender.ts:179-180` | load findings are discarded — a page whose module throws at import vanishes from the export | `apps/web/site/page.tsx` throwing at module scope → `prerenderSite` exits 0 with `pages: 0`; the output holds only `404.html` and `favicon.ico`, after being emptied; `x build` reports `ok: true` | CONFIRMED | throw or report when `loadApp` / `appManifest` returns findings, as `generateAppMigration` (`db-generate.ts:94`) | `packages/cli/src/prerender.test.ts` |

## Medium

| # | Where | Defect | Failing input → wrong output | Verdict | Test |
|---|---|---|---|---|---|
| 6 | `packages/cli/src/cmd-db-backfill.ts:177,211` | `x db backfill --pending` passes vacuously when a declaring module fails to import | `ok: true`, "every one of 0 declared backfill(s) has completed" | CONFIRMED | `packages/cli/src/cmd-db-backfill.test.ts` |
| 7 | `packages/cli/src/cmd-db.ts:302-309`, `cmd-i18n.ts:203,280` | `ok: true` and exit 0 alongside failure findings | `x db seed` whose only seed file throws at import → `ok: true` with `X_CLI_UNEXPECTED`; `x i18n add es` against a hand-written index → `ok: true` with `X_CATALOG_UNREGISTERED`. Fix: `ok: findings.length === 0`, as `seedPassResult` (`cmd-db.ts:332`) | CONFIRMED | `cmd-db.test.ts`, `cmd-i18n.test.ts` |
| 8 | `packages/cli/src/runtime-queue.ts:209-225` | `releaseQueue` never resets the event bus `startJobs` installs at `:187`; `resetEventBus` (`packages/jobs/src/events.ts:167`) has zero references in `cli` | after `queue.stop()`, `step.waitForEvent` and publishes go through an executor over a closed pool (MCP host, tests, an embedding caller) | CONFIRMED (static) | `packages/cli/src/runtime-queue.test.ts` |
| 9 | `packages/cli/src/cmd-doctor.ts:304-309`, `cmd-doctor-spec.ts:7,19` | doctor probes port 3000 regardless of `PORT`; `x dev` binds `PORT` | `PORT=4000` → dev binds 4000 / 4001, doctor probes 3000 / 3001. Fix: resolve through `devPortFor` | CONFIRMED | `packages/cli/src/cmd-doctor.test.ts` |
| 10 | `packages/cli/src/affected.ts:121-143` | a changed file owned by no workspace disappears from the plan | an edit to `scripts/x.ts`, `guards/y.ts`, `tsconfig.base.json` → `workspaces: [], rootWide: []`; `x test --affected` reports nothing. This repo has 89 `scripts/*.test.ts` | CONFIRMED (`planAffected`) | `packages/cli/src/affected.test.ts` |
| 11 | `packages/cli/src/seo-routes.ts:59-70` | a served sitemap index names child files no route serves | past `SITEMAP_MAX_URLS` (50,000) the web role serves only `sitemaps[0]`; every child is 404. The static export writes all of them | PLAUSIBLE | `packages/cli/src/seo-routes.test.ts` |
| 12 | `packages/cli/src/mcp-host.ts:266-275` | MCP `test.run` ignores the exit code and bun's `N errors` line; `test-counts.ts:24-27` exists because that line is separate | `0 fail`, `1 error`, non-zero exit → `failed: 0` | PLAUSIBLE, low | `packages/cli/src/mcp-test-output.test.ts` |
| 13 | `packages/cli/src/cmd-mcp.ts:86-96` | a taken port surfaces as a raw runtime error — `X_CLI_UNEXPECTED`, fix `x doctor --json`; the host is not closed. The default 9229 is also the inspector's port | fix: the `isAddressInUse` → `X_PORT_IN_USE` pattern (`metrics-endpoint.ts:61,101-118`) | CONFIRMED | `packages/cli/src/cmd-mcp.test.ts` |

## Low

| Where | Defect | Verdict |
|---|---|---|
| `packages/cli/src/dev-lock.ts:227,382` | `DevPortInUseError` suggests `port + 1` — held by the same `x dev` for sync. Fix: `portPairAfter` (`flag-number.ts:81`) | CONFIRMED (value) |
| `packages/cli/src/jobs-drain.ts:117-122` | drain lists one default page (100 rows) per state — 350 ready jobs: moved 100, summary "100 left", 250 remained | CONFIRMED (memory driver) |
| `packages/cli/src/role-start.ts:163-165` | a bad `TRUSTED_PROXY_HOPS` throws `PortInvalidError` ("is not a TCP port number") | CONFIRMED |
| `packages/cli/src/serve-env.ts:46-63` | `ROLE=''` throws while `PORT=''`, `HOST=''` default; `PORT=0x1F90` binds 8080, `PORT=8e3` binds 8000 despite "the whole string has to be a port" | CONFIRMED |
| `packages/cli/src/cmd-shot.ts:468,477` | relative `--out` resolves against the app root; `cmd-build.ts:268-274` resolves the same flag against the cwd and calls root-relative a defect | PLAUSIBLE |
| `packages/cli/src/templates/resource-service.ts`, `generate-kinds.ts:183-190` | no refusal for names shadowing a global type the template uses — `x g resource promise` emits `import type { Promise }` beside `Promise<Promise \| undefined>` | CONFIRMED (generated text; `tsc` not run) |
| `packages/cli/src/templates/naming.ts` | non-ASCII letters dropped silently — `x g entity Über` writes `ber` | CONFIRMED |
| `packages/cli/src/cmd-build.ts:270-275` | `--tag` with `binary` / `static` and `--out` with `docker` dropped silently; only `prebuilt` refuses (`:203-211`) | PLAUSIBLE |
| `packages/cli/src/templates/scaffold-entries.ts` (emitted `prerender.ts`) | `SITE_ORIGIN` passed as `options.origin` outranks `APP_URL` — the reverse of `publicOrigin` (`site-config.ts:87`); an empty value reaches `new URL(path, '')` | PLAUSIBLE, low |

## Gaps

- `budgets` trusts `.x/build-stats.json` with no link to the tree — `BuildStats` carries no build id; numbers from an older build pass against today's source. Documented (`verify-checks.ts:229-239`).
- `x db migrate` fails on object drift (`cmd-db.ts:218-222`); `ROLE=migrate` checks table drift only — `serve.ts:43-45` says the two "must not verify different things".
- `db-branch.ts:85-97` — `feature-x` and `feature_x` map to one database; `branchNameOf` reads any name containing `_branch_` as a branch, and MCP `db.migrate` decides from that.
- `seo-routes.ts:37-44` — every `/robots.txt` hit recomputes the whole sitemap, each dynamic route's `prerender()` included, no memo.
- `shot-server.ts:46-50` — a live dev lock is reused while that `x dev` is still booting or runs without the web role.

## Not a bug (do not re-open)

- CRLF migrations — `parseMigrationSql`.
- Site → app import through a tsconfig alias — `checkImportRules` reports `X_BOUNDARY_SITE_TO_APP`.
- Supervisor double SIGINT — `drain()` is idempotent.
- `x ci` findings parser; `stream` mode with `holes: []`; the hash rail — each argued in a doc block.
- Static memo keyed on `Host` — bounded (1,024 entries, 32 MB), per origin.
- `schemaStatements` splitting on `;` — no framework DDL carries one in a body today.
- Island identity — source-addressed, sorted, verified by content hash.
- `x secrets` rotation ordering and recovery.
- Resource names `record`, `response`, `event`, `error`, `date`.

## Still not read — a third pass would start here

| Area | Files |
|---|---|
| CDP / browser | all `cdp-shot-*`, `browser-launcher*`, `shot-browser`, `shot-settle`, `shot-verdict`, `cmd-shot-island`, `cmd-shot-matrix`, `island-shot*`, `island-harness*` |
| islands / assets | `island-realtime`, `island-styles`, `island-routes`, `solid-loader`, `worker-bundle`, `style-bundle`, `style-csp`, `script-csp`, `sw-artifacts`, `sw-precache-plan`, `sw-routes`, `pwa-artifacts`, `site-assets` |
| pages | `page-navigation`, `page-speculation`, `page-sync`, `theme-boot`, `error-pages`, `document-*`, `measure-*` |
| app projections | `app-reload-graph`, `app-mcp`, `app-openapi`, `app-env`, `app-auth`, `app-permissions`, `app-evals`, `api-routes`, `policy-facts`, `job-registration` |
| gate helpers | `fix-imports`, `ts-scan`, `boundary-*`, `import-closure`, `transport-calls`, `publish-closure`, `guards`, `schema-diff`, `coverage-*` |
| commands | `cmd-tasks`, `cmd-registries`, `cmd-docs`, `cmd-deploy-helm`, `jobs-report`, `error-*`, `mcp-ui*` |
| templates | everything under `templates/` beyond five partial reads — all `guard-*`, `entity`, `action`, `query`, `job`, `route`, `policy`, `resource*`, `island*`, `backfill`, `admin*` |
