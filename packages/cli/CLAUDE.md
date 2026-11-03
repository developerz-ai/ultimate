# @ultimat3/cli — boundary

Tier 5. May import tiers 0–4. Declared sideways edges: `cli → admin` (`x dev` mounts the `/_x`
dashboard), `cli → testing` (islands, the e2e step, `x shot`'s `launchChrome`). Nothing imports
this except `create-ultimate`. The reasoning behind every rule below, verbatim and dated, is
[`docs/history/cli.md`](../../docs/history/cli.md); where the two disagree this file wins.

Commands: `bun test packages/cli` (from the repo root — the test preload lives there),
`bunx tsc --noEmit -p packages/cli/tsconfig.json`.

## Rules

| Rule | Detail |
|---|---|
| Entry | `src/bin.ts` — argv, stdout, exit code only. Full rule: `docs/history/cli.md` |
| Registry | `registry.ts`: every declaration static (`cmd-<name>-spec.ts`), every body `await import()`ed when that command runs. Full rule: `docs/history/cli.md` |
| Startup cost | `sass` loads on the first stylesheet compile (`@ultimat3/render`'s `compileStylesheet`), Babel on the first island transform (`solid-loader.ts`); both pinned by `*-lazy.test.ts` in a child process |
| Module names | `role-*` / `runtime-*` are booted by `serve.ts` in production; `dev-*` is `x dev`'s alone. Derived from the import graph by `module-naming.test.ts`, never listed |
| stdout / stderr | `write-line.ts`'s `writeLine` / `writeErrorLine` — synchronous fd writes, never `process.stdout.write` (truncates at the pipe buffer before `process.exit`). A `CommandResult` with `stream: 'stderr'` goes to fd 2 (`x mcp serve --transport stdio`) |
| `--json` | every command; `dispatch.ts` sets core's log stream to stderr under it. Same data as the human render |
| I/O | only `dispatch.ts` renders or exits; commands return `CommandResult`. `ok()` / `failed()` write `ok` after the `extra` spread — the verdict cannot be overturned |
| Staying up | a command still listening when `run` resolves returns `hold` (`hold.ts`); the release runs inside the drain's own deadline |
| Test execution | `test-shards.ts`'s `testArgs` — one `bun test --parallel=N` per pass (`test-passes.ts`); `live`/`e2e` run serially (`SERIAL_TYPES`, `test-workers.ts`) |
| Numeric flags | `flag-number.ts` — one reader for `--port` / `--workers` / `--shard` |
| Shell quoting | `shell-quote.ts`'s `quoteArg` for every value pasted into a `fix:` or a reproduce line |
| Missing input | `MissingPositionalError` (its `example` is a real invocation); a bare subcommand is refused unless the spec DECLARES `defaultSubcommand` (`MissingSubcommandError`); `--help` short-circuits both |
| Closed flag values | read through a function that refuses the rest (`readTarget`, `readMethod`, `readSurfaceFilter`, `isTransport`), from the framework's own set where one exists |
| Passthrough | declared per command (`CommandSpec.passthrough`); every other command refuses a `--` tail with `X_CLI_BAD_FLAG` |
| App root | `CommandSpec.requiresApp`, enforced by `dispatch.ts` before `run` |
| Declared flags | every flag a command declares is read in this package's source — `flag-reads.test.ts` (`X_CLI_FLAG_UNREAD`) |
| Planned commands | `PLANNED_COMMANDS` / `PLANNED_SUBCOMMANDS` (`cmd-planned.ts`): in the registry, exit `X_NOT_IMPLEMENTED` with a fix naming a shipped command |
| Errors | codes + titles in `error-codes.ts`, a runnable line per code in `mcp-errors.ts` (typed over `CliErrorCode`), classes in `errors.ts` or beside their one thrower when `errors.ts` is at its ceiling. Never a bare `Error` |
| Subprocesses | only through `exec.ts`'s injectable `Runner`; `gh` through `ctx.runner` with a required `fix` |
| Templates | `templates/*.ts` return strings, pre-formatted for Biome (`wrap.ts`'s `wrapList` / `wrapImport` / `sortSpecifiers`); no fixture files on disk |
| Strings | rendered output through `messages.ts` (missing key renders `⟦key⟧`). Full rule: `docs/history/cli.md` |
| Facts | load the app (`app-load.ts`), then project a framework package's registry — never parse source for primitives, never re-derive a fact another package owns |
| Public API | `src/index.ts`, explicit re-exports only. Full rule: `docs/history/cli.md` |

## File map

### Gate steps (`x verify`)

| File | Job |
|---|---|
| `verify-checks.ts` / `verify-step.ts` / `verify-run.ts` | the step list, the outcome shape, the run order (`BESIDE_SERIAL_SUITES`) |
| `verify-floor.ts` | `x.verify.json`: a floor step that ran zero tests is `X_VERIFY_SUITE_VANISHED` |
| `coverage-floor.ts` / `coverage-lcov.ts` / `coverage-source.ts` / `verify-coverage-run.ts` | an APP's `unit` step holds `coverage` in `x.verify.json` over its whole source tree, in fixed slices, never `--parallel --coverage`; `coverage-lcov.ts` is the ONE lcov reader. Full rule: `docs/history/cli.md` |
| `verify-deadline.ts` / `verify-stalled.ts` / `verify-progress.ts` | a step past its deadline is `X_VERIFY_STEP_TIMEOUT`: its children carry `ULTIMATE_VERIFY_STEP` and are killed by that tag; the finding names the test file `bun test` had not finished. Full rule: `docs/history/cli.md` |
| `load-findings.ts` | module-load failures are reported once, by `manifest`; other steps point there |
| `boundary-findings.ts` / `app-boundaries.ts` / `boundary-cuts.ts` / `package-boundaries.ts` | `package-boundaries.ts`: `X_BOUNDARY_PACKAGE_TO_APP`, its own read of `packages/`, never `readAppSources`. surface + layer rules; a finding's `fix:` is the concrete cut |
| `app-transport.ts` / `browser-transport.ts` / `transport-calls.ts` / `import-closure.ts` / `server-barrels.ts` | `boundaries`, built in: one browser transport; `browser-transport.ts` is the pure rule, `scripts/browser-transport.ts` calls it. Never a `guards/` file: an app must not be able to delete it. Full rule: `docs/history/cli.md` |
| `guards.ts` / `guard-sources.ts` | an app's `guards/*.ts`, discovered, run on `boundaries`, held to the error contract; every `check(root, sources)` shares ONE walk, read and Sass compile per file (`GuardSources`) |
| `templates/scaffold-guards.ts` | `SHIPPED` — the one list of the nineteen shipped guards (`error-declared` and `raw-fetch` the newest): `x new` writes all, `x g guard <name>` writes one, `doctor-guards.ts` lists the ones an app lacks (a listing, never a finding). Full rule: `docs/history/cli.md` |
| `error-contract.ts` / `ts-scan.ts` / `fix-scan.ts` / `fix-imports.ts` / `fix-command.ts` / `fix-path.ts` | the `errors` step: every `fix:` names a runnable command, call or existing file |
| `workspace-checks.ts` / `test-only-shipped.ts` / `workspace-graph.ts` / `tsconfig-references.ts` / `publish-closure.ts` | `package-shape`, `filesize`. Full rule: `docs/history/cli.md` |
| `app-permissions.ts` / `permission-grants.ts` / `app-permissions-borrowed.ts` / `app-permissions-site.ts` | `policy`: every permission granted or required is declared, every one required is granted by some role (`X_PERMISSION_UNGRANTED`), and every one an app rule requires is declared by an app module, not only by a package (`X_PERMISSION_BORROWED`, read off `permissionDeclarationSites()`) |
| `job-registration.ts` | `manifest`: no job or task under a positional `anonymous-*` name (`X_JOB_UNREGISTERED`) |
| `unscanned-admin.ts` | `manifest`: a `defineAdmin()` outside the app scan (`apps/*/src/`) is `X_ADMIN_UNSCANNED` |
| `tool-gate-names.ts` | `manifest`: a gate on no tool |
| `verify-role-load.ts` / `verify-role-load-probe.ts` | `manifest`: a child imports the app as a worker does, then the rest module by module; a registration only a document-reaching module makes is `X_ROLE_LOAD_INCOMPLETE` with the module and the import the API index lacks |
| `async-pages.ts` / `live-routes.ts` / `budgets.ts` / `budgets-unmeasured.ts` | `budgets` riders: an async `Page` with no `load`, a live read no island imports, bytes per route; an unweighed route's finding names a refused measurement actor and `defineMeasurementActor()` |
| `budgets-freshness.ts` / `verify-budgets-build.ts` | the step builds first when stats are missing, of an old rule, or older than source: `x build --target static --no-preflight --out .x/verify-static` through `ctx.runner` |
| `app-agents-md.ts` / `app-env.ts` / `app-openapi.ts` / `app-manifest.ts` | `manifest` and `contract-diff`. Full rule: `docs/history/cli.md` |
| `schema-drift.ts` / `drift.ts` / `drift-replica-identity.ts` / `db-destructive.ts` / `db-ungeneratable.ts` | `drift`: snapshot vs declarations (`REPLICA IDENTITY FULL` a params channel needs included — never a `subscribes:` table, #518), the source hash (core's `canonicalJson`), the header markers |
| `db-rolling.ts` / `doctor-rolling.ts` | `drift`'s fifth rail: what the previous release trips over (`X_MIGRATION_ROLLING_UNSAFE`, `@ultimat3/db`'s classifier), for migrations after `rollingSince` in `x.verify.json` (`x new` writes `"0"`). Full rule: `docs/history/cli.md` |
| `schema-dump-drift.ts` | also the dump-vs-newest-snapshot rail, no database (`X_DB_DRIFT`). Full rule: `docs/history/cli.md` |
| `i18n-registration.ts` / `i18n-audit.ts` / `admin-catalog-keys.ts` | `i18n`; a mounted admin's keys are `AdminApp.catalogKeys()`, asked of every app catalog — never re-derived here (`X_CATALOG_MISSING_KEYS`) |
| `error-unthrown.ts` / `unthrown-codes.ts` | host check: a registered code nothing throws is listed in `UNTHROWN_CODES` (a row's wording waives nothing); a listed code thrown again is `X_ERROR_CODE_UNTHROWN_STALE` |
| `lint-findings.ts` | `lint`: `biome check --reporter=json` as one finding per diagnostic |
| `i18n-app-key-shapes.ts` | every shape whose literal is a catalog key; `i18n-app-key-shapes.test.ts` reads `blocks`, so a new block reds until listed |
| `job-budget.ts` | `X_JOB_OUTLASTS_DRAIN`, the `manifest` step: a job's `timeout` against `workerBudgetMs(drain)`, read from the registry after `loadApp`, never from `x.manifest.json`, which carries no `timeoutMs` |
| `output-findings.ts` | render layer only: `runnableFix` (`bunx x`, decided by `dispatch.ts`'s `readerFor`) and `collapseFindings`. Throw sites keep `x …` |
| `app-load-unresolved.ts` | `X_APP_IMPORT_UNRESOLVED`, read by the scan, `findingFrom` and `x doctor`'s `snapshots` probe |
| `fix-truth.test.ts` / `fix-truth-fixture.ts` / `db-fix-truth.job.test.ts` | a printed fix, executed: each row breaks a scaffold, asserts the code and runs the line. A false fix found later adds a row in the same diff |

### Generators (`x g`, `x new`)

| File | Job |
|---|---|
| `cmd-generate.ts` / `generate-files.ts` / `generate-kinds.ts` / `generate-write.ts` | argv → pure file list → writes (conflict-checked, `merge: 'json'` / `'if-absent'`) |
| `write-generated.ts` | `x new`'s writer: a `link` file is a relative symlink, a copy only on a refusing win32 |
| `generate-feature.ts` | a `--feature` naming no slice is `X_FEATURE_UNKNOWN`; nothing invents an entity |
| `generate-shadow.ts` | a name whose type spelling a planned file also uses as a global or local type (`promise`, `row`), or whose camel VALUE a planned file both imports and declares (`x g job job`, TS2440), is `X_CLI_BAD_FLAG`, decided on the planned files |
| `generate-plural.ts` | a planned `entity.ts` in an already-plural slice (`posts` → `postses`) is `X_CLI_BAD_FLAG`; the fix names the singular |
| `generate-catalog-locales.ts` | `--locales` never starts a catalog in an app with any: a missing non-default locale is `X_CLI_BAD_FLAG`, `fix: x i18n add <locale>`; non-default values land `⟦…⟧`-marked (`seedCatalog`) |
| `app-name.ts` | `x new`'s slug is asked of core's `defineConfig`, never a copied pattern; refused with a suggested name (`9lives` → `app-9lives`, `a` → `a-app`, cut at 64) |
| `generate-grants.ts` | a written `policy.ts` grants `:read` to `member`, `:write` to `admin` in `apps/web/shared/roles.ts`; a written `entity.ts` declares its table's `<table>:read\|write\|delete` there and grants all three to `admin` — what the admin asks for the screen that entity just became |
| `api-registration.ts` | a written job or task is listed in `apps/web/api/index.ts` |
| `handle-registration.ts` / `workspace-dep-edit.ts` / `templates/scaffold-db-client.ts` | a written entity joins `const entities = { … }` in `packages/db/src/client.ts` (the typed handle every generated `repo.ts` reads), with the two manifest lines the new imports need; no anchor is `X_DB_HANDLE_UNREGISTERED` carrying the lines. `cmd-generate.ts`'s `nextSteps` prints what the new table owes |
| `generated-imports.ts` | every sibling workspace a written file imports is declared in the manifest it landed under (`x g admin:page`'s `@<app>/i18n` in `apps/admin`) — `package-shape` would otherwise refuse the generator's own output (`X_WORKSPACE_DEP_UNDECLARED`) |
| `admin-registration.ts` / `templates/admin-catalog.ts` / `source-edit.ts` | `--admin` lists the override it wrote under `resources:` in `apps/admin/app/admin/admin.ts` (`X_ADMIN_RESOURCE_UNWIRED` when it cannot); every generated entity ships the `admin.<table>.*` labels its screen reads; `source-edit.ts` is the keyed-line and sorted-import edit both registrars share |
| `app-artifacts.ts` | `x.manifest.json` + `openapi.json`, written together by `x g` and `x manifest` |
| `templates/` | every emitted file; `scaffold-*.ts` for `x new`, one file per generator otherwise. Full rule: `docs/history/cli.md` |
| `generate-feature-required.ts` | `x g query`/`backfill` with no slice holding an `entity.ts` is `X_FEATURE_REQUIRED` |
| `generate-format-written.ts` | the app's own Biome over the TypeScript a run created, best effort; the verdict is `lint`'s |
| `templates/scaffold-mcp-json.ts` / `templates/scaffold-mcp-endpoint.ts` | `.mcp.json` (`bunx @ultimat3/cli mcp serve`, never `bunx x`) and the refusing `apps/web/mcp.ts` + `app/auth/agent-token.ts`; `scaffold-agents-md.test.ts` resolves every command `AGENTS.md` names |

### Boot (`x dev`, the container)

| File | Job |
|---|---|
| `serve.ts` / `serve-boot.ts` / `serve-entry.ts` / `serve-env.ts` | the production entry: roles from `ROLE`, bindings from env, `ROLE=migrate` = `x db migrate`. Full rule: `docs/history/cli.md` |
| `role-load.ts` / `document-graph.ts` / `serve-web.ts` | a role imports what it runs: `ROLE_LOADS`, verified against `x.manifest.json` (`X_ROLE_LOAD_INCOMPLETE` imports everything); `serve-web.ts` behind `await import()`. Full rule: `docs/history/cli.md` |
| `module-imports.ts` | the files a module's source imports, resolved once for both graphs: `referenced` (reload) and `evaluated` (document) |
| `cmd-dev.ts` / `dev-boot.ts` / `dev-rebuild.ts` / `dev-route-table.ts` | `x dev`: the command (`cmd-dev.ts`, re-exports `startDev`); the boot — every role in one process, `/_x`, the watcher (`dev-boot.ts`); one save rebuilt as one generation (`dev-rebuild.ts`) |
| `runtime-bindings.ts` | which service each binding points at (embedded or external); events follow `realtime.transport` / `urlEnv` |
| `runtime-queue.ts` / `runtime-services.ts` / `runtime-bus.ts` | db + queue; every other accessor; the bus |
| `framework-schema-apply.ts` / `framework-schema-stamp.ts` | the framework tables: `ROLE=migrate`, `x dev` and every CLI command APPLY them in one transaction behind `MIGRATION_LOCK_KEY` (`pg_advisory_xact_lock`) with a bounded `lock_timeout`. Full rule: `docs/history/cli.md` |
| `runtime-isr.ts` | the ISR controller both boots serve through, ATTACHED to `invalidateTags` and released on stop (`attachedIsr`); `appRoutes` without one builds and attaches its own |
| `runtime-mfa-warning.ts` / `runtime-idempotency-scope.ts` | boot warnings an operator can act on: unsealed MFA secrets (web role, `x auth seal-mfa`), a per-process idempotency store after the app loaded |
| `app-config-load.ts` | the ONE reader of an app's `app.config.ts`: `loadAppConfig(root)` — the `config` export through core's `defineConfig`, so validated and default-merged; `undefined` with no file; no `config` object is `X_CONFIG_INVALID`. Full rule: `docs/history/cli.md` |
| `theme-brand.ts` | the ONE reader of an app's theme: `export const brand` in `apps/web/shared/theme.ts` (ui's `defineTheme`), inlined after the surface stylesheet with its hash in `style-src`; none → nothing emitted |
| `runtime-jobs.ts` / `runtime-realtime.ts` / `runtime-notify-retention.ts` / `runtime-cache.ts` / `runtime-purge.ts` / `runtime-replica.ts` | `app.config.ts` sections the boot obeys (`*Of(config)` over the one loaded config), and what each wires |
| `runtime-jobs.ts` (queues) | `jobs.queues` ∪ registered queues; `WORKER_QUEUES` = the EXACT set, each entry in that union or `X_WORKER_QUEUE_UNKNOWN`; `queue-unserved` warns the rest |
| `serve-retire.ts` / `dev-restart-retire.ts` | the worker retire — `stop()`: claim nothing, abort nothing — on SIGUSR2 under `runRole` (armed before boot, then drain + exit 0; none on win32; the chart's `roles.worker.retireSeconds` preStop sends it), and before a supervised `x dev` restart's drain (#677) |
| `role-start.ts` / `role-start-types.ts` / `role-realtime.ts` | `--role` selection and start/stop for `web`, `sync`, `worker`, `scheduler`; `realtime.enabled: false` drops `sync` and `replicator` |
| `role-wake.ts` | the worker's LISTEN session (`@ultimat3/jobs`' `startQueueWake`) — worker role only, only over a client that `canListen` — and `queue_wake_live` |
| `role-sync.ts` / `role-replicator.ts` / `runtime-live-feed.ts` | the sync node, the change feed |
| `runtime-render.ts` / `runtime-render-document.ts` / `runtime-isr-outcome.ts` / `route-islands.ts` / `runtime-assets.ts` / `runtime-storage.ts` / `runtime-hooks.ts` / `api-routes.ts` | the HTTP surface: pages, `/icons` + `/media`, `/_storage` (http's `objectResponse`), authz, the app's API, its bearer mounts (`apiMountRoutes`) and pages' bound `POST`s (`pagePostRoutes`), mounted by BOTH boots. `isr` and `static` render as nobody (`runtime-render-shared-actor.test.ts`); a hole's children run in the forwarded request context (`stream-hole-scope.ts`, `X_STREAM_ALREADY_FLUSHED`). Full rule: [`docs/history/cli.md`](../../docs/history/cli.md#moved-out-2026-11-03-plan-101-wave-3-the-claudemd-ceiling) |
| `runtime-overrides.ts` | the one field a host hands the framework a driver through — and `routes`, the plain routes for a wire format no primitive speaks (OAuth token endpoint) |
| `app-openapi.ts` | `openapi.json` (complete when `defineApi({ openapi })` is declared) and each bearer mount's own document; staleness for all of them |
| `script-csp.ts` / `style-csp.ts` / `style-bundle.ts` / `page-sync.ts` / `worker-bundle.ts` | CSP hashes, the CSS file, the page's sync target and worker |
| `page-navigation.ts` | the client router for `navigation.client` surfaces — built, routed and named ONCE for `x dev`, the container and the static export; none opted in builds nothing |
| `page-speculation.ts` | Speculation Rules for documents WITHOUT the router (`navigation.speculation`): an allow-list of pure-read pages. Full rule: `docs/history/cli.md` |
| `static-document.ts` | a served `static` page: `304` on a matching `If-None-Match`, and (container only, `memoStatic`) the document kept after its first render. Never `x dev` — a save moves the stylesheet URL the kept document names |
| `island-bundle.ts` / `island-store.ts` / `island-sources.ts` / `island-realtime.ts` / `island-realtime-state.ts` / `island-runtime.ts` / `solid-loader.ts` | islands: one `Bun.build` each, source-addressed; the image build writes a verified store, and an edit since the build is a rebuild, never the old chunk. Full rule: `docs/history/cli.md` |
| `local-cli.ts` / `local-cli-handoff.ts` | a global `x` hands over to the app's own CLI (`local-cli.ts` decides whether; `x upgrade` alone stays when the app's is strictly older — `upgrade-handover.test.ts`). Full rule: `docs/history/cli.md` |
| `serve-prebuilt.ts` / `serve-prebuilt-paths.ts` | the image's prebuilt store (`node_modules/.cache/ultimate`, never `.x/` — state, tmpfs): every role adopts its compiled stylesheets before importing the app; a boot that built an island or ran Sass logs `X_IMAGE_NOT_PREBUILT` once |
| `dev-*.ts` | `x dev` only: dashboard sources, traces, the N+1 ledger, the watcher, the reload, the lock, the port |
| `cmd-stop.ts` / `cmd-stop-spec.ts` | `x stop`: the lock's pid only (its recorded start time must match), SIGTERM, then wait for pid gone and lock clear; Windows clears the lock (`drained: false`); `X_DEV_STOP_TIMEOUT` |
| `dev-dashboard-guard.ts` / `loopback-host.ts` | `/_x` answers a loopback `Host` only (`X_DEV_HOST_REFUSED`, 421 — DNS rebinding); the SQL panel runs on a same-origin `POST /_x/db` only, through admin's `readOnlySql`. Full rule: `docs/history/cli.md` |
| `doctor-pooler.ts` / `runtime-statement-bound.ts` | the applied bound on demand (`data.statementBound`), a pooler's refusal as the one database finding; the one boot line, total. `startDb` hands `poolerFromEnv(env)` to both pools |

### Build and data

| File | Job |
|---|---|
| `cmd-build.ts` / `image-prepare.ts` | `x build`: static gate first; `docker` stamps `BUILD_ID`; `prebuilt` is the Dockerfile's own `RUN` — islands and stylesheets, written by the image's Bun at the image's paths, no gate and no subprocess |
| `prerender.ts` / `measure-scope.ts` / `static-report.ts` | the static export; routes rendered only to weigh run inside a request as core's `measurementActor()`, with the app's API answered in process (`withInProcessFetch`) |
| `sw-artifacts.ts` / `pwa-artifacts.ts` / `favicon.ts` | the service worker, the web manifest, `/favicon.ico` |
| `cmd-db.ts` / `migrations.ts` / `db-generate.ts` / `db-branch.ts` / `db-seed.ts` / `db-backfill.ts` / `db-subscribes.ts` / `db-accept-created.ts` | one migration engine for `x db` and `ROLE=migrate` |
| `db-schema-dump.ts` / `db-schema-refresh.ts` / `db-replay-engine.ts` / `migration-extensions.ts` / `db-object-drift.ts` | the schema dump: replay on a scratch database (full rule: history), written by `x db gen` and `x db migrate`. `migration-extensions.ts` is also what `runtime-queue.ts` links `x dev`'s database with |

### Introspection and tools

| File | Job |
|---|---|
| `cmd-registries.ts` / `cmd-jobs.ts` / `cmd-tasks.ts` / `cmd-policy.ts` / `cmd-i18n.ts` | project a framework registry; each pairs CLI wiring with a facts module |
| `cmd-auth.ts` / `cmd-auth-spec.ts` / `doctor-auth.ts` | `x auth seal-mfa`: the one-shot that seals plaintext `x_users.mfa_secret` through auth's `sealMfaSecrets` (compare-and-set per row; `{ sealed, alreadySealed, skipped }`), over `startQueue`'s client, `open` injectable. Full rule: `docs/history/cli.md` |
| `cmd-mcp.ts` / `mcp-host.ts` / `mcp-errors.ts` / `mcp-db-target.ts` | `x mcp serve`: 18 tools, two transports; a taken port is `X_PORT_IN_USE`. `mcp-test-run.ts` folds `bun test`'s `N errors` line and exit code into `tests.run` |
| `cmd-shot*.ts` / `cdp-shot-*.ts` / `browser-launcher*.ts` / `island-*` | `x shot` over raw CDP; `verdict.json` names its own blind spots. Not a gate step |
| `cmd-pr.ts` / `cmd-ci.ts` | GitHub through `gh`, parsed against a schema. Not gate steps |
| `error-catalog.ts` | imports every `@ultimat3/*` package so `x errors` answers for any code |
| `cmd-docs.ts` / `docs-sources.ts` / `docs-section.ts` | `x docs`: the app's `@ultimat3` scope plus the CLI's own (Bun's isolated layout), the wiki at `<cli>/wiki` (tarball) or `<cli>/../../wiki` (checkout); `Page#anchor` prints a whole section |
| `cmd-env-init.ts` / `env-production.ts` / `cmd-deploy-preflight.ts` | `x env init --production`, the one writer of `.env.production` (values from `cmd-deploy-compose.ts`); compose's pre-flight (`X_DEPLOY_ENV_MISSING`) and a failed step's container line |
| `cmd-upgrade.ts` / `upgrade-*.ts` | `x upgrade`: one major per run; declares no `requiresApp` (`upgrade-root.ts`), and with no app runs the root's `typecheck`/`test` scripts and says so in `data.proof`; `upgrade-agents-link.ts`: `data.agentsMd`. Full rule: `docs/history/cli.md` |
| `cmd-deploy-verify.ts` / `deploy-verify-*.ts` | `x deploy verify`: the wait (samples, window, queues), the pure verdict, flags refused before a sample, the `--json` shape, the real sources (lazy, so the build verdict loads neither). `DATABASE_URL` from the env only, never `resolveServices` (full rule: history) |

## Adding a command

Write `cmd-<name>-spec.ts` (the declaration) and `cmd-<name>.ts` (a `CliCommand` whose `spec` is
that declaration), add one `lazy(<name>Spec, …)` row to `registry.ts`, add its message keys to
`messages.ts`. Help and parsing derive from the spec. `run` must be `async`.
