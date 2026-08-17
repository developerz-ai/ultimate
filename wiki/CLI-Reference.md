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
| App detection | most commands walk up for `app.config.ts` and fail with `X_NOT_IN_APP` if there is none. The exceptions: `new`, `test`, `doctor`, `errors`, `help`, `version` |
| Flags | long form only, `--flag value` or `--flag=value`. Booleans negate as `--no-<flag>` |
| Global flags | `--json` / `-j`, `--help` / `-h`, `--cwd <dir>`, `--verbose` — accepted by every command |
| Subcommands | when a command has them and none is given, **the first is the default**: `x actions` is `x actions list` |
| Passthrough | a bare `--` sends everything after it to the underlying tool untouched |
| `--json` shape | `{ ok, command, summary, steps?, findings?, data? }`. Findings are `{ code, cause, fix, docs?, at? }` |

## Command index

`As of 2026-08`. **shipped** = implemented in `packages/cli`; **planned** = specified, not yet built — calling it exits with `X_NOT_IMPLEMENTED` and a `fix:` line pointing at the closest shipped command.

| Command | Does | Status |
|---|---|---|
| `x new <name>` | scaffold a monorepo that already runs | shipped |
| `x dev` | all roles in one process: embedded services, sub-second reload, `/_x` mounted | shipped |
| `x g <kind> <name>` | scaffold a primitive with its test | shipped |
| `x db <sub>` | gen, migrate, reset, studio, branch, backfill | shipped |
| `x verify [--workers N]` | the gate — 17 steps, in this order: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, manifest, roadmap | shipped |
| `x env [check\|example]` | validate the process env against `envSchema`, or regenerate `.env.example` from it | shipped |
| `x secrets <sub>` | the committed encrypted secrets file: show, init, edit, set, rotate | shipped |
| `x build` | container image, single binary, or prerendered static site | shipped |
| `x deploy` | run the container deploy plan: migrate first, then the serving roles | shipped |
| `x manifest` | regenerate `x.manifest.json` and `openapi.json` | shipped |
| `x routes` | the route table: path, surface, render mode, hydrate, offline | shipped |
| `x mcp serve` | serve the framework MCP tools over stdio or HTTP | shipped |
| `x doctor` | environment, versions, drift, the newest migration's snapshot sidecar, ports, PWA prerequisites — each with a fix | shipped |
| `x help` / `x version` | catalogue and version | shipped |
| `x actions` / `x queries` / `x entities` | introspect the declaration registries | shipped |
| `x jobs` | list, show, retry, drain the queue | shipped |
| `x tasks` | cron tasks, their timezone and their next run | shipped |
| `x policy` | which clause decided a permission, and why | shipped |
| `x i18n` | add, sync, check catalogs | shipped |
| `x test <type>` | run one of the six test types, or the whole suite | shipped |
| `x errors explain <CODE>` | code → cause, fix, docs | shipped |
| `x docs "<question>"` | framework docs, offline, from `node_modules` | shipped |
| `x fix boundary <file>` | plan the minimal cut for an import that crossed a surface boundary (never rewrites) | shipped |
| `x cache` | tag graph, bust, clear, stats | planned |
| `x branch` | copy-on-write branch environments | planned |
| `x status` | connected-client build-ID distribution, role health | planned |
| `x upgrade` | move every `@ultimat3/*` in lockstep, with codemods | planned |
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
{"ok":true,"command":"new","summary":"…","data":{"dir":"/home/me/myapp","files":["README.md","AGENTS.md",…],"dryRun":true}}
```

**114 files** with the example slice, **90** with `--no-example` — measured on `main` `As of 2026-08`, one lower than 1.2.0's because the scaffold no longer writes `0000_initial.sql`. Both numbers move the moment a template is added, so derive rather than quote them:

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
| `docker/Dockerfile.dockerignore` | **this exact name** — not a root `.dockerignore` |
| `docker/docker-compose.prod.yml` | one service per role: migrate, web, sync, worker, scheduler |
| `docker/docker-compose.dev.yml` | parity checks only; `x dev` needs none of it |
| `docker/README.md` | how the two compose files differ |
| `bin/setup`, `bin/dev`, `bin/check` | written executable (`0755`) |

There is **no** `docker/helm` in the scaffold, which is why `x deploy --method helm` throws there.

`bunx create-ultimate myapp` is the same generator without a global install. Errors: `X_GENERATE_CONFLICT` (the directory exists — `fix` is the same command with `--force`), `X_CLI_BAD_FLAG` (no name given), `X_BUN_VERSION`.

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
| `NATS_URL` | in-process fanout | that NATS server |
| `NATS_KV_BUCKET` | the KV bucket `x_presence` | that bucket — one per app on a shared cluster |
| `S3_ENDPOINT` | `.x/storage` on disk | that S3 |

`migrate` is a real role but not a dev role: it runs once, as `x db migrate`; naming it under
`--role` is `X_CLI_BAD_FLAG`. `replicator` does run under `x dev --role replicator`, but stays out
of the default set — `x dev` with no `--role` still runs `web,sync,worker,scheduler`, because the
replicator takes a slot on a shared database. With `DATABASE_URL` unset the embedded PGlite still
serves no logical replication, so the role is refused, but `X_CLI_BAD_FLAG` now names the fix: set
`DATABASE_URL` to a Postgres with `wal_level=logical`. With `DATABASE_URL` set, the role starts for
real: advisory lock → `PgLogicalReplicationFeed` → `createReplicator` → publish to the transport.
Errors: `X_CLI_BAD_FLAG`, `X_PORT_IN_USE`, `X_ENV_MISSING`, `X_DB_DRIFT`.

## x g

```bash
x g resource|action|mutator|backfill|job|route|policy|entity|query|task <name> [--feature f]
x g island <name> [--at <dir>]              # a client component on an otherwise static page
x g admin:page <name> --permission <perm> [--at <dir>]   # a custom admin screen, guarded by construction
x g guard <name>                            # a convention this app enforces, as a build error
```

Alias: `x generate`.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--feature` | string | derived from the name | feature slice to write into |
| `--surface` | string | `app` | `site` or `app` |
| `--live` | boolean | `false` | for `query`: make it subscribable |
| `--admin` | boolean | `false` | `resource` only: also emit the per-entity admin override |
| `--locales` | string | `en` | comma-separated locales; lands each generator's catalog entry in every one, and for `resource` extends `packages/i18n/catalogs/` on disk |
| `--force` | boolean | `false` | overwrite existing files |
| `--dry-run` | boolean | `false` | print the file list, write nothing |

