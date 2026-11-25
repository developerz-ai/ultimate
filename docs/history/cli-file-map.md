# cli: file-map detail moved out of `packages/cli/CLAUDE.md`

`As of 2026-11-09`. The rows below are the full text of `packages/cli/CLAUDE.md` file-map cells cut
to keep that file under its 24,576 B ceiling (`bun run scripts/claude-md-size.ts`), and from
2026-11-10 under a 20 KB working target. A row marked `†` there has its full text here. Where the
two disagree, `packages/cli/CLAUDE.md` wins.

## `cmd-mcp.ts` / `mcp-host.ts` / `mcp-errors.ts` / `mcp-db-target.ts`

- `x mcp serve`: 19 tools, two transports.
- A taken port is `X_PORT_IN_USE`.
- Over HTTP a non-loopback `Host` is 421 `X_MCP_HOST_REFUSED` first; `GET`/`DELETE` are http's 405.
- `mcp-test-run.ts` folds `bun test`'s `N errors` line and exit code into `tests.run`.

## `cmd-deploy-verify.ts` / `deploy-verify-*.ts`

- `x deploy verify`: the wait (samples, window, queues), the pure verdict, flags refused before a
  sample, the `--json` shape, the real sources — lazy, so the build verdict loads neither.
- `DATABASE_URL` from the env only, never `resolveServices` (full rule: `docs/history/cli.md`).
- `deploy-verify-processes.ts` (2026-11-19): the registry's serving rows of this build grouped by
  `host` → `data.queues.containers` (`{ host, processes, slots }`): a container running N processes
  is one host with N rows.

## `runtime-cache-bus.ts` (v31, plan 101 slice 22)

Which bus carries cache and ISR invalidations between replicas — one rule, one boot line
(`cache.broadcast {bus, source}`, never the URL):

| Deployment | Bus |
|---|---|
| `NATS_URL` set, or `runtime.ts` supplies a `transport` | that transport |
| in-process bus, `REDIS_URL` (else `VALKEY_URL`) set — rung 1 | Redis pub/sub (`@ultimat3/cache`'s `redisPubSubAt`) |
| neither | in-process: this replica only |

- Why: rung 1 (roles split, Redis, no NATS) with 2+ web replicas published busts on the in-process
  bus, so a write on one replica left the others serving stale pages and `cache:` reads until TTL.
- A transport that crosses processes always wins: a second hop beside NATS would deliver each bust
  twice through two systems that fail independently.
- Loss: a dropped subscriber is resubscribed and `onReconnect` flushes the process's own tiers —
  pub/sub keeps nothing for the window it was away. `runtime-cache-redis.live.test.ts` proves both
  halves with two processes on one Redis.
- `runtime-bus.ts`'s production in-process warning drops "cache invalidations" from what stays
  local when Redis carries them, and points at the `cache.broadcast` line.

## `coverage-floor.ts` / `coverage-lcov.ts` / `coverage-source.ts` / `verify-coverage-run.ts`

- an APP's `unit` step holds `coverage` in `x.verify.json` over its whole source tree, in fixed slices, never `--parallel --coverage`; `coverage-lcov.ts` is the ONE lcov reader. Full rule: `docs/history/cli.md`

## `verify-deadline.ts` / `verify-stalled.ts` / `verify-progress.ts`

- a step past its deadline is `X_VERIFY_STEP_TIMEOUT`: its children carry `ULTIMATE_VERIFY_STEP` and are killed by that tag; the finding names the test file `bun test` had not finished. Full rule: `docs/history/cli.md`

## `runtime-render.ts` / `runtime-render-document.ts` / `runtime-isr-outcome.ts` / `route-islands.ts` / `runtime-assets.ts` / `runtime-storage.ts` / `runtime-hooks.ts` / `api-routes.ts`

- the HTTP surface: pages, `/icons` + `/media`, `/_storage`, authz, the app's API, bearer mounts and pages' bound `POST`s, mounted by BOTH boots. `isr` and `static` render as nobody. `route-islands-preload.ts`: modulepreload for each rendered eager island's imports. Full rule: `docs/history/cli.md`

## `retained-assets.ts` / `-layout.ts` / `-sweep.ts` / `-read.ts` / `-boot.ts`

- `assets.retain`: the web boot publishes this build's hashed files before `/readyz`; `withRetainedAssets` answers an assets 404 a retained manifest names. `x dev` never wraps. Full rule: `docs/history/cli.md`

## `island-bundle.ts` / `island-store.ts` / `island-sources.ts` / `island-realtime.ts` / `island-realtime-state.ts` / `island-runtime.ts` / `solid-loader.ts`

- islands: one `Bun.build` each, source-addressed; the image build writes a verified store, and an edit since the build is a rebuild, never the old chunk

## `db-schema-dump.ts` / `db-schema-refresh.ts` / `db-replay-engine.ts` / `migration-extensions.ts` / `db-object-drift.ts`

- the schema dump: replay on a scratch database (full rule: history), written by `x db gen` and `x db migrate`. `migration-extensions.ts` is also what `runtime-queue.ts` links `x dev`'s database with

## `verify-role-load.ts` / `verify-role-load-probe.ts`

- `manifest`: a child imports the app as a worker does, then the rest module by module; a registration only a document-reaching module makes is `X_ROLE_LOAD_INCOMPLETE` with the module and the import the API index lacks

## `db-rolling.ts` / `doctor-rolling.ts`

- `drift`'s fifth rail: what the previous release trips over (`X_MIGRATION_ROLLING_UNSAFE`, `@ultimat3/db`'s classifier), for migrations after `rollingSince` in `x.verify.json` (`x new` writes `"0"`). Full rule: `docs/history/cli.md`

