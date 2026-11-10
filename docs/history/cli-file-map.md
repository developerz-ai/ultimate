# cli: file-map detail moved out of `packages/cli/CLAUDE.md`

`As of 2026-11-09`. The rows below are the full text of `packages/cli/CLAUDE.md` file-map cells cut
to keep that file under its 24,576 B ceiling (`bun run scripts/claude-md-size.ts`). Where the two
disagree, `packages/cli/CLAUDE.md` wins.

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