`resource` emits the whole slice — `entity`, `repo`, `policy`, `errors`, `service`, `actions`, `live`, `jobs`, `ui`, the plural route and a test beside each declaration — **25 files** (27 with `--admin --live`), and **no migration**: `x db gen` is the only writer of `packages/db/migrations`, so a new slice is `x g resource <name>` then `x db gen "create <name>"`. `backfill` emits a `backfill()` declaration with its `source()` and `handle()` to fill in — see [Migrations and backfills](Migrations-And-Backfills). Every generator produces code that passes `x verify` unmodified. Errors: `X_GENERATE_CONFLICT`.

**A narrower generator plants the slice modules its own source imports**, `As of 2026-08` — they used to be `x g resource`'s alone, so `x g job` into a hand-written slice emitted `import * as repo from '../repo'` against a file nobody had written. Which modules differ per generator, on purpose: a job has no request behind it and evaluates no policy, so `x g job` plants no `policy.ts`.

| Generator | Files into a **bare** slice | Its own | Slice modules it plants |
|---|---|---|---|
| `x g action` · `x g mutator` | 8 | 2 | `entity.ts` + `entity.test.ts` + `repo.ts`, `policy.ts` + `policy.test.ts`, `errors.ts` |
| `x g query` (± `--live`) | 7 | 2 | `entity.ts` + `entity.test.ts` + `repo.ts`, `policy.ts` + `policy.test.ts` |
| `x g job` | 5 | 2 | `entity.ts` + `entity.test.ts` + `repo.ts` |
| `x g backfill` | 5 | 2 | `entity.ts` + `entity.test.ts` + `repo.ts` |
| `x g task` | 7 | 4 — the task **and** the job it enqueues | `entity.ts` + `entity.test.ts` + `repo.ts` |
| `x g entity` · `x g policy` | 3 · 2 | all of them | it *is* the slice module |

`repo.ts` is never planted alone: it imports `./entity` for its row type, so the pair goes in together or the unresolved import has only moved.

**A module the slice already has is skipped — never a conflict, never overwritten, `--force` included.** A foundation module belongs to the slice, not to the generator that needed it, and `--force` is about the primitive you named: clobbering `policy.ts` to regenerate one action would delete every rule in it. Regenerating a slice module is its own generator — `x g entity`, `x g policy`. So a second `x g action` into a finished slice writes exactly its own 2 files, and one into a half-built slice writes only what is missing.

The synopsis above is `GENERATORS` in `packages/cli/src/cmd-generate.ts`, which `x g --help` prints verbatim — run it if this list and the CLI ever disagree.

## x db

```bash
x db gen "add publish_at" | migrate | reset | studio | branch <name>
     | backfill --list [--name n] [--status s] [--limit n] [--json]
     | backfill --pending [--json]
     | backfill <name>|--all [--write] [--force] [--json]
```

| Subcommand | Does | Notes |
|---|---|---|
| `gen "<name>"` | diff the app's entities against what the migrations declare, write the next migration | the message is required and becomes the id's slug. **Opens no database** — the previous migration's snapshot is what it diffs against |
| `migrate` | apply pending migrations, then verify the result | literally `ROLE=migrate`'s own `runMigrations` — which ends by diffing the live schema against the ledger it just wrote, on the connection it already holds. A difference is `X_DB_DRIFT` and a non-zero exit |
| `reset` | delete the embedded data directory, then migrate | **embedded database only** — against an external Postgres it exits `X_NOT_IMPLEMENTED` and tells you to drop and recreate it yourself |
| `studio` | — | **planned**: exits `X_NOT_IMPLEMENTED` pointing at the `/_x` db panel. It used to shell out to `bunx drizzle-kit studio`; one subcommand is not worth a second schema engine |
| `branch <name>` | `CREATE DATABASE … TEMPLATE` copy-on-write clone (PGlite: a copied data directory) | the isolation an agent should use before migrating |
| `backfill --list` | print the `x_backfills` ledger — one row per `backfill()` pass, newest first | what has already been swept |
| `backfill --pending` | every backfill the app **declared**, minus the ones that completed | the alarm: a sweep merged and never enqueued had no ledger row and was invisible everywhere. **Non-zero exit** when anything is unswept, so a cron reads the code and not the table |
| `backfill <name>` / `backfill --all` | gate one sweep (or every pending one) and enqueue it | **dry run by default** — `--write` is never implied. `--write` enqueues; the workers perform the pass, because the queue is a job's execution surface. `--all` isolates per name and continues past a failure, exiting non-zero naming each |

