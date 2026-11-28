# CLI reference: inspect, diagnose and upgrade

Part of the [CLI reference](CLI-Reference): every other command. Conventions, global flags and the command index are on the index page.

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
x routes [--surface site|app|api|shared] [--json]
```

No positional: `x routes list` (the retired spelling) or `x routes app` is `X_CLI_UNKNOWN_COMMAND`
with fix `x routes --json` — the filter is `--surface`.

**Every URL the app serves through a primitive, in one table** (`As of 2026-10-07`, owner decision 2):
the pages from `describePages()`, then — sorted by path — the action and query routes from
`apiRoutes()` (the builder `x dev` and the container mount) and the plain `routes` of
`apps/<app>/runtime.ts`. The MCP dev tool `routes.list` answers the same rows.

| Row | Surface | Last column (`declared by`) | `--json` keys |
|---|---|---|---|
| a page | `site` / `app` | its file | `method` (`GET`), `path`, `surface`, `file`, `render`, `hydrate`, `offline`, `budget` |
| a mounted page — every screen `defineAdmin()` serves | `site` / `app` | the call and the permissions that gate it: `defineAdmin() · admin:read + widgets:read` | the page keys plus `mount: { by, permissions }`; a file route has no `mount` key |
| an action or query projection | `api` | the primitive, its name and its policy: `action publishPost · posts:publish` | `method`, `path`, `surface`, `primitive`, `name`, `auth`, `policy` |
| a plain route — a `runtime.ts` one (an OAuth endpoint) or a declared `webhookReceiver()`'s (`webhook.<name>`, public) | `api` | `runtime.ts routes <name>`, then its policy | the same keys, `primitive: null` |

```bash
$ x routes --surface api --json
{"ok":true,"command":"routes","summary":"2 routes","findings":[],"data":{"routes":[
  {"method":"GET","path":"/_x/query/org-feed","surface":"api","primitive":"query","name":"orgFeed","auth":"public","policy":"allow"},
  {"method":"POST","path":"/api/posts/publish","surface":"api","primitive":"action","name":"publishPost","auth":"required","policy":"posts:publish"}]}}
