# @ultimat3/cli

The `x` binary. One char during dev, one command per job, `--json` on every one of them.

## What it owns

Commands and the `x verify` step count, `As of 2026-08`:

| Command | Does | Notes |
|---|---|---|
| `x new <name>` | scaffolds the monorepo | interactive-free; auth, seeded DB, example route |
| `x dev` | every role in one process | embedded Postgres/events/storage, `/_x` mounted |
| `x build --target docker\|binary\|static` | one artifact | `ROLE` selects behaviour at start |
| `x build --target prebuilt` | the store a container boots from: island chunks, compiled stylesheets | a `RUN` line in the image build, never run by hand |
| `x verify` | **the gate** | 20 named steps, each with pass/fail + duration |
| `x g <primitive> <name>` | scaffolds a primitive **with a passing test** | never a TODO stub |
| `x db gen\|migrate\|reset\|branch\|backfill` | everything DB | `branch` = copy-on-write clone + preview URL; `backfill` dry-runs unless `--write`. `x db studio` is **planned** — it parses, and exits `X_NOT_IMPLEMENTED` naming `/_x`'s db panel |
| `x mcp serve` | `@ultimat3/mcp`'s 18 dev tools, over stdio or HTTP | one catalog, one scope set, both transports |
| `x doctor` | environment, ports, drift, PWA prerequisites, `APP_URL` | every finding carries a fix command; probes the port `x dev` binds ([which one](../../wiki/CLI-Reference.md#x-doctor)); the framework's deploy secrets only where the machine names `staging`/`production` |
| `x deploy` | container deploy plan | compose or helm; zero platform primitives |
| `x manifest` / `x routes` | generated facts | `x.manifest.json`, `openapi.json`, route table |
| `x actions` / `x queries` / `x entities` | the declaration registries | `list` and `show <name>`, straight off the registries |
| `x tasks list\|show` | cron tasks | timezone and next run, off `registeredTasks()` |
| `x jobs list\|show\|retry\|cancel\|delete\|promote\|pause\|resume` | the queue | depth, dead letters, step traces, `retry --from-step`, `cancel --reason`; `list --json` pages as `rows`/`nextCursor`/`hasMore`; `drain` is planned (`X_NOT_IMPLEMENTED`) |
| `x test [type]` | one of the six test types, or all | same type rule as the gate; `--filter`, `--sample N` |
| `x env check\|example` | the typed environment `envSchema` declares | and the `.env.example` rendered from it, plus the framework's deploy-required secrets (`ULTIMATE_CURSOR_SECRET`, `STORAGE_SIGNING_SECRET` unless `S3_ENDPOINT` is set), which `check` asks for wherever the boot refuses them — outside `development`/`test`, or with no environment named |
| `x auth seal-mfa` | one-shot auth maintenance | seals every `x_users.mfa_secret` still in the clear; idempotent, `{ sealed, alreadySealed, skipped }` |
| `x secrets show\|init\|edit\|set\|rotate` | the committed encrypted secrets | decrypted into the `envSchema` variables of the same names |
| `x policy list\|explain <subject>` | which clause decided a permission, and why | five packages print `x policy explain` as a denial's `fix:` |
| `x i18n check\|add\|sync` | catalogs: gaps, a new locale, key sync | all three of i18n's own error fixes name it |
| `x errors explain <CODE>` / `list` | the error table, programmatically | refuses an unregistered code instead of inventing one |
| `x docs "<question>"` | the framework docs, offline | answered from the installed packages, never the network |
| `x fix boundary <file>` | the minimal cut for a crossed surface boundary | prints the plan and the `git mv`; never rewrites a file |

Everything in [CLI reference](../../wiki/CLI-Reference.md)'s planned table is also in the registry
and exits `X_NOT_IMPLEMENTED` with a `fix:` naming the closest shipped command — "not built yet"
and "not a command" are different facts.

## `x build`: who a weighed page renders as

`x build --target static` renders every budgeted `app/` route it cannot publish only to weigh it,
then discards the document. That render runs as core's `measurementActor()`: the actor
`defineMeasurementActor()` declares in `app.config.ts`, else a **service actor holding `*` with no
`orgId` and no roles**. A page whose policy names a role, or whose `load` reads a tenant-scoped
entity, is refused under the default, and the `budgets` step reports it as `X_BUDGET_UNMEASURED`
with the actor, the refusal's code and cause (`X_FORBIDDEN`, `X_UNAUTHENTICATED`,
`X_TENANCY_ACTOR_ORG_REQUIRED`), and the edit that weighs it:

```ts
// app.config.ts — the one file every build imports; never used for a published site/ artifact
import { defineMeasurementActor, userActor } from '@ultimat3/core';

/** The org your dev seed creates. */
const DEMO_ORG_ID = '00000000-0000-4000-8000-000000000001';

defineMeasurementActor(() => userActor({ id: 'measure', orgId: DEMO_ORG_ID, roles: ['dev'] }));
```

Pick the org your dev seed creates and the most-privileged role your gated pages require: the
weigh measures the page a holder of that role is served. Any other refusal (a missing database, a
`TypeError` in `load`) keeps the generic `fix:` — the `unmeasured` list of
`x build --target static --json` — with the code already in the cause.

## Which `x` runs

**The app's own.** `x` is a workspace dependency, and `bunx x` / the `package.json` scripts resolve
`node_modules/.bin/x`. A **globally** installed `x` — `bun link` of a checkout, `bun add -g` — is
a second copy of every `@ultimat3/*` package, and a second copy of `@ultimat3/entity` is a second,
**empty** registry: the app's entities register into the instance under its `node_modules`, and
only the CLI under that same `node_modules` can see them. Measured 2026-09-05, in an app run with a
linked checkout's `x`: `x entities list` answered `0 entities`, `x policy list` answered
`0 permission(s), 0 role(s)`, and `x manifest` wrote a manifest with **zero entities and zero
actions** — exit 0, green — which `x db gen` then read as "drop every table".

So a global `x` inside an app **hands over** to `node_modules/@ultimat3/cli/src/bin.ts` when that
is a different file (`local-cli.ts`), prints one line on stderr saying so, and exits with the
child's code; fd 1 is the child's alone, so a `--json` consumer sees one document. A workspace
symlink resolves to the same file and is not handed over (both tracked apps, and every scaffold
CI installs), and a compiled `x` keeps itself — its own path is not one `realpath` can resolve.
`ULTIMATE_KEEP_GLOBAL_CLI=1` keeps the CLI that was invoked, for the one deliberate case: running a
checkout's `x` against an app pinned to an older release to see what the next one would say.

## The output contract

Every command returns one `CommandResult`; the human renderer and the JSON renderer are
projections of it, so `--json` can never drift from the terminal.

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

```sh
x verify --json
# {"ok":false,"command":"verify","summary":"1 of 20 steps failed","steps":[...]}
```

## `x verify` steps

`typecheck lint boundaries filesize package-shape errors unit contract live job e2e eval drift
contract-diff budgets seo i18n policy manifest roadmap`

Twenty, in cost order, defined once as `VERIFY_STEP_NAMES` (`verify-step.ts`) — the summary
count above is projected from that list, and the framework repo's own gate (`bun run verify`)
runs exactly it. A step with nothing to check here reports as skipped, never as
passed. Never bails early: an agent fixing three things needs all three findings from one run.

`--only <step>` runs one step, for an iteration loop — it prints `NOT A GATE RUN` in the human
summary **and** in `--json` (`data.notAGateRun`), and it writes no floor file. **The gate is this
command with no flag**, which is what "one command means shippable" means. There is no `--skip`:
a knob that removes a step from a run that still calls itself the gate is the one thing this
command must not offer. The exit code is non-zero if any step fails.

A committed `x.verify.json` is the floor, `As of 2026-08`: it names the steps this repo has already
proved it can run, and a step it names that reports nothing is `X_VERIFY_SUITE_VANISHED` rather
than a skip.
"Nothing" is both ways a suite disappears — no files at all, and every test in the files it found
skipping itself, which is read back out of `bun test`'s own summary. `x new` writes one.

The same file states the app's **coverage floor**: `"coverage": { "lines": 95, "funcs": 95 }`,
held by the `unit` step over every `.ts`/`.tsx` under `apps/` and `packages/`, a file no unit test
loads counted at 0%. No `coverage` is `X_COVERAGE_FLOOR_UNSTATED` (the finding carries the line to
add, with the measured numbers), under it is `X_COVERAGE_BELOW_FLOOR` naming the ten files losing
the most lines, and a floor under 95 the tree has left 1.5 points behind is
`X_COVERAGE_FLOOR_STALE` — the floor only rises. An `exclude` entry names code a unit test cannot
execute and carries its `why`; `x doctor` prints them. A `--shard` slice hands its facts to
`x verify merge`, which judges the fold. `x new` writes 95 / 95.

A step has a **deadline** — 8 minutes for the six suites, 5 for every other step,
`"stepTimeoutMs": { "<step>": ms }` in `x.verify.json` to change one. Past it the step fails by
name with `X_VERIFY_STEP_TIMEOUT` and every process it started is killed. Under `--json` each
finished step is one line on stderr (`{"step":"lint","ok":true,"ms":21987}`); stdout stays the
single document.

An app extends the gate with its own conventions, never with its own step: a file in `guards/`
exports a `guard` whose `check(root, sources)` returns `Finding[]`, and the `boundaries` step runs
every one of them. `sources` is the run's ONE read of the app (`GuardSources`): `files(glob)` is
walked and read once however many guards ask, and `compiled(path)` is a stylesheet as the build
compiles it. Nothing registers a guard — the directory is the registration — and what a guard returns
is held to the same error contract shipped source is (`X_GUARD_INVALID`, `X_GUARD_FAILED`,
`X_GUARD_FINDING_INVALID`). `x g guard <name>` scaffolds one with its test — the shipped guard of
that name where there is one (`x new` writes all seventeen), the blank template otherwise — and
`x doctor` lists the shipped ones an app does not hold.

## Layout

| File | Responsibility |
|---|---|
| `bin.ts` | argv, stdout, exit code — nothing else |
| `write-line.ts` | the synchronous fd-1 write both published entry points use (`create-ultimate`'s too) |
| `dispatch.ts` | parse → run → render → exit; the only I/O boundary |
| `parse.ts` | flags, subcommands, `--json`, `--help`, suggestions |
| `flag-number.ts` | the one integer-flag reader — `--port`, `--workers`, `--shard` |
| `shell-quote.ts` | the one POSIX quoter for a value pasted into a `fix:` or a reproduce line |
| `output.ts` | one data shape, two renderers, the 3-line error format |
| `registry.ts` | the one command list |
| `generate-kinds.ts` | which generators exist, and how a command line names one |
| `guards.ts` | the app's own conventions: `guards/` discovered, run, and held to the error contract |
| `guard-sources.ts` | one walk, one read and one Sass compile per file per gate run, shared by every guard |
| `cmd-*.ts` | one command group each |
| `templates/` | scaffolding as typed string modules, not copied fixtures |
| `app-load.ts` | import an app's modules so the framework registries hold it |
| `app-mcp.ts` | the app's own MCP endpoint: `apps/<app>/mcp.ts` exports `mcp`, and both boots mount `POST` at each endpoint's own `defineAppMcp({ path })` through this one call |
| `app-runtime.ts` | the app's `RuntimeOverrides`: `apps/<app>/runtime.ts` exports `runtime`, read by `x dev` and by `runRole` when its caller passed none |
| `local-cli.ts` | which `x` runs: a global CLI inside an app hands over to the app's own, because a second module instance is an empty registry |
| `measurement-actor.ts` | the actor a weigh-and-discard render runs as — every permission, never served |
| `runtime-live-feed.ts` | what feeds the sync node this process booted: the in-process row observer under the embedded database, the WAL decoder with a real one, nothing without the role — `live=` on the ready line |
| `app-manifest.ts` | `x.manifest.json`, projected by `@ultimat3/manifest` |
| `app-openapi.ts` | `openapi.json`, projected by `@ultimat3/action` |
| `app-boundaries.ts` | app import boundaries, over `@ultimat3/render`'s surface check |
| `app-transport.ts` / `browser-transport.ts` | one browser transport, on `boundaries` in every app: a raw `fetch(`, `new WebSocket(` or `new XMLHttpRequest(` in an island's closure is `X_BROWSER_TRANSPORT_BYPASS`; a server barrel there is `X_BROWSER_SERVER_BARREL` |
| `app-agents-md.ts` | `AGENTS.md` exists and stays short, over `@ultimat3/manifest`'s check |
| `serve.ts` | **what a container starts** — `runRole(options)`, the same boot `x dev` runs minus the watcher, `/_x` and `dev: true`. `x new`'s `apps/web/server.ts` is three lines that call it. `ROLE`, `PORT` and `HOST` are read from `env`; `role`, `port` and `hostname` on `ServeOptions` override each. `ROLE=worker` also retires on SIGUSR2 (`serve-retire.ts`, 25.0.0): stop claiming, finish every held job, abort nothing, drain, exit 0 — what the chart's opt-in `roles.worker.retireSeconds` `preStop` sends; core's `isRetiring()` is true from the signal on, and a SIGTERM mid-retire drains on `drain.workerDeadlineMs` when declared (`lifecycleForRole`); a no-op on Windows ([Deployment](../../wiki/Deployment.md#retiring-a-worker-before-sigterm)) |
| `prerender.ts` | `x build --target static`: which `site/` routes qualify, and where the bytes land |
| `metrics-endpoint.ts` | the `METRICS_PATH` scrape listener every role opens, on `METRICS_PORT`; opening it starts the `process_*` series, labelled by `startMetricsEndpoint({ role })` |
| `role-load.ts` / `document-graph.ts` / `serve-web.ts` | what each container role imports: `web`, `sync` and `replicator` every app module; `worker` and `scheduler` the API index plus every module that reaches no component or stylesheet |
| `otlp-export.ts` | the exporters `OTEL_EXPORTER_OTLP_ENDPOINT` switches on, and their drain hooks |
| `dev-*.ts` | what `x dev` boots: services, runtime, routes, hooks, roles, the `/_x` mount |
| `island-bundle.ts` | every `*.island.tsx` built as its own entry point, content-hashed |
| `island-routes.ts` | the one route those chunks are served from, in dev and in the container |
| `mcp-host.ts` | the shell-side half of `@ultimat3/mcp`'s dev server — db, tests, logs, verify |
| `verify-step.ts` | the step shape, the step names, the host-check hook |
| `verify-tests.ts` | one `bun test` invocation per test type |
| `workspace-checks.ts` | file-size ceiling and package contract files |
| `drift.ts` `budgets.ts` | the checks `x verify` composes |

The CLI describes an app by **loading** it, never by parsing it: `action()`, `entity()`,
`job()` and `defineRoute()` register themselves, and `x manifest`, `x routes` and `x verify`
read the same tables the running server reads. There is no second definition of a primitive,
no second OpenAPI builder and no second surface-boundary walk anywhere in this package.

## Generated file layout

`x g` writes into the feature slice:

```
apps/web/app/<feature>/{entity,repo,service,policy,errors,ui}.ts
apps/web/app/<feature>/{actions,queries,live,jobs,tasks}/<name>.ts
apps/web/{site,app}/<path>/page.tsx
apps/web/{site,app}/<path>/<name>.island.tsx     # x g island <name> --at <dir>
apps/admin/app/admin/pages/<name>.tsx            # x g admin:page <name> --permission p
guards/<name>.ts                                 # x g guard <name>
```

Every emitted source has a `<file>.test.ts` beside it that passes on the first run.

## Errors

`X_CLI_UNKNOWN_COMMAND` `X_CLI_BAD_FLAG` `X_VERIFY_FAILED` `X_NOT_IN_APP` `X_BUN_VERSION`
`X_NOT_IMPLEMENTED` `X_GUARD_INVALID` `X_GUARD_FAILED` `X_GUARD_FINDING_INVALID`

### Error classes

Every error class `src/index.ts` exports, for `instanceof` inside one process. Across a wire or
a job boundary the class is gone and the `code` is what survives — match on that.

| Class | Code | Declared in |
|---|---|---|
| `BadFlagError` | `X_CLI_BAD_FLAG` | `src/errors.ts` |
| `BuildEntryMissingError` | `X_BUILD_ENTRY_MISSING` | `src/cmd-build.ts` |
| `BunVersionError` | `X_BUN_VERSION` | `src/errors.ts` |
| `CatalogExistsError` | `X_GENERATE_CONFLICT` | `src/errors.ts` |
| `CdpBrowserMissingError` | `X_CDP_BROWSER_MISSING` | `src/cdp-errors.ts` |
| `CdpCallFailedError` | `X_CDP_CALL_FAILED` | `src/cdp-errors.ts` |
| `CdpLaunchFailedError` | `X_CDP_LAUNCH_FAILED` | `src/cdp-errors.ts` |
| `CdpTimeoutError` | `X_CDP_TIMEOUT` | `src/cdp-errors.ts` |
| `DeclarationUnknownError` | `X_DECLARATION_UNKNOWN` | `src/errors.ts` |
| `E2eAppFailedError` | `X_E2E_APP_FAILED` | `src/e2e-errors.ts` |
| `E2eEvaluateCapturedError` | `X_E2E_EVALUATE_CAPTURED` | `src/e2e-errors.ts` |
| `E2eEvaluateThrewError` | `X_E2E_EVALUATE_THREW` | `src/e2e-errors.ts` |
| `E2eEvaluateUnsupportedError` | `X_E2E_EVALUATE_UNSUPPORTED` | `src/e2e-errors.ts` |
| `E2eLocatorAmbiguousError` | `X_E2E_LOCATOR_AMBIGUOUS` | `src/e2e-errors.ts` |
| `E2eLocatorEmptyError` | `X_E2E_LOCATOR_EMPTY` | `src/e2e-errors.ts` |
| `E2eServiceWorkerAbsentError` | `X_E2E_SERVICE_WORKER_ABSENT` | `src/e2e-errors.ts` |
| `ErrorCodeUnknownError` | `X_ERROR_CODE_UNKNOWN` | `src/errors.ts` |
| `FixTargetUnknownError` | `X_FIX_TARGET_UNKNOWN` | `src/errors.ts` |
| `FrameworkSchemaFailedError` | `X_FRAMEWORK_SCHEMA_FAILED` | `src/schema-errors.ts` |
| `JobUnknownError` | `X_JOB_UNKNOWN` | `src/errors.ts` |
| `MissingPositionalError` | `X_CLI_BAD_FLAG` | `src/errors.ts` |
| `MissingSubcommandError` | `X_CLI_BAD_FLAG` | `src/errors.ts` |
| `NoTestFilesError` | `X_TEST_NO_FILES` | `src/errors.ts` |
| `NotInAppError` | `X_NOT_IN_APP` | `src/errors.ts` |
| `PortInvalidError` | `X_PORT_INVALID` | `src/errors.ts` |
| `QuerySubscribesUnknownError` | `X_QUERY_SUBSCRIBES_UNKNOWN` | `src/db-subscribes.ts` |
| `RoleUnknownError` | `X_ROLE_UNKNOWN` | `src/errors.ts` |
| `UnknownCommandError` | `X_CLI_UNKNOWN_COMMAND` | `src/errors.ts` |
| `VerifyFailedError` | `X_VERIFY_FAILED` | `src/errors.ts` |