A bare `x db backfill` is `X_CLI_BAD_FLAG` naming a shape that works: the four answer four different questions, and defaulting to one of them is the ambiguity axiom 1 refuses.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--name` | string | — | migration or branch name, or the backfill to filter the ledger by, when you would rather not pass it positionally |
| `--allow-destructive` | boolean | `false` | let `gen` emit a DROP whose `down` cannot restore the rows. `X_MIGRATION_IRREVERSIBLE`'s own `fix:` line names it |
| `--list` | boolean | `false` | `backfill`: print the ledger |
| `--pending` | boolean | `false` | `backfill`: declared minus completed, judged in this `ULTIMATE_ENV`. Non-zero exit when anything is unswept |
| `--all` | boolean | `false` | `backfill`: every pending sweep, isolated per name |
| `--write` | boolean | `false` | `backfill`: enqueue the pass. Without it the command is a dry run and writes nothing |
| `--force` | boolean | `false` | `backfill`: sweep a name the ledger records as completed, into a **new** ledger row |
| `--status` | string | — | `backfill`: `running`, `completed` or `failed`. Anything else is `X_CLI_BAD_FLAG` naming the three |
| `--limit` | string | `100` | `backfill`: max ledger rows |

**The backfill ledger is what has already been SWEPT.** One row per pass — name, status, rows
processed, last cursor, the app version that started it, started/completed — keyed by run rather
than by name, so `enqueue({ force: true })` writes a *new* row instead of editing the one it
reruns. A completed row is what makes the next **pass** a no-op — not the next enqueue: the
one-live-run index covers `ready`/`delayed`/`running`/`suspended`, and a completed job is in none
of them, so a second `enqueue()` creates a real job row whose pass then reports `skipped: true`.

```bash
$ x db backfill --list
  name           status     rows   cursor      started-at                duration-ms  run-id
  reindex-posts  completed  84000  -           2026-08-14T09:00:00.000Z  240000       9c1e…
  recount-likes  running    12500  post_12500  2026-08-14T09:31:12.004Z  -            7f3a…
