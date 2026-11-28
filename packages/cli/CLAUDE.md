# @ultimat3/cli — boundary

Tier 5. May import tiers 0–4. Declared sideways edges: `cli → admin` (`x dev` mounts the `/_x`
dashboard), `cli → testing` (islands, the e2e step); `x shot` launches via `@ultimat3/scraping/cdp`. Nothing imports
this except `create-ultimate`. The reasoning behind every rule below, verbatim and dated, is
[`docs/history/cli.md`](../../docs/history/cli.md) (`‡` marks a row whose rule is there); `†` marks a
row whose full text is in [`docs/history/cli-file-map.md`](../../docs/history/cli-file-map.md).
Where they disagree this file wins.

Commands: `bun test ./packages/cli/` (repo root: the preload),
`bunx tsc --noEmit -p packages/cli/tsconfig.json`.

## Rules

| Rule | Detail |
|---|---|
| Entry | `src/bin.ts` — argv, stdout, exit code only ‡ |
| Registry | `registry.ts`: every declaration static (`cmd-<name>-spec.ts`), every body `await import()`ed when that command runs ‡ |
| Startup cost | `sass` loads on the first stylesheet compile (`@ultimat3/render`'s `compileStylesheet`), Babel on the first island transform (`solid-loader.ts`); pinned by `*-lazy.test.ts` in a child |
| Module names | `role-*` / `runtime-*` are booted by `serve.ts` in production; `dev-*` is `x dev`'s alone. Derived by `module-naming.test.ts` from imports, never listed |
| stdout / stderr | `write-line.ts`'s `writeLine` / `writeErrorLine`, never `process.stdout.write`; `stream: 'stderr'` → fd 2 ‡ |
| `--json` | every command; `dispatch.ts` sets core's log stream to stderr under it. Same data as the human render |
| I/O | only `dispatch.ts` renders or exits; commands return `CommandResult`. `ok()` / `failed()` write `ok` after the `extra` spread, so the verdict stands |
| Staying up | a command still listening when `run` resolves returns `hold` (`hold.ts`); its release runs inside the drain's deadline |
| Test execution | `test-shards.ts`'s `testArgs` — one `bun test --parallel=N` per pass (`test-passes.ts`); `live`/`e2e` run serially (`SERIAL_TYPES`, `test-workers.ts`); a file's type and each step's argv: `verify-test-command.ts`; failing files, all-skipped: `test-verdict.ts` |
| Numeric flags | `flag-number.ts` — one reader for `--port` / `--workers` / `--shard` |
| Shell quoting | `shell-quote.ts`'s `quoteArg` for every value pasted into a `fix:` or a reproduce line |
| Missing input | `MissingPositionalError`; a bare subcommand needs a declared `defaultSubcommand` (`MissingSubcommandError`) ‡ |
| Closed flag values | read through a function that refuses the rest (`readTarget`, `readMethod`, `readSurfaceFilter`, `isTransport`), from the framework's own set where one exists |
| Passthrough | declared per command (`CommandSpec.passthrough`); every other command refuses a `--` tail with `X_CLI_BAD_FLAG` |
| App root | `CommandSpec.requiresApp`, enforced by `dispatch.ts` before `run` |
| Declared flags | every flag a command declares is read in this package's source — `flag-reads.test.ts` (`X_CLI_FLAG_UNREAD`) |
| Planned commands | none: `PLANNED_COMMANDS` / `PLANNED_SUBCOMMANDS` (`cmd-planned.ts`) stay empty. A command ships, else the parser refuses it `X_CLI_UNKNOWN_COMMAND` with its decision in `wiki/Known-Gaps.md` |
| Errors | codes + titles in `error-codes.ts`, a runnable line per code in `mcp-errors.ts` (typed over `CliErrorCode`); a family at the ceiling moves to `error-codes-<family>.ts` / `mcp-errors-<family>.ts` (`-verify`: the gate's floor, run and split); classes in `errors.ts`, else beside their one thrower. Never a bare `Error` |
| Subprocesses | only through `exec.ts`'s injectable `Runner`; `gh` through `ctx.runner` with a required `fix` |
| Templates | `templates/*.ts` return strings, pre-formatted for Biome (`wrap.ts`'s `wrapList` / `wrapImport` / `sortSpecifiers`); no fixture files on disk |
| Strings | rendered output through `messages.ts` (missing key renders `⟦key⟧`) ‡ |
| Facts | load the app (`app-load.ts`), then project a framework package's registry — never parse source for primitives, never re-derive a fact another package owns |
| Public API | `src/index.ts`, explicit re-exports only ‡ |

## File map

### Gate steps (`x verify`)

| File | Job |
|---|---|
| `verify-checks.ts` / `verify-step.ts` / `verify-run.ts` / `verify-e2e-lane.ts` | steps, outcome, order (`BESIDE_SERIAL_SUITES`, e2e lane) |
| `verify-changed*.ts` | `x verify --changed`: file → rule → steps, fail-open; `drift` only when reached † |
| `verify-drift-owner.ts` | `drift`: an `app.config.ts` under `apps/`/`packages/` is `X_APP_ROOT_NESTED`: one app (image, migration owner) per repo |
| `verify-exercise.ts` / `cmd-exercise.ts` / `exercise-*.ts` | `exercise`: `x exercise --json` as a child, red on its findings |
| `verify-floor.ts` | `x.verify.json`: a floor step that ran zero tests is `X_VERIFY_SUITE_VANISHED` |
| `verify-strict.ts` / `verify-skip-reason.ts` / `verify-guard-baseline.ts` / `verify-merge-skips.ts` | `strict` + `skip` (`X_VERIFY_STRICT_UNRUN`), each zero-check step's reason, per-guard `guardBaseline` † |
| `verify-live.ts` / `verify-services.ts` | `live`: nothing answering → the gate starts `docker/docker-compose.test.yml`; can't → `X_TEST_SERVICES_UNAVAILABLE`, red if floored and none ran, else a warning |
| `verify-e2e.ts` / `doctor-browser.ts` | `e2e` floored with no Chrome is `X_VERIFY_E2E_BROWSER_MISSING`; `x doctor` reports the browser |
| `coverage-remap.ts` / `coverage-island.ts` / `island-bundle-options.ts` | a coverage build credits island chunk lines to their sources via the chunk's source map |
| `coverage-{floor,lcov,source,island,remap}.ts` / `verify-coverage-run.ts` | an app's `unit` coverage floor; `coverage-lcov.ts` is the ONE lcov reader † |
| `verify-deadline.ts` / `verify-stalled.ts` / `verify-progress.ts` | a step past its deadline is `X_VERIFY_STEP_TIMEOUT`; its children are killed by tag † |
| `load-findings.ts` | a module-load failure is reported once, by `manifest`; each step that loads the app stands down (`blockedByLoad`) † |
| `verify-contract-diff.ts` | `contract-diff`: baseline `x.manifest.json` at HEAD, in CI at the merge base † |
| `verify-factories.ts` | `unit` lints `<app>/packages/db/factories.ts` (`X_TEST_FACTORY_INVALID`) |
| `verify-seeds.ts` / `verify-seeds-probe.ts` | `unit` runs the seeds in a child on `x exercise`'s scratch database; an uncoded throw is `X_SEED_FAILED` † |
| `boundary-findings.ts` / `app-boundaries.ts` / `boundary-cuts.ts` / `package-boundaries.ts` | surface + layer rules, `X_BOUNDARY_PACKAGE_TO_APP`; a `fix:` is the concrete cut † |
| `app-boundaries.ts` (workspaces) | `@<scope>/<app>/<rest>` resolves onto `apps/<app>/<rest>` when that is an app source, so the surface rules hold across app workspaces |
| `app-transport.ts` / `browser-{transport,import-chain,barrel-cut}.ts` / `transport-*.ts` / `binding-names.ts` / `import-closure.ts` / `server-barrels.ts` | `boundaries`: one browser transport; a server barrel below an island is cut at its first hop † |
| `guards.ts` / `guard-sources.ts` | an app's `guards/*.ts`, run on `boundaries`; ONE shared walk (`GuardSources`) † |
| `guards-built-in.ts` / `guards-built-in-refusal.ts` | shipped guards run from the installed CLI, never a copy; `guards/shipped.json` is the opt-in and the severities; `x g guard <shipped>` is `X_GUARD_BUILT_IN` |
| `templates/scaffold-guards.ts` | `SHIPPED`, the one list of shipped guards (`guards-built-in.ts`, `doctor-guards.ts`, `codemods/vendored-guards.ts`) † |
| `error-contract.ts` / `ts-scan.ts` / `fix-scan.ts` / `fix-imports.ts` / `fix-command.ts` / `fix-path.ts` | the `errors` step: every `fix:` names a runnable command, call or existing file † |
| `fix-sequence.ts` | `errors`: a deferring, re-run-only or `--force` fix is `X_ERROR_FIX_INVALID`, ratcheted per file † |
| `workspace-checks.ts` / `test-only-shipped.ts` / `workspace-graph.ts` / `tsconfig-references.ts` / `publish-closure.ts` | `package-shape`, `filesize` ‡ |
| `workspace-external-deps.ts` · `tsconfig-aliases.ts` · `error-codes-package.ts` | `package-shape`: an undeclared registry import is `X_WORKSPACE_EXTERNAL_DEP_UNDECLARED`; the step family's codes † |
| `app-permissions*.ts` / `permission-grants.ts` | `policy`: `X_PERMISSION_UNGRANTED`, `X_PERMISSION_BORROWED` † |
| `job-registration.ts` | `manifest`: no job or task under a positional `anonymous-*` name (`X_JOB_UNREGISTERED`) |
| `unscanned-admin.ts` | `manifest`: a `defineAdmin()` outside the app scan (`apps/*/src/`) is `X_ADMIN_UNSCANNED` |
| `tool-gate-names.ts` · `verify-mcp-mount.ts` | `manifest`: a gate on no tool · `expose` and no `POST /mcp` |
| `verify-role-load.ts` / `verify-role-load-probe.ts` | `manifest`: what a worker never registers (`X_ROLE_LOAD_INCOMPLETE`) † |
| `async-pages.ts` / `live-routes.ts` / `budgets.ts` / `budgets-unmeasured.ts` | `budgets` riders: async `Page` with no `load`, unimported live read, bytes per route, unweighed routes † |
| `budgets-freshness.ts` / `verify-budgets-build.ts` | stale or missing stats: the step builds first (`x build --target static`) † |
| `app-agents-md.ts` / `app-env.ts` / `app-openapi.ts` / `app-manifest.ts` | `manifest` and `contract-diff` ‡ |
| `schema-drift.ts` / `drift.ts` / `drift-replica-identity.ts` / `db-destructive.ts` / `db-ungeneratable.ts` | `drift`: snapshot vs declarations, the source hash, the header markers ‡ |
| `db-rolling.ts` / `doctor-rolling.ts` | `drift`'s rolling rail (`X_MIGRATION_ROLLING_UNSAFE`) † |
| `redundant-indexes.ts` / `doctor-redundant-indexes.ts` | covered indexes: `gen --drop-redundant` drops, `drift` excuses, `x doctor` lists |
| `schema-dump-drift.ts` | also the dump-vs-newest-snapshot rail, no database (`X_DB_DRIFT`) ‡ |
| `i18n-registration.ts` / `i18n-audit.ts` / `admin-catalog-keys.ts` | `i18n`; a mounted admin's keys come from `AdminApp.catalogKeys()` (`X_CATALOG_MISSING_KEYS`) † |
| `error-unthrown.ts` / `unthrown-codes.ts` | host check: a registered code nothing throws is listed in `UNTHROWN_CODES`; stale is `X_ERROR_CODE_UNTHROWN_STALE` † |
| `lint-findings.ts` | `lint`: `biome check --reporter=json` as one finding per diagnostic |
| `i18n-app-key-shapes.ts` | every shape whose literal is a catalog key; `i18n-app-key-shapes.test.ts` reads `blocks`, so a new block reds until listed |
| `job-budget.ts` | `X_JOB_OUTLASTS_DRAIN` (`manifest`): `timeout` vs `workerBudgetMs(drain)`, from the registry † |
| `output-findings.ts` | render layer only: `runnableFix` (`bunx x`, decided by `dispatch.ts`'s `readerFor`) and `collapseFindings`. Throw sites keep `x …` |
| `app-load-{unresolved,import-chain}.ts` / `app-dev-imports.ts` | `X_APP_IMPORT_UNRESOLVED`; `X_BOUNDARY_DEV_IMPORT` † |
| `fix-truth*.ts` / `db-fix-truth.job.test.ts` | a printed fix, executed against a broken scaffold † |

### Generators (`x g`, `x new`)

| File | Job |
|---|---|
| `cmd-generate.ts` / `generate-files.ts` / `generate-kinds.ts` / `generate-write.ts` | argv → pure file list → conflict-checked writes † |
| `templates/workspace.ts` | `x g app` / `x g package`: a workspace the root globs and the one tsconfig alias (`@<app>/*` → `packages/*/src`, then `apps/*`) already reach |
| `write-generated.ts` | `x new`'s writer: a `link` file is a relative symlink, a copy only on a refusing win32 |
| `generate-feature.ts` | a `--feature` naming no slice is `X_FEATURE_UNKNOWN`; nothing invents an entity |
| `generate-shadow.ts` | a name that shadows a type or value in a planned file is `X_CLI_BAD_FLAG` † |
| `generate-plural.ts` | a planned `entity.ts` in an already-plural slice (`posts` → `postses`) is `X_CLI_BAD_FLAG`; the fix names the singular |
| `generate-catalog-locales.ts` | `--locales` never starts a catalog; missing locale is `X_CLI_BAD_FLAG` † |
| `app-name.ts` | `x new`'s slug is asked of core's `defineConfig`, never a copied pattern; refused with a suggested name (`9lives` → `app-9lives`, `a` → `a-app`, cut at 64) |
| `generate-grants.ts` | a written `policy.ts` grants the set the run wrote, never one already in the file ‡ † |
| `policy-append.ts` | a second `x g policy` appends its set; the same set again is the conflict, fix another set |
| `scaffold-growth.contract.test.ts` | an entity gaining a defaulted and a nullable column breaks no generated insert (`Insertable`) |
| `api-registration.ts` | a written job or task is listed in `apps/web/api/index.ts` |
| `generate-exercise.ts` | a contract test's entry in `apps/web/exercise.ts` (`exercise-entry-edit.ts`) |
| `handle-registration.ts` / `workspace-dep-edit.ts` / `templates/scaffold-db-client.ts` | a written entity joins `entities` (`X_DB_HANDLE_UNREGISTERED`) † |
| `generated-imports.ts` | a written file's sibling-workspace imports are declared where it landed (`X_WORKSPACE_DEP_UNDECLARED`) † |
| `admin-registration.ts` / `templates/admin-catalog.ts` / `source-edit.ts` | `--admin` wires its override (`X_ADMIN_RESOURCE_UNWIRED`) † |
| `app-artifacts.ts` | `x.manifest.json` + `openapi.json`, written together (`x g`, `x manifest`) |
| `templates/` | every emitted file; `scaffold-*.ts` for `x new`, one per generator otherwise. See history |
| `generate-feature-required.ts` | `x g query`/`backfill` with no slice holding an `entity.ts` is `X_FEATURE_REQUIRED` |
| `generate-sign-in*.ts` | `x g sign-in`: one flag, no name; OIDC swaps only `x new`'s bytes and ships the `mfaPath` leg |
| `generate-invite*.ts`, `templates/invite*.ts` | `x g invite`: no name; three actions + two pages over `defineMemberInvite` |
| `generate-format-written.ts` | the app's Biome over the TypeScript a run created, best effort; `lint` judges |
| `templates/scaffold-mcp-{json,endpoint,admin}.ts` | `.mcp.json` (`bunx @ultimat3/cli mcp serve`, never `bunx x`) and the refusing MCP endpoints ‡ |
| `templates/scaffold-suites.ts` | the `live` + `e2e` suites every scaffold ships: both steps run from the first commit |

### Boot (`x dev`, the container)

| File | Job |
|---|---|
| `serve.ts` / `serve-boot.ts` / `serve-entry.ts` / `serve-env.ts` | the production entry: `ROLE` (outside `config.roles`: `X_CONFIG_INVALID`; `migrate` exempt), env bindings, `ROLE=migrate`; `X_APP_MODULE_LOAD_FAILED` † |
| `app-load-batch.ts` / `app-load-register.ts` | one hook module per app module, registered in order; registration state † |
| `app-load-prebuilt.ts` / `build-registry.ts` / `build-registry-background.ts` | every serving role boots from the prebuilt registry (`x build`); stale → scan † |
| `generate-refresh.ts` | `x g` refreshes the manifest only when a written file needs it |
| `role-load.ts` / `document-graph.ts` / `serve-web.ts` | a role imports what it runs: `ROLE_LOADS` (`X_ROLE_LOAD_INCOMPLETE`) † |
| `module-imports.ts` | a module's imports, resolved once for both graphs: `referenced` (reload), `evaluated` (document) |
| `dev-rebuild-remount.ts` / `dev-rebuild-schema.ts` | a save that changes what `x dev` mounted is a restart; entities ahead of migrations are `X_DB_DRIFT`, the ledger behind them `X_APP_MIGRATIONS_UNAPPLIED` † |
| `dev-log.ts` | every logger line to `<stateDir>/dev.log` (`logs.tail`); `dev.log.1` at 16 MiB |
| `cmd-dev.ts` / `dev-boot.ts` / `dev-rebuild.ts` / `dev-route-table.ts` | `x dev`: every role in one process, `/_x`, the watcher; one save = one generation † |
| `runtime-bindings.ts` | which service each binding points at (embedded or external); events follow `NATS_URL` |
| `runtime-queue.ts` / `runtime-services.ts` / `runtime-bus.ts` | db + queue; every other accessor; the bus |
| `framework-schema-apply.ts` / `framework-schema-stamp.ts` | the framework tables, applied in one locked transaction † |
| `framework-schema-verify.ts` / `-wait.ts` / `app-migrations-verdict.ts` / `serve-boot-probe.ts` | a serving role behind its schema WAITS (`ULTIMATE_SCHEMA_WAIT_MS`); a newer major refuses at once † |
| `runtime-isr.ts` | the ISR controller both boots serve through, attached to `invalidateTags` (`attachedIsr`) † |
| `runtime-mfa-warning.ts` / `runtime-idempotency-scope.ts` | boot warnings: unsealed MFA secrets, a per-process idempotency store † |
| `app-config-load.ts` | the ONE reader of `app.config.ts` (`loadAppConfig`) † |
| `theme-brand.ts` | the ONE reader of an app's theme (`brand` in `apps/web/shared/theme.ts`) † |
| `runtime-{jobs,realtime,notify-retention,cache,purge,replica,database-ssl}.ts` | the `app.config.ts` sections the boot obeys (`*Of(config)`) † |
| `runtime-cache-bus.ts` | which bus carries cache/ISR invalidations across replicas; one `cache.broadcast` boot line † |
| `runtime-cache-frame.ts` | the bust frame on `x.cache.invalidate`: tags + optional `{scopes}`; older receivers keep the strings |
| `runtime-jobs.ts` (queues) | `WORKER_QUEUES` = the EXACT set, else `X_WORKER_QUEUE_UNKNOWN`; `-unserved.ts`: what no worker serves † |
| `supervise*.ts` | `ULTIMATE_PROCESSES`: count and clamps, N children on one port, `METRICS_PORT`, IPC † |
| `runtime-jobs-share.ts` / `doctor-processes*.ts` | a worker child's slot share; `x doctor`'s processes fact † |
| `serve-retire.ts` / `dev-restart-retire.ts` | the worker retire (SIGUSR2, before an `x dev` restart's drain) † |
| `role-start*.ts` / `role-select.ts` / `role-realtime.ts` | `--role` selection (`x dev` runs only `config.roles`: `rolesDeclaredForDev`), start/stop per role, device mounts † |
| `role-wake.ts` | the worker's LISTEN session (one per process) and `queue_wake_live` † |
| `role-sync.ts` / `role-replicator.ts` / `runtime-live-feed.ts` | the sync node, the change feed |
| `runtime-render*.ts` / `runtime-{isr-outcome,assets,storage,hooks}.ts` / `route-islands.ts` / `api-routes.ts` | the HTTP surface both boots mount † |
| `asset-route-meta.ts` | the ONE writer of an asset route's `tags: ['assets']` + `rateLimit: 'assets'` † |
| `client-{errors,vitals}-*.ts` | `clientErrors` (and `.vitals`): the script on `app/` (vitals: listed) documents, its `POST` route, mounted by BOTH boots ‡ |
| `retained-assets.ts` / `-layout.ts` / `-sweep.ts` / `-read.ts` / `-boot.ts` / `-warned.ts` | `assets.retain`: the web boot publishes this build's hashed files before `/readyz` † |
| `runtime-overrides.ts` / `runtime-ports.ts` / `runtime-port-bindings.ts` | `runtime.ts`: a field per `ADAPTER_PORTS` row; unbound row = build error † |
| `plain-routes.ts` | the plain routes both boots mount and `x routes` lists: `runtime.routes`, then every declared `webhookReceiver()`'s, each once |
| `app-openapi.ts` | `openapi.json` (complete when `defineApi({ openapi })` is declared) and each bearer mount's own document; staleness for all of them |
| `script-csp.ts` / `style-csp.ts` / `style-bundle.ts` / `page-sync.ts` / `worker-bundle.ts` | CSP hashes, the CSS file, the page's sync target and worker |
| `page-navigation.ts` | the client router for `navigation.client` surfaces, built once for every target † |
| `page-speculation.ts` | Speculation Rules for documents without the router (`navigation.speculation`) ‡ † |
| `static-document.ts` | a served `static` page: `304` on `If-None-Match`; container keeps the document (never `x dev`) † |
| `island-{bundle,groups,outputs,build-pool,group-cache,cache-inputs,store,sources,runtime}.ts` / `island-realtime*.ts` / `solid-loader.ts` | islands, named by their final bytes: one `Bun.build` per route group, cached in `.x/cache/islands/` † |
| `local-cli.ts` / `local-cli-handoff.ts` | a global `x` hands over to the app's own CLI † |
| `serve-prebuilt.ts` / `serve-prebuilt-paths.ts` | the image's prebuilt store; a boot that built anything logs `X_IMAGE_NOT_PREBUILT` † |
| `dev-*.ts` | `x dev` only: dashboard sources, traces, the N+1 ledger, watcher, reload, lock, port |
| `cmd-stop.ts` / `cmd-stop-spec.ts` | `x stop`: the lock's pid only, SIGTERM, wait; a reused pid's lock is cleared, unsignalled; `X_DEV_STOP_TIMEOUT` † |
| `dev-lock-live.ts` / `db-{migrate,rollback}-pass.ts` / `dev-db-*.ts` | beside a live `x dev` on the embedded database, `x db migrate\|rollback` run in it (`POST /_x/db/…`); other writes refuse † |
| `dev-dashboard-guard.ts` / `loopback-host.ts` | `/_x`: loopback `Host` (`X_DEV_HOST_REFUSED`) and peer (`X_DEV_PEER_REFUSED`) † |
| `dev-host.ts` / `dev-tls*.ts` | `x dev --host`, `--tls` † |
| `doctor-pooler.ts` / `runtime-statement-bound.ts` | the statement bound and a pooler's refusal, one finding, one boot line † |

### Build and data

| File | Job |
|---|---|
| `cmd-build.ts` / `image-prepare.ts` | `x build`: static gate first; `prebuilt` is the Dockerfile's own `RUN` † |
| `prerender.ts` / `measure-scope.ts` / `static-report.ts` / `static-*.ts` | the static export; weigh-only renders as `measurementActor()` † |
| `sw-artifacts.ts` / `pwa-artifacts.ts` / `favicon.ts` | the service worker, the web manifest, `/favicon.ico` |
| `cmd-db.ts` / `migrations.ts` / `db-*.ts` (generate, branch, seed, backfill, subscribes, accept-created) | one migration engine for `x db` and `ROLE=migrate` † |
| `cmd-db-rollback.ts` / `db-rollback-consent.ts` / `db-applied-edits.ts` | `x db rollback`: on a named deploy, or an external non-loopback database, every id named in `ROLLBACK_ALLOW_DESTRUCTIVE`; `gen` refuses an edited applied migration |
| `db-diagnostics.ts` | `x db diagnostics`: `startDb`, never `startQueue`; exit 0 whatever it says † |
| `db-schema-dump.ts` / `db-schema-refresh.ts` / `db-replay-engine.ts` / `migration-extensions.ts` / `db-object-drift.ts` | the schema dump, replayed on a scratch database † |

### Introspection and tools

| File | Job |
|---|---|
| `cmd-registries.ts` / `cmd-jobs.ts` / `cmd-tasks.ts` / `cmd-policy.ts` / `cmd-i18n.ts` | project a framework registry; each pairs CLI wiring with a facts module |
| `cmd-tasks-run.ts` | `x tasks run`: `TaskHandle.enqueue()`; production needs `--production` or `ULTIMATE_TASK_RUN=<name>` (`X_TASK_RUN_PRODUCTION`) |
| `doctor-api-listing.ts` | `x doctor` warns: action/query off a `defineApi()` listing others |
| `cmd-auth.ts` / `cmd-auth-spec.ts` / `doctor-auth.ts` | `x auth seal-mfa`: seals plaintext `x_users.mfa_secret` through auth's `sealMfaSecrets` |
| `cmd-mcp.ts` / `mcp-host*.ts` / `mcp-errors.ts` / `mcp-db-target.ts` / `mcp-test-{output,run}.ts` | `x mcp serve`: 24 tools, two transports; `tests.run`/`verify.run` ARE `x test`/`x verify` † |
| `cmd-shot*.ts` / `cdp-shot-*.ts` / `browser-launcher*.ts` / `island-*` | `x shot` over raw CDP; `verdict.json` names its own blind spots. Not a gate step |
| `cmd-profile*.ts` | `x profile <route>`: in-process JSC sampling profile of a route, hottest functions |
| `mcp-host-logs.ts` | `logs.tail` and `x logs tail`'s reader: path rule, end-first bounded read, per-role tail |
| `shot-route.ts` / `shot-run.ts` / `shot-gpu.ts` | `x shot`'s route argument, one capture, the page's GPU adapter (never gating) † |
| `cmd-pr.ts` / `cmd-ci.ts` / `ci-runs.ts` / `ci-tested.ts` | GitHub through `gh`, schema-parsed; not gate steps † |
| `pr-threads.ts` / `pr-activity.ts` | `x pr review`'s ONE GraphQL document: threads, plus every review (verdict, body) and issue comment |
| `pr-bots.ts` | which review bots posted a "did not review" notice (rate/review limit, skipped); `blocked` = no review of theirs after it |
| `ci-log.ts` | `x ci`'s log reader: markers and fences undone, provenance `source: 'ci-log'` † |
| `error-catalog.ts` | imports every `@ultimat3/*` package so `x errors` answers for any code; app codes: `cmd-errors-app.ts` |
| `cmd-docs.ts` / `docs-sources.ts` / `docs-section.ts` | `x docs`: the app's and the CLI's `@ultimat3` docs; `Page#anchor` prints a section † |
| `cmd-env-init.ts` / `env-production.ts` / `cmd-deploy-preflight.ts` | the one writer of `.env.production`; compose pre-flight (`X_DEPLOY_ENV_MISSING`) † |
| `cmd-upgrade.ts` / `upgrade-*.ts` | `x upgrade`: one major per run; no `requiresApp` † |
| `codemods/` / `cmd-upgrade-codemods.ts` / `upgrade-gate-codemods.ts` | a kept template change, carried by a codemod (ONE list: `codemods/index.ts`) † |
| `cmd-deploy-verify.ts` / `deploy-verify-*.ts` / `cmd-status*.ts` | `x deploy verify`: wait, verdict, lazy sources, rows per container † · `x status` |

## Adding a command

Write `cmd-<name>-spec.ts` (the declaration) and `cmd-<name>.ts` (a `CliCommand` whose `spec` is
that declaration), add one `lazy(<name>Spec, …)` row to `registry.ts`, add its message keys to
`messages.ts`. Help and parsing derive from the spec. `run` must be `async`.
