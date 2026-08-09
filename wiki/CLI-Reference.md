# CLI reference

The binary is `x`. One command registry — a command that is not in it does not exist, and there is no second place to register one.

```bash
x help                 # the catalogue
x help <command>       # usage for one command
x <command> --help     # the same thing
x version              # CLI version
```

| Convention | Detail |
|---|---|
| `--json` | every command accepts it and prints a single machine-readable object on stdout. Human output goes to stdout too, but never mixed with JSON |
| Exit codes | `0` success · `1` the command failed (a typed `X_*` error is printed) · `2` usage error (`X_CLI_BAD_FLAG`, `X_CLI_UNKNOWN_COMMAND`) |
| Errors | always `code` + `cause` + `fix`. See [Error codes](Error-Codes) |
| App detection | every command except `new`, `help` and `version` walks up for `app.config.ts` and fails with `X_NOT_IN_APP` if there is none |
| Flags | long form only, `--flag value` or `--flag=value`. Booleans negate as `--no-<flag>` |

## Command index

`As of 2026-07`. **shipped** = implemented in `packages/cli`; **planned** = specified, not yet built — calling it exits with `X_NOT_IMPLEMENTED` and a `fix:` line pointing at the closest shipped command.

| Command | Does | Status |
|---|---|---|
| `x new <name>` | scaffold a monorepo that already runs | shipped |
| `x dev` | all roles in one process: embedded services, sub-second reload, `/_x` mounted | shipped |
| `x g <kind> <name>` | scaffold a primitive with its test | shipped |
| `x db <sub>` | gen, migrate, reset, studio, branch | shipped |
| `x verify` | the gate: typecheck, lint, boundaries, all tests, drift, contract, budgets, manifest | shipped |
| `x build` | container image, single binary, or prerendered static site | shipped |
| `x deploy` | run the container deploy plan: migrate first, then the serving roles | shipped |
| `x manifest` | regenerate `x.manifest.json` and `openapi.json` | shipped |
| `x routes` | the route table: path, surface, render mode, hydrate, offline | shipped |
| `x mcp serve` | serve the framework MCP tools over stdio or HTTP | shipped |
| `x doctor` | environment, versions, drift, ports, PWA prerequisites — each with a fix | shipped |
| `x help` / `x version` | catalogue and version | shipped |
| `x actions` / `x queries` / `x entities` | introspect the declaration registries | planned |
| `x policy explain` | why a policy allowed or denied | planned |
| `x jobs` | list, show, retry, drain the queue | planned |
| `x tasks` | list cron tasks and their next run | planned |
| `x cache` | tag graph, bust, clear, stats | planned |
| `x test <type>` | run one of the six test types | planned |
| `x i18n` | add, sync, check catalogs | planned |
| `x branch` | copy-on-write branch environments | planned |
| `x status` | connected-client build-ID distribution, role health | planned |
| `x upgrade` | move every `@ultimat3/*` in lockstep, with codemods | planned |
| `x errors explain <CODE>` | code → cause, fix, docs | planned |
| `x env check` | validate the typed env, `--fix` writes the missing keys | planned |
| `x fix boundary <file>` | rewrite the import that crossed a surface boundary | planned |
| `x logs tail` | structured logs + OTel spans | planned |
| `x token` | create and grant MCP scopes | planned |
| `x ai` | eval, cache stats, reindex | planned |
| `x money add-currency` | extend the currency table | planned |
| `x config show` | the resolved `app.config.ts` | planned |

## x new

```bash
x new <name> [--dir path] [--no-example] [--dry-run] [--force] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--dir` | string | cwd | parent directory to create the app in |
| `--example` / `--no-example` | boolean | `true` | include the example feature slice |
| `--dry-run` | boolean | `false` | print the file list, write nothing |
| `--force` | boolean | `false` | write into a directory that already exists |

```bash
$ x new myapp --dry-run --json
{"ok":true,"app":"myapp","dir":"/home/me/myapp","files":142,"wrote":false}
```

`bunx create-ultimate myapp` is the same generator without a global install. Errors: `X_GENERATE_CONFLICT` (directory exists), `X_BUN_VERSION`.

## x dev

```bash
x dev [--port 3000] [--role web,worker] [--once] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--port` | string | `3000` | HTTP port. The `sync` role listens on `--port + 1` |
| `--role` | string | `web,sync,worker,scheduler` | comma-separated roles to run in this process |
| `--once` | boolean | `false` | boot, report, exit — for smoke tests and CI |

Boots the app: embedded Postgres (PGlite under `.x/pgdata`), the in-process event bus, a local
directory for S3, then every module under `apps/*/{site,app,api,shared}` and `packages/*/src` —
importing them IS the registration. What those modules registered is then served:

| Registered | Served as |
|---|---|
| `action` / `mutator` | `POST /api/<resource>/<verb>`, policy enforced by the pipeline |
| `route` | its URL, in its declared render mode, with that mode's cache headers |
| `job` | claimed off the real Postgres queue by the `worker` role |
| `task` | dispatched by the `scheduler` role |
| — | `/_x`, the dev dashboard from `@ultimat3/admin` |

A module that will not import becomes a finding on the result rather than a dead process, so the
dev loop stays reachable while something is broken.

`/_x/<panel>` is one tab per panel; `?json=1` (or `accept: application/json`) returns exactly what
the tab draws. Eleven panels — the nine `@ultimat3/admin` ships plus the two only the CLI can
answer:

| Panel | Kills the question |
|---|---|
| `routes` | which URL renders how, with which budget |
| `timeline` | where did this request spend its milliseconds |
| `live` | why did this subscriber not get the row |
| `jobs` | which step failed, and what is queued |
| `db` | what is in the table, and does the schema match the migrations (read-only SQL) |
| `mail` | what did that email look like, in that locale |
| `cache` | which tags would this invalidation bust |
| `policy` | which clause decided, for which actor |
| `manifest` | is the committed `x.manifest.json` current |
| `services` | which database/events/storage this process is talking to, and its reload count |
| `boundaries` | which import crosses a surface or a layer |

A panel whose source is not wired in this process answers `ok: false` with the exact wiring line
rather than an empty tab.

| Env | Unset means | Set means |
|---|---|---|
| `DATABASE_URL` | PGlite in this process | that Postgres |
| `NATS_URL` | in-process fanout | that NATS server |
| `S3_ENDPOINT` | `.x/storage` on disk | that S3 |

`migrate` and `replicator` are real roles but not dev roles: `migrate` is `x db apply`, and the
replicator needs logical replication the embedded database does not serve. Naming either is
`X_CLI_BAD_FLAG`, never a silently ignored value. Errors: `X_CLI_BAD_FLAG`, `X_PORT_IN_USE`,
`X_ENV_MISSING`, `X_DB_DRIFT`.

## x g

```bash
x g resource|action|mutator|job|route|policy|entity|query|task <name> [--feature f]
```

Alias: `x generate`.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--feature` | string | derived from the name | feature slice to write into |
| `--surface` | string | `app` | `site` or `app` |
| `--live` | boolean | `false` | for `query`: make it subscribable |
| `--force` | boolean | `false` | overwrite existing files |
| `--dry-run` | boolean | `false` | print the file list, write nothing |

`resource` emits the whole slice — `entity`, `repo`, `policy`, `actions`, `live`, `ui`, a migration, and the failing test scaffolds. Every generator produces code that passes `x verify` unmodified. Errors: `X_GENERATE_CONFLICT`.

## x db

```bash
x db gen "add publish_at" | migrate | reset | studio | branch <name>
```

| Subcommand | Does | Notes |
|---|---|---|
| `gen "<name>"` | diff entities against migrations and write the next migration | the message is required and becomes the filename |
| `migrate` | apply pending migrations | the same code path as `ROLE=migrate` |
| `reset` | drop, recreate, migrate, seed | dev only; refuses when `NODE_ENV=production` |
| `studio` | open the Drizzle studio against the dev database | read/write, dev only |
| `branch <name>` | `CREATE DATABASE … TEMPLATE` copy-on-write clone | the isolation an agent should use before migrating |

Errors: `X_DB_DRIFT`, `X_DB_GEN_FAILED`, `X_DB_MIGRATE_FAILED`, `X_DB_BRANCH_FAILED`, `X_DB_STUDIO_FAILED`, `X_MIGRATE_CONCURRENT`.

## x verify

```bash
x verify [--json]
```

The single gate. Green means shippable; CI runs exactly this. One step list, in cost order, shared
with the framework repo's own `bun run verify` — there is no `--only` and no `--skip`, because
"green" has to mean the same thing for everyone. A step with nothing to check in this project
reports as skipped (`-`), never as passed.

| Step | Checks |
|---|---|
| `typecheck` | `tsc` across every workspace |
| `lint` | Biome: no `any`, no default exports, no bare `Error`, no raw colours, no hardcoded user-facing strings |
| `boundaries` | surface and layer imports, resolved transitively; package tiers in a monorepo |
| `filesize` | a source file over 500 lines |
| `package-shape` | a workspace package missing `README.md`, `CLAUDE.md`, `tsconfig.json`, `src/index.ts` |
| `unit` | pure logic — services, money, policy predicates, matchers |
| `contract` | action/query schemas, policy denials, emitted OpenAPI and MCP shapes |
| `live` | live-query snapshot, incremental patches, reconnect delta, policy-filtered rows |
| `job` | step replay, idempotency dedupe, retry/backoff, concurrency, outbox atomicity |
| `e2e` | Playwright against the built output, including offline and SW update |
| `eval` | prompt scores vs. their recorded baselines, and a prompt with no eval at all |
| `drift` | schema vs migrations |
| `contract-diff` | published actions vs `openapi.json` |
| `budgets` | per-route JS bytes and LCP |
| `manifest` | `x.manifest.json` freshness |

A test's type is its filename suffix — `*.contract.test.ts`, `*.live.test.ts`, `*.job.test.ts`,
`*.e2e.test.ts` (or any test under `e2e/`), `*.eval.test.ts`. Everything else is a unit test, so no
test can fall between two steps.

`eval` is the one step that applies with no suite of its own: a prompt no `defineEval` names is
`X_EVAL_MISSING`, because a skipped step would read as a green gate over untested code. It gates on
the drop from each eval's committed baseline, never on an absolute score —
`ULTIMATE_EVAL_RECORD=1 x test eval` re-records those baselines so accepting a new number is a
reviewable diff.

```bash
$ x verify --json
{"ok":false,"command":"verify","summary":"1 of 15 steps failed","steps":[
  {"name":"budgets","ok":false,"durationMs":812,"skipped":false,"findings":[
    {"code":"X_BUDGET_EXCEEDED","cause":"site/pricing ships 61kb of JS, over the 40kb budget",
     "fix":"x fix boundary site/pricing/page.tsx",
     "docs":"https://ultimate.dev/errors/X_BUDGET_EXCEEDED","at":"site/pricing"}]}]}