✓ 2 backfill pass(es)
```

`started-at` is the ledger's own ISO string, printed verbatim — this repo formats no date without
an explicit IANA `timeZone`, and not formatting is the one rendering with no zone to get wrong.
An empty ledger exits **0**: "nothing has swept this database yet" is an answer. `--json` carries
the same rows plus the definition checksum. The live half of the same ledger is on `x jobs ls`,
and `/_x`'s jobs panel carries the whole of it.

**One migration engine, everywhere.** `gen` calls `@ultimat3/db`'s `generateMigration()`;
`migrate` and `reset` call `migrate()` — the same `x_migrations` ledger, the same per-migration
checksum, the same session-pinned advisory lock a `ROLE=migrate` container runs. A laptop, CI,
staging and production therefore share one answer to "what has been applied". Before 1.2.0 these
shelled out to `bunx drizzle-kit`, a second engine with a second journal that no `package.json`
declared and `bunx` fetched unpinned at run time. Nothing in the request path goes through an ORM
either: reads and writes run on `@ultimat3/entity`'s hand-written `postgresDriver()`.

**One migration is one file.** `x db gen` writes three, all committed:

| File | Holds |
|---|---|
| `packages/db/migrations/<id>.sql` | the `up`, then a lone `-- down` line, then the reverse |
| `packages/db/migrations/<id>.snapshot.json` | the schema this migration leaves behind — what the *next* `x db gen` diffs against |
| `packages/db/migrations/<id>.hash` | the entity-source hash `x verify`'s `drift` step checks |

**And `x db gen` is that directory's only writer**, `As of 2026-08`. `x new` scaffolds no migration:
a hand-written first file carried no `.snapshot.json` — the one artifact only the generator produces
— so the app's first `x db migrate` and first `x db gen` refused each other. A pristine scaffold's
first two commands are `x db gen "initial"` then `x db migrate` (`bin/setup` runs both), and until
the first has run, `x verify`'s `drift` step is red naming exactly that — **for an app that declares
an entity**, since zero declared against zero recorded is agreement and `--no-example` is therefore
green. A foreign key is
emitted as `alter table … add constraint` **after** every table statement, never as a `references`
clause inside `create table`, so the order entities happen to register in cannot make a migration
unappliable.

**`X_DB_DRIFT` has two detectors, and each answers what the other cannot.** `x verify`'s `drift`
step hashes the entity source against the `.hash` sidecars — no database, so it runs in a CI with
nothing listening, and it catches "you edited an entity and never generated". `x db migrate` diffs
the live catalog against the `x_migrations` ledger — a database, so it runs only where one is open,
and it catches "someone changed the schema by hand". A table in the `x_` namespace is framework
bookkeeping (the ledger, the queue, the outbox, the auth tables) and is never counted as drift.

A separate `<id>.down.sql` is not a migration and is never applied — that was a hand-written
pre-1.2.0 layout, and reading it as one would drop every table the pair exists to reverse.

Errors, schema: `X_DB_DRIFT`, `X_DB_GEN_FAILED`, `X_DB_MIGRATE_FAILED`, `X_DB_BRANCH_FAILED`, `X_MIGRATION_CONFLICT`, `X_MIGRATION_IRREVERSIBLE`, `X_MIGRATE_CONCURRENT`, `X_NOT_IMPLEMENTED`. `X_DB_STUDIO_FAILED` is reserved and no longer thrown — `x db studio` is planned.

Errors, backfill: `X_BACKFILL_PENDING` (`--pending`, and the only one that is not a refusal — the sweep simply has not run), `X_BACKFILL_UNKNOWN`, `X_BACKFILL_ENVIRONMENT`, `X_BACKFILL_MIGRATION_PENDING`, `X_BACKFILL_APPLIED`, `X_BACKFILL_RUNNING`. All six are `@ultimat3/jobs`', carry a one-line runnable `fix:`, and are what a non-zero exit from these shapes means — full wording in [Error codes → Backfills](Error-Codes#backfills). `X_BACKFILL_STALLED` is the seventh and never reaches this command: it is raised by the pass, on a worker, so it surfaces through `x jobs show <id>`.

## x verify

```bash
x verify [--workers N] [--json]
```

The single gate. Green means shippable; CI runs exactly this. One step list, in cost order, shared
with the framework repo's own `bun run verify` — there is no `--only` and no `--skip`, because
"green" has to mean the same thing for everyone. A step with nothing to check in this project
reports as skipped (`-`), never as passed — and the summary counts skips apart from passes and
names them, so a gate that is green because a suite does not exist has to say so on the one line
every reader sees:

```text
✓ 14 of 17 steps passed in 11153ms — 3 skipped: e2e, contract-diff, roadmap
```

`--json` carries the same fact twice: `steps[].skipped` per step, and `data.skipped` as the list of
names beside `data.failed`. `all {n} steps passed` is printed only when nothing was skipped.

`x.verify.json` ratchets those skips. Hand-written, committed at the repo root, read by the gate
and written by nothing:

```json
{ "steps": ["typecheck", "lint", "boundaries", "unit", "contract", "live", "e2e", "manifest"] }
```

Every name in it is a step this repo has already run, so a step in the list with nothing left to
check is a deleted suite — reported as **failed**, not skipped, with `X_VERIFY_SUITE_VANISHED` and
the two edits that resolve it. A repo with no such file is not ratcheted, and a name the gate does
not run is refused by the `manifest` step (`X_CONFIG_INVALID`) rather than silently covering
nothing. Removing a line is allowed; it just has to be a diff somebody reviews.

`--workers` widens the test steps only. `unit`, `contract`, `job` and `eval` shard across worker
processes, each with its own database; `live` and `e2e` are serial by declaration and say so in the
output. The default oversubscribes the cores — `clamp(round(cpus * 1.5), 2, 8)` — because leaving a
core spare measured *slower than not sharding at all* on a 4-core runner, where sharding's own cost
is not covered by three workers.

| Step | Checks |
|---|---|
| `typecheck` | `tsc` across every workspace |
| `lint` | Biome: no `any`, no default exports, no bare `Error`, no raw colours, no hardcoded user-facing strings |
| `boundaries` | surface and layer imports, resolved transitively; package tiers in a monorepo |
| `filesize` | a source file over 500 lines |
| `package-shape` | a workspace package missing `README.md`, `CLAUDE.md`, `tsconfig.json`, `src/index.ts` |
| `errors` | every `X_*` code has a runnable fix and a docs page |
| `unit` | pure logic — services, money, policy predicates, matchers |
| `contract` | action/query schemas, policy denials, emitted OpenAPI and MCP shapes |
| `live` | live-query snapshot, incremental patches, reconnect delta, policy-filtered rows |
| `job` | step replay, idempotency dedupe, retry/backoff, concurrency, outbox atomicity |
| `e2e` | Playwright against the built output, including offline and SW update |
| `eval` | prompt scores vs. their recorded baselines, and a prompt with no eval at all |
| `drift` | schema vs migrations |
| `contract-diff` | published actions vs `openapi.json` |
| `budgets` | per-route JS bytes and LCP, and the global style layer every document carries (`X_STYLES_GLOBAL_MISSING`) |
| `manifest` | the files an agent reads: `x.manifest.json` freshness, `.env.example`, a hand-written `AGENTS.md` that exists and is under 12kB, and `x.verify.json` naming only steps the gate runs |
| `roadmap` | framework repo only — every `docs/idea/14-roadmap.md` milestone carries a status marker, and a milestone marked shipped still has the artifacts its own row names |

A test's type is its filename suffix — `*.contract.test.ts`, `*.live.test.ts`, `*.job.test.ts`,
`*.e2e.test.ts` (or any test under `e2e/`), `*.eval.test.ts`. Everything else is a unit test, so no
test can fall between two steps.

`eval` is the one step that applies with no suite of its own: a prompt no `defineEval` names is
`X_EVAL_MISSING`, and an eval whose baseline was never recorded is `X_EVAL_BASELINE_MISSING`,
because a skipped step — or one gating against nothing — would read as a green gate over untested
code. It gates on the drop from each eval's committed baseline, never on an absolute score —
`ULTIMATE_EVAL_RECORD=1 x test eval` re-records those baselines so accepting a new number is a
reviewable diff.

That flag and this step are mutually exclusive. `x verify` with `ULTIMATE_EVAL_RECORD` set is
`X_EVAL_RECORDING` and the suite does not run: recording makes every eval write the numbers it
just measured and pass, so a gate that inherited the flag reports green over scores nothing
compared — and rewrites the committed baselines on its way through.

```bash
$ x verify --json
{"ok":false,"command":"verify",
 "summary":"1 of 17 steps failed — 3 skipped: e2e, contract-diff, roadmap","steps":[
  {"name":"budgets","ok":false,"durationMs":812,"skipped":false,"findings":[
    {"code":"X_BUDGET_EXCEEDED","cause":"site/pricing ships 61kb of JS, over the 40kb budget",
     "fix":"x fix boundary site/pricing/page.tsx",
     "docs":"https://ultimate.dev/errors/X_BUDGET_EXCEEDED","at":"site/pricing"}]}],
 "data":{"failed":["budgets"],"skipped":["e2e","contract-diff","roadmap"],"durationMs":11153}}
