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