## `framework-schema-apply.ts` / `framework-schema-stamp.ts`

- the framework tables: `ROLE=migrate`, `x dev` and every CLI command APPLY them in one transaction behind `MIGRATION_LOCK_KEY` (`pg_advisory_xact_lock`) with a bounded `lock_timeout`. Full rule: `docs/history/cli.md`

## `app-config-load.ts`

- the ONE reader of an app's `app.config.ts`: `loadAppConfig(root)` — the `config` export through core's `defineConfig`, so validated and default-merged; `undefined` with no file; no `config` object is `X_CONFIG_INVALID`. Full rule: `docs/history/cli.md`

## `serve-prebuilt.ts` / `serve-prebuilt-paths.ts`

- the image's prebuilt store (`node_modules/.cache/ultimate`, never `.x/` — state, tmpfs): every role adopts its compiled stylesheets before importing the app; a boot that built an island or ran Sass logs `X_IMAGE_NOT_PREBUILT` once

## `db-diagnostics.ts`

- `x db diagnostics`: `startDb` (never `startQueue`, which applies the framework tables), `@ultimat3/db/diagnostics`'s `dbDiagnostics`, one table per section; exit 0 whatever it says; an embedded database `x dev` holds is `X_DEV_ALREADY_RUNNING`

## Rows cut 2026-11-10 (plan 101 wave G, toward a 20 KB `CLAUDE.md`)

Each heading is the row's file cell; the text is the cell as it stood, verbatim.

## `runtime-render.ts` / `runtime-render-document.ts` / `runtime-isr-outcome.ts` / `route-islands.ts` / `runtime-assets.ts` / `runtime-storage.ts` / `runtime-hooks.ts` / `api-routes.ts`

the HTTP surface both boots mount: pages, assets, storage, authz, the API, bearer mounts. Full rule: `docs/history/cli-file-map.md`

## `async-pages.ts` / `live-routes.ts` / `budgets.ts` / `budgets-unmeasured.ts`

`budgets` riders: an async `Page` with no `load`, a live read no island imports, bytes per route; an unweighed route's finding names a refused measurement actor and `defineMeasurementActor()`

## `generated-imports.ts`