```

Errors: `X_VERIFY_FAILED` (with the failing step names), plus each step's own code.

## x build

```bash
x build --target docker|binary|static [--tag name] [--out path] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--target` | string | `docker` | `docker` (one image, all roles), `binary` (`bun build --compile`), `static` (prerendered `site/`) |
| `--tag` | string | `ultimate-app:dev` | image tag, docker target |
| `--out` | string | `.x/app` (`.x/static` for `static`) | output path, binary and static targets |

### Every target has one entry file

`BUILD_ENTRY` is the whole mapping. The entry is checked **before** the verify gate runs and before the builder is spawned, because `bun build`'s own "module not found" names no owner.

| `--target` | Entry file | Command it execs | Output |
|---|---|---|---|
| `docker` | `docker/Dockerfile` | `docker build -f <root>/docker/Dockerfile -t <tag> <root>` | one OCI image, `ROLE` selects behaviour |
| `binary` | `apps/web/server.ts` | `bun build --compile --minify --define ULTIMATE_FRAMEWORK_VERSION="<version>" <root>/apps/web/server.ts --outfile <out>` | a single executable |
| `static` | `apps/web/prerender.ts` | `bun run <root>/apps/web/prerender.ts --out <out>` | prerendered `site/` |

All three are written by `x new`. A missing one is `X_BUILD_ENTRY_MISSING`, whose `fix` names the file and points at a fresh scaffold — the usual cause is an app scaffolded before 1.1.0 wrote `server.ts` and `prerender.ts`, or a deleted `docker/Dockerfile`.

Runs the static verify steps first (`typecheck`, `lint`, `boundaries`, `filesize`, `package-shape`, `errors`); if any fail, exits non-zero without building. The content-hash build ID every target shares is `x.manifest.json`'s, written by `x manifest`, not computed here. Errors: `X_BUILD_ENTRY_MISSING`, `X_BUILD_FAILED`; an unknown `--target` is `X_CLI_UNKNOWN_COMMAND` with `build --target docker` as the suggestion.

> `--target binary` adds `--define ULTIMATE_FRAMEWORK_VERSION="<version>"`. A single-file executable carries no `package.json`, so the define is the only thing the framework's version read can find — build one with a bare `bun build --compile` and it exits `X_INVARIANT` at the first read, naming the flag. One define answers for both reads: `@ultimat3/cli` ships in lockstep with `@ultimat3/core`, so `x --version` inside a binary falls back to the same flag rather than declaring a second one. What is still unmeasured is the target end to end: no scaffolded app has been compiled and served from a bare VM ([Known gaps](Known-Gaps)).

## x deploy

```bash
x deploy --image repo/app:tag [--method compose|helm] [--dry-run] [--critical] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--image` | string | `ultimate-app:dev` | image reference to deploy |
| `--method` | string | `compose` | `compose` or `helm` |
| `--dry-run` | boolean | `false` | print the plan, run nothing |
| `--critical` | boolean | `false` | security deploy: clients are forced to reload after the grace period |

`compose` is six ordered steps against `docker/docker-compose.prod.yml` — `run --rm migrate` to
completion, then `up -d` for `web`, `sync`, `worker`, `scheduler`, then `run --rm backfill` last.
**`migrate` gates and `backfill` triggers**: a slow `UPDATE` inside a release gate holds the deploy
open against a database still serving the previous release, so data sweeps are enqueued after the
new pods serve and the workers already draining the queue perform them. The `backfill` service runs
`x db backfill --all --write --json` and exits. Steps run sequentially and stop
at the first non-zero exit; the `fix` is that step's command, so you can rerun it directly for full
output. `helm` is one `helm upgrade --install app docker/helm --set image=<ref>`; the chart is
**committed** at `docker/helm` in the framework repo, there is no `--helm` flag and nothing
generates it. Because `x new` never writes `docker/helm`, `--method helm` in a scaffolded app exits
`X_NOT_IMPLEMENTED` naming `x deploy --method compose`. Any `--method` value other than the literal
`helm` is treated as `compose`. `--critical` is carried into `--json` output and nothing else acts
on it today. Errors: `X_DEPLOY_FAILED`, `X_NOT_IMPLEMENTED`.

`X_MIGRATE_CONCURRENT` is **reserved and never thrown** — the lock is real. `ROLE=migrate` holds
`pg_advisory_lock` on one pinned session for the whole run, so two overlapping deploys serialise:
the second **waits**, it does not race and does not error → [Known gaps](Known-Gaps).

## Serving in production — `ROLE` and `PORT`

There is no `x serve` command. A container runs the scaffolded `apps/web/server.ts`, which calls
`runRole({ root, env: Bun.env })` — the production boot path, with no dev watcher, no `/_x`, and
`dev: false`. It binds `0.0.0.0`, because a process bound to `localhost` inside a container is
unreachable from the port mapping, the load balancer and every health probe at once.

| Env | Default | Meaning |
|---|---|---|
| `ROLE` | `web` | one of `web`, `sync`, `worker`, `scheduler`, `migrate`, `replicator`. **There is no `all`** |
| `PORT` | `3000` | empty or whitespace falls back to the default; anything else must be an integer in 0–65535 (`0` is legal — an ephemeral port) |

| Failure | Code | Fix as printed |
|---|---|---|
| `ROLE` names something else | `X_ROLE_UNKNOWN` | `docker run -e ROLE=web <image>` |
| `PORT` is not a TCP port | `X_PORT_INVALID` | `docker run -e PORT=3000 <image>` |

**`ROLE=migrate` is the release phase.** It starts only the db/queue pair, applies the app's
migrations through the ledger — carrying `APP_VERSION` when set — logs `{ applied, available,
appVersion }`, and **exits**. It never holds a port and never serves. Every other role loads the
app's modules (importing them *is* registration), resolves the build id from `BUILD_ID` or the
manifest, assembles its routes, and holds until SIGTERM → [Deployment](Deployment).

The scaffolded `docker/Dockerfile` defaults `NODE_ENV=production ROLE=web PORT=3000`, exposes 3000,
and health-checks `/readyz`.

## x secrets

```bash
x secrets [show|init|edit|set <NAME>|rotate] [--json]
```

Two files, one committed and one never:

| File | Committed | Holds |
|---|---|---|
| `secrets.enc.json` | yes | the sealed envelope: `v`, `alg`, the master key's id, the IV, the ciphertext |
| `.secrets.key` | **no** — `x secrets init` writes the `.gitignore` rule before it writes the key | 64 hex characters, mode `0600` |

`ULTIMATE_SECRETS_KEY` is read first and the key file second, so a container is handed its key by the platform and ships no key file at all.

**A secret is an environment variable.** The decrypted payload is a flat map of `ENV_NAME` to value, and `installSecrets()` writes each one into the process environment where nothing has already set it — the real environment always wins, so one image runs in Compose and on K8s with the same committed file. Everything downstream is what already existed:

```ts
// app.config.ts
await installSecrets();
export const envSchema = {
  SESSION_SECRET: { type: 'string', secret: true, description: 'Cookie signing key' },
} satisfies EnvSchema;
export const env = defineEnv(envSchema);
```

One declaration, one row in `.env.example`, one mask (`maskedEnvValues`), one redaction entry, one reader (`env.SESSION_SECRET`). There is no `secrets.get()` — a second accessor would be values with no declaration, no type and no mask.

| Subcommand | Does |
|---|---|
| `show` (default) | names, lengths, and whether `envSchema` declares each one. **Never a value**, in either renderer |
| `init` | a fresh master key, the `.gitignore` rule, and an empty sealed file. Refuses to overwrite either file |
| `edit` | decrypt into a temp buffer outside the repo, open `$VISUAL`/`$EDITOR`, reseal on save. The buffer is deleted in a `finally` and by a `SIGINT`/`SIGTERM` handler; an unchanged buffer writes nothing |
| `set <NAME>` | one value, read from **stdin** — never argv, which lands in shell history and in `ps` |
| `rotate` | reseal the same values under a new master key. The committed file is written first and the key last: only the committed one can be restored from git |

```bash
$ x secrets init --json
{"ok":true,"command":"secrets","summary":"sealed secrets.enc.json — master key 4f2a…",
 "data":{"path":"secrets.enc.json","keyPath":".secrets.key","keyId":"4f2a…","gitignore":"added"}}