```

Errors: `X_VERIFY_FAILED` (with the failing step names), plus each step's own code.

## x build

```bash
x build --target docker|binary|static [--tag name] [--out path] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--target` | string | `docker` | `docker` (one image, all roles), `binary` (`bun build --compile`), `static` (prerendered `site/`) |
| `--tag` | string | app name + build id | image tag, docker target |
| `--out` | string | `dist/` | output path, binary and static targets |

Runs `x verify`'s static checks first — a build that would fail `x verify` does not produce an artifact. All targets share one content-hash build ID, stamped into the image, the HTML, the assets, `sw.js` and `x.manifest.json`. Errors: `X_BUILD_FAILED`, `X_BUDGET_EXCEEDED`, `X_PWA_NO_ICON_SOURCE`, `X_PWA_NO_FALLBACK`.

## x deploy

```bash
x deploy --image repo/app:tag [--method compose|helm] [--dry-run] [--critical] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--image` | string | required | image reference to deploy |
| `--method` | string | `compose` | `compose` or `helm` |
| `--dry-run` | boolean | `false` | print the plan, run nothing |
| `--critical` | boolean | `false` | security deploy: clients are forced to reload after the grace period |

The plan is always migrate-first, then the serving roles, drain-aware. Errors: `X_DEPLOY_FAILED`, `X_MIGRATE_CONCURRENT`.

## x manifest

```bash
x manifest [--check] [--no-openapi] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--check` | boolean | `false` | fail if the committed files are stale instead of rewriting them |
| `--openapi` / `--no-openapi` | boolean | `true` | also write `openapi.json` |

Regenerates the generated facts: routes, entities, actions, mutators, queries, jobs, tasks, policies, cache tags, MCP tools, budgets, build ID. Never hand-edit the output. Errors: `X_MANIFEST_STALE`, `X_MANIFEST_DRIFT`, `X_MANIFEST_BREAKING`.

## x routes

```bash
x routes [--surface site|app] [--json]
```

```bash
$ x routes --surface site --json
{"ok":true,"routes":[{"path":"/","surface":"site","render":"static","hydrate":"never",
  "offline":"precache","budget":{"js":"0kb"},"meta":{"title":true,"description":true}}]}