```

Not listed: a bearer mount's copies of the API (`defineApi({ http: { mounts } })`), a page's
`post:` binding, and the framework's own asset, island and `/_x` routes.

Errors: `X_ROUTE_CONFLICT`, `X_ROUTE_META_MISSING`.

## x mcp

```bash
x mcp tools [--json]
x mcp serve [--transport stdio|http] [--port 9229] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--transport` | string | `stdio` | `stdio` for an editor client, `http` for a socket |
| `--port` | string | `9229` | HTTP port when `--transport http`. `9229` is also the inspector's default; a taken port is `X_PORT_IN_USE`, naming the next one |

Serves `@ultimat3/mcp`'s dev server — 24 tools (`As of 31.53`), one catalog, the same on both transports. Every
tool declares a scope; the local developer's caller carries all five, and an HTTP caller carries
whatever its bearer token was issued.

| Tool | Does | Scope |
|---|---|---|
| `routes.list` | the `x routes --json` table: pages (render mode, hydrate, offline, budget), then every action, query and `runtime.ts` route | `dev:read` |
| `schema.describe` | entities with columns, types and invariants; `{ entity }` narrows to one, by name or table (`As of 31.22`) | `dev:read` |
| `policies.list` | every policy: permission, subject, where it is enforced | `dev:read` |
| `actions.describe` | actions and queries: schemas, policy, cache tags, MCP exposure | `dev:read` |
| `jobs.inspect` | job definitions, retry policy and steps | `dev:read` |
| `queue.depth` | pending, running and failed counts per queue | `dev:read` |
| `manifest.read` | the generated `x.manifest.json` as text | `dev:read` |
| `errors.explain` | `X_*` → cause, fix, docs | `dev:read` |
| `docs.search` | `x docs` as a tool: the installed docs ranked for a question, a topic or a symbol; `limit` 1–20, default 5 (`As of 31.22`) | `dev:read` |
| `verify.narrow` | `{ file }` → the steps `x verify --changed` selects for that one file and the narrowest commands that run them; runs nothing (`As of 31.22`) | `dev:read` |
| `db.query` | ONE read-only SQL statement; `limit` defaults to 100 rows, maximum 1000 | `db:read` |
| `db.explain` | the plan of ONE `SELECT`/`WITH … SELECT` as `EXPLAIN (FORMAT JSON)`; `analyze: true` executes it inside `db.query`'s SELECT-only role, read-only transaction and 5 s timeout. A production database is refused, as `x explain` refuses it (`As of 31.22`) | `db:read` |
| `db.migrate` | apply pending migrations to a **branch** database | `db:migrate` |
| `tests.run` | `x test [--filter]` itself — the shell's files, batches and environment, so it agrees with `x test`; structured results — an error outside any test (`1 error` beside `0 fail`) or a non-zero exit is a failure, never `failed: 0` | `dev:test` |
| `verify.run` | `x verify` itself, so it agrees with the shell; `only: [steps]` is `--only` (not a gate run); structured per-step result | `dev:test` |
| `logs.tail` | last N log lines, optionally for one role: its `.x/logs/<role>.log` when one was written, else the `.x/dev.log` lines whose `role` field names it (`As of 2026-11-15`; a line written outside any request or job names none) | `dev:logs` |
| `requests.statements` | the running `x dev`'s per-request statement ledger: SQL count, repeated statements and N+1 verdicts per recent request, or one `requestId`; `limit` default 10, maximum 50. No `x dev` running: `X_NOT_IMPLEMENTED` naming it (`As of 31.22`) | `dev:logs` |
| `graph.query` | `{ node }`: what a change to a file or primitive reaches (`x impact`); `{ from, to }`: the edges linking two nodes (`x graph --from --to`) | `dev:read` |
| `ui.shot` | photograph one route at a named viewport, light or dark; PNG path plus verdict. Launches a browser | `dev:test` |
| `ui.island` | photograph an island in every state its `*.island.states.ts` declares, as `x shot --island` does | `dev:test` |
| `ui.inspect` | DOM, computed-style and accessibility facts for a bounded set of selectors, in one navigation | `dev:test` |
| `ui.interact` | drive one route through a bounded step list, then photograph it; refuses a password field and any step that leaves the origin | `dev:test` |
| `ui.diff` | pixel-compare two PNGs the other `ui.*` tools wrote under `.x/shot/`; launches no browser | `dev:read` |
| `ui.research` | `x design research` as a tool: `{ urls: 1..5, follow?: 0..20 }` → `reference.json`, `tokens.proposal.json`, `motion-map.json`, `sources.json` under `.x/design/<slug>/`; every request to a private, loopback or link-local address refused | `dev:test` |

`db.query` and `db.migrate` refuse structurally — multiple statements, a mutating keyword
(a data-modifying CTE included), a locking clause, `EXPLAIN ANALYZE` (or `ANALYSE`), a banned
function family (`pg_read_*`, `pg_copy_*`, `pg_backup_*`, `pg_restore_*`, … — [MCP and AI](MCP-And-AI)),
a non-branch target —
before the host runs anything. `db.explain` is where `ANALYZE` is allowed: it writes the `EXPLAIN`
itself around a statement the same scan passed.

Never exposed in `ROLE=web`. Errors split by when they fire:

| When | Codes | Effect |
|---|---|---|
| boot — configuring an MCP surface with `defineAppMcp` | `X_MCP_TOOL_UNDECLARED`, `X_MCP_TOOL_UNSAFE`, `X_MCP_TOOL_DUPLICATE` | the call throws; no server starts |
| runtime — one request | `X_MCP_TOOL_UNKNOWN`, `X_INPUT_INVALID` (an `isError` result), `X_MCP_SCOPE_DENIED`, `X_MCP_QUERY_REJECTED`, `X_MCP_NOT_BRANCH_DB`, `X_MCP_PROTOCOL` | that call is refused; the server keeps serving |

A tool this caller may not see is absent from `tools/list` and answers ToolNotFound, never Forbidden. A wider token — `x token create --scopes <a>,<b> --json`, then `x token revoke <old-id>` — takes effect on the next connection: scopes are fixed for the life of one. Full model: [MCP and AI](MCP-And-AI).

## x doctor

```bash
x doctor [--port 3000] [--json]
```

A taken port is judged by who holds it (`As of 2026-11-18`): from this checkout, or by a process the OS will not name, it is an `X_PORT_IN_USE` finding; from another checkout it is the same code as a warning in `data.warnings[]`, naming that directory, and the exit stays 0. Either way the fix names a port pair that is free when asked.

Checks Bun version, env completeness, source drift, **the newest migration's `.snapshot.json`**, port availability, PWA prerequisites and **embedded-Postgres readiness** — each failing check carries its own fix command.

It also lists the copies of shipped guards the app's `guards/` still holds, each with `X_GUARD_VENDORED` beside the verdict in `data.warnings[]`: shipped guards run from the installed framework, so a copy runs in place of the shipped one and never receives a fix. `As of 31.28`. No shipped guard is ever missing, so `data.guards.missing` is always `[]`.

| Listing | One line each | `--json` |
|---|---|---|
| a copy, identical or edited | the edit that resolves it: `rm -f` for an identical copy; for an edited one, `mv` to `guards/app-<name>.ts` and `"<name>": "off"` in `guards/shipped.json` | `data.guards.vendored[]`: every copy's name |
| an edited copy | the same line | `data.guards.differs[]`: `{ name, refresh, diff }` — `refresh` is that edit |

A listing, never a finding: the verdict does not move. `x upgrade` applies the same migration (`vendored-guards` codemod); how a shipped guard reports is a row in `guards/shipped.json`.

Warnings about how the app is held — beside the verdict, never in it: the exit status, `findings` and `data.codes` stay as they were, and `--json` carries each as `data.warnings[]` (`{ code, cause, fix, docs, at }`). None is a gate step; on `next` they join the verdict, red:

| Code | Asked | Fix |
|---|---|---|
| `X_DB_ROW_SECURITY_OFF` | `database.rowSecurity` is off and a raw `` sql`…` `` (or `` Bun.sql`…` ``, `` tx.sql`…` ``, `raw('…')`, `identifier('…')`) outside migrations, seeds and tests names a tenant table — up to five sites listed. Off with no raw tenant SQL is not reported | `database: { rowSecurity: true }` in `app.config.ts`, then `x db gen "row security" && x db migrate` |
| `X_VERIFY_STEP_UNFLOORED` | a gate step applies here — its suite files exist, its input is committed — and `x.verify.json` `"steps"` does not hold it, so a deleted suite reads as skipped. `e2e` is never proposed (the scaffold's placeholder skips until a browser driver is registered) | `x verify --only <steps> --json`, then add each step that passed to `"steps"` |
| `X_FRAMEWORK_PIN_RANGE` | an `@ultimat3/*` dependency in any of the app's manifests is anything but an exact version or a `workspace:`/`file:`/`link:` path (`^31.0.0`, `*`, `latest`, `>=31 <32`; an `npm:` alias by its own spec), one finding per manifest | the exact version `bun install` resolved, at the line named; then `bun install` |
| `X_ENV_NAME_RESERVED` | a name the app declares in `envSchema` or seals in `secrets.enc.json` is one `FRAMEWORK_ENV` (`@ultimat3/core`) lists as a `switch` or `internal` name — setting it for the app also switches that package's behaviour. Deploy-contract names (`DATABASE_URL`, `PORT`) and host names are not collisions | rename it `APP_<name>` (or delete it where the value is meant for the framework); then `x env example` |
| `X_GUARD_VENDORED` (`As of 31.28`) | the app's `guards/` holds a copy of a shipped guard, which runs in place of the built-in one and never receives a fix — one per copy. `boundaries` lists it too | the resolving edit above |
| `X_ACTION_UNREGISTERED` · `X_QUERY_UNREGISTERED` (`As of 2026-11-19`) | the app's API index lists actions or queries in `defineApi()`, and a loaded module exports one whose name no list carries — served by the module scan, missing from the typed `Api`. An app that lists none (scan only) is told nothing; a failed load is silent | the import line, as `X_JOB_UNREGISTERED` prints it: `import * as refundTicket from '../app/ticket/actions/refund-ticket';` in `apps/web/api/index.ts`, `refundTicket` added to `actions: [...]` there — then `x manifest` |

**Processes per container**, the same way (`As of 2026-11-19`): one line per role — the count a production container of it runs on this host under `ULTIMATE_PROCESSES` and the clamp that bound it, its pool plus LISTEN sessions as connections per container — then, when an external database answered, one container of each role against `max_connections`. `--json`: `data.processes` = `{ environment, cores, cpuBudget, migrateReq, roles: [{ role, count, binding, pool, listen, connections } | { role, refused }], connectionsOneOfEach, maxConnections }` (`cpuBudget`, `migrateReq`, `maxConnections` are `null` when unknown; `binding` is one of `environment`, `platform`, `role`, `cpu`, `memory`, `pool`, `shared-state`, `image`, `requested`; `refused` is the code an explicit count met). On a production or staging host only, two warnings join `data.warnings[]`: `X_PROCESSES_CPU_UNDECLARED` (no CPU quota on a multi-core host, so `auto` runs one process; fix `cpus:` on the service) and `X_PROCESSES_MIGRATE_REQ_OFF` (N > 1 with `net.ipv4.tcp_migrate_req` at 0, only where the knob exists — Linux ≥ 5.14; a kernel without it is told nothing; fix: uncomment the `sysctls:` line). A listing, never a finding ([Deployment](Deployment#processes-per-container)).

**Redundant indexes**, the same way (`As of 2026-11-14`): each implicit index the entities describe that another index, the primary key or a unique invariant already leads with, still in the newest migration's snapshot, is one line — `<table>.<index> (<columns>) — <covering index>` — under a header naming `x db gen "drop redundant indexes" --drop-redundant`; `--json`: `data.redundantIndexes[]` = `{ table, name, columns, coveredBy }`, `[]` when none, absent when the app would not load or has no snapshot. A listing, never a finding: every write pays for each twice, and dropping it is a migration the app opts into.

**The chart's monitoring templates**, the same way (`As of 2026-11`): an app with a `docker/helm/Chart.yaml` and no `templates/servicemonitor.yaml` or `templates/alert-rules.yaml` gets one line per missing file, then `x g chart-alerts`, which writes only those (`--json`: `data.chartAlerts`, `{ missing[], add }`). The dashboard is its own row: no `dashboards/ultimate-app.json` or `templates/dashboard-configmap.yaml` lists them, then `x g chart-dashboard` (`data.chartDashboard`, the same shape). A chart that dropped them on purpose keeps a green verdict; an app with no chart is listed nothing.

The embedded half is the bare-VM case: the external-database probe answers nothing the moment `DATABASE_URL` is unset, and that silence *is* the configuration a fresh box has. So `x doctor` also asks whether `@electric-sql/pglite` resolves from the app root — a resolve, never an import, because loading it boots the WASM build and takes the single-writer lock the next command needs. Red only where both hold: `DATABASE_URL` unset **and** the peer unresolvable, reported as `X_DB_UNAVAILABLE` with `@ultimat3/db`'s own sentence and its own runnable fix ([Bare VM](Bare-VM)). The snapshot half is `As of 2026-08` and separate from drift on purpose: they are two questions with two remedies, and `x db gen`'s own `X_MIGRATION_SNAPSHOT_MISSING` was a condition this diagnostic could not see at all, so `x doctor --json` — the `fix:` of the `X_CLI_UNEXPECTED` an author reaches it through — ran clean over a broken app.

**It probes BOTH ports `x dev` binds** — `PORT` for the web role and `PORT + 1` for the sync node —
and the suggestion moves both: `x doctor --port 3000` with 3001 taken answers `x dev --port 3002`,
never `3001`, which is the port it has just reported as taken (`As of 2026-09`; the same repair
`X_PORT_IN_USE`'s own `fix:` took in `x dev`). A `--port` at the top of the range has no room for
the sync node at all, so it reports the boot's own `X_PORT_INVALID` rather than probing a port
below it that `x dev` would never bind. The port is `x dev`'s own: `--port`, then `PORT`, then
3000 — under `PORT=4000` it probes 4000 and 4001, never 3000.

**`APP_URL`, when set**, must be an `http://` or `https://` origin (`X_CONFIG_INVALID`, the sync
boot's own refusal), and a loopback one must name that same port — `APP_URL=http://localhost:3000`
beside `PORT=4000` is `X_APP_URL_PORT_MISMATCH`, whose fix is the `export` line with the port `x dev`
serves on. Unset is no finding; a public origin is the deploy's and is not judged here.

**Sealed columns against the key ring.** An app that declares `.sealed()` columns is checked for
two conditions; an app with none is never judged.

| Finding | Condition | Fix |
|---|---|---|
| `X_SEAL_KEY_MISSING` | sealed columns, and no usable master key in this environment | `x secrets init`, or export `ULTIMATE_SECRETS_KEY` |
| `X_SEAL_RESEAL_PENDING` | sealed columns, and a retired key still in `ULTIMATE_SECRETS_RETIRED_KEYS` — a rotation whose re-seal is not finished | a `backfill()` rewriting each row, then `x secrets rotate --drop <keyId>` |

The ring is read as a booted process would see it — the real environment first, then the
committed `secrets.enc.json`.

**What an upgrade left in the auth tables** (`As of 2026-10`). Asked of an external
`DATABASE_URL` only — the embedded database is never opened by a diagnostic.

| Finding | Condition | Fix |
|---|---|---|
| `X_MFA_SECRET_UNSEALED` | `x_users` rows hold a second-factor secret that is not sealed; each is refused at the second factor until it is | `x auth seal-mfa --json` |
| `X_FRAMEWORK_TABLE_ORPHANED` | `x_auth_failures` is still present: no release reads it, and the boot does not drop a table a replica on the previous release may still be using | `psql "$DATABASE_URL" -c 'drop table if exists x_auth_failures'`, once every replica runs this release |

The output is a `CommandResult` like every other command's: `findings`, not a `checks` array.

```bash
$ x doctor --json
{"ok":false,"command":"doctor","summary":"1 finding(s)","findings":[{"code":"X_DB_DRIFT",
  "cause":"packages/db has a schema but no migration recorded it",
  "fix":"x db gen \"initial\"","docs":"https://github.com/developerz-ai/ultimate/wiki/Error-Codes",
  "at":"packages/db/migrations"}],"data":{"count":1,"codes":["X_DB_DRIFT"]}}
```

## x actions · x queries · x entities

```bash
x actions  [list|show <name>] [--json]
x queries  [list|show <name>] [--json]
x entities [list|show <name>] [--json]
```

The declaration registries, projected. `list` is the default subcommand; `show <name>` is one declaration (it was `describe` until 26.0.0). Same rows the manifest and the MCP `actions.describe` tool are built from — the CLI keeps no second table.

```bash
$ x actions list
  name          verb     resource  path                  capability    mcp
  createPost    create   posts     /api/posts/create     post:create   yes
  publishPost   publish  posts     /api/posts/publish    post:publish  yes

$ x entities show posts --json
{"ok":true,"command":"entities","summary":"entity posts","data":{"name":"posts","table":"posts",
  "primaryKey":["id"],"columns":[…],"invariants":[…],"softDelete":true,"orgScoped":true}}
```

A name nothing registered is `X_DECLARATION_UNKNOWN`, whose `fix` names the nearest real one. A module that would not import is reported as a finding — the listing describes what loaded, and never pretends the rest is absent.

## x mail

```bash
x mail preview <id> [--locale <tag>] [--tz <zone>] [--out <dir>] [--json]
```

`As of 2026-11-06`. Renders the mail's `defineMail({ preview })` data through `renderMessage`'s own
path, with nothing sent. No `--locale`: every locale the app routes.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| *(positional)* | mail id | — | the `defineMail({ id })` to render |
| `--locale` | string | every routed locale | one locale |
| `--tz` | IANA zone | `UTC` | every date in the body; never the machine's zone (`X_TIMEZONE_INVALID`) |
| `--out` | string | — | write `<id>.<locale>.html` and `<id>.<locale>.txt` there |

`--json`: `data.tz` is the zone rendered in; `data.previews[]` is `{ locale, subject, missing, files }`; `missing` names every catalog
key the locale cannot resolve, and any is a non-zero exit. `x verify`'s `i18n` step renders every
declared preview in every locale the same way, so a preview is a test too.

Errors: `X_MAIL_PREVIEW_MISSING`, `X_MAIL_PREVIEW_INVALID`, `X_MAIL_TEMPLATE_UNKNOWN`, `X_CLI_BAD_FLAG`.

## x upgrade

```bash
x upgrade [--to <version>] [--only <step>[,<step>…]] [--dry-run] [--json]
x upgrade codemods --from <version> [--to <version>] [--dry-run] [--json]
```

One major per run, so each hop's gate attributes its red to that hop. `As of 30.0.0`.

**An app with no `x upgrade` yet** (below 30.0.0) runs the newest CLI: `bunx @ultimat3/cli@latest upgrade --json`. The only command that does not hand over to an older app CLI ([why](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/README.md#which-x-runs)); the gate still runs from the CLI the hop installs. Needs Bun at the newest release's floor: below it, `X_BUN_VERSION`, `fix: bun upgrade`.

| Step | What | Refused with |
|---|---|---|
| 1 | clean tree, git is the only state between runs | `X_UPGRADE_DIRTY_TREE` |
| 2 | read every workspace's `@ultimat3/*` pins, `overrides` and `resolutions` included | `X_UPGRADE_PIN_UNREADABLE`, `X_UPGRADE_MIXED_PINS` |
| 3 | `bun pm view @ultimat3/cli versions`: the next major's newest; the last major's newest when no later major exists | `X_UPGRADE_REGISTRY_UNREACHABLE`, `X_UPGRADE_HOP_TOO_WIDE`, `X_UPGRADE_VERSION_UNPUBLISHED`, `X_BUN_VERSION` |
| 4 | write exact pins, raise the Bun floor | — |
| 5 | `bun install`, then `bun update <names>` for each transitive package `bun.lock` holds under an advisory floor (`X_ADVISORY_FLOOR_UNMET`) | `X_UPGRADE_INSTALL_FAILED`, `fix:` carries the undo |
| 6 | the installed CLI: `x upgrade codemods --from <from> --to <to>` (below), then `x manifest`, `x doctor --json`, each guard that doctor reports missing (only a hop landing before 31.28: `x g guard <name>`, kept when `x verify --only boundaries` finds nothing more), a Bun-floor hop's `x verify --only unit` coverage rebaseline, `x kit --json` (the managed agent kit refreshed, `As of 31.53`), `x exercise --json` and its `exercise` floor figures, `x verify --json` | `X_UPGRADE_GATE_UNREADABLE`, as a finding on a red hop |

A dry run refuses exactly what the real run would, then stops before step 4 — after previewing this CLI's codemods for the span, written nowhere. It never commits; `git diff` is the hop. Under `--json` fd 1 is one document, fd 2 a `{"upgrade":"<stage>"}` line per stage and a heartbeat a minute.

`--only <step>[,<step>…]` (`As of 2026-11-19`): the last stage runs `x verify --only <steps> --json` in place of `x verify --json` — the list `x verify --only` takes, in the gate's order, refused the same way (`X_CLI_BAD_FLAG`, `fix:` the corrected `x upgrade --only …`), and refused with no `app.config.ts`, where no `x verify` runs. **Not the full gate**: `proof` is `verify-only`, `verify.notRun[]` names every step left out — of the installed CLI's gate, read off its `x verify plan --parts 1 --json` (this CLI's list when it has no plan), the summary says `NOT THE FULL GATE` and `then` names `x verify --only <notRun> --json` for CI. Every step named — of this CLI's gate, or of the installed one's — is the full gate, run and reported as one. Default: the full gate. The stages before it (codemods, manifest, doctor, guards, a Bun-floor hop's coverage rebaseline, exercise) run either way: each writes what the hop leaves.

`--to`: an exact release in the next major. Over a mixed set a run moves the LOWEST pins one major: `^19` beside `^29` is told `--to 20.x.y`, that hop rewrites only the pins at or below it (a pin above is never moved backwards) and names its walkthrough, `next` names the following hop, and the last one levels the set. A straggler jump straight to the highest major is `X_UPGRADE_HOP_TOO_WIDE`: it skipped every walkthrough between.

| `data` field | Meaning |
|---|---|
| `from`, `to` | the lowest version pinned; this hop's target |
| `next` | what a bare `x upgrade` takes after this hop; `null` when the walk is over |
| `done` | verify's verdict, and the exit code follows it. `true` when already there, `false` on a dry run |
| `dryRun` | nothing written, no gate run |
| `app` | whether the root holds `app.config.ts` |
| `proof` | what `done` rests on: `verify` (the full gate), `verify-only` (`--only`: some steps, the rest in `verify.notRun`), `scripts` or `none` |
| `section` | `{ title, url, local }` in [Upgrading](Upgrading); `local` is the same section as an `x docs` topic, printed whole offline; `null` when no major is crossed |
| `pins[]` | `{ file, name, from, to }` |
| `bun` | `{ from, to, edited[], manual[] }`. `manual[]`: `{ path, line, text, why }`, a site only you can move, listed on every run |
| `agentsMd` | `link`: `AGENTS.md` was byte-identical to `CLAUDE.md` and the hop makes it a relative symlink to it · `linked`: already one · `differs`: two different files, left alone; merge what only `AGENTS.md` says into `CLAUDE.md`, then `ln -sf CLAUDE.md AGENTS.md` · `none`: one of the two is missing · `null`: no hop planned |
| `guards` | `{ reported, missing[], differs[], installed[], withheld[], baselined[]? }` from the hop's own `x doctor`. A hop landing on 31.28 or later has `missing[]`, `installed[]` and `withheld[]` empty: shipped guards run built in. Landing earlier (`As of 31.16.0`), each missing shipped guard is written from the installed release's template and kept when `boundaries` finds nothing more with it on disk: `installed[]` names it; one the tree already breaks is taken back out: `withheld[]` is `{ name, add, findings }` (`findings: null` when the count could not be measured) and `missing[]` still lists it. `differs[]` is `{ name, refresh }`: an edited copy the hop's `vendored-guards` codemod left, never overwritten, `refresh` the edit that resolves it. `reported: false` is a CLI too old to list them, which is not the same as none |
| `guards.baselined` | `[{ name, findings }]`, absent when empty, `As of 2026-11-15`: a guard the tree breaks, kept anyway — its measured count merged into `x.verify.json` as `"guardBaseline": { "<name>": n }` (beside the app's keys; a baseline the app already wrote for it, or a floor that is not a JSON object, is never touched) and kept only when the installed CLI's `boundaries` then finds no more than before. Also in `installed[]`. `findings: null` stays withheld |
| `coverage` | a hop that moved the Bun floor re-measures unit coverage (`x verify --only unit`); only when that measurement is `X_COVERAGE_BELOW_FLOOR` is the `x.verify.json` `coverage` floor moved to it, the number that fell alone, with a dated `why`: `{ file, measured, from, to, why }`. `null` when nothing moved |
| `exerciseFloor` | `{ file, written }`: the `exercise` keys (`unprovenMax`, `statementsMax` ≥ 100) the hop's own `x exercise` measured, written into an `x.verify.json` that stated none, so the hop stays green and the floor only falls. A key the app already wrote is never touched; `null` when nothing was written |
| `coverageRaised` | `As of 2026-11-20`: `{ file, measured, from, to }` when the gate's `unit` step said `X_COVERAGE_FLOOR_STALE` (the tree covers more than its floor, a codemod's new test among the causes): each `x.verify.json` `coverage` number is set to the larger of the stated floor and the whole percent that run measured, never lowered (a floor reaching 95 drops its `why`), then `x verify --only unit` re-runs and `verify` is the verdict with `unit` replaced by that run. `null` when nothing rose |
| `manifest` | `{ ok, findings[] }`. A failure does not stop the gate |
| `exercise` | `{ reported, ok, findings[] }` from the hop's own `x exercise --json`, listed (and printed) before the gate's findings; each `fix` pastes as written. `reported: false`: the hop's CLI answered no exercise document — unknown, never a finding |
| `verify` | `{ ok, summary, failed[], findings[], only?, notRun? }`, each finding `{ step?, code, cause, fix, at? }`. `only[]` and `notRun[]` only under `--only`: the steps run, and the gate's steps this hop did not run |
| `codemods` | `As of 2026-11-15`: `{ from, to, dryRun, source, applied[] }`, each `applied[]` a codemod that ran: `{ id, since, summary, changed[], skipped[] }`; a `skipped[]` entry is `{ path, reason, diff? }`, a file the codemod would not overwrite (the app edited it), with the template's change as a unified diff to make by hand. `source: installed` — the hop's own CLI applied its list; `driver` — that CLI predates codemods, so this one applied its own. `reinstalled: true` — a `package.json` differs after the codemods (read byte for byte, never off a codemod's report), so the hop ran `bun install` again before any gate stage; `x upgrade codemods` does the same by hand. `failure: { code, cause, fix }` — the installed CLI's codemods run failed for a reason other than lacking the subcommand: nothing applied, this CLI does not stand in, and the hop is not done. `null`: no app, or already at the target, where no codemod runs (`As of 2026-11-18`; `x upgrade codemods --from 0.0.0 --json` carries an app still holding an old template's copy) |
| `superseded[]` | `As of 2026-11-15`: a workaround the hop's framework made unnecessary, read after the codemods — `{ code: X_SUPERSEDED_WORKAROUND, cause, fix, at }`. A warning, never the verdict |
| `kit` | `As of 31.53`: `{ reported, written[{ path, action }], unchanged, findings[] }` from the installed CLI's `x kit --json`; `reported: false` when that CLI predates `x kit` |
| `then` | the next thing to do, in a sentence naming the commands |

**Codemods.** A file `x new` wrote is the app's; when a release changes the template, a codemod (`packages/cli/src/codemods/<id>.ts`, `since` = the release whose template change it carries) moves the app's copy. The hop runs every codemod whose `since` lies after `from` and at or before `to`, in version then id order, before any gate stage, and leaves the edits uncommitted beside the pins. Mechanical or nothing: a file the app edited is listed in `skipped[]` with its diff and never overwritten. `x upgrade codemods --from <version>` runs the same list by hand — for a hop an older CLI drove, which applied none:

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--from` | string | required | the release the app came from (its old `@ultimat3/cli` pin); `X_CLI_BAD_FLAG` when absent or not `major.minor.patch` |
| `--to` | string | this CLI's version | the last release whose codemods run |
| `--dry-run` | boolean | off | report what would change; write nothing |

`data.codemods` is the same shape as the hop's, without `source`. A second run changes nothing.

`null` for `guards`, `manifest`, `exercise` and `verify` means no gate ran: a dry run, already there, or no app.

**Pins and no `app.config.ts`.** Needs no app: the root is the app at or above the cwd, else the nearest manifest holding `@ultimat3/*` pins, or the workspace root claiming it. No such manifest is `X_UPGRADE_PIN_UNREADABLE`; an app below that root is `X_NOT_IN_APP`, with the `cd`. With no app, `x manifest`, `x doctor` and `x verify` cannot run, so the hop runs the `typecheck` and `test` scripts the root declares: `data.scripts[]` is `{ name, ok, code, output }`, `proof` is `scripts`, and the summary says no `x verify` ran. Neither script declared: `proof: none`, `done: false`, red. It checked nothing, so it never claims otherwise.

| Bun site | Edit |
|---|---|
| `engines.bun`, `packageManager`, `.bun-version` | raised to the release's `engines.bun`, never lowered. A spelling a text edit would falsify (`1.3.x`, `>=1.3.0 <1.4.0`, `bun@1.3.6+sha512…`, `v1.3.0`) is listed in `manual` |
| `bun-version:` in YAML | same, quotes kept. An expression (`${{ env.BUN_VERSION }}`) or an x-range is listed in `manual` |
| `oven/bun:` tag | keeps its suffix and precision: `1.3-alpine` → `1.4-alpine`. A `$VARIABLE` is listed in `manual`, as is a digest whose tag is below the floor or does not state the patch (`1.4-alpine@sha256:…` at a 1.4.4 floor). `1.4.4-alpine@sha256:…` is not |

A hop below 30.0.0 reports `X_BUDGET_UNMEASURED` until `x build --target static --json` has run, as that release's `x verify` does.

## x graph · x impact

```bash
x graph [--from <node> --to <node>] [--json]
x impact <file|primitive|entity> [--json]
```

The app as one graph, rebuilt per call from the loaded app (`As of 2026-11`). Nodes: `route`,
`action`, `mutator`, `query`, `job`, `task`, `entity`, `permission`, `channel`, `tag`, `mcpTool`,
`operation`, `file`, `test`, each id `<kind>:<name>`. An edge is `from` depends on `to`, with its
provenance:

| Provenance | Source | Edges |
|---|---|---|
| `declared` | `x.manifest.json`'s facts, from the registries | `requires` (permission), `invalidates` / `reads-tag` / `revalidates` (cache tag), `exposes` (MCP tool), `publishes` (OpenAPI operation), `references` (entity), `enqueues` (task → job), `reads` (channel → entity) |
| `import` | the module graph: every app file's imports, type-only included; the test preload is an import of every test | `imports`, `declared-in` (primitive → its file, matched by identity against the registries) |
| `observed` | `.x/exercise.json`, when newer than `x.manifest.json` | `writes` / `reads` (entity), `enqueues` (job) |

`x impact` answers `{ routes, actions, queries, jobs, mcpTools, publishedOperations, tests, budgets,
opaque, provenance }`, each entry with the provenances of the path that reached it. A non-empty
`publishedOperations` means `contract-diff` will have an opinion. A file with a computed `import()`
is `opaque`: it and its dependents are in every answer. `x graph --from a --to b` prints the
shortest chain of edges, or none known and the provenances searched. A name, id or path that is
no node is `X_GRAPH_NODE_UNKNOWN` with the nearest three. Queries carry no MCP fact in the
manifest, so a query's `mcpTools` is reached only through an action that imports it.

**`x affected` in an app root** adds `data.tests`: the test files whose import closure meets the
diff (`all: true` with `forcing` when a changed file is read rather than imported — `app.config.ts`,
`package.json`, a catalog, anything outside the app).

## x client

```bash
x client vendor <name> [--from <file|url>] [--only <tag,…>] [--json]
x client customer --out <dir> [--mount <prefix>] [--only <tag,…>] [--package <name>] [--json]
```

One compiler (`$ref`, objects, arrays, enums, `const`, `oneOf`/`anyOf`, `allOf`, nullable), two emitters. `As of 2026-11`.

| Subcommand | Reads | Writes | The client |
|---|---|---|---|
| `vendor <name>` | `--from` (a file, or an https URL read through `outbound({ dial: 'public' })`); omitted, the committed `source.json` | `apps/web/clients/<name>/{source.json,schemas.ts,client.ts}` | `create<Name>Client({ baseUrl, dial, deadlineMs, headers?, deps? })`: one `outbound()` call per operation, input parsed with `t` before a byte leaves, the answer through `answer.json(schema)` |
| `customer` | the committed `openapi.json`, or the file a bearer mount declares (`--mount /v1` needs `openapi:` on that mount) | `<dir>/{index.ts,types.ts}`, plus `package.json` with `--package` | `createClient({ baseUrl, headers?, fetch? })`: plain `fetch`, no import beyond `./types`; a non-2xx is `ProblemError`, `refusalOf(error, 'op')` narrows it to the codes the operation declares; a `Retry-After` on 429/503 is waited out once (at most 60 s) |

| Flag | Meaning |
|---|---|
| `--from` | `vendor` only. A path from the current directory or an https URL. Written to `source.json` as two-space JSON, so the next regeneration is offline |
| `--only` | keep operations carrying one of these tags; a construct the compiler refuses outside them is never read. A regeneration with no `--only` keeps the tags the stamp records. Matching nothing is `X_CLI_BAD_FLAG` |
| `--out` | `customer` only, required |
| `--mount` | `customer` only: a declared bearer mount's prefix |
| `--package` | `customer` only: a `package.json` named so; publishing is yours |

| Failure | Code |
|---|---|
| a construct it does not read (`not`, `if`/`then`/`else`, `patternProperties`, a non-JSON body, a cookie parameter, a typed `additionalProperties` beside `properties`) | `X_CLIENT_SPEC_UNSUPPORTED`, the JSON pointer in the cause |
| not OpenAPI 3.0 or 3.1 | `X_CLIENT_SPEC_INVALID` |
| a vendor answer that fails its declared shape | `X_OUTBOUND_BODY_INVALID` (core's), the field in `meta.issues` |
| a documented vendor non-2xx | `X_OUTBOUND_REFUSED`, `meta.status` |

**The stamp is the build error.** Every generated `.ts` opens with `// @x-client {command, source, sourceHash, bodyHash}`. The gate's `drift` step reads it back under `apps/*/clients/` and the source globs: the source document's parsed content moved is `X_CLIENT_STALE` (fix: the stamp's own command), the body's bytes moved is `X_CLIENT_EDITED`. Reformatting `source.json` changes nothing; the `.ts` files carry `biome-ignore-all format`. Names come from `operationId`, so a `contract-diff` red is a customer's client breaking. `rpc` stays the client inside the app's own repo.

## x design research

```bash
x design research <url…> [--follow <n>] [--out .x/design] [--viewport 390x844,1440x900]
                         [--allow-hosts <h,…>] [--timeout 30000] [--json]