$ printf %s "$STRIPE_KEY" | x secrets set STRIPE_KEY --json
$ x secrets show
name            value       length     envSchema
SESSION_SECRET  [redacted]  44 chars   yes
STRIPE_KEY      [redacted]  32 chars   no
```

`--json` carries exactly what the terminal does, which is why no subcommand has a `--reveal` flag: the one way to see a value is `x secrets edit`, and the one way to read one is the app reading `env.<NAME>`.

Errors: `X_SECRETS_KEY_MISSING`, `X_SECRETS_KEY_INVALID`, `X_SECRETS_KEY_MISMATCH`, `X_SECRETS_FILE_MISSING`, `X_SECRETS_FILE_INVALID`, `X_SECRETS_TAMPERED`, `X_SECRETS_PLAINTEXT_INVALID`, `X_SECRETS_EDITOR_MISSING`, `X_SECRETS_EDIT_FAILED`, `X_GENERATE_CONFLICT` (`init` over an existing file).

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
| `db.query` | ONE read-only SQL statement; `limit` defaults to 100 rows, maximum 1000 | `db:read` |
| `db.migrate` | apply pending migrations to a **branch** database | `db:migrate` |
| `tests.run` | run the suite, structured results | `dev:test` |
| `verify.run` | run `x verify`, structured per-step result | `dev:test` |
| `logs.tail` | last N log lines, optionally for one role | `dev:logs` |

`db.query` and `db.migrate` refuse structurally — multiple statements, a mutating keyword
(a data-modifying CTE included), a locking clause, `EXPLAIN ANALYZE`, a non-branch target —
before the host runs anything.

Never exposed in `ROLE=web`. Errors split by when they fire:

| When | Codes | Effect |
|---|---|---|
| boot — configuring an MCP surface with `defineAppMcp` | `X_MCP_TOOL_UNDECLARED`, `X_MCP_TOOL_UNSAFE`, `X_MCP_TOOL_DUPLICATE` | the call throws; no server starts |
| runtime — one request | `X_MCP_TOOL_UNKNOWN`, `X_MCP_ARGS_INVALID`, `X_MCP_SCOPE_DENIED`, `X_MCP_QUERY_REJECTED`, `X_MCP_NOT_BRANCH_DB`, `X_MCP_PROTOCOL` | that call is refused; the server keeps serving |

A tool this caller may not see is absent from `tools/list` and answers ToolNotFound, never Forbidden. `x token grant <scope>` takes effect on the next connection — scopes are fixed for the life of one. Full model: [MCP and AI](MCP-And-AI).

## x doctor

```bash
x doctor [--port 3000] [--json]
```

Checks Bun version, env completeness, source drift, **the newest migration's `.snapshot.json`**, port availability and PWA prerequisites — each failing check carries its own fix command. The snapshot half is `As of 2026-08` and separate from drift on purpose: they are two questions with two remedies, and `x db gen`'s own `X_MIGRATION_SNAPSHOT_MISSING` was a condition this diagnostic could not see at all, so `x doctor --json` — the `fix:` of the `X_CLI_UNEXPECTED` an author reaches it through — ran clean over a broken app.

The output is a `CommandResult` like every other command's: `findings`, not a `checks` array.

```bash
$ x doctor --json
{"ok":false,"command":"doctor","summary":"1 finding(s)","findings":[{"code":"X_DB_DRIFT",
  "cause":"packages/db has a schema but no migration recorded it",
  "fix":"x db gen \"initial\"","docs":"https://ultimate.dev/errors/X_DB_DRIFT",
  "at":"packages/db/migrations"}],"data":{"count":1,"codes":["X_DB_DRIFT"]}}
```

## x actions · x queries · x entities

```bash
x actions  [list|describe <name>] [--json]
x queries  [list|describe <name>] [--json]
x entities [list|describe <name>] [--json]
```

The declaration registries, projected. `list` is the default subcommand. Same rows the manifest and the MCP `actions.describe` tool are built from — the CLI keeps no second table.

```bash
$ x actions list
  name          verb     resource  path                  capability    mcp
  createPost    create   posts     /api/posts/create     post:create   yes
  publishPost   publish  posts     /api/posts/publish    post:publish  yes

