# CLI reference: project

Part of the [CLI reference](CLI-Reference): `x new`, `x dev`, `x stop`, `x g`. Conventions, global flags and the command index are on the index page.

## x new

```bash
x new <name> [--dir path] [--shape api|blog|dashboard] [--no-example] [--no-git] [--dry-run] [--force] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--dir` | string | cwd | parent directory to create the app in |
| `--example` / `--no-example` | boolean | `true` | include the example feature slice (default: on; `--no-example` for an empty `app/`) |
| `--shape` | string | none | start from an app shape — `api`, `blog` or `dashboard`, each an overlay over this scaffold ([Shapes](Shapes)). An unknown name is `X_NEW_SHAPE_UNKNOWN`; with `--no-example`, `X_NEW_SHAPE_CONFLICT` (a shape is its own example). Both refuse before a file is written. `dashboard` then runs `x g sign-in --password` in the new app (listed under `data.generate` by `--dry-run`); a refusal there is `X_NEW_SHAPE_GENERATE_FAILED` |
| `--git` / `--no-git` | boolean | `true` | `git init`, then one commit named `x new`. On by default because three surfaces assume a repository — `x affected`, `x ci` and `x pr`. A git that is absent or fails never fails `x new`: the tree is the verdict, and `data.git` carries `{ initialized, committed, problem }` |
| `--dry-run` | boolean | `false` | print the file list, write nothing |
| `--force` | boolean | `false` | write into a directory that already exists and holds no `app.config.ts`, only into free paths: one path the scaffold would write already on disk (`README.md`, `package.json`, `.gitignore`, …) refuses the run before a byte is written — `X_GENERATE_CONFLICT`, the first five taken paths and a count in `cause`, the same free-directory fix. Never an overwrite. A fresh clone holding `.git` and a `LICENSE` scaffolds. Over an app it is refused, `--force` included (`X_GENERATE_CONFLICT`), and the fix names a free directory (`<name>-2`), never `--force`. `As of 2026-11` |

**The name must be one `app.config.ts` accepts.** `x new` asks core's own `defineConfig` about the slug before anything is planned (`appNameIssue`, `packages/cli/src/app-name.ts`) — it is written verbatim as `name:`. Refused with `X_CLI_BAD_FLAG` and a corrected name in the `fix:`, the rest of your flags kept:

| You type | Why it is refused | `fix:` |
|---|---|---|
| `x new 9lives` | starts with a digit — core's pattern is `^[a-z][a-z0-9-]{1,63}$` | `x new app-9lives` |
| `x new a` | one character | `x new a-app` |
| a slug over 64 characters | past the pattern's bound | the slug cut at 64, trailing `-` dropped |

```bash
$ x new myapp --dry-run --json
{"ok":true,"command":"new","summary":"…","data":{"dir":"/home/me/myapp","files":["README.md","AGENTS.md",…],"dryRun":true}}
```

**This page states no file count, deliberately** — one template added moves it, and a number hand-copied onto four pages goes stale on three of them. `scripts/generator-counts.ts` is the single source: it re-derives both shapes from the CLI's own generators and, as a step of `x verify`'s `manifest` check, turns any page quoting a stale one red on the same commit. Two moves worth knowing about rather than counting: the scaffold gained `apps/web/app/auth/dev-actor.ts` and its test, because `hooks.authenticate` is the only place an actor can come from and a generated app configured none — so every route declaring a `policy:` refused every request and the boot warned `X_CONFIG_INVALID` on every start; and it gained `.github/workflows/ci.yml`, which runs `bun run setup && bun run verify` on every push and pull request. Derive the number:

```bash
x new myapp --dry-run --json | jq '.data.files | length'
```

`--dry-run --json` lists every file, which is also how you check what a build target expects to find.

Deployment artifacts are part of the scaffold — an app is deployable the moment it is generated:

| Path | Why |
|---|---|
| `apps/web/server.ts` | the production entry: `runRole({ root, env: Bun.env })`. Also `--target binary`'s entry |
| `apps/web/prerender.ts` | `--target static`'s entry |
| `docker/Dockerfile` | `--target docker`'s entry. Defaults `ROLE=web`, `PORT=3000`, health-checks `/readyz` |
| `docker/Dockerfile.dockerignore` | **this exact name** — not a root `.dockerignore`. Drops `*.test.ts`, `*.test.tsx` and the root `docs/`; an app serving a file from `docs/` re-includes it with `!docs/<path>` |
| `docker/docker-compose.prod.yml` | one service per role: migrate, web, sync, worker, scheduler |
| `docker/docker-compose.dev.yml` | parity checks only; `x dev` needs none of it |
| `docker/helm/` | the chart, 12 files — `Chart.yaml`, `values.yaml` and 10 templates (`_helpers.tpl`, `_volumes.tpl`, `deployments`, `service`, `migrate-job`, `ingress`, `hpa`, `networkpolicy`, `servicemonitor`, `alert-rules`). Written `As of 2026-08-19`, which is what makes `x deploy --method helm` work in a scaffold; the last two render only where the cluster serves the Prometheus operator's kinds (`auto`) |
| `docker/README.md` | how the two compose files differ |
| `.github/workflows/ci.yml` | the generated app's own CI: `bun run setup` then `bun run verify`, on push and pull request — the same two commands its `README.md` opens with |
| `bin/setup.ts` | TypeScript Bun runs, never shell — `package.json`'s `setup` script (`bun bin/setup.ts`), so `bun run setup` is the same command in PowerShell, cmd and bash; `bun run dev` is `x dev` and `bun run verify` is `x verify`, and neither needs a file. There is no `bin/check.ts` `As of 30.0`: `x verify`'s `budgets` step builds when the stats are missing or stale, so a wrapper that built first would be a second name for the gate |

The framework repo's own `docker/helm` carries one template the scaffold does not — `pdb.yaml`, cluster policy rather than app topology. It ships in no npm tarball, so copying it is a `git clone` of this repo, not an install. An app chart from before the monitoring pair gets it from `x g chart-alerts`.

`bunx create-ultimate myapp` is the same generator without a global install — and it says so in its own refusals, `As of 2026-08-23`: a `fix:` line is a command the reader is meant to RUN, and `x new myapp` named a binary they have not installed yet. Errors: `X_GENERATE_CONFLICT` (the directory exists — `fix` is the same command with a free name, `<name>-2`; never `--force`), `X_CLI_BAD_FLAG` (no name given, or a path where a name goes), `X_BUN_VERSION`.

## x dev