x design research --list [--json]
```

Measures a public reference page in Chrome over raw CDP into five artefacts per URL — shots at each viewport in light and dark, `reference.json`, a `tokens.proposal.json` that `defineTheme` accepts, `motion-map.json` (observed animation → `@ultimat3/ui/motion` call or `@ultimat3/effects` entry) and `sources.json` (licence posture). Every navigation, redirect and subresource to a private, loopback or link-local address is refused browser-wide (`X_DESIGN_URL_REFUSED`); a navigation that fails or times out is `X_DESIGN_REFERENCE_UNREACHABLE`. A cancelled `ui.research` call ends with `X_ABORTED` and publishes nothing half-written; a followed link that fails is listed in `data.skipped`, by code. Needs no app. Flags, artefacts and the ideas-only rule: [Design research](Design-Research).

## x kit

```bash
x kit [--json]
```

Writes the managed agent kit — `.claude/skills/{feature,planx,verify,upgrade,design-research}/SKILL.md`, `.claude/agents/{shape,data,server,web,audit}.md` and the `.claude/kit.json` marker — from the installed framework. Never touches an `app-*` file, `apps/web/DESIGN.md`, or an entry named in `kit.json`'s `"off"`. Needs an app root. `--json` answers `data: { written[{ path, action }], unchanged, off }`. `x verify`'s `manifest` step judges the kit: with the marker, a missing or edited managed file is `X_KIT_DRIFT` and an app file under a managed name is `X_KIT_SHADOWED`; without it, one warning naming `bunx x kit`. `x upgrade` runs it after the guards. → [Agents](Agents)

## x shot

```bash
x shot <route> [--port 0] [--out <dir>] [--no-full] [--settle 2000] [--against <png|.x/design/<slug>>]
               [--timeout 30000] [--browser <path>] [--cdp-url <ws://…>]
               [--allow-hosts a.com,b.com] [--theme light|dark] [--locale <l>]
               [--cookie name=value[,name=value]] [--expect-status 404]
               [--viewport 390x844,1440x900] [--json]
x shot --matrix [<route>] [--locale <l>] [--theme light|dark] [--viewport …] [--cookie …] [--json]
x shot --island <name> [--state <id>] [--json]
x shot --all-islands [--json]
```

**The framework's stated primary developer is an agent, and an agent cannot look at anything.** It can read a file and run a command that prints. `x shot` turns a rendered route into both.

| Flag | Default | Meaning |
|---|---|---|
| `<route>` | required | a path on the app. An absolute URL is `X_CLI_BAD_FLAG` — pointing a headless browser inside your network at someone else's site is not a screenshot tool's job |
| `--port` | `0` | the kernel picks a free one. **Never 3000**, which another project usually holds |
| `--out` | `<root>/.x/shot/<slug>/` | `.x/` is already gitignored in every scaffold. A relative `--out` resolves against the cwd, as `x build --out` does |
| `--full` | on (`--no-full` for the fold) | a fold-sized viewport crops nearly every route |
| `--settle` | `2000` | matches the hydration runtime's own `requestIdleCallback` timeout |
| `--timeout` | `30000` | one navigation |
| `--browser` | `PUPPETEER_EXECUTABLE_PATH`, then `CHROME_PATH` | refused before anything boots if the path does not exist |
| `--cdp-url` | `SCRAPE_CDP_URL` | **attach** to a browser somebody else is running instead of launching one here. `ws:`/`wss:`/`http:`/`https:`; anything else is refused before the attach |
| `--allow-hosts` | the app's host only | extra hosts the page may request |
| `--cookie` | none | `name=value[,name=value]`, `As of 2026-09-29`: set in the browser for the app's own origin before the first navigation, so a page is photographed with a cookie-held choice already made — `x shot --matrix --cookie consent=granted` shoots every cell with the consent banner answered. Applies to `--matrix` cells and `--island` states too. A name that is not an RFC 6265 token, or a value holding a space, `;`, `,`, a quote or a backslash, is `X_CLI_BAD_FLAG` before anything boots |
| `--expect-status` | absent — any 2xx | the document status this shot is ok with, `As of 2026-09-26`: `x shot /nope --expect-status 404` photographs the not-found page on purpose. Absent, a non-2xx document fails the verdict and the summary names the status. With `--matrix` it applies to every cell |
| `--locale` | the app's `defaultLocale`, **always pinned** | one of the app's `locales`, `As of 2026-09-25`. Sent as `Accept-Language` on every request the page makes, and for a non-default locale the path is prefixed (`x shot /precios --locale en` opens `/en/precios`). Absent, `Accept-Language` is still pinned to the default locale, so a picture never depends on the language of the machine's Chrome. An undeclared locale is `X_CLI_BAD_FLAG` before anything boots; refused beside `--island` |
| `--matrix` | off | every static `site/` route × every locale × `light`/`dark` × `390x844` and `1440x900` — or the `--viewport` list instead (laid out at exactly that width: scrollbars are hidden, `As of 2026-09-29` — a classic scrollbar made every capture 15 px narrow), into `.x/shot/matrix/<route>/<locale>/<theme>-<width>x<height>/` (`<theme>-<width>/` before 2026-10: two sizes sharing a width wrote one directory), plus `.x/shot/matrix/index.html`, a contact sheet of every picture with failures marked. One dev server for the whole run. A `<route>` narrows it to that route, `--locale` and `--theme` to one value of their axis; `ok` only when every cell's verdict is. Refused beside `--island`/`--all-islands` |
| `--against` | none | a PNG or a `x design research` directory: each picture compared with the reference shot of its width and scheme — `diff-<w>-<scheme>.png` and `against.{similarity,changedPercent,changedBox}` in `verdict.json`; recorded, never gating. A missing pair is `X_SHOT_AGAINST_MISSING`. Refused beside `--matrix`/`--island`/`--all-islands` → [Design research](Design-Research) |
| `--viewport` | absent — the driver's default size | `<w>x<h>[,<w>x<h>…]` in CSS pixels, `As of 2026-10` (#444): the route photographed **once per size** over one dev server, each into `<out>/<w>x<h>/` with its own `shot.png` and `verdict.json`; `ok` only when every size's verdict is, and the summary is the first failing size's. `x shot /pricing --viewport 390x844,820x1180,1440x900` replaces a hand-written browser script. With `--matrix` the list replaces the default pair. One flag holding a list, never repeated — the parser keeps a repeated flag's last value. A side outside `1..16384`, anything but digits around an `x` (`0x10`, `1e3`, `390.5`), an empty entry or the same size twice is `X_CLI_BAD_FLAG` before anything boots; refused beside `--island`/`--all-islands`, whose states declare their own `viewport` |
| `--theme` | absent — the box's own preference and the app's own `theme.defaultMode` | `light` or `dark`, `As of 2026-09-19`. Both `prefers-color-scheme` is emulated **and** the scheme is stored as the visitor's choice under `THEME_STORAGE_KEY` before navigation — the boot script since 20.2.0 answers `defaultMode` before the OS, so emulation alone photographs a dark-default app dark whatever was asked (#489). The `ui.shot`/`ui.inspect`/`ui.interact` tools' `theme` is this flag. Refused beside `--island`, which photographs both themes |

**`verdict.json` is the half that gates**, and the more important of the two files: a picture cannot tell you the island threw or logged. It carries the console lines, the island counts, the canvas size, the network tallies, `gpu` — `{ api, available, adapter, fallback }` from the page's `navigator.gpu.requestAdapter()`, recorded and never gating, `null` when the page answered no probe (`As of 31.1`) — and `blind`, which names what this capture could **not** observe. A tool that silently omits what it cannot see is worse than one that says so.

`ok` is decided by `buildVerdict` in `packages/cli/src/shot-verdict.ts` — read it there rather than trusting a count here: **nothing logged an error**, **nothing threw**, **no island failed to mount**, **the document photographed is the route asked for**, and **the document answered 2xx** (or exactly `--expect-status`; `status` and `expectedStatus` ride `verdict.json`, `null` when no response was seen — unseen never gates). A failed subresource — a missing favicon — is counted under `network.failed` and never gates. The island condition is new in 8.0.0: before it, every island's `mount()` could reject and the run still reported `ok: true`, "clean". The last matters most: a route behind `auth: 'required'` photographs the sign-in page and reports every island missing, which reads as a bug in the app when it is a bug in the capture.

**It drives `x dev`, never the static build.** `x build --target static` prerenders `site/` only, so an `app/` route would photograph the landing page. If an `x dev` is already running on the checkout it is **reused** rather than booted over — embedded Postgres is single-writer, so a second boot is `X_DEV_ALREADY_RUNNING` and no picture is ever taken. The verdict says which happened.

**`x shot` launches Chrome itself**, over raw CDP — no browser library in the app. It takes `--browser`, else `CHROME_PATH`, else the first of the probed paths (`/usr/bin/google-chrome` and its siblings), or attaches with `--cdp-url`. With none of them it answers `X_SHOT_BROWSER_MISSING`, whose fix is `export CHROME_PATH=/usr/bin/google-chrome`.

**`--cdp-url` is how a run gets a browser this box could not have started**, `As of 2026-08-24`. Every stealth provider — Browser Use Cloud, Scrapfly, Browserless, Remote Browser and the CAPTCHA-solving services — sells the same shape: create a session over their API, get a `wss://` CDP endpoint back, connect to a real un-fingerprintable Chromium behind it. `@ultimat3/scraping`'s `remoteBrowser({ cdpUrl })` has called that its **primary production path** since it shipped, and until now no CLI command could reach it: `x shot` only ever called `localBrowser()`, so a CI runner or a container with no Chrome could take no picture at all.

```bash
# A provider session — the API call is theirs, the endpoint is what x shot needs
CDP=$(curl -s -X POST https://api.example.com/v3/browsers -H "Authorization: Bearer $KEY" | jq -r .cdpUrl)
x shot /pricing --cdp-url "$CDP" --json

# A sidecar in the same compose network
x shot /pricing --cdp-url http://chrome:9222 --json
```

Three rules decide which browser a run gets, and the third is the one worth knowing: **both flags together is refused** rather than ranked (one names a Chrome to *start*, the other says the browser is somebody else's); an exported `SCRAPE_CDP_URL` is a shell-wide default, so `--browser` beside it **wins** and launches locally; and `--browser` is not read at all on an attach, so a correct remote run is never refused for a binary it will never execute. The variable is `SCRAPE_CDP_URL` and not a name of the CLI's own because `@ultimat3/scraping`'s own refusal already tells its reader `remoteBrowser({ cdpUrl: env.SCRAPE_CDP_URL })`.

**Closing an attached browser ends the remote session too** — `remoteBrowser()` calls `close()` and not `disconnect()`, deliberately: a disconnect leaves a browser somebody is billing for running until its provider times it out, and nobody attributes that bill to the run that caused it.

**Never a step of `x verify`.** A gate that needs a browser goes red for reasons unrelated to the change, and CI does not install one.

### x shot --island

```bash
x shot --island <name> [--state <id>] [--settle 2000] [--json]
x shot --all-islands [--settle 2000] [--json]
```

One **component**, in the states it declares, photographed one address at a time. A route shot answers "what does this page look like"; this answers "what does this component look like in the state a reviewer cannot click their way to" — an empty result set, a save the server refused, a quota banner.

The states come from a sibling `<name>.island.states.ts` beside the island, and that file is **pure data**: no JSX, no `solid-js`, one erased `import type`. It has to be, because the complete expected picture list is computed from it **before a browser exists**, which is what lets the run diff what it owed against what landed and refuse `X_SHOT_ISLAND_MISSING` rather than reporting a clean run with no pictures in it. An import of the component itself is `X_TEST_ISLAND_STATES_NOT_PURE`.

| Flag | Default | Meaning |
|---|---|---|
| `--island <name>` | required | the manifest's own `name`. A route positional beside it is refused — they are two different subjects, not two spellings of one |
| `--state <id>` | every declared state | one state. An id the manifest does not declare is refused by name, with the known ids |
| `--settle` | `2000` | the readiness window. Ready is **quiet**, not idle: fonts, then N consecutive frames with an unchanged network-activity counter — never "nothing in flight", which never comes for a fixture declared `pending` |
| `--all-islands` | off | **every** island in the app, in every state each declares. Its own spelling and never `--island` with no value: the parser refuses a bare `--island` ("expects a value"), so "every island" had no form a reader could type that could not be read as a mistyped name. Naming it beside `--island`, beside `--state` or beside a route positional is refused by name |

Everything else — `--out`, `--timeout`, `--browser`, `--cdp-url`, `--allow-hosts` — is the route shot's, unchanged. Pictures land at `.x/shot/island/<name>/<state>-<theme>.png`, one per state per theme, beside a `verdict.json` of the same shape and an `index.md` one level up.

**`x shot --all-islands` is the one command that answers "what does this app look like".** It expands every `*.island.states.ts` in the app through the same plan the one-island form uses, boots one dev server, and keeps **one browser per declared viewport across every island** — forty states at one size is still one launch. A state that cannot be photographed does not stop the run, and not the next *island* either: every picture the app can produce is taken, every verdict and the index are written, and only then does the missing-picture gate turn the refusals into a non-zero exit. An app that declares no states at all is refused by name rather than answered with an empty gallery — "produced nothing and exited 0" is the one outcome a reader cannot tell from success.

### .x/shot/island/index.md

The file an agent opens instead of guessing at forty PNGs. Markdown, written by **both** forms — a single-island run gets one too, because the file that says what a picture *is* cannot be a property of how many islands were asked for.

| It carries | Why |
|---|---|
| the counts, and the commands that re-run everything / one island / one state | an artifact that cannot be regenerated is one nobody trusts twice |
| what the capture could **not** see | the verdict's own `blind` list, handed in rather than reworded — two wordings would drift |
| per island: the app-relative path of the `.island.tsx` | so a reader can open the component the pictures are of |
| per state: the `id`, the `title` and the `note` | the note is the *"you cannot reach this by clicking, because …"* line, and it is the whole reason a reviewer knows what they are looking at |
| per state: one path per theme, and the state's own verdict | `ok`, or every reason it is not — a missing picture, a mount that never happened, a request no stub answers, a console error |
| per state: console **warnings** and whether the content overflows its box | **recorded, and gating nothing.** A signal that fails a run is a signal an author switches off, and a box its content spills out of is the commonest ugly-UI symptom a pixel-tight PNG cannot show. `stateShotOk` reads neither |

**One session per picture**, and it costs a browser launch each: `page.console()` and `page.pageErrors()` are bounded rings over the whole *session*, so a shared one files state A's console errors under state B — and per-state attribution is the half of the artifact that gates.

**An unstubbed HTTP request fails the run.** The page's seal replaces `fetch` and `XMLHttpRequest` before the island's chunk is imported, answers the state's `routes`, and publishes everything else; the capture refuses with `X_SHOT_ISLAND_UNSTUBBED_REQUEST` naming each method and path. A component whose fetch quietly hangs paints its own loading branch, and the picture then shows a fixture gap dressed up as a real component state.

**A socket needs no stub, `As of 2026-09-17`.** `WebSocket` and `EventSource` are replaced with an INERT stand-in rather than a refusal: no real dial, no network, no message and no error ever delivered; `close()`/`send()` are no-ops. A snapshot of an island does not need a *live* socket — every state's fixture already rides `props`/`routes` — so a component whose `mount()` unconditionally dials `@ultimat3/realtime`'s `LiveClient.connect()` used to fail **every** state of **every** such island with `X_SHOT_ISLAND_UNSTUBBED_REQUEST`, and the error's own `fix:` told the author to declare a stub whose `match` the harness's `"<METHOD> <pathname>"` grammar can never accept — `WS ws://…` matches no `isStubMatch`, so the printed remedy could never be run. `readyState` DOES leave `CONNECTING` once, on a zero-delay timer that fires `onopen`/an `'open'` listener and nothing else — a component whose `mount()` awaits the socket's own open event before rendering anything (not true of this app's `LiveClient`, whose `connect()` registers callbacks and returns, but not a fact this harness may assume of every app) would otherwise hang the mount forever, trading one impossible `--settle` deadline for the unsatisfiable stub fix this defect was about. Each socket a component constructs is recorded on its own `sockets` list instead — in the readiness probe, on `IslandStateShot.sockets`, and in `--json` — never on `unstubbed`, and `stateShotOk` reads neither: a component legitimately holding an open, silent channel is not the same fact as a request nobody stubbed, and this list gates nothing. Not a candidate for the blind-spot list below, either — that list is for a fact a *picture* cannot show, and both `sockets` fields ride `--json` plainly. A real unstubbed `fetch`/XHR is unaffected and still fails the run exactly as above.

**Open popups are in the frame** (`As of 2026-09-29`). The crop is the union of the target's box and every visible `[role=listbox]`, `[role=menu]`, `[role=dialog]`, `[role=alertdialog]`, `[role=tooltip]`, `dialog[open]` and `:popover-open` in the harness — portalled or not — so a combobox state declared `open` photographs its listbox instead of a closed input. `verdict.json`'s `box` stays the target's own box.

**The picture is the crop target plus a small margin.** The rectangle is the state's declared selector, or the island's host element, translated out of viewport coordinates into the page's — `As of 2026-08-26`; measured before that, 720×560 for a component whose own box the same verdict reported as 688×104. The margin came later, because a pixel-tight crop shaves off everything a component paints *outside* its border box — a `box-shadow`, an outline, a focus ring, a hairline border on a subpixel — and a reviewer then reads a component with no elevation as flat, which is a change the component never made. It is clamped to the document at both ends, so the frame never starts in negative space and never runs past the page, and it may only ever make the frame **bigger** than the component's own box.

**Both themes are photographed by emulating `prefers-color-scheme`**, not by setting an attribute — `As of 2026-08-26`. An attribute on the document is the *outcome* of a theme decision and the component owns it: one that resolves `'system'` itself deletes or overwrites it on mount, so the harness is silently overruled and both pictures converge. Measured on the reference app, `<state>-light.png` and `<state>-dark.png` came back byte-identical, same md5, from two addresses that really did serve different documents. The attribute is still set, because it is right for a component that *reads* a theme it does not own.

## x pr · x ci

```bash
x pr review [--pr <n>] [--repo owner/name] [--all] [--full] [--json]
x pr resolve <thread-id> [--json]
x pr reply <thread-id> --body "…" [--json]
x ci [runs] [--branch <name>] [--run <id>] [--repo owner/name] [--tail <n>] [--full] [--workflow <name>] [--event <push|pull_request|workflow_dispatch>] [--json]
x ci tested [--max-age 24h] [--repo owner/name] [--workflow ci.yml] [--json]
```

**`gh pr view --comments` does not show inline review threads.** It shows *issue* comments; the actionable findings are anchored to lines and reachable only through GraphQL, and the thread id needed to resolve one exists nowhere else. That is the whole reason `x pr` exists — otherwise every team on Ultimate rediscovers the same query.

Two hazards it encodes, both of which have bitten in this repo:

| Hazard | What `x pr review` does |
|---|---|
| **A review decision goes stale.** It survives later pushes, so `CHANGES_REQUESTED` can predate the commits that addressed it | compares the deciding review's **commit oid** against `headRefOid` and says `stale` outright. Not timestamps — two reviews seconds apart can straddle a push, and the timestamp then calls one of them current |
| **An outdated thread has `line: null`** | selects `originalLine` too, so a thread whose diff moved still has a locator instead of arriving anchorless |

It reads `latestOpinionatedReviews`, not `reviews(last: n)`: the most recent reviews are often all `COMMENTED` at the current head, so dating the decision from "the newest review" reports a stale `CHANGES_REQUESTED` as current — the hazard, inverted.

**`--json` carries the whole conversation, additively** (as of 2026-11, 31.1.0): beside `threads`, `reviews` (every review: `state` — `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, … — `author`, `isBot`, `commit`, `stale`, `body`), `comments` (the PR's issue comments, `updatedAt` included), `reviewsTruncated`/`commentsTruncated` (newest 50 each), and `bots` — one row per review bot: `{ login, reviews, comments, lastReviewAt, notice, blocked }`. `notice` is the newest "did not review" notice the bot posted as a PR comment — recognised by CodeRabbit's `<!-- … by coderabbit.ai -->` tag or a heading that begins with the notice's title, never by a phrase in prose; a submitted review is never one (`kind: 'rate-limited'` — CodeRabbit's rate or review limit; `kind: 'skipped'` — review skipped, too many files), and `blocked: true` means no review of its came after it: no new threads is a review that never happened, not a clean one. Bodies are clamped like thread bodies; `--full` lifts it. Same one GraphQL round trip. The human render adds one count line and, per bot with a notice, one line: `<bot> did not review: …` when blocked, else `<bot> posted a … notice at …, then reviewed at …`.

**Resolving closes a conversation, not a finding.** Whether the code is fixed is a fact no GitHub mutation observes, and `x pr resolve` says so rather than implying otherwise.

`x ci` exists because *"`gh run view` prints a tree of ticks and one cross, and the error is inside a per-job log that is mostly setup noise."* For a `verify` job the log tail **is** the findings block — this repo's gate already prints `X_*` codes and executable `fix:` lines — so `x ci` reads them back out into `findings[]` in the standard shape. `cause` and `fix` are the text the gate wrote, with every transport wrapper undone — `##[group]`, `##[error]`/`##[warning]` prefixes, an echoed `::error …::` command (its `%0A` decoded), and a `<comment id=…>` fence a nested `x ci` printed; the log's foreign origin is `source: 'ci-log'` and the job `meta.job` — printed on the finding's head as `[from=ci-log <job>]` — never markup inside `fix`. `ok: false` iff a run failed; `ok: true` means *no failed run* — an in-flight or queued run still completes with `ok: true` and is reported through the `running > 0` line and a per-run `headSha`, not as a green verdict. `x pr review` always exits 0, because unresolved threads are the work to do, not a failure of the command that listed them. The two flags narrow the `gh run list` server-side — `--workflow` takes the workflow name or filename (`ci.yml`), `--event` takes `push|pull_request|workflow_dispatch` — so `x ci --workflow ci.yml --event push --branch main` answers *"is main's push CI green"* instead of folding every main-branch workflow into one verdict.

**`x ci tested` answers whether a push may reuse a green pull-request run** — `{ tested, condition, reason, pr?, run? }`, for `GITHUB_SHA` or `HEAD`. `tested: true` needs all of: the subject ends `(#N)`; PR N merged as this very commit; its head is in this repository (a fork's run is never reused); its head tree is this tree; the newest same-repository run of `--workflow` (default `ci.yml`) on that head concluded `success`, under `--max-age` old (default `24h`: the runner image and the registry move). Any doubt — a condition unmet, `gh` absent, an API that did not answer — is `tested: false` and a full run. Exit 0 on every answer, so a workflow reads `data.tested`; only an unreadable `--max-age` refuses (`X_CLI_BAD_FLAG`). The workflow shape that consumes it: [CI-Parallel-Gate](CI-Parallel-Gate.md#a-push-a-green-pr-run-already-tested). As of 2026-11.

**Neither is a step of `x verify`.** A gate that needs network and a GitHub token goes red for reasons unrelated to the change.

## x errors

```bash
x errors [explain <CODE> [--recent]|list] [--json]
```

`--recent` (in an app) adds what THIS app has seen of the code: its groups in `x_error_groups`
(count, first and last seen) and the bundles `x_failures` holds, each with its `x repro` line.

The [Error codes](Error-Codes) table, programmatically. Runs outside an app: triaging a code must not need an app root.

```bash
$ x errors explain X_CURSOR_INVALID --json
{"ok":true,"command":"errors","summary":"X_CURSOR_INVALID — pagination cursor is malformed…",
 "data":{"code":"X_CURSOR_INVALID","cause":"pagination cursor is malformed, tampered with or from
 another query","fix":"after: null   // drop the cursor and request the first page again",
 "docs":"https://github.com/developerz-ai/ultimate/wiki/Error-Codes",
 "site":{"at":"@ultimat3/core/src/cursor.ts","line":28}}}
```

`site` is the CLI locating a throw site in the tree — it is **not** a field the thrown error
carries. A code raised at more than one site gets one of them, named in the `fix` line; run the
command rather than quoting the line. `docs` is `ERROR_DOCS_URL`, the same URL for every code.

`list` enumerates every registered code, and names under `data.unavailable` any package this process could not import — a list silently missing codes is worse than one that says which. An unregistered code is `X_ERROR_CODE_UNKNOWN` with the nearest real code as its fix; the command never invents an explanation.

**An app's own codes answer inside the app** (`As of 2026-11-19`, `packages/cli/src/cmd-errors-app.ts`). A code the framework does not know is looked up after `loadApp` registers the app's `defineError()` declarations: the answer is the registered title, the `cause:` / `fix:` read off the declaration's text (never by constructing the error), `status`, and the declaring `file:line` as `site`; `--json` carries `{ code, title, cause, fix, docs, status, site }`. Framework codes pay no load. A near miss of a framework code keeps its suggestion. Otherwise `X_ERROR_CODE_UNKNOWN`, its fix inside an app `grep -rn <CODE> apps packages`, outside one `x errors list --json` naming the `--cwd` form.

## x repro

```bash
x repro <jobId|requestId|traceId|fingerprint> [--write] [--verify] [--json]
x repro --list [--code X_…] [--json]
x repro --from <file> [--write] [--verify] [--json]
x repro <id> --bundle [--include-rows] [--json]   |   x repro --from <file> --bundle [--include-rows] [--json]
```

A production failure becomes a failing test. `As of 2026-11`.

| Subject | Read from | Written as |
|---|---|---|
| a dead job (`x_jobs` id) | its row and its steps — capture off or on | `repro/repro-<id>.job.test.ts`: `reproJob(runJobs, …)` replays the completed steps from their stored output and runs once more |
| a captured 5xx (request id, trace id, bundle id, or a fingerprint's newest) | `x_failures`, written when `failureCapture.enabled` (`x dev`: always) | `repro/repro-<id>.contract.test.ts`: `reproduce(bundle, { driver })` seeds the rows the call read, freezes the clock at the failure, invokes as the actor |

The written test is RED until the fault is fixed. `--verify` runs it: `data.reproduced` is true
when it failed with the captured code; otherwise the answer is `X_REPRO_NOT_REPRODUCED`, naming
the masked fields and the captured build — a fault in the database or a different build replays
green. Masked input (`.sensitive()`, secret-named keys) and masked columns are stood in for from
the schema. `--list` reads the bundles with each group's count and last sighting. An id nothing
holds is `X_REPRO_UNKNOWN`; a request id with capture off is `X_REPRO_CAPTURE_OFF`.

**`--bundle` carries the failure to an issue** (`As of 2026-11`): one JSON file,
`repro/bundle-<id>.json` (the scaffold's `.gitignore` keeps it out of a commit), deterministic
bytes, meant to be read before it is attached — its `readFirst` lines say what is in it and what
is not found. Never with `--write`/`--verify`; `--include-rows` without `--bundle` is refused
(`X_CLI_BAD_FLAG`).

| Section | Holds |
|---|---|
| `framework` | every installed `@ultimat3/*` package and the versions found of it, the CLI's, Bun's, the platform |
| `error` | the code, the cause, the stack's `at …` frames — from the job row, a `--from` file's `error`, or the error group's sample only when that sample is this request's own |
| `schema.entities` | the declarations of the entities whose rows the call read — never the whole app |
| `subject` | the failure, as `x repro --from` reads it back. Always: input masked by the primitive's `.sensitive()` schema and core's `captureValue`, rows minus sealed columns, a row of an undeclared entity dropped (`dropped`, `truncated: true`). By default also: every value that is not a key — input leaves, row columns other than the primary key, a declared reference or an `…Id`, step outputs — is `[redacted]` (a step's number `0`), listed as masked so the replay stands it in from the schema; the actor's org is a placeholder uuid everywhere it appears |
| `masked` / `scrubbed` | the masked paths; the env var NAMES whose values were found, the count of hostnames |
| `reproducer` | the test, rendered from `subject` alone, against the scaffold's `apps/web/api` and the `@app/db` placeholder |

| Flag | Does |
|---|---|
| `--include-rows` | real values for those non-key fields, and the real org — read them before sending. Secrets, `.sensitive()` fields and sealed columns stay masked |

Replaced everywhere (never in the primitive's name, the code or the reproducer's imports): the app
root (`.`), the home directory (`~`), an env value that is secret-named, a URL or from the app's
`.env*` files (`[env:NAME]`; 6+ characters, any length under a secret name) — and an env URL's
user and password raw, URL-decoded and base64 (a Basic header) —, every hostname in
`app.config.ts` or an env URL (`[host]`), any URL's userinfo (`[cred]@`) and query values
(`?k=[redacted]`), emails (`[email]`), IPv4/IPv6 addresses (`[ip]`); in a cause or frame, any other
absolute file path (`<abs>/<file>`). **Not found**: a value this machine never knew — a
production-only secret, a customer's name in a cause.

**A bundle is untrusted input.** `bunx create-ultimate repro <bundle.json>` reads only its
`subject`, checked field by field (`X_REPRO_BUNDLE_INVALID` otherwise, control characters
included), and renders the test from it; the bundle's own `reproducer` text never reaches disk.
It opens into a scratch app (`repro-<id>/`), the test under `repro/`, linked to the framework
checkout the command runs in (or `--framework <checkout>`) through `file:` overrides.

## x docs

```bash
x docs "<question|topic|symbol>" [--limit <n>] [--json]
```

**The first lookup**, before stating or working around a framework limit. Offline, no app needed. `As of 30.0.0`.

| Reads | Topic |
|---|---|
| every installed `@ultimat3/*` package's `README.md`, `CLAUDE.md` and source headers — the app's direct dependencies and the CLI's own | `<pkg>.<module>`, `<pkg>.README#<anchor>` |
| this wiki, shipped in the `@ultimat3/cli` tarball (`wiki/`) — every page but Error codes | `wiki.<Page>`, `wiki.<Page>#<anchor>`, the anchor GitHub renders |
| an `X_*` code | redirected to `x errors explain <CODE>`, the one way to a code |

A question is ranked; a `Page#anchor` topic (`x docs Upgrading#28x--2900-entry-by-entry`) prints that **whole section**, subsections included, and nothing past it. **`x docs <topic-id>`** (`As of 2026-11-19`) prints one topic's body: the id is what every search line starts with — `jobs.retry` (a module: its header comment, its exports, its file), `jobs.README#one-job-per-org-from-a-schedule` (a package guide: that whole section, subsections included), `wiki.Upgrading#<anchor>` (a wiki section). Quote an id that carries `#`. A search's last line is the command for its first hit (`x docs jobs.retry   # any topic id above prints that section whole`); a query that is exactly a topic id answers that topic alone, not a ranked search. `x upgrade --json`'s `section.local` is that topic. A search hit carries a capped excerpt.

A question is ranked by its task words too (`As of 31.22`): a synonyms table maps a word that names one task to the mechanism that does it — `paginate` → `keyset`, `poll`/`interval` → `pollEvery`/`visibleInterval`, `concurrency` → `mapBounded`, `latest` → `latestBy`, `typing` → `debounce`, `advisory` → `lockKeys`, `denormalize` → `countedIn`, `memoize` → `retryMemo` — and a page that exports the mechanism outranks prose about the task. The dev MCP's `docs.search` is this command.

The ranking — which hits, in which order — is **not a stable surface**: a minor may reorder it. The `--json` shape is. An install with no `wiki/` still answers from the packages, with an `X_CLI_UNEXPECTED` finding.

## x fix

```bash
x fix boundary <file> [--json]
```

The minimal cut for an import that crossed a surface boundary — the command every `X_SURFACE_BOUNDARY` finding names in its `fix:` line. It prints a plan and **writes nothing**; there is no `--write`.

`site-imports-app` (`X_BOUNDARY_SITE_TO_APP`) is one finding per crossing edge — the first import in the chain that lands on `app/` — reported at the file that writes it, with the chain from the `site/` entry in `cause`. Imports below the crossing are `app/ → app/` and are never reported, by the gate or here: one illegal import is one finding and one edit (`As of 2026-11-19`; `classify()`, `packages/render/src/surfaces.ts`).

For each violation involving the file it reports the offending edge, the full chain that makes it one, and the edit to make. For the `shared/` fattening case it generates the split: when exactly one surface reaches the module **and the module lands on the same surface as the file it imports**, the plan carries the `git mv` plus every import specifier that move invalidates — the move alone is not a repair, it just relocates the break. When two surfaces reach it, or when relocating would leave the forbidden edge exactly where it was, the module has to be cut by hand and the plan says so rather than guessing.

`<file>` is app-root-relative, or any suffix that matches exactly one source file — the short form a `fix:` line emits. Errors: `X_FIX_TARGET_UNKNOWN` (with the nearest real path as its fix), `X_CLI_BAD_FLAG` on an ambiguous suffix.

## x token

`As of 2026-11`. The app's machine credentials — the keys an MCP endpoint's `apiKeyResolver` and the `/v1` mount accept — in the framework's `x_api_keys`, through `@ultimat3/auth`'s `issueApiKey` / `describeApiKey` / `revokeApiKey`. No default subcommand: `create` writes a credential.

| Subcommand | Does |
|---|---|
| `create --scopes <a,b> [--user <id>] [--org <id>] [--env dev\|stage\|prod] [--days n]` | issues one key carrying exactly those scopes (a wildcard is `X_CONFIG_INVALID`). `--env` unsaid is the environment's label: `ULTIMATE_ENV` (else `NODE_ENV`) production → `prod`, staging → `stage`, else `dev`; an unreadable `ULTIMATE_ENV` reads as `prod`. `--user` cuts its scopes to what that user may do and stops it when the user is disabled. The plaintext is printed **once** — in the human lines, or `data.token` under `--json` — and never in the summary; only its SHA-256 is stored |
| `list --owner <id>` | the keys of a user or org, as `describeApiKey` answers them: no hash, no secret. A key issued with neither is listed by nobody and revoked by its id |
| `revoke <id>` | revokes it; an unknown or already-revoked id answers `revoked: false`, exit 0 — neither is a key that works |

Every flag is read before the database opens: a refusal costs no boot.

## x merge-driver

`As of 2026-11-19`. `x merge-driver install [--json]` · `x merge-driver run <base> <ours> <theirs> <path>` — how two branches that each generated a feature merge with no hand edit. The rules and what stays a conflict: [Merging two features](Many-Agents#merging-two-features).

| Form | Does |
|---|---|
| `x merge-driver install` | writes `merge.x-registry.*` and `merge.x-generated.*` into `.git/config`; `data.installed: false` outside a git checkout. `bun run setup` runs it; `x doctor` warns `X_MERGE_DRIVER_UNSET` where it never ran |
| `x merge-driver run` | what git invokes, with its temporary files. Exit 0 merged; exit 1 left the markers in the file and reports `X_MERGE_UNRESOLVED` |

## x logs

`As of 2026-11`. `x logs tail [--lines n] [--role <role>]` — the last `n` lines (default 100, at most 10,000) of `.x/dev.log`, which `x dev` tees; with `--role`, that role's `.x/logs/<role>.log` when one was written, else the dev log's lines whose `role` field names it (`As of 2026-11-15`). The `logs.tail` MCP tool's reader (`mcp-host-logs.ts`), so both answer the same lines. A `--role` that is not a runtime role is `X_CLI_BAD_FLAG` before any path is built; no dev log yet is `X_DEV_LOG_ABSENT`, fix `x dev`.

## x explain

`As of 2026-11`. `x explain <query> [--input '<json>'] [--org <id>]` — the query run once on the app's dev database (rows discarded; its policy is not asked, as `explainQuery`'s is not), every statement it **sent** captured off `db.statement` and planned by `sweepPlans`: the oracle the `exercise` step judges with. A read no declared index serves is `X_QUERY_UNINDEXED` / `X_QUERY_SORT_UNSERVED` with the `indexes:` entry as its fix, exit 1. A query over a tenant-scoped entity needs `--org`, else `X_CLI_BAD_FLAG`. Tables the dev database lacks are listed as not planned — run `x db migrate` first. An external `DATABASE_URL` where `ULTIMATE_ENV` (else `NODE_ENV`) resolves production — or `ULTIMATE_ENV` is unreadable — is refused before anything opens, `X_EXPLAIN_PRODUCTION_DATABASE`: the query would be sent for real with its policy skipped. Plan on the embedded database, or on a staging restore under `ULTIMATE_ENV=staging`.

## x profile

`As of 2026-11`. `x profile <route> [--runs 20] [--top 10] [--json]` — the app booted in this
process (`x dev`'s boot, web role, an ephemeral port, the same `.x/dev.lock` claim — so a running
`x dev` on the checkout is `X_DEV_ALREADY_RUNNING`), the route requested once to warm it, then
`--runs` more through the pipeline's in-process dispatch under JavaScriptCore's sampling profiler
(`bun:jsc`, 100 µs). Reports the `--top` hottest functions by self samples:

| `--json` field | Meaning |
|---|---|
| `route`, `status`, `runs` | what was rendered, the warm-up's status, how many requests were sampled |
| `samples`, `intervalMicros` | samples taken and the sampling interval |
| `hottest[]` | `{ name, file, line, self, total, selfPercent }` — `file` root-relative for the app's own, `native` for a frame with no source; `total` counts samples with the function anywhere on the stack |

A route answering `>= 400` is profiled and reported red, `X_PROFILE_ROUTE_FAILED` (fix: `x routes
--json`). An absolute URL, a missing route or a `--runs` outside 1–10000 is `X_CLI_BAD_FLAG`.