$ x entities describe posts --json
{"ok":true,"command":"entities","summary":"entity posts","data":{"name":"posts","table":"posts",
  "primaryKey":["id"],"columns":[…],"invariants":[…],"softDelete":true,"orgScoped":true}}
```

A name nothing registered is `X_DECLARATION_UNKNOWN`, whose `fix` names the nearest real one. A module that would not import is reported as a finding — the listing describes what loaded, and never pretends the rest is absent.

## x jobs

```bash
x jobs [ls|show <id>|retry <id>|cancel <id>|drain --to <driver>] [--queue q] [--state s]
       [--limit n] [--name n] [--from-step name] [--reason text] [--to driver]
       [--dry-run] [--json]
```

| Subcommand | Does |
|---|---|
| `ls` | queue depth, the matching rows, the dead-letter list — a dead job is never filtered out of view — and the `backfill()` passes **in flight**, with rows so far and cursor |
| `show <id>` | state, attempt, every step's result, the remaining retry delays, and the `x_backfills` row for this run when the job is a backfill (`backfill: null` for every other job) |
| `retry <id>` | re-queue; `--from-step <name>` drops that step so it re-executes while everything before it replays from storage |
| `cancel <id>` | stop a job that has not finished — the way to end a runaway `backfill()` sweep. `--reason <text>` is recorded on the job. Re-reads the row after cancelling, so **exit 0 means it is genuinely stopped**: a job that already finished, an id no queue holds, and a driver with no `introspect.cancel` (the redis and nats stubs) all raise `X_JOB_NOT_CANCELLABLE` rather than reporting success |
| `drain --to memory\|redis\|nats` | move every `ready`/`delayed`/`suspended` job onto another driver; `--dry-run` reports the plan and moves nothing |

`retry` and `cancel` each take **one id positional** — there is no bulk form and no time filter. `--queue`, `--state`, `--limit` and `--name` narrow `ls` only.

```bash
x jobs cancel 019ff1c5-0000-7000-8000-000000000001 --reason "wrong tenant" --json
```

Runs against the app's own driver — the ambient one when a process already installed it, otherwise the same embedded Postgres queue `x dev` boots. `drain` enqueues on the target **before** acking the source: a crash mid-drain duplicates a job, where the idempotency key dedupes it, instead of losing it.

`ls` reports only the sweeps still **running**, because it is a live view of the queue; the whole
ledger, finished passes included, is `x db backfill --list`. A driver that ships no backfill ledger
answers with no passes rather than failing the command — the queue is still the question here.

Errors: `X_JOB_UNKNOWN`, `X_JOB_NOT_CANCELLABLE`, `X_CLI_BAD_FLAG`, and `X_NOT_IMPLEMENTED` from a driver with no introspection.

## x tasks

```bash
x tasks [list|show <name>] [--count n] [--json]
```

| Subcommand | Does |
|---|---|
| `list` | every registered `task`: cron, timezone, catch-up policy, the jobs it enqueues, and its next occurrence |
| `show <name>` | the same plus the cron in words and the next `--count` occurrences (default 5, max 50) |

Every instant is rendered in the task's **own** `tz`, never a machine-local default: a `0 3 * * *` in `America/New_York` reads `2026-03-06T03:00:00-05:00` before the spring-forward and `2026-03-09T03:00:00-04:00` after it. Same wall clock, different instant — the ambiguity the required `tz` exists to remove.

Errors: `X_DECLARATION_UNKNOWN` (with the nearest name as its fix), `X_CLI_BAD_FLAG`.

## x policy

```bash
x policy [list|explain <subject>] [--json]
```

| Subcommand | Does |
|---|---|
| `list` | every permission, the roles that grant it, and the actions and queries that enforce it — plus the permissions **nothing** enforces, which are grants that do nothing |
| `explain <subject>` | the allow/deny matrix, one row per actor per declaration — every declared role plus `anonymous`, evaluated once for each action or query that enforces the subject — naming the clause that decided and its reason |

`<subject>` resolves in order against a permission (`post:publish`), an action name (`publishPost`), a query name (`postFeed`), then an action's HTTP path (`/api/posts/publish`) — so the `fix:` line printed by an `X_FORBIDDEN` is runnable whichever of the four the throwing surface had to hand.

```bash
$ x policy explain publishPost
  action publishPost — policy post:publish
  actor      verdict  deciding      reason
  anonymous  deny     post:publish  no actor for post:publish
  author     deny     post:publish  post:publish predicate returned false
  reader     deny     post:publish  actor lacks post:publish
    evaluated with no request input and no row — a rule reading either decides again on the real request