every sibling workspace a written file imports is declared in the manifest it landed under (`x g admin:page`'s `@<app>/i18n` in `apps/admin`) — `package-shape` would otherwise refuse the generator's own output (`X_WORKSPACE_DEP_UNDECLARED`)

## `app-permissions.ts` / `permission-grants.ts` / `app-permissions-borrowed.ts` / `app-permissions-site.ts`

`policy`: every permission granted or required is declared and granted (`X_PERMISSION_UNGRANTED`, `X_PERMISSION_BORROWED`). Full rule: `docs/history/cli.md`

## `boundary-findings.ts` / `app-boundaries.ts` / `boundary-cuts.ts` / `package-boundaries.ts`

`package-boundaries.ts`: `X_BOUNDARY_PACKAGE_TO_APP`, its own read of `packages/`, never `readAppSources`. surface + layer rules; a finding's `fix:` is the concrete cut

## `prerender.ts` / `measure-scope.ts` / `static-report.ts` / `static-*.ts`

the static export; a weigh-only render runs as core's `measurementActor()`, API in process (`withInProcessFetch`); SEO reads as nobody; `/_img/` + `/_og/` files; `--no-capture` the gate's

## `role-start.ts` / `role-start-types.ts` / `role-realtime.ts` / `role-start-devices.ts`

`--role` selection and start/stop for `web`, `sync`, `worker`, `scheduler`; `realtime.enabled: false` drops `sync` and `replicator`; device mounts, swapped per path on save

## `generate-shadow.ts`

a name whose type spelling a planned file also uses as a global or local type (`promise`, `row`), or whose camel VALUE a planned file both imports and declares (`x g job job`, TS2440), is `X_CLI_BAD_FLAG`, decided on the planned files

## `verify-changed.ts` / `verify-changed-facts.ts` / `verify-changed-scope.ts`

`x verify --changed`: file → rule → steps (fail-open), `drift` only when an entity's import closure or `packages/db` moved; suites narrowed to `appTestScope`'s tests (`ctx.tests`)

## `app-transport.ts` / `browser-transport.ts` / `transport-calls.ts` / `import-closure.ts` / `server-barrels.ts`

`boundaries`, built in: one browser transport. Never a `guards/` file: an app must not be able to delete it. Full rule: `docs/history/cli.md`

## `role-load.ts` / `document-graph.ts` / `serve-web.ts`

a role imports what it runs: `ROLE_LOADS`, verified against `x.manifest.json` (`X_ROLE_LOAD_INCOMPLETE` imports everything); `serve-web.ts` behind `await import()`. Full rule: `docs/history/cli.md`

## `cmd-env-init.ts` / `env-production.ts` / `cmd-deploy-preflight.ts`

`x env init --production`, the one writer of `.env.production` (values from `cmd-deploy-compose.ts`); compose's pre-flight (`X_DEPLOY_ENV_MISSING`) and a failed step's container line

## `island-bundle.ts` / `island-store.ts` / `island-sources.ts` / `island-realtime.ts` / `island-realtime-state.ts` / `island-runtime.ts` / `solid-loader.ts`

islands: one `Bun.build` each, source-addressed. Full rule: `docs/history/cli-file-map.md`

## `cmd-upgrade.ts` / `upgrade-*.ts`

`x upgrade`: one major per run; declares no `requiresApp` (`upgrade-root.ts`), and with no app runs the root's `typecheck`/`test` scripts and says so in `data.proof`; `upgrade-agents-link.ts`: `data.agentsMd`

## `runtime-jobs.ts` / `runtime-realtime.ts` / `runtime-notify-retention.ts` / `runtime-cache.ts` / `runtime-purge.ts` / `runtime-replica.ts`

`app.config.ts` sections the boot obeys (`*Of(config)` over the one loaded config), and what each wires

## `cmd-docs.ts` / `docs-sources.ts` / `docs-section.ts`

`x docs`: the app's `@ultimat3` scope plus the CLI's own (Bun's isolated layout), the wiki at `<cli>/wiki` (tarball) or `<cli>/../../wiki` (checkout); `Page#anchor` prints a whole section

## `cmd-build.ts` / `image-prepare.ts`

`x build`: static gate first; `docker` stamps `BUILD_ID`; `prebuilt` is the Dockerfile's own `RUN` — islands and stylesheets, written by the image's Bun at the image's paths, no gate and no subprocess

## `coverage-floor.ts` / `coverage-lcov.ts` / `coverage-source.ts` / `verify-coverage-run.ts`

an APP's `unit` step holds `coverage` in `x.verify.json`; `coverage-lcov.ts` is the ONE lcov reader. Full rule: `docs/history/cli-file-map.md`

## `handle-registration.ts` / `workspace-dep-edit.ts` / `templates/scaffold-db-client.ts`

a written entity joins `entities` in `packages/db/src/client.ts` (`X_DB_HANDLE_UNREGISTERED` carries the lines). Full rule: `docs/history/cli.md`

## `static-document.ts`

a served `static` page: `304` on a matching `If-None-Match`, and (container only, `memoStatic`) the document kept after its first render. Never `x dev` — a save moves the stylesheet URL the kept document names

## `cmd-dev.ts` / `dev-boot.ts` / `dev-rebuild.ts` / `dev-route-table.ts`

`x dev`: the command (re-exports `startDev`); the boot — every role in one process, `/_x`, the watcher; one save rebuilt as one generation (`dev-rebuild.ts`)

## `doctor-pooler.ts` / `runtime-statement-bound.ts`

the applied bound on demand (`data.statementBound`), a pooler's refusal as the one database finding; the one boot line, total. `startDb` hands `poolerFromEnv(env)` to both pools

## `serve.ts` / `serve-boot.ts` / `serve-entry.ts` / `serve-env.ts`

the production entry: roles from `ROLE`, bindings from env, `ROLE=migrate` = `x db migrate`; a module that fails to load stops it (`X_APP_MODULE_LOAD_FAILED`)

## `admin-registration.ts` / `templates/admin-catalog.ts` / `source-edit.ts`

`--admin` wires the override it wrote into `admin.ts` (`X_ADMIN_RESOURCE_UNWIRED`) and the labels its screen reads. Full rule: `docs/history/cli.md`

## `templates/scaffold-guards.ts`

`SHIPPED`, the one list of the twenty-one shipped guards: `x new` writes all, `x g guard <name>` one, `doctor-guards.ts` lists the missing (never a finding). Full rule: `docs/history/cli.md`

## `cmd-db.ts` / `migrations.ts` / `db-generate.ts` / `db-branch.ts` / `db-seed.ts` / `db-seed-generate.ts` / `db-backfill.ts` / `db-subscribes.ts` / `db-accept-created.ts`

one migration engine for `x db` and `ROLE=migrate`

## `budgets-freshness.ts` / `verify-budgets-build.ts`

the step builds first when stats are missing, of an old rule, or older than source: `x build --target static --no-preflight --out .x/verify-static` through `ctx.runner`

## `cmd-pr.ts` / `cmd-ci.ts` / `ci-runs.ts` / `ci-tested.ts`

GitHub through `gh`, parsed against a schema. Not gate steps. `x ci tested` is a pure predicate over three injected reads; every doubt is `tested: false`, exit 0

## `serve-retire.ts` / `dev-restart-retire.ts`

the worker retire, `stop()` claiming and aborting nothing: SIGUSR2 under `runRole`, and before a supervised `x dev` restart's drain (#677). Full rule: `docs/history/cli.md`

## `generate-catalog-locales.ts`

`--locales` never starts a catalog in an app with any: a missing non-default locale is `X_CLI_BAD_FLAG`, `fix: x i18n add <locale>`; non-default values land `⟦…⟧`-marked (`seedCatalog`)

## `cmd-stop.ts` / `cmd-stop-spec.ts`

`x stop`: the lock's pid only (its recorded start time must match), SIGTERM, then wait for pid gone and lock clear; Windows clears the lock (`drained: false`); `X_DEV_STOP_TIMEOUT`

## `dev-dashboard-guard.ts` / `loopback-host.ts`

`/_x` answers a loopback `Host` only (`X_DEV_HOST_REFUSED`, 421 — DNS rebinding); the SQL panel runs on a same-origin `POST /_x/db` only, through admin's `readOnlySql`

## `theme-brand.ts`

the ONE reader of an app's theme: `export const brand` in `apps/web/shared/theme.ts` (ui's `defineTheme`), appended to every surface stylesheet by `style-bundle.ts` (no inline `<style>`, no `style-src` hash, since 2026-11); none → sheets unchanged

## `job-budget.ts`

`X_JOB_OUTLASTS_DRAIN`, the `manifest` step: a job's `timeout` against `workerBudgetMs(drain)`, read from the registry after `loadApp`, never from `x.manifest.json`, which carries no `timeoutMs`

## `guards.ts` / `guard-sources.ts`

an app's `guards/*.ts`, discovered, run on `boundaries`, held to the error contract; every `check(root, sources)` shares ONE walk, read and Sass compile per file (`GuardSources`)

## `island-{bundle,groups,outputs,build-pool,group-cache,cache-inputs,store,sources,runtime}.ts` / `island-realtime*.ts` / `solid-loader.ts` (moved 2026-11-15)

- islands, named by their final bytes (#1075): one `Bun.build` per route group — islands on exactly the same routes split together, every other alone; groups read from `page.tsx` sources, known before rendering (`islands.sharedChunks` = one group). A group's output is reused from `.x/cache/islands/` while every file it read (Sass partials too), directory listing it resolved in and lockfile/tsconfig/`package.json` hash unchanged (`reuse: false` for a determinism test). `islands.vendorSolid` (`island-vendor.ts`, off: regressed every tracked app) builds Solid once (`vendor-solid.<hash>.js`) for every island; `island-link-check.ts` refuses a merged bundle whose import names bind nothing (#1075's smoke)

## `app-transport.ts` / `browser-transport.ts` / `transport-calls.ts` / `transport-values.ts` / `binding-names.ts` / `import-closure.ts` / `server-barrels.ts` / `browser-import-chain.ts` / `browser-barrel-cut.ts` (moved 2026-11-15)

`boundaries`, built in: one browser transport; a server barrel below an island is cut at its first hop unless the browser entry exports every name taken (`meta.chain`; `x fix boundary` lists it, rule `browser-server-barrel`); never a `guards/` file

## `verify-seeds.ts` / `verify-seeds-probe.ts` (moved 2026-11-15)

`unit` runs the seeds in a child on ONE scratch database — `x exercise`'s (`withExerciseDatabase`): framework schema + migrations, installed as `db()`, so `register()` and entity rows agree; a refused row keeps the entity's code and fix, an uncoded throw is `X_SEED_FAILED`

## `cmd-mcp.ts` / `mcp-host*.ts` / `mcp-errors.ts` / `mcp-db-target.ts` / `mcp-test-{output,run}.ts` (moved 2026-11-15)

`x mcp serve`: 23 tools, two transports, stdout only JSON-RPC under stdio (`cmd-mcp-stdio.test.ts`); `tests.run`/`verify.run` ARE `x test`/`x verify`, `ULTIMATE_ENV` unset in children (`mcp-host.parity.test.ts`)

## `app-load-prebuilt.ts` / `build-registry.ts` / `build-registry-background.ts` (moved 2026-11-15)

every serving role boots from the prebuilt registry (`node_modules/.cache/ultimate/registry`, `x build`), format 3: the whole app, and the worker/scheduler subset under a stamp; an older format or `X_PREBUILT_REGISTRY_STALE` → scan

## `workspace-external-deps.ts` · `tsconfig-aliases.ts` · `error-codes-package.ts` (moved 2026-11-15)

`package-shape`: a registry import neither the workspace nor the root declares (`X_WORKSPACE_EXTERNAL_DEP_UNDECLARED`); fix `bun add <pkg> --cwd <workspace>`. The step family's codes and titles, split out of `error-codes.ts`

## `generate-grants.ts` (moved 2026-11-15)

a written `policy.ts` grants the set the run wrote — its LAST `definePermissions([...])` (`:read` → member, else admin), never a permission already in the file; the slice path only when nothing reads; in `apps/web/shared/roles.ts`

## `dev-rebuild-remount.ts` / `dev-rebuild-schema.ts` (moved 2026-11-15)

a save that changes what `x dev` mounted or its load findings is a restart, naming what moved; entities ahead of migrations are `X_DB_DRIFT` (`x db gen "…" && x db migrate`), skipped after a failed load

## `load-findings.ts` (moved 2026-11-15)

a module-load failure is reported once, by `manifest`; while red, each step that loads the app is wrapped in `blockedByLoad`: `skipped: load failed (see manifest)`. Under `--only` without `manifest` it carries the findings itself

## `runtime-overrides.ts` / `runtime-ports.ts` / `runtime-port-bindings.ts` (moved 2026-11-15)

`runtime.ts`: a field per `ADAPTER_PORTS` row, installed by ONE loop or read where used; unbound row = build error. Plus `routes`. `docs/history/cli-adapter-ports.md`

## `shot-route.ts` / `shot-run.ts` / `shot-gpu.ts` (moved 2026-11-15)

`x shot`'s route argument (`readRoute`, `shotSlug`); one capture (`runShot`); the page's `navigator.gpu` adapter (`verdict.gpu`, never gating). `cmd-shot.ts` re-exports the first two

## `verify-contract-diff.ts` (moved 2026-11-15)

`contract-diff`: baseline `x.manifest.json` at HEAD; in CI at the merge base with `origin/$GITHUB_BASE_REF` (the ref when shallow; HEAD + notice when unfetched); outside git, the file on disk + notice

## `ci-log.ts` (moved 2026-11-15)

`x ci`'s log reader: undoes `##[…]` markers, `::error` annotations and `<comment>` fences; `fix` stays clean, provenance is `source: 'ci-log'` + `meta.job` + `output.ts`'s `[from=ci-log …]` head marker

## `error-unthrown.ts` / `unthrown-codes.ts` (moved 2026-11-15)

host check: a registered code nothing throws is listed in `UNTHROWN_CODES` (a row's wording waives nothing); a listed code thrown again is `X_ERROR_CODE_UNTHROWN_STALE`

## `fix-truth.test.ts` / `fix-truth-fixture.ts` / `db-fix-truth.job.test.ts` (moved 2026-11-15)

a printed fix, executed: each row breaks a scaffold, asserts the code, runs the line; `typeErrors()` asserts the app still typechecks

## `i18n-registration.ts` / `i18n-audit.ts` / `admin-catalog-keys.ts` (moved 2026-11-15)

`i18n`; a mounted admin's keys are `AdminApp.catalogKeys()`, asked of every app catalog — never re-derived here (`X_CATALOG_MISSING_KEYS`)

## `local-cli.ts` / `local-cli-handoff.ts` (moved 2026-11-15)

a global `x` hands over to the app's own CLI (`local-cli.ts` decides whether; `x upgrade` alone stays when the app's is strictly older — `upgrade-handover.test.ts`)

## `fix-sequence.ts` (moved 2026-11-15)

`errors`: a `fix:` that defers its edit (`# after …`/`# once …`), only says re-run, or runs `x g … --force` is `X_ERROR_FIX_INVALID`; ratcheted per file (`FIX_SEQUENCE_BASELINE`)

## `verify-strict.ts` / `verify-skip-reason.ts` / `verify-guard-baseline.ts` (moved 2026-11-15)

`strict` + `skip` (an unexcused zero-check step is `X_VERIFY_STRICT_UNRUN`; not strict, a warning); every zero-check step's reason (`data.skipReasons`); `guardBaseline` per guard (`X_GUARD_OVER_BASELINE`, `X_GUARD_BASELINE_STALE`)

## `asset-route-meta.ts` (moved 2026-11-15)

the ONE writer of an asset route's `tags: ['assets']` + `rateLimit: 'assets'`; the test walks `examples/dummy`'s built table and refuses an `assets.*` route on `default`

## `page-navigation.ts` (moved 2026-11-15)

the client router for `navigation.client` surfaces — built, routed and named ONCE for `x dev`, the container and the static export; none opted in builds nothing

## `app-load-batch.ts` / `app-load-register.ts` (moved 2026-11-15)

one hook module per app module, each registered before the next evaluates: serial order kept, top-level await isolated; registration state

## `runtime-jobs.ts` (queues) (moved 2026-11-15)

`jobs.queues` ∪ registered; `WORKER_QUEUES` = the EXACT set, each in that union or `X_WORKER_QUEUE_UNKNOWN`; `-unserved.ts`: what no live worker serves

## `runtime-isr.ts` (moved 2026-11-15)

the ISR controller both boots serve through, ATTACHED to `invalidateTags` and released on stop (`attachedIsr`); `appRoutes` without one builds and attaches its own

## `runtime-mfa-warning.ts` / `runtime-idempotency-scope.ts` (moved 2026-11-15)

boot warnings: unsealed MFA secrets (web role, `x auth seal-mfa`), a per-process idempotency store after the app loaded

## `cmd-generate.ts` / `generate-files.ts` / `generate-kinds.ts` / `generate-write.ts` (moved 2026-11-15)

argv → pure file list → writes (conflict-checked, `merge: 'json'` / `'if-absent'`, `policy.ts` appended)

## `error-contract.ts` / `ts-scan.ts` / `fix-scan.ts` / `fix-imports.ts` / `fix-command.ts` / `fix-path.ts` (moved 2026-11-15)

the `errors` step: every `fix:` names a runnable command, call or existing file; `*FIXES` tables are throw sites

## `cmd-dev.ts` / `dev-boot.ts` / `dev-rebuild.ts` / `dev-route-table.ts` (moved 2026-11-15)

`x dev`: every role in one process, `/_x`, the watcher; one save = one generation, and the boot is the first: `buildGeneration` builds the manifest and the islands at once

## `runtime-cache-bus.ts` (moved 2026-11-15)

which bus carries cache/ISR invalidations: transport if it crosses processes, else Redis pub/sub on `REDIS_URL`, else in-process; one `cache.broadcast` boot line

## `page-speculation.ts` (moved 2026-11-15)

Speculation Rules for documents WITHOUT the router (`navigation.speculation`): an allow-list of pure-read pages

## `dev-lock-live.ts` / `db-{migrate,rollback}-pass.ts` / `dev-db-*.ts` (moved 2026-11-19)

a live `x dev` on the embedded database runs `x db migrate|rollback` itself (`POST /_x/db/…`), then rebuilds; `x db reset|status|diagnostics|recount|seed`, `backfill --write`, `x jobs` writes, `x tasks run` and `x auth seal-mfa` refuse, the fix stopping it first

## `codemods/` / `cmd-upgrade-codemods.ts` / `upgrade-gate-codemods.ts` (moved 2026-11-19)

a template change an app keeps, carried by a codemod (`codemod.ts`, the ONE list `codemods/index.ts`); the hop's installed CLI applies them before its gate; `scripts/template-codemods.ts` refuses one with none

## `framework-schema-verify.ts` / `-wait.ts` / `app-migrations-verdict.ts` / `serve-boot-probe.ts` (moved 2026-11-19)

a serving role behind its schema (stamp or app ledger) WAITS, `ULTIMATE_SCHEMA_WAIT_MS`, probe port up; a newer major refuses at once

## `runtime-{jobs,realtime,notify-retention,cache,purge,replica,database-ssl}.ts` (moved 2026-11-19)

the `app.config.ts` sections the boot obeys (`*Of(config)`); `database.ssl` adds `sslmode=require` where neither the URL nor `PGSSLMODE` sets one, on every pool (`withAppTls`)

## `dev-host.ts` / `dev-tls*.ts` (moved 2026-11-19)

`x dev --host` (loopback default) and `--tls`: a cached self-signed cert in `.x/tls/`, WebCrypto + hand-written DER

## `supervise*.ts` (2026-11-19)

`ULTIMATE_PROCESSES` = `auto` | a count, production and staging containers only (`x dev` and tests run one). `supervise-count.ts`: auto is the minimum of the cgroup CPU quota (none declared → 1), the memory fit ((`memory.max` − 32 MiB) / 256 MiB), the pool, the role (scheduler/replicator/migrate 1), per-process state (`unsharedState`, the ONE decision: auto clamps, an explicit count is refused `X_PROCESSES_UNSHARED_STATE`, a child refuses an idempotency store only its boot sees), a prebuilt image, Linux; one `ultimate processes` boot line names the binding clamp. `supervise.ts`: N `Bun.spawn` children of the same argv, `ipc` json, `ULTIMATE_CHILD=i/N` + a `DATABASE_POOL_MAX` share each; signal handlers before the first spawn; backoff 1, 2, 4… ≤ 30 s, reset after 60 s up, 5 crashes in 5 min → `X_PROCESS_CRASH_LOOP`, exit 1; a child's drain bound starts at its `draining` ack, one outer ceiling, exit 0/70/1. `supervise-probe.ts`: the container's `METRICS_PORT` (`/healthz`, `/readyz`, `/metrics` merged with `child="i"`). `supervise-child.ts`: `ready`/`draining`/`gone`/`fatal`, IPC `disconnect` + an original-ppid poll. `serve-boot-probe.ts` opens nothing in a child; its scrape is loopback `:0` (`serve.ts`).
The `supervise*.ts` row's cell before 2026-11-19's cut: "`ULTIMATE_PROCESSES`: the count and its clamps, N children on one port, the container's `METRICS_PORT`, each child's IPC link".

## `runtime-jobs-share.ts` / `doctor-processes*.ts` (2026-11-19)

`runtime-jobs-share.ts`: a supervised worker child's share of the container's `jobs.concurrency` and `maxInFlight` (`childShare`; a total below N is served only by the indices below it, so `1` stays serial; a child past `maxInFlight` claims nothing). `runtime-jobs.ts` applies it only when `ULTIMATE_CHILD` is set. `doctor-processes.ts` (pure) / `doctor-processes-probe.ts` (cgroup, `tcp_migrate_req`, `max_connections`): `x doctor`'s `data.processes` — per role the count a production container would run here and its binding clamp, connections per container = max(pool, N) + N × LISTEN (worker); warnings `X_PROCESSES_CPU_UNDECLARED`, `X_PROCESSES_MIGRATE_REQ_OFF` on production/staging hosts only.

## `role-wake.ts` (moved 2026-11-19)

The worker's LISTEN session (`@ultimat3/jobs`' `startQueueWake`) — worker role only, only over a client that `canListen` — and `queue_wake_live`. One session per process, outside the pool: a container running N worker processes holds N (`x doctor`'s connections fact counts them).

## `app-load-unresolved.ts` / `app-load-import-chain.ts` / `app-dev-imports.ts` (2026-11-25)

- `app-load-unresolved.ts`: `X_APP_IMPORT_UNRESOLVED`, read by the scan, `findingFrom` and `x doctor`'s
  `snapshots` probe. In the boot graph, so it walks nothing.
- `app-load-import-chain.ts`: the same finding when the import failed inside an installed package,
  re-told at the app module that reached it. Imported only after a load failed: the serve-graph
  ceilings did not move.
- `app-dev-imports.ts`: `boundaries` warns `X_BOUNDARY_DEV_IMPORT`, the same defect before a deploy.
- `evaluated-walk.ts` is the walk both use; `dev-only-imports.ts` is the one list of specifiers and
  the one edit, so the boot and the gate cannot disagree.
- `apps/*/prerender.ts` importing the barrel is fine and stays: the scan excludes it
  (`ENTRY_POINT`), and only `x build --target static` runs it, so no role evaluates it.