**The ready line names the live feed, `As of 2026-09-05`:** `live=in-process` under the embedded
database (repository writes in this process reach subscribers — the bridge PGlite's missing
walsender needed), `live=replication` with a real `DATABASE_URL` (the WAL decoder, `--role
replicator` here or elsewhere), `live=none` without the `sync` role. `--json` carries it as
`liveFeed`. The app's MCP endpoint, when `apps/<app>/mcp.ts` exports one, prints as `mcp POST /mcp`
in the summary and `mcp` in `--json`; an app exporting several prints one line per endpoint, and
`--json` lists them all in `mcpPaths`, endpoint #0 first.

```bash
x dev [--port 3000] [--host 0.0.0.0] [--tls] [--role web,worker] [--once] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--port` | string | `3000` | HTTP port. The `sync` role listens on `--port + 1` |
| `--host` | string | `localhost` | the interface every socket binds — web, `sync`, metrics: one decision. `localhost` or an IP literal (`0.0.0.0`, `::`, `192.168.1.5`, `[::1]`); a hostname or a typo is `X_CLI_BAD_FLAG`. `HOST` is not read here (the container's variable must not widen a dev shell). A wildcard is reported as `http://localhost:<port>`; `--json` carries `host` |
| `--tls` | boolean | `false` | the web listener serves https with a generated self-signed ECDSA certificate (no openssl, no dependency), cached in `.x/tls/` — `cert.pem`, `key.pem` (0600) — and regenerated when its names change or within 7 days of its 90-day end. It carries `localhost`, `127.0.0.1`, `::1` and a specific `--host` address. The summary prints the path; `--json` carries `tls.certPath` (`null` without the flag). Trust it once: `curl --cacert .x/tls/cert.pem`, or the OS keychain. No HSTS in dev — a browser pins it per host, every localhost port at once. The `sync` port and the metrics endpoint stay plaintext |
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

**`/_x` stays loopback-only whatever `--host` binds, `As of 2026-11`:** a non-loopback `Host` is
`X_DEV_HOST_REFUSED` (421), and a non-loopback peer naming a loopback `Host` is
`X_DEV_PEER_REFUSED` (403) — the peer as the pipeline resolves it (`TRUSTED_PROXY_HOPS` honoured,
so a terminator in front forwards the real client's address). Bound to one specific non-loopback
address, nothing loopback listens: the summary prints `introspect none` and `--json`'s
`introspect` is `null`. Over `--tls` the same two checks hold.

**What it watches is decided before a descriptor is taken, and the ignore set is your own
`.gitignore`, `As of 2026-09-06`.** `x dev` walks the app root and opens one non-recursive watcher
per directory it admits, skipping an ignored one at descent rather than filtering its events
afterwards — a recursive watch on the root took an inotify descriptor per directory in the tree,
including `.git/`, `node_modules/` and the `.x/` this same process writes to continuously (measured:
110 descriptors on the reference app, 39 of them noise; 1901 on a monorepo root, 1490 of them
`.git/` and `node_modules/`, against a per-user budget of 8192 on many distributions). The rules are
git's own — an unanchored `coverage/` matches at any depth, a leading `/` or an inner slash pins the
pattern where it is written, `!` re-includes, a trailing `/` matches a directory and never a file —
and ignore files in ancestor directories up to the repository root count, so an app inside a
monorepo inherits it. Editing `.gitignore` re-reads it and re-walks the tree in place; no restart,
and nothing ever runs `git check-ignore`. Five directory names are ignored whatever your file says,
because it cannot be relied on to name them: `.git`, `.x`, `node_modules`, `.personal`, `.claude`.
**`dist` and `coverage` are not among them** — root-anchor them in your `.gitignore` (`x new` now
scaffolds `/dist/` and `/coverage/`) or an `apps/web/site/coverage/page.tsx` route is a directory
git will not commit and the dev loop will not reload. A save that touches five files is one reload,
and a save arriving while a reload is still building is one more reload after it, never a second one
racing it.

**What a reload changes, `As of 2026-09-27`.** Every file the process loaded is hashed on each
reload; a changed one — a component, a helper, a `.module.scss`, a Sass partial a sheet `@use`s, a
JSON catalog — leaves Bun's module registry together with every module that imports it, up to the
route modules, and the scan imports that chain again. A route module that comes back as a new
instance has its entry replaced, so the next request serves what is on disk; its islands are
re-bundled on the same tick, so the two are one generation; the `isr` store is emptied, so a page's
first render does not answer for its whole ttl. A save that will not import is a finding on `/_x`
and the last page that did import stays up. The replaced instances are collected — nothing is kept
per save ([`app-reload-graph.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/app-reload-graph.ts)).

A module that **defines a primitive** — it exports an entity, an action, a query, a mutator, a job
or a task, or it is `apps/web/api/index.ts` — is pinned: never re-evaluated, and the invalidation
stops at it: its exports are held by every importer and by a registry that refuses a second
definition of one name. **A save that reaches one restarts `x dev`, `As of 22.12`** — the pinned
module itself, or anything it imports: a slice's `service.ts` under its query, an admin page's view
under `defineAdmin`. `x dev` is a supervisor and a child: the child prints
`restarting: <saved file> under <pinned module> — …` on stderr, **retires its worker first** — it
stops claiming and waits for every running job to finish, aborting none (`As of 25.0.0`; before, the
drain cut off a job running past `drain.deadlineMs` with `X_DRAINING` and the next child ran it
again), printing `restart waits for <n> running job(s) to finish — …` while it waits, `Ctrl-C`
cutting the wait short at the drain deadline — then drains, releases the port, the lock
and the embedded Postgres, and exits `75`; the supervisor boots a fresh child on the same port
(`--port 0` is pinned to one free port before the first boot). Every other save stays the in-process
reload above, and `Ctrl-C` stops both. `--once` and an embedded `startDev()` are unsupervised: there
the save is `X_DEV_RESTART_REQUIRED` on `/_x` (or `startDev({ onRestart })` is called). With
`--json`, each child prints its own ready document. Until 22.12 such a save logged `reloaded` and
served the old code until a manual restart. The route's guard (`policy`) is read by the HTTP
pipeline at boot, so adding one is a restart too, and so is an edited site asset under an unchanged
stylesheet that names it with Sass `asset()`. Until 2026-09-27 only the edited route module itself
was re-imported (`?x-reload=<hash>`), and every component it imported stayed the cached one: `x dev`
logged `reloaded` and rendered the old component until a restart.

**The database is part of the verdict, `As of 2026-11-19`.** While the migrations on disk are ahead
of the database `x dev` serves, or an applied one was edited since, its banner is `✗ dev ready`
(`ok: false` under `--json --once`) with `X_APP_MIGRATIONS_UNAPPLIED` (fix `x db migrate`; `x stop --json && x db migrate && x dev`
where this server cannot apply it) or `X_MIGRATION_CONFLICT`, on
`/_x` too; it still serves. `x db migrate` or `x db rollback` beside it is
applied by this dev server, and the finding clears with no restart. A schema finding appearing or
clearing (`X_DB_DRIFT` after `x db gen`) no longer restarts the child — an entity edit still does,
as a pinned module — so `x db gen "…" && x db migrate` runs against a server that is up; after it
the terminal prints an `hmr` line, not a fresh banner, and `/_x` holds the verdict.

Without `--once` the process stays up until it is signalled. `Ctrl-C` runs the same three-phase
drain a production `SIGTERM` runs — stop accepting, finish in-flight, close — and only then
releases the embedded Postgres, the worker and the file watcher, so `.x/pgdata` is never left
locked by a process that has gone. `x mcp serve --transport http` behaves identically.

`/_x/<panel>` is one tab per panel; `?json=1` (or `accept: application/json`) returns exactly what
the tab draws. Eleven panels — the nine `@ultimat3/admin` ships plus the two only the CLI can
answer:

| Panel | Kills the question |
|---|---|
| `routes` | which URL renders how, with which budget |
| `timeline` | where did this request spend its milliseconds, and did it loop |
| `live` | why did this subscriber not get the row |
| `jobs` | which step failed, and what is queued |
| `db` | what is in the table, and does the schema match the migrations (read-only SQL) |
| `mail` | what did that email look like, in that locale |
| `cache` | which tags would this invalidation bust |
| `policy` | which clause decided, for which actor |
| `manifest` | is the committed `x.manifest.json` current |
| `services` | which database/events/storage this process is talking to, and its reload count |
| `boundaries` | which import crosses a surface or a layer |

`/_x` answers a loopback `Host` only — `localhost`, `*.localhost`, `127.0.0.1`, `[::1]` — and
refuses any other with `421` `X_DEV_HOST_REFUSED` (a DNS-rebound name is how a page reads a
loopback server). The `db` panel runs a statement on a same-origin `POST` only, inside a
`BEGIN READ ONLY` transaction that always rolls back:
`curl -sS -H 'accept: application/json' --data-urlencode 'sql=select 1' http://localhost:3000/_x/db`.
A `GET /_x/db?sql=…` is `X_METHOD_NOT_ALLOWED`; a cross-site `POST` is `X_CSRF_BLOCKED`.

Every one of the eleven answers in a `x dev` process. Three of them read facts only this process
holds, so nothing else can serve them: `timeline` is core's own spans, recorded by the exporter
`x dev` installs at boot (tracing is always on and free until one is configured); `cache` is the
report `invalidateTags()` already built, kept by `@ultimat3/cache`; `policy` is
`@ultimat3/policy`'s own `policyMatrix()` run over every capability an action or query gates,
against one actor per role the app declared with `defineRoles` plus the anonymous caller — never
a second reading of the actor. The matrix is evaluated with no row, and each cell's trace says so:
a row-level rule decides again on the real request.

`timeline` carries two SQL facts and they are not the same fact. `repeatedSql` is a **measurement**
over the trace: every statement text that appeared twice. `nPlusOne` is the **verdict** — one entry
per statement shape this request repeated past five, each carrying `X_N_PLUS_ONE_QUERY` or
`X_N_PLUS_ONE_WRITE` with the runnable `fix:`, counted with attribution applied and
`expectedQueryLoop` honoured. Only `x dev` installs the ledger behind it; a host that did not
answers `nPlusOne: null`, which is "nobody counted" and not "this request was clean". The same
verdicts reach three more places, never re-counted: `x dev`'s own findings (text and `--json`), the
browser error overlay for the request that looped, and one `logger.warn` per request per code.

`live` lists the registered live queries and notes that no subscriber list is attached —
`@ultimat3/realtime` does not retain a subscriber's matcher trace, which is the rest of that
panel's question. A panel whose source a host has not wired answers `ok: false` with the exact
wiring line rather than an empty tab, and a panel that can degrade says which half is missing
rather than rendering an empty one as an answer.

| Env | Unset means | Set means |
|---|---|---|
| `DATABASE_URL` | PGlite in this process | that Postgres |
| `NATS_URL` | in-process fanout | that NATS server — set, it is the bus for every role; a bus of the app's own is `transport` in `export const runtime = { … }` in `apps/<app>/runtime.ts` instead |
| `NATS_KV_BUCKET` | the KV bucket `x_presence` | that bucket — one per app on a shared cluster |
| `S3_ENDPOINT` | `.x/storage` on disk | that S3 |

`realtime.enabled: false` in `app.config.ts` drops the `sync` and `replicator` roles from the set `x dev` starts, and a container's `ROLE=sync` answers the same way — no node, so no live feed.

`migrate` is a real role but not a dev role: it runs once, as `x db migrate`; naming it under
`--role` is `X_CLI_BAD_FLAG`. `replicator` does run under `x dev --role replicator`, but stays out
of the default set — `x dev` with no `--role` still runs `web,sync,worker,scheduler`, because the
replicator takes a slot on a shared database. With `DATABASE_URL` unset the embedded PGlite still
serves no logical replication, so the role is refused, but `X_CLI_BAD_FLAG` now names the fix: set
`DATABASE_URL` to a Postgres with `wal_level=logical`. With `DATABASE_URL` set, the role starts for
real: advisory lock → `postgresChangeFeed()` → `changeFeedReplicator` → publish to the transport.
Errors: `X_CLI_BAD_FLAG`, `X_PORT_IN_USE` (names the holder's pid and directory; its fix names a port pair that is free when asked), `X_ENV_MISSING`, `X_DB_DRIFT`.

## x stop

```bash
x stop [--timeout 30s] [--json]
```

Ends **this checkout's** `x dev` and returns only once the next `x dev` there can boot. `As of 30.0`.

| Case | What happens | `--json` `data` |
|---|---|---|
| a live `x dev` holds `.x/dev.lock` | SIGTERM to the pid the lock names, then wait for the pid to exit and the lock to clear | `{ stopped: true, pid, port, waitedMs, drained: true }` |
| Windows | `kill` is TerminateProcess, so no drain runs; `x stop` clears the lock itself | `{ …, drained: false }` |
| no lock, or a lock naming a dead pid | nothing is signalled, exit 0. A stale lock is left for the next `x dev`'s preflight to clear | `{ stopped: false }` |
| a lock naming a live pid that is not the `x dev` that wrote it (a reused pid) | nothing is signalled, exit 0; the lock is cleared, under the boot's own guard and only while it still holds the bytes judged. `x db reset`/`status`/`diagnostics`/`recount` treat such a lock as no holder anyway (`liveDevLockChecked`, `packages/cli/src/dev-lock-live.ts`). `As of 2026-11` | `{ stopped: false, stale: true }` |
| the pid outlives `--timeout` | `X_DEV_STOP_TIMEOUT`, naming the pid; the lock stays | — |

| Flag | Type | Default | Does |
|---|---|---|---|
| `--timeout` | duration (`30s`, `2m`, `PT1M`) | core's default drain deadline (25 s) + the 5 s release floor + 5 s | how long to wait for the drain. An app that configured a longer drain passes it here: `x stop` loads no app |

**The lock is the only authority.** No `--all`, no port lookup, no process-name match: on a box shared by several agents, `pkill` ends someone else's server and `x stop` never does. Dev services an app runs beside `x dev` (its own compose file) are the app's to stop. `X_DEV_ALREADY_RUNNING`'s `fix:` is this command.

Errors: `X_DEV_STOP_TIMEOUT`, `X_CLI_BAD_FLAG` (a `--timeout` that is not a positive duration).

## x g

```bash
x g resource|action|mutator|backfill|job|route|policy|entity|query|task <name> [--feature f]
x g cron-job|purge|webhook-receiver <name> [--feature f]   # a primitive factory's one call + tests
x g export-rows|import-rows <name> --feature f   # the slice's table through storage + tests
x g island <name> [--at <dir>]              # a client component on an otherwise static page
x g admin:page <name> --permission <perm> [--at <dir>]   # a custom admin screen, guarded by construction
x g guard <name>                            # a convention this app enforces, as a build error
x g sign-in --password | --oidc <provider>  # the app's one sign-in: pages, actions, boot guard
x g invite                                  # the member invite: three actions and two pages over defineMemberInvite
x g chart-alerts [--print]                  # the chart's ServiceMonitor + alert rules, backfilled
x g chart-dashboard [--print]               # the chart's Grafana dashboard + its ConfigMap, backfilled
x g app <name>                              # one more app workspace: apps/<name>/
x g package <name>                          # one more shared package: packages/<name>/
```

**`x g app <name>` / `x g package <name>`** (`As of 2026-11`) add a workspace to the monorepo: `apps/<name>/` (`package.json` + `tsconfig.json`) or `packages/<name>/` (manifest, README, `src/index.ts` and its test), named `@<scope>/<name>` with the scope read off the root `package.json` (`@acme/root` → `acme`). Nothing outside the new directory is edited: the root `workspaces` globs and tsconfig alias already reach it. A name the other kind already holds is `X_WORKSPACE_NAME_TAKEN` (both would install as `@<scope>/<name>`); one the same kind holds is `X_GENERATE_CONFLICT`. The run prints `bun install` then `bunx x verify --changed --dirty` (`data.next`). A workspace is no slice: it reads `--force` and `--dry-run` only, and any other `x g` flag (`--feature`, `--surface`, `--live`, `--admin`, `--locales`, `--at`, `--app`, `--permission`) is `X_CLI_BAD_FLAG`, fix the same run without it.

**`x g sign-in`** (`As of 2026-11`) is what a deployed scaffold needs to issue a session: before it, a production `web` role answered every policy-protected route `401` (`packages/cli/e2e/sign-in.e2e.test.ts` proves the after). Exactly one of the two flags, and no `<name>` — an app has one sign-in; anything else is `X_CLI_BAD_FLAG`, and so is any other `x g` flag it would ignore (`--feature`, `--surface`, `--at`, `--permission`, `--live`, `--admin`), and either flag on another generator. Its keys land in every catalog the app ships, or the ones `--locales` names, as every other generator's do. The auth slice lands under `apps/web/app/auth/` beside `x new`'s `auth.ts`, plus `apps/web/runtime.ts` and the edits in the last column. A dry run lists the deletions in `data.removed`, apart from `data.files`; a real run reports them under the same key:

| Shape | Writes | Also edits |
|---|---|---|
| `--password` | `sign-in/page.tsx` (a native form, 0 kB) posting to `createSession` over `login()`; `sign-in/second-factor/page.tsx` posting to `confirmSession` over `completeMfa()` (the sealed challenge travels in an HttpOnly cookie); `destroySession` over `logout()` + `signOutHeaders()`; `sign-in-guard.ts`; `apps/web/runtime.ts` — 22 files on a dry run in the default scaffold, 24 after setup | `apps/web/api/index.ts` (the three actions), `app.config.ts` (`auth: { signInPath: '/auth/sign-in' }`), the catalogs |
| `--oidc <provider>` | `oidc.ts` — `discoverOAuthProvider` on the FIRST sign-in, never at import — and `sign-in-routes.ts`, the `oauthLogin` legs on `runtime.routes`; the sign-in page (one link to `/auth/sso/<provider>`); `destroySession`; the guard — 20 files on a dry run (plus the two in `data.removed`), 22 after setup | as above, plus `<PROVIDER>_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET` in `envSchema`; and **the authenticator swap**: `authenticator.ts` loses the development fallback and `dev-actor.ts` is deleted, only while all four files are byte-for-byte what `x new` wrote — an edited one is an `X_GENERATE_CONFLICT` finding naming the line to delete by hand |

The boot guard is generated, app-owned: `apps/web/runtime.ts` calls `assertSignInConfigured(process.env)` before the boot binds a port, and outside `development`/`test` a `web` or `sync` role with a sign-in key unset refuses to start — `X_AUTH_SIGN_IN_UNCONFIGURED`, fix `export <KEY>="<value>"` in the role's deployed environment, then restart it (`x env example` lists the keys). The keys: `ULTIMATE_SECRETS_KEY` for `--password` (it seals the second-factor challenge); the provider's three plus `SESSION_SECRET` and `APP_URL` for `--oidc`. A second `x g sign-in` is `X_GENERATE_CONFLICT` and writes nothing. `--password` keeps the development viewer: it ships no sign-up page, so the first user is `register(appAuth(), { email, password, orgId, roles })`. An app that already has an `apps/web/runtime.ts` is that conflict too — merge the two `runtime` objects by hand.

**`x g invite`** (`As of 2026-11-14`) is the member invite, as the app's own actions over `@ultimat3/auth`'s `defineMemberInvite` ([Auth](Auth#member-invites)) — the shape `x g sign-in` writes for `login()`. No `<name>` (an app has one), and any `x g` flag but `--force`, `--dry-run` and `--locales` is `X_CLI_BAD_FLAG`, fix `x g invite`. Under `apps/web/app/auth/`: `invite.ts` (the flow, its `defineMail` and the link to `/auth/invites/accept?orgId=…&token=…`, built on `APP_URL` — never the request's `Host`, which the caller writes; unset, `inviteMember` is `X_ENV_MISSING`, fix `export APP_URL=…`), `policy.ts` (`member:invite`, the actor's own org), `inviteMember` and `revokeInvite` behind it (revoke removes only an address that joined through an invite; owner protection is the app's rule in `policy.ts`), `acceptInvite` (public by declaration; refuses an anonymous caller, rotates the session), `invites/page.tsx` and `invites/accept/page.tsx` (native forms, 0 kB), a test beside each. Also edits: `apps/web/shared/roles.ts` (`member:invite` to `admin`), `apps/web/api/index.ts` (the three actions), `apps/web/exercise.ts` (each action `off`, with its reason — the pass holds no mailed token), the root `package.json` of an app scaffolded before `x new` declared `@ultimat3/mail` (at the range `@ultimat3/auth` has; run `bun install`), the catalogs. Who may invite, seat limits and the roles a joiner gets are those files', to edit. A second run is `X_GENERATE_CONFLICT`, and so is an API index already binding `inviteMember`. Proof: `bun test ./packages/cli/src/generate-invite.contract.test.ts` — a fresh scaffold, the run, `tsc`, Biome and the generated tests.

**`x g chart-alerts`** (`As of 2026-11`) writes the two monitoring templates `x new`'s chart carries into an app chart that predates them — `docker/helm/templates/servicemonitor.yaml` and `alert-rules.yaml`, named after `Chart.yaml`'s `name` — and appends the `serviceMonitor:` / `alerts:` blocks `values.yaml` lacks. Only what is missing: a template already there is kept (`--force` rewrites both), and a values key already there — `enabled: false` included — is never touched; both templates read a missing block as `auto`, rendering only where the cluster serves the Prometheus operator's kinds. A second run writes nothing. No `<name>`, and any other `x g` flag but `--force`/`--dry-run` is `X_CLI_BAD_FLAG`. **`--print`** writes nothing and needs no chart: the same rules as plain Prometheus rule groups, defaults in place, for a loader outside Kubernetes (`--json`: `data.rules`, the YAML text). No `docker/helm/Chart.yaml` is `X_CHART_MISSING`, fix `x g chart-alerts --print --json`. `x doctor` lists the missing templates. The rules: [Observability](Observability).

**`x g chart-dashboard`** (`As of 2026-11`) is the same backfill for the chart's Grafana dashboard: `docker/helm/dashboards/ultimate-app.json` (one column of panels over the series the framework declares — requests, latency by route, statements, pool, jobs, realtime, the process) and `templates/dashboard-configmap.yaml`, which ships it as a ConfigMap a Grafana sidecar provisions by label — plus the `dashboard:` block `values.yaml` lacks, `enabled: false` (`x new`'s chart writes the same three). The same rules as `chart-alerts`: only what is missing, `--force` rewrites, no `<name>`, `X_CHART_MISSING` with no chart. **`--print`** writes nothing and needs no chart: the dashboard JSON, to import into a Grafana outside Kubernetes (`--json`: `data.dashboard`).

`x g guard <name>` writes `guards/<name>.ts` and its test: the app's own convention, from the blank template. Every name in `SHIPPED_GUARD_NAMES` (`packages/cli/src/templates/scaffold-guards.ts`) already runs on `boundaries` from the installed framework; how one reports is a row in `guards/shipped.json` (`"error"`, `"warning"`, `"off"`). `x doctor` lists the copies of shipped guards an app still holds (`.data.guards.vendored`), and `x upgrade` migrates them ([Interface rules](Interface-Rules)).

**`x g cron-job` · `x g purge` · `x g webhook-receiver`** (`As of 31.17.0`) scaffold a primitive *factory*'s one declaration — each a factory over `job()`, never a ninth primitive — with its tests, into the feature's slice, listed in `apps/web/api/index.ts`'s `jobs:`. None reads a table, so a slice with no `entity.ts` is fine.

| Generator | Writes | What the declaration holds |
|---|---|---|
| `x g cron-job <name>` | `jobs/<name>.ts`, `<name>.job.test.ts`, `<name>.test.ts` | `cronJob({ name, cron: '0 3 * * *', tz: 'UTC', tenant: 'none' })` — the job and its `.schedule` task from one call, an explicit IANA zone, the org stripped so a tenant read fails closed |
| `x g purge <name>` | `jobs/<name>.ts`, `<name>.job.test.ts`, `<name>.test.ts`, `tasks/<name>-hourly.ts` | `purge({ name, entities: 'declared' })` — the sweep for every `retain` the schema declares (`X_ENTITY_RETAIN_UNSWEPT` without one), fired on `DEFAULT_PURGE_CRON` |
| `x g webhook-receiver <name>` | `jobs/<name>.ts`, `<name>.test.ts`, and the job's entry in `apps/web/exercise.ts` (a draw cannot sign an event, so `x exercise` queues a verified-shape one) | `webhookReceiver()` at `/hooks/<name>`: the exact bytes `verifyBodyHmac`-checked under `<NAME>_WEBHOOK_SECRET` (comma-separated, so a rotation keeps the old one live), the event read out of the signed body, queued, then acknowledged; an unreadable event is the app's own `X_<NAME>_UNREADABLE` |

**`x g export-rows` · `x g import-rows`** (`As of 2026-11`) are the two factory generators that DO read a table: the slice's own scaffolded one (`db.<plural>`, `title`, `price`), read off its `entity.ts` like `x g backfill`. A `--feature` with no `entity.ts` is `X_FEATURE_REQUIRED`; one whose entity is shaped otherwise is `X_ROWS_SLICE_ENTITY`, fix a `x g job` to declare the call in by hand. Both write `jobs/<name>.ts`, `<name>.job.test.ts` and `<name>.test.ts` (the pass run in process against a memory disk), and read storage through `disk()` — `@ultimat3/storage`, in a new app's dependencies.

| Generator | What the declaration holds |
|---|---|
| `x g export-rows <name> --feature f` | `exportRows({ input: { orgId, exportId }, tenant: ({ orgId }) => orgId, source: db.<plural>.where({ orgId }), format: 'csv', columns, row, sink: () => disk() })` — one org's rows, Money as minor units + currency, dates as UTC instants, parts under `exports/<name>/<orgId>/<exportId>/` |
| `x g import-rows <name> --feature f` | `importRows({ input: { orgId, key }, tenant, source: () => disk(), schema, handle })` — the input refines `key` onto `imports/<name>/<orgId>/` (`key-in-own-org`, no `..`), so an import never reads another org's upload and the run's dedupe key is per org; `handle` is `upsertAll(…, { onConflict: ['id'], onMatch: 'nothing' })`, so a replayed page writes nothing twice and never another org's row; refused rows by line under `imports/<name>/<orgId>/errors` |

Every other factory, and why no generator writes it (`rollup`, `webhook`, `llm`, `agentJob`, …): `FACTORY_GENERATORS` in `packages/cli/src/generate-factories.ts`, held complete against `PRIMITIVE_FACTORIES` by its test.

Alias: `x generate`.

`<name>` is one directory segment for every generator but `route`, whose name is its URL:
`x g route casos/[id]/notificar` writes `apps/web/app/casos/[id]/notificar/page.tsx`. Each segment
is a word (`a-z`, `0-9`, `-`, `_`) or `[param]` / `[...rest]`; `..`, `.` and empty segments are
`X_CLI_BAD_FLAG`.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--feature` | string | derived from the name | feature slice to write into. Not for `resource`: its name IS the slice (`app/<name>/`, page at `app/<names>/`), and a `--feature` naming anything else is `X_CLI_BAD_FLAG` |
| `--surface` | string | `app` | `site` or `app` |
| `--app` | string | `web` | `route`, `island`, `query` only: the app workspace under `apps/` the files land in (`x g route reports --app admin` → `apps/admin/app/reports/page.tsx`). An app that is not there is `X_CLI_BAD_FLAG`, fix `x g app <app>`; any other generator registers in files only `apps/web` holds (API index, roles, exercise file, db handle) and refuses it, fix the same run without the flag |
| `--permission` | string | `<name>:read` | `admin:page` only: the permission the page's own work needs, on top of the frame's `admin:read`. A `<resource>:<verb>`, or namespaced with more segments (`admin:blog:write`, `As of 27.6.2` — one colon exactly was required, which refused every `admin:<area>:<verb>` a staff console declares); an empty segment, a space or a quote is `X_CLI_BAD_FLAG` before a file is written — the value reaches the emitted source three times and `Permission` is `${string}:${string}` |
| `--live` | boolean | `false` | `query` only: make it subscribable. On any other generator it is `X_CLI_BAD_FLAG` naming the `x g query … --live` to run instead |
| `--admin` | boolean | `false` | `resource` only: also emit the per-entity admin override **and list it** under `resources:` in `apps/admin/app/admin/admin.ts`. The screen itself needs no flag — an entity in the handle is an admin screen |
| `--locales` | string | every locale with a catalog in `packages/i18n/catalogs/`, else `en` | comma-separated locales; lands each generator's catalog entry in every one. **Never starts a catalog** in an app that has any: a non-default locale with no `packages/i18n/catalogs/<locale>.json` is `X_CLI_BAD_FLAG`, `fix: x i18n add <locale>`, before a file is planned — a catalog a generator started would hold only its own keys. A non-default locale's new keys land marked `⟦…⟧`, as `x i18n add` seeds them, so `x i18n check` reports them until translated. In an app with no catalogs yet, a first `--locales en,es` writes `en` bare and `es` marked. `As of 2026-10-06` (`localiseCatalogs`, `packages/cli/src/generate-catalog-locales.ts`) |
| `--password` | boolean | `false` | `sign-in` only: an address and a password over `login()` |
| `--oidc` | string | — | `sign-in` only: an OpenID Connect provider id (`corp-sso`; lowercase, digits, hyphens, not a built-in), discovered from `<PROVIDER>_ISSUER` |
| `--print` | boolean | `false` | `chart-alerts` and `chart-dashboard` only: print the alert rules as plain Prometheus rule groups, or the dashboard as Grafana JSON, write nothing. On any other generator it is `X_CLI_BAD_FLAG` |
| `--force` | boolean | `false` | overwrite existing files |
| `--dry-run` | boolean | `false` | the write plan, nothing written: **every file the run would touch** — the ones it creates (a slice module already on disk is skipped, not listed) and, `As of 27.6.2`, the ones it EDITS outside the slice (role map, typed handle, API index, manifests, catalogs, the i18n index), in the order the run lists them. `--json`: `data.files` is that list, `data.edits` the subset that already exists, `data.refreshes` the committed contracts (`x.manifest.json`, `openapi.json`) a real run re-projects. `ok: false` with every finding the real run would report — an existing file, an API-index binding already held, a grant or a handle entry it cannot place |

`resource` emits the whole slice — `entity`, `repo`, `policy`, `errors`, `service`, `actions`, `live`, `jobs`, `ui`, the form island, the plural route and a test beside each declaration — **38 files** on a dry run in an app scaffolded with its example slice, 40 on the real run after `bun run setup` (`x.manifest.json` and `openapi.json` re-projected; 41 dry with `--admin`) — and `x g resource` in a `--no-example` app, which also gains two `package.json` edits, writes 40 and 42 files (43 and 45 with `--admin`; `--live` is refused — a resource already ships a live query, and the flag belongs to `x g query`: `X_CLI_BAD_FLAG`, fix `x g query <name>-feed --feature <name> --live`), and **no migration**: `x db gen` is the only writer of `packages/db/migrations`, so a new slice is `x g resource <name>`, then `x db gen "create <table>"`, then `x db migrate`, then `x build --target static && x verify --only budgets` — the four commands the run prints, in that order (`data.next` under `--json`). **The plural route is reachable as written**, `As of 2026-10-01`: its `load` reads the list through the slice's query as the request's actor (no org in the URL), `AsyncRegion` renders ready, empty and refused, the form island is mounted, and the route declares `policy: { permission: '<name>:read' }`. Its `budget.js` is MEASURED on `x new`'s app (58,522 B, Bun 1.4.0) and carries the `measured:` / `why:` comment `bun run budget-raises` reads; an app that charges more to every document — `navigation: { client: [...] }` adds its router — is over it on the printed build, and the raise is that edit. The page sits in `apps/web/shared/shell.tsx` when the app has one. `backfill` emits a `backfill()` declaration with its `source()` and `handle()` to fill in — see [Migrations and backfills](Migrations-And-Backfills). **`x g query` and `x g backfill` read a table and never create one**, `As of 2026-11-02`: both name a slice holding an `entity.ts`, by `--feature <slice>` or by a name that is one, and neither finding it is `X_FEATURE_REQUIRED`, zero files written, its fix the closest slice's `--feature` line or `x g resource <name>`. `x g resource` and `x g entity` are what create a table. Every generator produces code that passes `x verify` unmodified, and writes it through the app's own Biome when the app has one: `node_modules/.bin/biome` over the TypeScript files that run created, best effort, never a failed `x g`. A slice whose `entity.ts` declares another table under its name gets no foundation from `x g action`/`x g mutator`, and `x g query` there is `X_QUERY_SLICE_ENTITY`. A written contract test reads its exercise from `apps/web/exercise.ts` (`target.contract({ exercise })`), and the same run inserts its entry there — once, the file created from `x new`'s when absent, `As of 2026-11-08`; a file that is not one `export const exercise = defineExercise({ … })` is `X_EXERCISE_FILE_UNEDITABLE`, the entry to paste in its `fix:`. Errors: `X_GENERATE_CONFLICT`, `X_DB_HANDLE_UNREGISTERED`, `X_FEATURE_UNKNOWN`, `X_FEATURE_REQUIRED`, `X_QUERY_SLICE_ENTITY`, `X_EXERCISE_FILE_UNEDITABLE`.

**A generated read answers the slice's `<Feature>View`, not the whole row** (`As of 2026-11-19`): `x g query` and `x g resource` project each row through `viewOf` in the query's `sql:` provider (`from<XView>(…)`), so no tenant column reaches the wire and a column added to the entity is published only by an edit to the view, live patches included. That holds when the run writes the scaffold entity or the slice's `entity.ts` declares `XView = x.$view([...])` over `id`, `title` and `createdAt` (the columns the read orders by); otherwise the read answers the row as before. Files generated earlier are untouched.

**A name the templates would mangle is `X_CLI_BAD_FLAG` before anything is planned**, each with a `fix:` that runs: a reserved word or a leading digit; a letter outside ASCII (`Über` → `x g entity uber` — it was dropped to `ber`); an already-plural `resource`/`entity` name (`posts` → `x g resource post` — it became `entity('postses')`); and a name whose type spelling an emitted file also uses as a global or local type (`promise`, `omit`, `partial`, `row` → `x g resource promise-resource`).

**`entity` and `resource` write a repo over the typed handle, and register the entity in it**, `As of 2026-10`. The generated `repo.ts` holds no `sql` literal, no row decoding and no tenant predicate of any kind — `byId(id)`, `list(limit)` and `insert(row)` read `db.<table>`, and the handle scopes each to the actor's org ([Entities and migrations](Entities-And-Migrations#the-repo)) — and a table is on the handle only when its entity is in the set `packages/db/src/client.ts` passes to `database()`. The generator makes that edit, and four more:

| Edited | What lands | When it cannot |
|---|---|---|
| `packages/db/src/client.ts` | the entity's import, and `<table>: <entity>,` in `const entities = { … }`, in key order. Created whole only where the db package would export it: its `index.ts` names `./client`, or it has no index. **Never created in a db package of the app's own** (`As of 27.6.2`: an `index.ts` that exports no handle — a schema and a seed over `@ultimat3/db`'s client) | `X_DB_HANDLE_UNREGISTERED`, exit 1, the two lines in the `fix:` — the files are written, the handle is not. In an app with its own db package the finding sits on `index.ts` and says the generated repo expects `database()`'s handle |
| `packages/db/src/index.ts` | nothing — it is checked: it must export from `./client` | `X_DB_HANDLE_UNREGISTERED` naming the export line |
| `packages/db/package.json`, `apps/web/package.json` | the workspace dependency each new import needs: `@<app>/db` in the app, and `@<app>/web` in the db package only when the handle this run leaves imports an entity from it. Planned with the handle edit and written together — a handle that refuses the entry leaves both manifests untouched | left to `package-shape` (`X_WORKSPACE_DEP_UNDECLARED`), whose `fix:` is the same line |
| `packages/i18n/catalogs/<locale>.json` | the labels the admin reads for the new screen — `admin.<table>.title` and one `admin.<table>.field.<column>` per column — merged in the file's OWN key order (a sorted level stays sorted, a hand-ordered one gains its keys at the end), in every locale the run writes to | — |
| `apps/web/shared/roles.ts` | a written `policy.ts`'s grants (`<feature>:read` to `member`, `<feature>:write` to `admin`) and the admin's three per-table permissions, declared and granted. A permission is declared only where its grant can be placed, and one any `definePermissions([…])` call already declares is not declared again | `X_PERMISSION_UNGRANTED`, exit 1, naming each role and the permissions its `grants` owes — an app whose role map lives elsewhere, has no such role, or holds a list that cannot be edited safely is told, and the file is left byte-identical |
| `apps/web/api/index.ts` | every action, query, job and task module the run wrote, imported and listed under `actions` / `queries` / `jobs` / `tasks` — the lists `Api`, the typed client's shape, is read from | left alone when the file is not `defineApi({ actions: [...] })`; `X_JOB_UNREGISTERED` on the `manifest` step names a job nothing lists. A module whose binding (its file name, camelCased) the index already holds — another feature's `reindex-post`, or `api` / `defineApi` / `health` — is `X_GENERATE_CONFLICT` **before anything is written**, fix: the same run with the feature as a prefix |
| `apps/admin/app/admin/admin.ts` (`--admin` only) | the override's import, and `<table>: <name>AdminResource,` under `resources:` — the block is created, last in the call, when there is none | `X_ADMIN_RESOURCE_UNWIRED`, exit 1, the two lines in the `fix:` |

The summary line ends with what the new table owes, as commands that run as printed, and `--json` carries them as `data.next`:

```
✓ wrote 7 file(s) for entity widget — next: bunx x db gen "create widgets" && bunx x db migrate
```

`bun install` leads the list when a manifest gained a dependency. `--dry-run` runs the same edits against the plan held in memory, so it lists every file above that the run would change (`As of 27.6.2`; it listed the generator's own files only).

**An edit to a file the app owns is syntax-aware, and refused rather than guessed**, `As of 27.6.2`. Every list a generator grows — a role's `grants`, `definePermissions([…])`, a `defineApi` list, the handle's entity set — is located on the source with comments and literal contents masked (`packages/cli/src/source-list-edit.ts`), so an apostrophe, a bracket or a comma inside a comment is never code. A list holding a comment gains rows and no existing byte moves; a comment-free one is re-wrapped the way Biome prints it. The result is read back before it is written — the same entries plus the new ones, the text around it untouched — and an edit that does not read back that way is the finding in the table above, never a write. (`x g entity` read each apostrophe in a role map's comments as a string delimiter and rewrote the comments between two of them into permissions.)

**A feature's second entity is a sibling file**, `As of 27.6.2`. `x g entity <name> --feature <feature>` in a slice whose `entity.ts` declares another table writes `entity-<name>.ts`, `entity-<name>.test.ts`, `repo-<name>.ts` and `repo-<name>.test.ts` beside it — one file per table, nothing the author wrote edited — and registers it exactly as a first entity: handle, role map, admin labels, `data.next` naming its own table. It was `X_GENERATE_CONFLICT` on the first entity's four files, with a `--force` that would have written the second table over the first. The same entity again is still that conflict, on its own files. `x db gen` reads the entity registry, so a sibling is in the next migration because it is declared. The other generators (`action`, `query`, `job`, …) keep reading the slice's `entity.ts` and `repo.ts`: a primitive over a sibling's table imports `./repo-<name>` by hand.

**Catalog writes are the labels the admin reads**: `x g entity`, `x g resource` and `x g admin:page` merge their keys (`admin.<table>.title`, `admin.<table>.field.<column>`; `admin.<name>.title` for a page) into every locale the app has a catalog for — the default locale bare, each other locale marked `⟦…⟧` exactly as `x i18n add` seeds it, so `x i18n check` reports them as owed rather than rendering a raw key. Existing keys always win. `--dry-run` lists each catalog it would change; `--locales <one>` narrows the run to the catalogs named.

**`x g admin:page` DECLARES the permission it requires**, `As of 2026-09`. It emitted
`permissions: ['ops:read']` and nothing anywhere declared `ops:read`, so `assertPermission` threw
`X_PERMISSION_UNKNOWN` on the first request that reached the page — a screen the generator built
and no actor could open, under a green gate: the `policy` step reads `roleDefinitions()` and
`routeEntries()`, and an admin page is neither a role nor a route. The page file now carries the
`definePermissions([...])` call and the `PermissionRegistry` augmentation beside its
`AdminCustomPage`, and its emitted test fails if either is dropped. Registration is a side effect
of import and `pages:` already imports that module, which is why the declaration is in the page and
not in a `policy.ts` beside it. Since 27.2.0 a `policyAuthz()` map that omits the permission decides it by the role map, so
the role grant is the one declaration; a map entry only refines it. The page
lands in `apps/admin/app/admin/pages/` without `--at` — beside the declaration, inside the app scan
(`DEFAULT_ADMIN_PAGE_DIR`); `apps/admin/src/pages`, the old default, was never imported.

**A narrower generator plants the slice modules its own source imports**, `As of 2026-08` — they used to be `x g resource`'s alone, so `x g job` into a hand-written slice emitted `import * as repo from '../repo'` against a file nobody had written. Which modules differ per generator, on purpose: a job has no request behind it and evaluates no policy, so `x g job` plants no `policy.ts`.

| Generator | Files into a **bare** slice | Its own | Slice modules it plants |
|---|---|---|---|
| `x g action` · `x g mutator` | 5 | 3 — the declaration, a unit test and a `.contract.test.ts` | `policy.ts` + `policy.test.ts`; `errors.ts` only when its body reads a row: a slice with an entity whose repo exports `byId` |
| `x g query --feature <slice>` (± `--live`) | refused: no `entity.ts` is `X_FEATURE_REQUIRED` | 2 | what the slice lacks of `repo.ts` + `repo.test.ts`, `policy.ts` + `policy.test.ts`; never `entity.ts` |
| `x g job` | 2 | 2 | none — a slice with no entity gets the neutral body, never an invented table |
| `x g backfill --feature <slice>` | refused: no `entity.ts` is `X_FEATURE_REQUIRED` | 2 | what the slice lacks of `repo.ts` + `repo.test.ts`; never `entity.ts` |
| `x g task` | 4 | 4 — the task **and** the job it enqueues | none |
| `x g entity` · `x g policy` | 5 · 2 | all of them — `x g entity` counts the catalog it merges its admin labels into | it *is* the slice module |

`repo.ts` is never planted alone: it imports `./entity` for its row type, so the pair goes in together or the unresolved import has only moved — and `repo.test.ts` rides with it, running the repo against the in-memory driver. An entity planted this way is registered in the handle exactly as `x g entity`'s is. Counts re-derive with `--dry-run --json` (`data.files`), `As of 2026-10`.

**A module the slice already has is skipped — never a conflict, never overwritten, `--force` included.** A foundation module belongs to the slice, not to the generator that needed it, and `--force` is about the primitive you named: clobbering `policy.ts` to regenerate one action would delete every rule in it. Regenerating a slice module is its own generator — `x g entity`, `x g policy`. So a second `x g action` into a finished slice writes exactly its own 3 files, and one into a half-built slice writes only what is missing.

**`x g action` and `x g mutator` complete nothing a slice's author wrote.** A module already on disk gets no companion from them — no `entity.test.ts`, `repo.test.ts` or `policy.test.ts`, no admin catalog labels — because those assert the shape `x g resource` writes, not the one that is there. A `repo.ts` with no `byId` gets the lookup-free body. And a hand-written `policy.ts` that does not export what the generated file imports (`can<Feature>Write`; for an action also `<feature>Tag`) is refused before anything is written: `X_SLICE_POLICY_INCOMPLETE`, naming the file and the missing exports. A destructured export counts, one level of relative `export * from` is followed, and a barrel that cannot be followed (a package) is never refused. Into such a slice the generated unit test grants what the policy grants — the one permission of a literal `can('<perm>')` — and when that cannot be read it makes no handler assertion and says so in a comment; the contract test makes no foreign-org assertion against a policy it did not write. `As of 2026-10`.

**Every generated entity is tenant-scoped, and there is no `--no-tenant` flag**, `As of 2026-09-05` — decided rather than omitted. `orgId` is not one generator's: `x g action`, `x g query`, `x g policy` and `x g job` all decide on it too, so a flag on `x g entity` alone would leave `x g resource` emitting an action over a column its entity no longer has. A single-tenant app makes the edit per slice, and the emitted `entity.ts` names it in the comment above `tenant: 'orgId'`: delete that line and the `orgId: uuid()` column, drop `'orgId'` from `indexes`, let `entity.test.ts` expect `$tenantColumn` null and `orgScoped` false, and drop `orgId` from `repo.test.ts`'s draft along with its last two tests, and let `policy.ts`'s write rule stop reading `input.orgId`. `repo.ts` needs no edit: it names no org. From then on `x g action` and `x g mutator` read the slice as `x g job` does, `As of 2026-11-02`: no `orgId` in the input, either test or a policy they plant. A `policy.ts` still deciding on `input.orgId` keeps it in the input, because the action compiles against the rule it imports and that file is the author's.

**The filename carries the test's type**, `As of 2026-08-19` — `x verify` selects a suite by it, so a generated test that landed in a plain `*.test.ts` ran under `unit` and `x test contract` answered `X_TEST_NO_FILES`:

| Generator | Test filename it writes | Step that runs it |
|---|---|---|
| `x g action` · `x g mutator` | `<name>.test.ts` **and** `<name>.contract.test.ts` | `unit`, `contract` |
| `x g query --live` | `<name>.live.test.ts` | `live` |
| `x g job` · `x g task` · `x g backfill` | `<name>.job.test.ts` | `job` |
| `x g cron-job` · `x g purge` | `<name>.job.test.ts` **and** `<name>.test.ts` | `job`, `unit` |
| `x g webhook-receiver` | `<name>.test.ts` | `unit` |
| `x g export-rows` · `x g import-rows` | `<name>.job.test.ts` **and** `<name>.test.ts` | `job`, `unit` |
| `x g query` (not live) · `x g entity` · `x g policy` · `x g route` | `<name>.test.ts` | `unit` |

`--force` writes the new name and does not touch a file under the old one, because the old name is not in its output list. Delete the orphan by hand.

The synopsis above is `GENERATORS` in `packages/cli/src/cmd-generate.ts`, which `x g --help` prints verbatim — run it if this list and the CLI ever disagree.
