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
| `load-findings.ts` | module-load failures are reported once, by `manifest`; other steps point there |
| `boundary-findings.ts` / `app-boundaries.ts` / `boundary-cuts.ts` | surface + layer rules; a finding's `fix:` is the concrete cut |
| `guards.ts` | an app's `guards/*.ts`, discovered, run on `boundaries`, held to the error contract |
| `error-contract.ts` / `ts-scan.ts` / `fix-scan.ts` / `fix-imports.ts` / `fix-command.ts` / `fix-path.ts` | the `errors` step: every `fix:` names a runnable command, call or existing file |
| `workspace-checks.ts` / `workspace-graph.ts` / `tsconfig-references.ts` | `package-shape`, `filesize` |
| `app-permissions.ts` / `permission-grants.ts` | `policy`: every permission granted or required is declared, and every one required is granted by some role (`X_PERMISSION_UNGRANTED`) |
| `job-registration.ts` | `manifest`: no job or task under a positional `anonymous-*` name (`X_JOB_UNREGISTERED`) |
| `async-pages.ts` / `live-routes.ts` / `budgets.ts` | `budgets` riders: an async `Page` with no `load`, a live read no island imports, bytes per route |
| `app-agents-md.ts` / `app-env.ts` / `app-openapi.ts` / `app-manifest.ts` | `manifest` and `contract-diff` |
| `schema-drift.ts` / `drift.ts` / `db-destructive.ts` / `db-ungeneratable.ts` | `drift`: snapshot vs declarations, the source hash (core's `canonicalJson`), the header markers |
| `i18n-registration.ts` / `i18n-audit.ts` | `i18n` |
| `error-unthrown.ts` | host check: a registered code nothing throws must say so |

### Generators (`x g`, `x new`)

| File | Job |
|---|---|
| `cmd-generate.ts` / `generate-files.ts` / `generate-kinds.ts` / `generate-write.ts` | argv → pure file list → writes (conflict-checked, `merge: 'json'` / `'if-absent'`) |
| `generate-feature.ts` | a `--feature` naming no slice is `X_FEATURE_UNKNOWN`; nothing invents an entity |
| `generate-grants.ts` | a written `policy.ts` grants `:read` to `member`, `:write` to `admin` in `apps/web/shared/roles.ts` |
| `api-registration.ts` | a written job or task is listed in `apps/web/api/index.ts` |
| `app-artifacts.ts` | `x.manifest.json` + `openapi.json`, written together by `x g` and `x manifest` |
| `templates/` | every emitted file; `scaffold-*.ts` for `x new`, one file per generator otherwise |

### Boot (`x dev`, the container)

| File | Job |
|---|---|
| `serve.ts` / `serve-boot.ts` / `serve-entry.ts` / `serve-env.ts` | the production entry: roles from `ROLE`, bindings from env, `ROLE=migrate` = `x db migrate` |
| `cmd-dev.ts` / `dev-route-table.ts` | `x dev`: every role in one process, `/_x`, the watcher |
| `runtime-bindings.ts` | which service each binding points at (embedded or external); events follow `realtime.transport` / `urlEnv` |
| `runtime-queue.ts` / `runtime-services.ts` | the db + queue pair; everything else and every ambient accessor |
| `runtime-jobs.ts` / `runtime-realtime.ts` / `runtime-notify-retention.ts` / `runtime-cache.ts` / `runtime-purge.ts` / `runtime-replica.ts` | `app.config.ts` sections the boot obeys, and what each wires |
| `role-start.ts` / `role-start-types.ts` / `role-realtime.ts` | `--role` selection and start/stop for `web`, `sync`, `worker`, `scheduler`; `realtime.enabled: false` drops `sync` and `replicator` |
| `role-sync.ts` / `role-replicator.ts` / `runtime-live-feed.ts` | the sync node, the change feed |
| `runtime-render.ts` / `runtime-assets.ts` / `runtime-storage.ts` / `runtime-hooks.ts` / `api-routes.ts` | the HTTP surface: pages, `/icons` + `/media`, `/_storage`, authz, the app's API |
| `runtime-overrides.ts` | the one field a host hands the framework a driver through |
| `script-csp.ts` / `style-csp.ts` / `style-bundle.ts` / `page-sync.ts` / `worker-bundle.ts` | CSP hashes, the CSS file, the page's sync target and worker |
| `island-bundle.ts` / `island-store.ts` / `island-realtime.ts` / `solid-loader.ts` | islands: one `Bun.build` each, source-addressed; `x build --target docker` writes a verified store the container loads |
| `dev-*.ts` | `x dev` only: dashboard sources, traces, the N+1 ledger, the watcher, the reload, the lock, the port |

### Build and data

| File | Job |
|---|---|
| `cmd-build.ts` / `image-prepare.ts` | `x build`: static gate first; docker stamps `BUILD_ID` and writes the island store |
| `prerender.ts` / `measure-scope.ts` / `static-report.ts` | the static export; routes rendered only to weigh run inside a request as core's `measurementActor()`, with the app's API answered in process (`withInProcessFetch`) |
| `sw-artifacts.ts` / `pwa-artifacts.ts` / `favicon.ts` | the service worker, the web manifest, `/favicon.ico` |
| `cmd-db.ts` / `migrations.ts` / `db-generate.ts` / `db-branch.ts` / `db-seed.ts` / `db-backfill.ts` / `db-subscribes.ts` / `db-accept-created.ts` | one migration engine for `x db` and `ROLE=migrate` |

### Introspection and tools

| File | Job |
|---|---|
| `cmd-registries.ts` / `cmd-jobs.ts` / `cmd-tasks.ts` / `cmd-policy.ts` / `cmd-i18n.ts` | project a framework registry; each pairs CLI wiring with a facts module |
| `cmd-mcp.ts` / `mcp-host.ts` / `mcp-errors.ts` / `mcp-db-target.ts` | `x mcp serve`: 18 tools, two transports |
| `cmd-shot*.ts` / `cdp-shot-*.ts` / `browser-launcher*.ts` / `island-*` | `x shot` over raw CDP; `verdict.json` names its own blind spots. Not a gate step |
| `cmd-pr.ts` / `cmd-ci.ts` | GitHub through `gh`, parsed against a schema. Not gate steps |
| `error-catalog.ts` | imports every `@ultimat3/*` package so `x errors` answers for any code |

## Adding a command

Write `cmd-<name>-spec.ts` (the declaration) and `cmd-<name>.ts` (a `CliCommand` whose `spec` is
that declaration), add one `lazy(<name>Spec, …)` row to `registry.ts`, add its message keys to
`messages.ts`. Help and parsing derive from the spec. `run` must be `async`.
