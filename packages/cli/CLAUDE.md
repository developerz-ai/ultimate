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
| Entry | `src/bin.ts` — argv, stdout, exit code only. `local-cli.ts` re-executes the app's own `node_modules/@ultimat3/cli` when a global `x` is a different realpath: a second `@ultimat3/entity` instance is an empty registry |
| Registry | `registry.ts`: every declaration static (`cmd-<name>-spec.ts`), every body `await import()`ed when that command runs. A command body is never imported to answer the parser or `x help` — `registry-lazy.test.ts`. A spec's constants live in the spec file or a leaf module, never in the body |
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
| Strings | rendered output through `messages.ts` (missing key renders `⟦key⟧`). NOT in the catalog: `CommandSpec` summaries and usage, `Finding.cause` / `fix`, fixed-width table headers |
| Facts | load the app (`app-load.ts`), then project a framework package's registry — never parse source for primitives, never re-derive a fact another package owns |
| Public API | `src/index.ts`, explicit re-exports only. Every name there is a semver promise; a name nothing outside this package reads is not exported (22.0.0 pruned 236) |

## File map

### Gate steps (`x verify`)

| File | Job |
|---|---|
| `verify-checks.ts` / `verify-step.ts` / `verify-run.ts` | the step list, the outcome shape, the run order (`BESIDE_SERIAL_SUITES`) |
| `verify-floor.ts` | `x.verify.json`: a floor step that ran zero tests is `X_VERIFY_SUITE_VANISHED` |
| `coverage-floor.ts` / `coverage-lcov.ts` / `coverage-source.ts` / `verify-coverage-run.ts` | an APP's `unit` step holds `coverage` in `x.verify.json` over its whole source tree. The suite runs as fixed slices, one plain `bun test` each — never `--parallel --coverage`, whose merge moves with the core count. `coverage-lcov.ts` is the ONE lcov reader; `scripts/coverage-gate.ts` reads through it. A shard defers to `verify-merge.ts` (`coverageRiders`), which also holds the shards' `files` to a partition of the corpus they hashed and reads each part step through `verify-part-step.ts`; `doctor-coverage.ts` lists the excludes |
| `verify-deadline.ts` / `verify-stalled.ts` / `verify-progress.ts` | a step past its deadline is `X_VERIFY_STEP_TIMEOUT`: its children carry `ULTIMATE_VERIFY_STEP` and are killed by that tag; the finding names the test file `bun test` had not finished (`at`, `meta.inFlight`) and its `fix:` runs that file; `--json` streams a line per finished step to stderr. A `fix:` names `ctx.command` — `bun run verify` at the framework root |
| `load-findings.ts` | module-load failures are reported once, by `manifest`; other steps point there |
| `boundary-findings.ts` / `app-boundaries.ts` / `boundary-cuts.ts` | surface + layer rules; a finding's `fix:` is the concrete cut |
| `app-transport.ts` / `browser-transport.ts` / `transport-calls.ts` / `import-closure.ts` / `server-barrels.ts` | `boundaries`, built in: one browser transport. `app-transport.ts` reuses the files `readAppSources` read (no second walk), resolves through the app's tsconfig `paths` and workspace manifests, reads the app's own `packages/*` lazily, and STOPS at `node_modules`. `browser-transport.ts` is the pure rule — `scripts/browser-transport.ts` calls the same function with this repo's seam FILES. Never a `guards/` file: an app must not be able to delete it |
| `guards.ts` / `guard-sources.ts` | an app's `guards/*.ts`, discovered, run on `boundaries`, held to the error contract; every `check(root, sources)` shares ONE walk, read and Sass compile per file (`GuardSources`) |
| `templates/scaffold-guards.ts` | `SHIPPED` — the one list of shipped guards: `x new` writes all, `x g guard <name>` writes one, `doctor-guards.ts` lists the ones an app lacks (a listing, never a finding). A new one is a `templates/guard-<name>.ts` + a row + `guard-<name>.test.ts`; `scaffold-guards-style.test.ts` holds embedded scales to `@ultimat3/ui`, the framework's own sheets to the rules, and both tracked apps byte-equal to the templates |
| `error-contract.ts` / `ts-scan.ts` / `fix-scan.ts` / `fix-imports.ts` / `fix-command.ts` / `fix-path.ts` | the `errors` step: every `fix:` names a runnable command, call or existing file |
| `workspace-checks.ts` / `workspace-graph.ts` / `tsconfig-references.ts` / `publish-closure.ts` | `package-shape`, `filesize`. A published package's `files` negates `*.test.ts` and `*-fixture.ts`, and no entry point (`exports`, `bin`) may reach a `-fixture.ts` — `X_PACKAGE_SHAPE` names the file to rename |
| `app-permissions.ts` / `permission-grants.ts` / `app-permissions-borrowed.ts` / `app-permissions-site.ts` | `policy`: every permission granted or required is declared, every one required is granted by some role (`X_PERMISSION_UNGRANTED`), and every one an app rule requires is declared by an app module, not only by a package (`X_PERMISSION_BORROWED`, read off `permissionDeclarationSites()`) |
| `job-registration.ts` | `manifest`: no job or task under a positional `anonymous-*` name (`X_JOB_UNREGISTERED`) |
| `unscanned-admin.ts` | `manifest`: a `defineAdmin()` outside the app scan (`apps/*/src/`) is `X_ADMIN_UNSCANNED`, with the `git mv` that mounts it |
| `verify-role-load.ts` / `verify-role-load-probe.ts` | `manifest`: a child imports the app as a worker does, then the rest module by module; a registration only a document-reaching module makes is `X_ROLE_LOAD_INCOMPLETE` with the module and the import the API index lacks |
| `async-pages.ts` / `live-routes.ts` / `budgets.ts` | `budgets` riders: an async `Page` with no `load`, a live read no island imports, bytes per route |
| `app-agents-md.ts` / `app-env.ts` / `app-openapi.ts` / `app-manifest.ts` | `manifest` and `contract-diff` |
| `schema-drift.ts` / `drift.ts` / `drift-replica-identity.ts` / `db-destructive.ts` / `db-ungeneratable.ts` | `drift`: snapshot vs declarations (`REPLICA IDENTITY FULL` a params channel needs included — never a `subscribes:` table, #518), the source hash (core's `canonicalJson`), the header markers |
| `schema-dump-drift.ts` | `drift`'s fourth rail, the only one that boots a database: committed `packages/db/schema/` vs a scratch replay, and that dump loaded back (`X_SCHEMA_DUMP_DRIFT`) |
| `i18n-registration.ts` / `i18n-audit.ts` / `admin-catalog-keys.ts` | `i18n`; a mounted admin's keys are `AdminApp.catalogKeys()`, asked of every app catalog — never re-derived here (`X_CATALOG_MISSING_KEYS`) |
| `error-unthrown.ts` / `unthrown-codes.ts` | host check: a registered code nothing throws is listed in `UNTHROWN_CODES` (a row's wording waives nothing); a listed code thrown again is `X_ERROR_CODE_UNTHROWN_STALE` |

### Generators (`x g`, `x new`)

| File | Job |
|---|---|
| `cmd-generate.ts` / `generate-files.ts` / `generate-kinds.ts` / `generate-write.ts` | argv → pure file list → writes (conflict-checked, `merge: 'json'` / `'if-absent'`) |
| `generate-feature.ts` | a `--feature` naming no slice is `X_FEATURE_UNKNOWN`; nothing invents an entity |
| `generate-shadow.ts` | a name whose type spelling a planned file also uses as a global or local type (`promise`, `row`) is `X_CLI_BAD_FLAG`, decided on the planned files |
| `generate-grants.ts` | a written `policy.ts` grants `:read` to `member`, `:write` to `admin` in `apps/web/shared/roles.ts`; a written `entity.ts` declares its table's `<table>:read\|write\|delete` there and grants all three to `admin` — what the admin asks for the screen that entity just became |
| `api-registration.ts` | a written job or task is listed in `apps/web/api/index.ts` |
| `handle-registration.ts` / `workspace-dep-edit.ts` / `templates/scaffold-db-client.ts` | a written entity joins `const entities = { … }` in `packages/db/src/client.ts` (the typed handle every generated `repo.ts` reads), with the two manifest lines the new imports need; no anchor is `X_DB_HANDLE_UNREGISTERED` carrying the lines. `cmd-generate.ts`'s `nextSteps` prints what the new table owes |
| `generated-imports.ts` | every sibling workspace a written file imports is declared in the manifest it landed under (`x g admin:page`'s `@<app>/i18n` in `apps/admin`) — `package-shape` would otherwise refuse the generator's own output (`X_WORKSPACE_DEP_UNDECLARED`) |
| `admin-registration.ts` / `templates/admin-catalog.ts` / `source-edit.ts` | `--admin` lists the override it wrote under `resources:` in `apps/admin/app/admin/admin.ts` (`X_ADMIN_RESOURCE_UNWIRED` when it cannot); every generated entity ships the `admin.<table>.*` labels its screen reads; `source-edit.ts` is the keyed-line and sorted-import edit both registrars share |
| `app-artifacts.ts` | `x.manifest.json` + `openapi.json`, written together by `x g` and `x manifest` |
| `templates/` | every emitted file; `scaffold-*.ts` for `x new`, one file per generator otherwise. `templates/emitted-contract.test.ts` holds every emitted string to the scaffold's own Biome format and lint, its imports to what the scaffold installs, and its `fix:` lines to the error contract — run it after touching a template: `bun test packages/cli/src/templates/emitted-contract.test.ts` |

### Boot (`x dev`, the container)

| File | Job |
|---|---|
| `serve.ts` / `serve-boot.ts` / `serve-entry.ts` / `serve-env.ts` | the production entry: roles from `ROLE`, bindings from env, `ROLE=migrate` = `x db migrate`. `serve-boot.ts` (services + roles) is ONE `await import()` in `serveApp`, so `migrate` loads neither |
| `role-load.ts` / `document-graph.ts` / `serve-web.ts` | a role imports what it runs: `ROLE_LOADS` (declared over `Role`) — `worker`/`scheduler` import the API index and every module reaching no `.tsx`/stylesheet, verified against `x.manifest.json`'s jobs and tasks (`X_ROLE_LOAD_INCOMPLETE` imports everything); `serve-web.ts` is the web surface, behind `await import()`. `scanAppModules(root, { track: false })` is the container's scan — no reload graph, no error-code walk. Per-role module pins and `NEVER_AT_BOOT`: `serve-graph.test.ts` |
| `module-imports.ts` | the files a module's source imports, resolved once for both graphs: `referenced` (reload) and `evaluated` (document) |
| `cmd-dev.ts` / `dev-route-table.ts` | `x dev`: every role in one process, `/_x`, the watcher |
| `runtime-bindings.ts` | which service each binding points at (embedded or external); events follow `realtime.transport` / `urlEnv` |
| `runtime-queue.ts` / `runtime-services.ts` | the db + queue pair; everything else and every ambient accessor |
| `framework-schema-apply.ts` / `framework-schema-stamp.ts` | the framework tables: `ROLE=migrate`, `x dev` and every CLI command APPLY them in one transaction behind `MIGRATION_LOCK_KEY` (`pg_advisory_xact_lock`) with a bounded `lock_timeout`, then stamp the build on `x_jobs`' table comment; a serving role on an external database runs no DDL and VERIFIES the stamp (`X_FRAMEWORK_SCHEMA_UNAPPLIED`, a major skew is a warning). A comment, never a table: a new framework table moves every app's schema dump |
| `runtime-isr.ts` | the ISR controller both boots serve through, ATTACHED to `invalidateTags` and released on stop (`attachedIsr`); `appRoutes` without one builds and attaches its own |
| `runtime-mfa-warning.ts` / `runtime-idempotency-scope.ts` | boot warnings an operator can act on: unsealed MFA secrets (web role, `x auth seal-mfa`), a per-process idempotency store after the app loaded |
| `app-config-load.ts` | the ONE reader of an app's `app.config.ts`: `loadAppConfig(root)` — the `config` export through core's `defineConfig`, so validated and default-merged; `undefined` with no file; no `config` object is `X_CONFIG_INVALID`. Every boot fact (`app-auth.ts`, `theme-boot.ts`, `site-config.ts`, `pwa-artifacts.ts`, …) reads a section off it, and `startServices` loads it once. An `import(` of the config module anywhere else is `X_CONFIG_IMPORT_OUTSIDE_LOADER` (`scripts/lib/config-import.ts`) |
| `runtime-jobs.ts` / `runtime-realtime.ts` / `runtime-notify-retention.ts` / `runtime-cache.ts` / `runtime-purge.ts` / `runtime-replica.ts` | `app.config.ts` sections the boot obeys (`*Of(config)` over the one loaded config), and what each wires |
| `role-start.ts` / `role-start-types.ts` / `role-realtime.ts` | `--role` selection and start/stop for `web`, `sync`, `worker`, `scheduler`; `realtime.enabled: false` drops `sync` and `replicator` |
| `role-wake.ts` | the worker's LISTEN session (`@ultimat3/jobs`' `startQueueWake`) — worker role only, only over a client that `canListen` — and `queue_wake_live` |
| `role-sync.ts` / `role-replicator.ts` / `runtime-live-feed.ts` | the sync node, the change feed |
| `runtime-render.ts` / `runtime-isr-outcome.ts` / `route-islands.ts` / `runtime-assets.ts` / `runtime-storage.ts` / `runtime-hooks.ts` / `api-routes.ts` | the HTTP surface: pages (an `isr` hit never runs `load`, and a `load` redirect is answered per request, never stored or shared — `runtime-isr-outcome.ts`; `route-islands.ts` is a render's island collector and realtime boot), `/icons` + `/media`, `/_storage`, authz, the app's API — plus its bearer mounts (`apiMountRoutes`) and pages' bound `POST`s (`pagePostRoutes`), mounted by BOTH boots |
| `stored-object-headers.ts` | how `/_storage` and `/media` present a stored object: inline only for raster images, audio and video; every other type (`text/html`, SVG, XML, PDF) is `content-disposition: attachment` with a `sandbox` CSP, which http's security stage keeps beside the app's |
| `runtime-overrides.ts` | the one field a host hands the framework a driver through — and `routes`, the plain routes for a wire format no primitive speaks (OAuth token endpoint) |
| `app-openapi.ts` | `openapi.json` (complete when `defineApi({ openapi })` is declared) and each bearer mount's own document; staleness for all of them |
| `script-csp.ts` / `style-csp.ts` / `style-bundle.ts` / `page-sync.ts` / `worker-bundle.ts` | CSP hashes, the CSS file, the page's sync target and worker |
| `page-navigation.ts` | the client router for `navigation.client` surfaces — built, routed and named ONCE for `x dev`, the container and the static export; none opted in builds nothing |
| `page-speculation.ts` | Speculation Rules for documents WITHOUT the router (`navigation.speculation`): the allow-list of pure-read pages, the one tag, and its `script-src` hash — composed once for all three writers. An allow-list, never "every link but": a prefetch is a real GET with cookies |
| `static-document.ts` | a served `static` page: `304` on a matching `If-None-Match`, and (container only, `memoStatic`) the document kept after its first render. Never `x dev` — a save moves the stylesheet URL the kept document names |
| `island-bundle.ts` / `island-store.ts` / `island-sources.ts` / `island-realtime.ts` / `solid-loader.ts` | islands: one `Bun.build` each, source-addressed; the image build writes a verified store the container loads — each chunk's recorded source files (`island-sources.ts`) are rehashed at read, so an edit since the build is a rebuild, never the old chunk |
| `local-cli.ts` / `local-cli-handoff.ts` | a global `x` hands over to the app's own CLI (`local-cli.ts` decides whether); the hand-off forwards SIGTERM/SIGHUP at once and a SIGINT only if the child is still running after a 1 s grace (a terminal Ctrl-C already reached it), and exits with the child's code |
| `serve-prebuilt.ts` / `serve-prebuilt-paths.ts` | the image's prebuilt store (`node_modules/.cache/ultimate`, never `.x/` — state, tmpfs): every role adopts its compiled stylesheets before importing the app; a boot that built an island or ran Sass logs `X_IMAGE_NOT_PREBUILT` once |
| `dev-*.ts` | `x dev` only: dashboard sources, traces, the N+1 ledger, the watcher, the reload, the lock, the port |
| `dev-dashboard-guard.ts` / `loopback-host.ts` | `/_x` answers a loopback `Host` only (`X_DEV_HOST_REFUSED`, 421 — DNS rebinding); the SQL panel runs on a same-origin `POST /_x/db` only, through admin's `readOnlySql`. Checked in the route, never left to the app's `csrf` config |

### Build and data

| File | Job |
|---|---|
| `cmd-build.ts` / `image-prepare.ts` | `x build`: static gate first; `docker` stamps `BUILD_ID`; `prebuilt` is the Dockerfile's own `RUN` — islands and stylesheets, written by the image's Bun at the image's paths, no gate and no subprocess |
| `prerender.ts` / `measure-scope.ts` / `static-report.ts` | the static export; routes rendered only to weigh run inside a request as core's `measurementActor()`, with the app's API answered in process (`withInProcessFetch`) |
| `sw-artifacts.ts` / `pwa-artifacts.ts` / `favicon.ts` | the service worker, the web manifest, `/favicon.ico` |
| `cmd-db.ts` / `migrations.ts` / `db-generate.ts` / `db-branch.ts` / `db-seed.ts` / `db-backfill.ts` / `db-subscribes.ts` / `db-accept-created.ts` | one migration engine for `x db` and `ROLE=migrate` |
| `db-schema-dump.ts` / `db-schema-refresh.ts` / `db-replay-engine.ts` / `migration-extensions.ts` / `db-object-drift.ts` | the schema dump: replay on a scratch database (embedded, snapshot-cached under `.x/cache`; a real Postgres only when a migration creates an extension PGlite cannot link), written by `x db gen` and `x db migrate`. `migration-extensions.ts` is also what `runtime-queue.ts` links `x dev`'s database with |

### Introspection and tools

| File | Job |
|---|---|
| `cmd-registries.ts` / `cmd-jobs.ts` / `cmd-tasks.ts` / `cmd-policy.ts` / `cmd-i18n.ts` | project a framework registry; each pairs CLI wiring with a facts module |
| `cmd-auth.ts` / `cmd-auth-spec.ts` / `doctor-auth.ts` | `x auth seal-mfa`: the one-shot that seals plaintext `x_users.mfa_secret` through auth's `sealMfaSecrets` (compare-and-set per row; `{ sealed, alreadySealed, skipped }`), over `startQueue`'s client, `open` injectable. `doctor-auth.ts` is the deploy-time half: unsealed secrets and retired framework tables (`RETIRED_TABLE_FIXES`, a `Map` holding a whole literal per table), asked of an external `DATABASE_URL` only |
| `cmd-mcp.ts` / `mcp-host.ts` / `mcp-errors.ts` / `mcp-db-target.ts` | `x mcp serve`: 18 tools, two transports; a taken port is `X_PORT_IN_USE`. `mcp-test-run.ts` folds `bun test`'s `N errors` line and exit code into `tests.run` |
| `cmd-shot*.ts` / `cdp-shot-*.ts` / `browser-launcher*.ts` / `island-*` | `x shot` over raw CDP; `verdict.json` names its own blind spots. Not a gate step |
| `cmd-pr.ts` / `cmd-ci.ts` | GitHub through `gh`, parsed against a schema. Not gate steps |
| `error-catalog.ts` | imports every `@ultimat3/*` package so `x errors` answers for any code |

## Adding a command

Write `cmd-<name>-spec.ts` (the declaration) and `cmd-<name>.ts` (a `CliCommand` whose `spec` is
that declaration), add one `lazy(<name>Spec, …)` row to `registry.ts`, add its message keys to
`messages.ts`. Help and parsing derive from the spec. `run` must be `async`.