```

The verdict comes from `@ultimat3/policy`'s own `policyMatrix()` over the app's real `Policy` objects — the same evaluation the request path runs, never a second one. It runs **outside a request**, which is what the last line says: a rule reading input or a row decides again on the real call, so a `predicate returned false` here is a no-input verdict rather than a standing denial. A policy that cannot be evaluated at all outside a request — a predicate dereferencing `input.post.id` has nothing to dereference — reports `decidable: false` and prints that note in place of the table, never a table of invented denials.

Errors: `X_DECLARATION_UNKNOWN`, `X_CLI_BAD_FLAG`.

## x i18n

```bash
x i18n [check|add <locale>|sync <locale>] [--json]
```

| Subcommand | Does |
|---|---|
| `check` | scan every `t('…')` in the app's source, audit it against every catalog on disk, and **fail** on a missing key |
| `add <locale>` | write `packages/i18n/catalogs/<locale>.json` seeded with the default locale's keys and values |
| `sync <locale>` | add the keys that locale is missing; a key it already has is never overwritten, translated or not |

Catalogs are one flat file per locale under `packages/i18n/catalogs/`. `check` reports three things separately: `missing` (a gap, and an exit code), `unused` (defined and never called), and `dynamic` — a `t(`plans.${plan}.name`)` the extractor cannot resolve. A dynamic call contributes its static head as a runtime-key prefix, so a key only ever reached that way is never listed unused; an expression with no static head contributes nothing, because a guessed prefix would suppress real gaps.

Errors: `X_CATALOG_MISSING_KEYS` (per locale, as a finding), `X_CATALOG_INVALID`, `X_GENERATE_CONFLICT` (`add` over an existing catalog), `X_CLI_BAD_FLAG`, `X_SCAFFOLD_PATH_ESCAPE`.

## x test

```bash
x test [unit|contract|live|job|e2e|eval] [--filter text] [--sample N]
       [--workers N] [--worker I] [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| *(positional)* | test type | every type | one of the six; a test's type is its filename suffix |
| `--filter` | string | — | only files whose path contains this substring |
| `--sample` | string | — | run at most N files of the selection, deterministically. A fast signal for the eval loop — **never a gate** |
| `--workers` | string | CPUs | process count; each worker gets its own template-cloned database |
| `--worker` | string | — | rerun only shard I of the same split, reproducing a CI worker failure locally |

The type rule is `x verify`'s, not a second one — so `x test contract` runs exactly what the gate's `contract` step runs. A selection that matches no files is `X_TEST_NO_FILES`; an unknown type is `X_CLI_BAD_FLAG` naming the six and suggesting the nearest.

## x errors

```bash
x errors [explain <CODE>|list] [--json]
```

The [Error codes](Error-Codes) table, programmatically. Runs outside an app: triaging a code must not need an app root.

```bash
$ x errors explain X_CURSOR_INVALID --json
{"ok":true,"command":"errors","summary":"X_CURSOR_INVALID — pagination cursor is malformed…",
 "data":{"code":"X_CURSOR_INVALID","cause":"pagination cursor is malformed, tampered with or from
 another query","fix":"x verify --json","docs":"https://ultimate.dev/errors/X_CURSOR_INVALID"}}
```

`list` enumerates every registered code, and names under `data.unavailable` any package this process could not import — a list silently missing codes is worse than one that says which. An unregistered code is `X_ERROR_CODE_UNKNOWN` with the nearest real code as its fix; the command never invents an explanation.

## x fix

```bash
x fix boundary <file> [--json]
```

The minimal cut for an import that crossed a surface boundary — the command every `X_SURFACE_BOUNDARY` finding names in its `fix:` line. It prints a plan and **writes nothing**; there is no `--write`.

For each violation involving the file it reports the offending edge, the full chain that makes it one, and the edit to make. For the `shared/` fattening case it generates the split: when exactly one surface reaches the module **and the module lands on the same surface as the file it imports**, the plan carries the `git mv` plus every import specifier that move invalidates — the move alone is not a repair, it just relocates the break. When two surfaces reach it, or when relocating would leave the forbidden edge exactly where it was, the module has to be cut by hand and the plan says so rather than guessing.

`<file>` is app-root-relative, or any suffix that matches exactly one source file — the short form a `fix:` line emits. Errors: `X_FIX_TARGET_UNKNOWN` (with the nearest real path as its fix), `X_CLI_BAD_FLAG` on an ambiguous suffix.

## Planned commands

Specified in the design docs, not yet implemented. Every one is in the command registry: calling it exits `X_NOT_IMPLEMENTED` with a `fix:` naming the closest shipped command, because "not built yet" and "not a command" are different facts and only one of them is true.

The table is `PLANNED_COMMANDS` in `packages/cli/src/cmd-planned.ts`; `cmd-planned.test.ts` asserts every row is reachable through the parser and that no `fix` points at another planned command. `PLANNED_SUBCOMMANDS` in the same file is the one-level-down version — a subcommand of a shipped command that this build does not implement, `x db studio` being the only entry. It stays in `x db`'s subcommand list, so the parser reaches it and `x help db` lists it.

| Command | Purpose | `fix:` today |
|---|---|---|
| `x cache [graph\|bust <tag>\|clear\|stats]` | what a write evicts; targeted eviction | `x dev` → the `/_x` cache panel |
| `x branch [<name>\|rm <name>]` | copy-on-write database + preview URL + scoped MCP socket | `x db branch <name>` |
| `x status` | role health and the build-ID distribution of connected clients | `x doctor --json` |
| `x upgrade [--dry-run]` | move every `@ultimat3/*` in lockstep, run codemods, then `x verify` | `bun update --latest && x verify` |
| `x logs tail` | structured logs and spans, filterable | `x dev` → the `/_x` timeline panel |
| `x token [create --scopes <s>\|grant <scope>]` | MCP tokens and scopes | `x mcp serve --help` |
| `x ai [eval <name>\|cache\|reindex]` | eval scores, cache hit rate and tokens saved, vector reindex | `x test eval --json` |
| `x money add-currency <ISO> --exponent <n>` | extend the currency table | `x manifest --json` |
| `x config show` | the resolved configuration, defaults included | `x manifest --json` |

**Call them flagless.** A planned command's spec declares no command-specific flags, so `x money add-currency USD --exponent 2` and `x upgrade --dry-run` fail at the *parser* with `X_CLI_BAD_FLAG` — an unknown flag — instead of the honest `X_NOT_IMPLEMENTED`. Only the bare form reaches the real message. [Known gaps](Known-Gaps).

## Names that moved

| Older name in the design docs | Use instead |
|---|---|
| `x db apply` | `x db migrate` |
| `x gen <kind>` | `x g <kind>` (or `x generate`) |
| `x deploy compose` / `x deploy static` | `x deploy --method compose` / `x build --target static` |
| `x mcp` (bare) | `x mcp serve` |
| `x routes list` | `x routes` |

Related: [Getting started](Getting-Started) · [Configuration](Configuration) · [Testing](Testing) · [Deployment](Deployment) · [Troubleshooting](Troubleshooting).