```

Errors: `X_ROUTE_CONFLICT`, `X_ROUTE_META_MISSING`.

## x mcp

```bash
x mcp serve [--transport stdio|http] [--port 9229] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--transport` | string | `stdio` | `stdio` for an editor client, `http` for a socket |
| `--port` | string | `9229` | HTTP port when `--transport http` |

Serves `@ultimat3/mcp`'s dev server — 13 tools, one catalog, the same on both transports. Every
tool declares a scope; the local developer's caller carries all five, and an HTTP caller carries
whatever its bearer token was issued.

| Tool | Does | Scope |
|---|---|---|
| `routes.list` | route table: url, render mode, offline, hydrate, budget | `dev:read` |
| `schema.describe` | entities with columns, types and invariants | `dev:read` |
| `policies.list` | every policy: permission, subject, where it is enforced | `dev:read` |
| `actions.describe` | actions and queries: schemas, policy, cache tags, MCP exposure | `dev:read` |
| `jobs.inspect` | job definitions, retry policy and steps | `dev:read` |
| `queue.depth` | pending, running and failed counts per queue | `dev:read` |
| `manifest.read` | the generated `x.manifest.json` as text | `dev:read` |
| `errors.explain` | `X_*` → cause, fix, docs | `dev:read` |
| `db.query` | ONE read-only SQL statement, row-capped | `db:read` |
| `db.migrate` | apply pending migrations to a **branch** database | `db:migrate` |
| `tests.run` | run the suite, structured results | `dev:test` |
| `verify.run` | run `x verify`, structured per-step result | `dev:test` |
| `logs.tail` | last N log lines, optionally for one role | `dev:logs` |

`db.query` and `db.migrate` refuse structurally — multiple statements, a mutating keyword, a
locking clause, a non-branch target — before the host runs anything.

Never exposed in `ROLE=web`. Errors: `X_MCP_TOOL_UNKNOWN`, `X_MCP_ARGS_INVALID`, `X_MCP_SCOPE_DENIED`, `X_MCP_READONLY_VIOLATION`, `X_MCP_PROTOCOL`.

A tool this caller may not see is absent from `tools/list` and answers ToolNotFound, never Forbidden. `x token grant <scope>` takes effect on the next connection — scopes are fixed for the life of one. Full model: [MCP and AI](MCP-And-AI).

## x doctor

```bash
x doctor [--port 3000] [--json]
```

Checks Bun version, env completeness, migration drift, port availability, and PWA prerequisites — each failing check carries its own fix command.

```bash
$ x doctor --json
{"ok":false,"checks":[{"name":"drift","ok":false,"code":"X_DB_DRIFT",
  "cause":"table \"posts\" has column \"publish_at\" not present in any migration",
  "fix":"x db gen \"add publish_at\""}]}
```

## Planned commands

Specified in the design docs, not yet implemented. Shapes are fixed so scripts written against them keep working.

| Command | Purpose |
|---|---|
| `x actions list --json` / `x actions describe <name> --json` | every action, its input/output schema, policy, tags and MCP exposure |
| `x queries list --json` / `x queries describe <name> --json` | the same for reads, including `live` and `persist` |
| `x entities list --json` / `x entity explain <name> --json` | entities, columns, invariants and their SQL CHECKs |
| `x policy list --json` / `x policy explain <permission> --json` | which clause decided, and why |
| `x jobs ls --json` | queue depth, in-flight, failed |
| `x jobs show <id> --json` | state, step results, next retry, full trace |
| `x jobs retry <id>` | replay from the failed step |
| `x jobs drain --to redis` | migrate in-flight rows to another driver |
| `x tasks list --json` / `x tasks show <name>` | cron expression, tz, next run |
| `x cache graph --json` | what a write will evict, before you run it |
| `x cache bust <tag>` / `x cache clear` | targeted eviction; `clear` is dev-only |
| `x test unit\|contract\|live\|job\|e2e\|eval [--json]` | one test type; `--sample N` for the fast eval loop |
| `x i18n add <locale>` / `x i18n sync <locale>` / `x i18n check --json` | catalogs, missing keys, malformed entries |
| `x branch <name>` / `x branch rm <name>` | copy-on-write database + preview URL + scoped MCP socket |
| `x status --json` | role health and the build-ID distribution of connected clients |
| `x upgrade [--dry-run --json]` | move every `@ultimat3/*` in lockstep, run codemods, regenerate, then `x verify` |
| `x errors explain <CODE> [--json]` | the row from [Error codes](Error-Codes), programmatically |
| `x env check [--fix]` | validate the typed env; `--fix` writes the missing keys with placeholders |
| `x fix boundary <file>` | rewrite the import that crossed a surface boundary |
| `x logs tail --json` | structured logs and spans, filterable |
| `x token create --scopes <s>` / `x token grant <scope>` | MCP tokens and scopes |
| `x ai eval <name> [--verbose]` / `x ai cache --json` / `x ai reindex` | eval scores, cache hit rate and tokens saved, vector reindex |
| `x money add-currency <ISO> --exponent <n>` | extend the currency table |
| `x config show --json` | the resolved configuration, defaults included |

## Names that moved

| Older name in the design docs | Use instead |
|---|---|
| `x db apply` | `x db migrate` |
| `x gen <kind>` | `x g <kind>` (or `x generate`) |
| `x deploy compose` / `x deploy static` | `x deploy --method compose` / `x build --target static` |
| `x mcp` (bare) | `x mcp serve` |
| `x routes list` | `x routes` |

Related: [Getting started](Getting-Started) · [Configuration](Configuration) · [Testing](Testing) · [Deployment](Deployment) · [Troubleshooting](Troubleshooting).
