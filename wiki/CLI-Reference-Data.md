# CLI reference: data

Part of the [CLI reference](CLI-Reference): `x db`, `x jobs`, `x tasks`, `x cache`. Conventions, global flags and the command index are on the index page.

## x db

```bash
x db gen "add publish_at" [--merge-fork] | migrate | rollback [--steps n] | reset
     | seed [<name>] [--tier reference|dev] [--dry-run] [--json]
     | branch list | branch create <name> | branch delete <name>
     | backfill --list [--name n] [--status s] [--limit n] [--json]
     | backfill --pending [--json]
     | backfill <name>|--all [--write] [--force] [--json]
     | diagnostics [--limit n] [--json]
     | status [--json]
```

| Subcommand | Does | Notes |
|---|---|---|
| `gen ["<name>"]` | diff the app's entities against what the migrations declare, write the next migration, then rewrite the schema dump | One run at a time per checkout, `As of 2026-11`. The summary names the tables the migration touches (`data.tables`); a run with nothing to write names the newest migration (`data.newest`), which a concurrent run may have written. A forked chain is refused first (`X_MIGRATION_FORKED`). the message becomes the id's slug; left out it is `change`. **Writes to no database of yours** — the diff reads the previous migration's snapshot, and the dump is replayed on a scratch database it boots and discards: the embedded one, restored from a snapshot under `.x/cache` after its first boot, or a real Postgres when a migration creates an extension PGlite cannot link ([the engine rule](Migrations-And-Backfills#extensions-and-the-scratch-database)). **Exit 1 with a migration written** is possible: the dump failed after the migration was generated, the summary and the finding both say so, and the next move is a bare `x db gen`, never the same message again. A bare `x db gen` with nothing to generate rewrites `packages/db/schema/` alone, which makes it `X_SCHEMA_DUMP_DRIFT`'s whole fix. On the **embedded** database it first reads the ledger once (through a running `x dev`, else a read-only open of `.x/pgdata` when it exists; `As of 2026-11-19`): an applied migration whose SQL was edited since is `X_MIGRATION_CONFLICT`, exit 1, nothing written — the dump is never rewritten to match an edit. A ledger it cannot read is a printed line, never a refusal; an external `DATABASE_URL` is never dialled. A change that needs a step outside the transaction is written as two migrations, `<id>` and `<id>_concurrently`, and the summary names both. When the app does not load, nothing is compared and the summary says so — *nothing was compared — the app did not load (N finding(s)); fix them, then run x db gen again* — never "no migration needed". `--json`: `data.schemaDump` = `{ directory, status, files, written, removed }`, `status` one of `written`, `unchanged`, `skipped` (no migration yet), `failed`. `--allow-destructive` lets it emit a drop whose `down` cannot restore the rows; `--rolling-unsafe` lets it drop a column never retired, for an app that stops before it starts → [A column drop takes two releases](Migrations-And-Backfills#a-column-drop-takes-two-releases) |
| `migrate` | apply pending migrations, verify the result, then rewrite the schema dump | literally `ROLE=migrate`'s own `runMigrations` — which ends by diffing the live schema against the ledger it just wrote, on the connection it already holds. A difference is `X_DB_DRIFT` and a non-zero exit. Beside a live `x dev` holding the embedded database it is **applied by that dev server** (`POST /_x/db/migrate`, loopback and same-origin only), never by a second process: PGlite takes no lock of its own, and a second writer's tables are dropped by the holder's next write. The report, drift and dump are the same either way. The request sends `Sec-Fetch-Site: same-origin`, so an app's CSRF check admits it, and a holder still booting is waited for (up to 120 s; only a refused connection is retried, so a sent request is never sent twice). Applied that way, `x dev` serves the new schema without restarting. A holder that cannot answer (older server, dead port) is `X_DEV_ALREADY_RUNNING`, fix `x stop --json && x db migrate && x dev` (against an external `DATABASE_URL` it runs as always). A holder with `database.rowSecurity` serves as `x_app` and applies the pass all the same: it holds its one session exclusively, runs the pass as `x_migrator`, and serves as `x_app` again before any other statement runs; if it cannot, it stops serving (`X_DB_ROW_SECURITY_BYPASSED`, fix `x stop --json && x dev`) (`As of 2026-11-27`). Then, `x db migrate` only: the dump is regenerated as `gen` does, and the database is reopened to report any trigger, function, view, type or sequence no migration creates (`unexpected-object`, also `X_DB_DRIFT`). `--json` carries the same `data.schemaDump` |
| `rollback [--steps n]` | reverse the most recently applied migration(s), most recently applied first (`applied_at`, not id), by running each file's `-- down` half | default 1 (`--steps` is an integer ≥ 1, read before anything opens). The files stay, so each is pending again: `x db migrate` re-applies it, deleting its `.sql` / `.snapshot.json` / `.hash` drops the change. No `-- down` marker in the file: `X_MIGRATION_IRREVERSIBLE` (an empty `down` under the marker reverses with no statement). A ledger row whose file is gone: `X_MIGRATION_CONFLICT`. On a named deploy (staging or production, `NODE_ENV=production` included), an `ULTIMATE_ENV` that names no environment, or — whatever the environment — an external `DATABASE_URL` whose host is not this machine (loopback or a local socket): `X_MIGRATION_ROLLBACK_DESTRUCTIVE` until `ROLLBACK_ALLOW_DESTRUCTIVE` names every id it would reverse — judged under the migrate lock against the rows it is about to reverse. Beside a live embedded `x dev` it is run by that server (`POST /_x/db/rollback`), as `migrate` is; a request that reached it and lost its answer may have run, so its `X_DEV_ALREADY_RUNNING` fix is `x stop --json && x db status && x dev` — read the ledger, never the rollback again (only a refused connection repeats it). A change `gen` wrote as `<id>` + `<id>_concurrently` takes `--steps 2`; one step reverses the second half and names `<id>` as still applied. An index-only change is one non-transactional migration under the plain id, whole: no such line. `--json`: `data` = `{ reverted, steps, files }`. `As of 2026-11-19` |
| `reset` | delete the embedded data directory, then migrate | **embedded database only** — against an external Postgres it exits `X_NOT_IMPLEMENTED` and tells you to drop and recreate it yourself |
| `seed [<name>]` | apply the app's seeds — every one this environment takes, or the one named | **replayable**: a second run writes nothing and raises nothing, on Postgres as well as in memory. One transaction per seed, so one bad fixture graph cannot roll back the seeds that already landed. `--dry-run` reports what each would write and writes nothing. Beside a live `x dev` holding the embedded database, `seed` (`--dry-run` and `--generate` included) is refused `X_DEV_ALREADY_RUNNING`, its fix `x stop --json && x db seed … && x dev` (`As of 2026-11-19`); `backfill --write` is refused the same way, `backfill` listing and dry runs are not |
| `branch list` | every **managed** branch of this database: name, location, created-at, size | managed means this framework made it — external, a database carrying `createBranch()`'s `comment on database` marker; embedded, a `pgdata-<name>` directory. A branch cloned by the pre-1.2.x `psql` shell-out carries no marker, so it is absent here and `delete` refuses it → [Known gaps](Known-Gaps). `size` reads `unknown` on the embedded database — measuring it is a full directory walk. The delete path only touches what this lists |
| `branch create <name>` | `CREATE DATABASE … TEMPLATE` copy-on-write clone (PGlite: a copied data directory) | the isolation an agent should use before migrating. An existing name is `X_BRANCH_EXISTS`, never an overwrite |
| `branch delete <name>` | delete that branch database (PGlite: its `pgdata-<name>` directory) | a name `list` does not show is refused with `X_DB_BRANCH_FAILED` naming what it *would* have touched — that is the whole guard, and it is why there is no `--force` |
| `backfill --list` | print the `x_backfills` ledger — one row per `backfill()` pass, newest first | what has already been swept |
| `backfill --pending` | every backfill the app **declared**, minus the ones that completed | the alarm: a sweep merged and never enqueued had no ledger row and was invisible everywhere. **Non-zero exit** when anything is unswept, so a cron reads the code and not the table |
| `backfill <name>` / `backfill --all` | gate one sweep (or every pending one) and enqueue it | **dry run by default** — `--write` is never implied. `--write` enqueues; the workers perform the pass, because the queue is a job's execution surface. `--all` isolates per name and continues past a failure, exiting non-zero naming each |
| `diagnostics` | what the database is doing now: `blockers` (each waiting `pid` and the `blockedBy` pid holding it, at `data.blockers.rows[]`), `activity`, `slowQueries`, `unusedIndexes`, `invalidIndexes`, `notValidConstraints`, `deadTuples` | **facts, never a verdict: exit 0** whatever they say. The one failure is a connection that never opens, `X_DB_UNAVAILABLE`. Every section is one catalog read in its own `BEGIN READ ONLY` with a 2 s `statement_timeout`, capped at `--limit` rows (default 20, at most 1000). A section that fails is `{ available: false, code, reason, fix }` in place and the other six still answer; `slowQueries` is unavailable until an operator installs `pg_stat_statements` (never on the embedded database). No user table is read; session SQL is printed with every literal as `?`; a credential in a reason is masked. **Whoever runs it sees the redacted SQL of every session on the app's database role** (every role, when it holds `pg_read_all_stats`): statement shape and identifiers, never values. `unusedIndexes` skips unique and primary indexes and carries `statsAgeSeconds` and `replica`. Opens the database without applying the framework tables; an embedded one `x dev` holds is refused (`X_DEV_ALREADY_RUNNING`). `--json`: `data.<section>`. Arbitrary read-only SQL is `db.query` over [`x mcp serve`](MCP-And-AI) |
| `recount <entity>.<column>` | compare a `countedIn` counter with the true count of its child rows | **dry run by default**: lists the drifted rows (at most 50, the count whole) and exits non-zero with `X_LIFECYCLE_TRIGGER_MISSING` when any drifted. The parent is walked in windows of 1,000 keys, in key order, each window one cross-tenant transaction (`As of 31.23`). `--write` repairs each window's drift inside its transaction and exits 0. An unknown `<entity>.<column>` is `X_CLI_BAD_FLAG`. `--json`: `data` = `{ target, write, drifted, batches, rows }` |
| `status` | is this database at this build? The app migrations this build ships against the `x_migrations` ledger (`pending`: shipped, not applied; `ahead`: applied, not shipped; `edited`: applied, the file now hashes otherwise), and the framework stamp (`framework.applied`, the newest build it records, a major skew) | **one read, no writes**, `As of 2026-11-15`: the stamp comment and the ledger rows, judged by the rules a serving role's boot applies (`appMigrationsVerdict`, `stampVerdict`). No DDL, no ledger created, no migrate lock; an embedded database never created is reported as nothing applied without being initialised, one `x dev` holds is refused (`X_DEV_ALREADY_RUNNING`). **Non-zero exit** with the boot's own findings when behind — `X_FRAMEWORK_SCHEMA_UNAPPLIED`, `X_APP_MIGRATIONS_UNAPPLIED` (fix `x db migrate`) — and the ledger judged as `x db migrate` judges it (`ledgerAheadOfBuild`, then `auditLedger`): an edited migration, or an `ahead` row that is not exactly a rollback — one sorting before the newest migration this build ships, or beside a pending one — is `X_MIGRATION_CONFLICT`; a rollback over a row recorded destructive is `X_MIGRATION_ROLLBACK_DESTRUCTIVE` unless `ROLLBACK_ALLOW_DESTRUCTIVE` names it. An `ahead` that is exactly a rollback exits 0: `x db migrate` accepts it and a serving role serves it with a warning (a rollback, or a rollout's old pods). `--json`: `data` = `{ shipped, applied, pending, ahead, edited, framework: { version, schema, applied, newest, skew, aheadByMajor } }`, `applied` `null` when no ledger exists |

A bare `x db backfill` is `X_CLI_BAD_FLAG` naming a shape that works: the four answer four different questions, and defaulting to one of them is the ambiguity axiom 1 refuses.

**Seeds have TIERS, and production takes one of them**, `As of 2026-08`. A seed declares
`tier: 'reference'` — data the app is wrong without, which ships to production through this same
command — or `tier: 'dev'`, the default, which is fixture data. A bare `x db seed` runs every tier
the resolved environment takes: `reference` and `dev` everywhere, `reference` alone under
`ULTIMATE_ENV=production`.

| To do this | Run |
|---|---|
| every seed this environment takes | `x db seed --json` |
| one named seed | `x db seed dev --json` |
| the reference data only, anywhere | `x db seed --tier reference --json` |
| dev fixtures on a box whose `ULTIMATE_ENV` says production | `x db seed dev --tier dev --json` |
| the same, with no argv to change (a release-phase container) | `ULTIMATE_SEED_TIER=dev x db seed --json` |
| rows for every entity with no seed written, parents first, same-tenant keys | `x db seed --generate --rows 3 --seed 1 --json` |

Naming the tier is both the selection and the consent, and that is why it is one word rather than
two flags: a cluster that sets `ULTIMATE_ENV=production` on every box — staging included — would
otherwise have to lie about the environment to load its own fixtures. A `dev` seed reached under
`production` with neither the flag nor the variable is `X_CLI_BAD_FLAG` and a non-zero exit; the
cause names both spellings and the `fix:` is the runnable one.

`--generate` draws rows off the entity declarations alone — the seed graph `x exercise` runs on: `--rows` per table (per tenant when tenant-scoped, default 3), `--seed` the integer it is drawn from, so the same seed writes the same rows. Generated rows are `dev` fixtures with no natural key to replay against, so production refuses them **whatever tier is named** (`X_SEED_ENVIRONMENT`); `--dry-run` counts the plan and writes nothing. The pass reports as one row named `(generated)`.

`--json` carries a row per seed — `{ file, name, tier, status, ms, inserted, updated, skipped }`,
**slowest first** — plus the totals, because a seed run that got slow is diagnosed by which file
took the time. `skipped` is the replay: a row already stored, with no statement sent for it.

**`branch` requires a verb, and the verb set is closed.** The first argument *was* the branch name, so `x db branch` with the word `ls` cloned a database called `ls` instead of listing anything — and every verb is itself a legal branch name, which is why verb-first is the only shape where a name cannot be read as a subcommand. `As of 2026-08` a bare name is refused: a word outside `list`, `create` and `delete` is `X_CLI_UNKNOWN_COMMAND` and its `fix:` hands the caller's own word back inside the command that still creates it (`x db branch create <word>`). The two retired verbs are refused too since 26.0.0, one verb each with no alias, but their `fix:` names the replacement instead — `ls` gets `x db branch list --json`, `drop <name>` gets `x db branch delete <name>` — because `create drop` would clone a database for a caller who asked to delete one.

Two more facts about the set, both `As of 2026-08`:

| Fact | Why |
|---|---|
| an external `create` runs through `@ultimat3/db`, not `psql` | `createBranch()` writes the marker comment `list` finds branches by. The `psql` shell-out wrote the database and no marker, so every branch the CLI made was invisible to the only lister the framework has |
| the marker records the **base**, not just the date | `ultimate:branch:<base>:<iso>` `As of 2026-08-19`, and `BranchInfo` carries `base` alongside `createdAt`. `listBranches()` walks `pg_database` for the whole **server**, so two Ultimate apps sharing one Postgres plus one nightly `reapBranches` was the other app's branches dropped — a `DROP DATABASE` nobody asked for and nothing recovers from. The reaper skips any branch whose base is not this database, **and skips a pre-3.x marker that records no base rather than dropping it**: a branch of nothing is not a branch of this database. Self-healing with no migration — the next `createBranch` writes the base down. The payload is split on the ISO tail, not on the first `:`, because a database name may contain one |
| there is no `reap` verb | `reapBranches()` is a `task` — a nightly sweep with an app-chosen max age. A CLI verb would be a second path to one job, and no default max age is defensible |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--name` | string | — | migration or branch name, or the backfill to filter the ledger by. Under `backfill --list` it is the **only** spelling of that filter: a positional there is a pass target in every other shape and is refused with `X_CLI_BAD_FLAG` rather than silently dropped |
| `--allow-destructive` | boolean | `false` | let `gen` emit a DROP whose `down` cannot restore the rows. `X_MIGRATION_IRREVERSIBLE`'s own `fix:` line names it |
| `--drop-redundant` | boolean | `false` | `gen`: leave out of the diff each implicit index (a column's own, from `.references()` or `.index()`) that another index, the primary key or a unique invariant already leads with, so the migration drops it `concurrently` in a non-transactional step you review. Never a default; once dropped, a plain `x db gen` does not rebuild it. A table with no migration yet keeps every index. `x doctor` lists what it would drop (`data.redundantIndexes`), `As of 2026-11-14` |
| `--merge-fork` | boolean | `false` | `gen`: the fix `X_MIGRATION_FORKED` prints. Rewrites the newest `.snapshot.json` to what the merged chain builds, then continues as any `gen`. Changes no SQL and deletes no migration. `--json`: `data.outcome` is `fork-merged` when no migration was needed, `data.forkRepairs` the objects corrected. Two migrations creating one object are still refused ([Two branches, one chain](Migrations-And-Backfills#two-branches-one-chain--x_migration_forked)) |
| `--steps` | integer ≥ 1 | `1` | `rollback` only: how many applied migrations to reverse, most recently applied first. `0`, a fraction or a word is `X_CLI_BAD_FLAG` before anything opens |
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
the same rows plus the definition checksum. The live half of the same ledger is on `x jobs list`,
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
| `packages/db/migrations/<id>.hash` | the hash `x verify`'s `drift` step checks: the loaded entity **registry** plus every non-test file under `packages/db/src` — the registry half sees what `describe()` means, the source half sees a seed or helper edit |

**Plus the schema dump** — `packages/db/schema/`, the whole schema as SQL, one file per table, rewritten on every `x db gen` and `x db migrate` and held by the `drift` step (`X_SCHEMA_DUMP_DRIFT`). Layout, limits and what it is not: [Migrations and backfills → The schema dump](Migrations-And-Backfills#the-schema-dump).

**And `x db gen` is that directory's only writer**, `As of 2026-08`. `x new` scaffolds no migration:
a hand-written first file carried no `.snapshot.json` — the one artifact only the generator produces
— so the app's first `x db migrate` and first `x db gen` refused each other. A pristine scaffold's
first two commands are `x db gen "initial"` then `x db migrate` (`bun run setup` runs both), and until
the first has run, `x verify`'s `drift` step is red naming exactly that — **for an app that declares
an entity**, since zero declared against zero recorded is agreement and `--no-example` is therefore
green. A foreign key is
emitted as `alter table … add constraint` **after** every table statement, never as a `references`
clause inside `create table`, so the order entities happen to register in cannot make a migration
unappliable.

**A rendered `fix:` names `bunx x` where `node_modules/.bin/x` exists** (`As of 2026-11-02`, both renderers, after `&&` too; a `#` tail and quoted text stay as written). `x` need not be on `PATH`. Identical findings collapse to one, with `meta.count` and `meta.reportedAt`.

**`x env init --production`** (`As of 30.0.0`) writes `.env.production`, the file `x deploy --method compose` reads: `ULTIMATE_ENV=production`, `IMAGE=ultimate-app:dev` (the tag `x build --target docker` makes), `POSTGRES_PASSWORD` and a `DATABASE_URL` naming the compose `db` service with it, `APP_URL` and `SYNC_URL` on localhost, and every secret the app declares or the framework refuses to boot without, 32 random bytes as hex each. Secrets are never printed: `--json` lists the key names (`data.written`). `.gitignore` gains `.env.production` first, the file is mode 600, and a second run refuses (`X_ENV_FILE_EXISTS`): the password is the one the database volume was initialised with. A required key nothing can derive is written empty, named in `data.unfilled`, and exits 1.

**`x env check` answers for one environment and says which** (`As of 2026-11-19`). Named — `ULTIMATE_ENV`, else `NODE_ENV` — it is checked as named, always. With neither set it is checked as **development**, the environment `x dev` in the same directory declares, and the summary ends `checked as development, as x dev runs here: no ULTIMATE_ENV named — a deploy: ULTIMATE_ENV=production x env check`. With neither set under `CI` it is checked as production, because the boot fails closed (`checked as production: no ULTIMATE_ENV named`). `--json` carries `data.environment`. For a deploy's answer, name it: `ULTIMATE_ENV=production x env check` — the scaffold's image sets `NODE_ENV=production`, and `x deploy`'s pre-flight fix is `NODE_ENV=production x env check --json`. A missing key's `X_ENV_MISSING` fix is the line to add, in the file that environment loads (`.env.development.local`, `.env.test.local`, `.env.production`).

**The schema dump against the newest snapshot** (`As of 2026-11-02`, `drift`, no database) is `X_DB_DRIFT`: a column in `packages/db/schema/04_tables/<t>.sql` no snapshot records means an applied migration was edited and regenerated. A table hand-written SQL names is exempt.

**`X_DB_DRIFT` has two detectors, and each answers what the other cannot.** `x verify`'s `drift`
step hashes the loaded entity **registry** plus the bytes of every non-test file under
`packages/db/src` against the `.hash` sidecars — no database, so it runs in a CI with nothing
listening, and it catches "you edited an entity and never generated". The registry half sees an
entity declared under `apps/`; the source half sees a seed or helper edit. Bytes, not meaning: a
formatter pass over `packages/db/src` after `x db gen` moves the hash too, and `x db gen` answers
"no migration needed" and re-records it. `x db migrate` diffs
the live catalog against the `x_migrations` ledger — a database, so it runs only where one is open,
and it catches "someone changed the schema by hand". A table in the `x_` namespace is framework
bookkeeping (the ledger, the queue, the outbox, the auth tables) and is never counted as drift.
The `drift` step's dump rail is the one part of it that boots a database — a scratch embedded one,
its own — so CI still needs nothing listening.

A separate `<id>.down.sql` is not a migration and is never applied — that was a hand-written
pre-1.2.0 layout, and reading it as one would drop every table the pair exists to reverse.

Errors, seed: `X_DECLARATION_UNKNOWN` (no seed of that name — the cause lists the ones there are), `X_CLI_BAD_FLAG` (an unknown `--tier`, one name declared twice, or a `dev` seed reached under `production` with no consent), and whatever the seed itself threw, reported per seed with the file it came from.

Errors, schema: `X_DB_DRIFT`, `X_SCHEMA_DUMP_DRIFT`, `X_DB_GEN_FAILED`, `X_DB_MIGRATE_FAILED`, `X_DB_BRANCH_FAILED`, `X_MIGRATION_CONFLICT`, `X_MIGRATION_FORKED`, `X_MIGRATION_IRREVERSIBLE`, `X_MIGRATION_VIEW_DEPENDS`, `X_MIGRATE_CONCURRENT`, `X_NOT_IMPLEMENTED`. `X_DB_STUDIO_FAILED` is reserved and no longer thrown — `studio` left `x db` `As of 2026-11-15` ([Known gaps](Known-Gaps#open-by-decision)).

Errors, backfill: `X_BACKFILL_PENDING` (`--pending`, and the only one that is not a refusal — the sweep simply has not run), `X_BACKFILL_UNKNOWN`, `X_BACKFILL_ENVIRONMENT`, `X_BACKFILL_MIGRATION_PENDING`, `X_BACKFILL_APPLIED`, `X_BACKFILL_RUNNING`. All six are `@ultimat3/jobs`', carry a one-line runnable `fix:`, and are what a non-zero exit from these shapes means — full wording in [Error codes → `@ultimat3/jobs`](Error-Codes-jobs). `X_BACKFILL_STALLED` is the seventh and never reaches this command: it is raised by the pass, on a worker, so it surfaces through `x jobs show <id>`.

## x jobs

```bash
x jobs [list|show <id>|retry <id>|cancel <id>|delete <id>|promote <id>|resolve-step <id> <step>
       |pause <queue>|resume <queue>|drain] [--queue q] [--state s] [--name n] [--limit n]
       [--after cursor] [--from-step name] [--reason text] [--ran|--not-ran] [--output json] [--json]
```

| Subcommand | Does |
|---|---|
| `list` | queue depth (with a `failed` bucket), ONE page of matching rows, the dead-letter list — a dead job is never filtered out of view — the `backfill()` passes **in flight**, the paused queues and the live workers. `--limit` is 1 to 200 (default 100). `--json` answers the framework's one page shape — `data.rows`, `data.nextCursor`, `data.hasMore` — and `nextCursor` is a string **exactly when another row exists**: the command reads one row past the page (at 200, one probe after it), so a full last page is `hasMore: false` with no cursor, never one that fetches an empty page. Pass `nextCursor` as `--after` while `hasMore` is true. Until 25.0.0 it was `data.next`, guessed from the row count |
| `show <id>` | state, attempt, every step's result, the payload (`input`, with every key the app declared secret redacted), the failure's `stack`, the last `progress` the body reported, the remaining retry delays, the concurrency key the run counts under (`concurrencyKey` — `concurrency.key(input)`, `null` unless the job declares a keyed cap), and the `x_backfills` row for this run when the job is a backfill (`backfill: null` for every other job) |
| `retry <id>` | re-queue a job that has FINISHED; a job still `ready`, `delayed` or running is refused with `X_JOB_NOT_REQUEUEABLE`. `--from-step <name>` drops that step and every step that started after it, so they re-execute while everything before it replays from storage |
| `cancel <id>` | stop a job that has not finished — the way to end a runaway `backfill()` sweep. `--reason <text>` is recorded on the job. Re-reads the row after cancelling, so **exit 0 means it is genuinely stopped**: a job that already finished, an id no queue holds, and a driver with no `introspect.cancel` all raise `X_JOB_NOT_CANCELLABLE` rather than reporting success |
| `delete <id>` | delete one job and its step records. An unknown id is `X_JOB_UNKNOWN`; a **running** job is refused with `X_JOB_NOT_REMOVABLE`, whose fix is `x jobs cancel <id> --json` — deleting the row under a body does not stop the body |
| `promote <id>` | make a job waiting on its run time — delayed at enqueue, or backing off before a retry — due now. Anything else (due, running, finished, suspended in a `step.sleep`) is `X_JOB_NOT_PROMOTABLE`, naming the state |
| `resolve-step <id> <step>` | answer a `once` step whose outcome is unknown (`X_STEP_OUTCOME_UNKNOWN`): `--ran --output '<json>'` records it `completed` — a replay returns that JSON, default `null` — and `--not-ran` records it `cleared`, so the next run calls it again. Exactly one of the two. Refused on a running job, or a step that did not start-and-not-complete (`X_STEP_NOT_RESOLVABLE`). Answers the job's trace; then `x jobs retry <id>` |
| `pause <queue>` | no worker claims from the queue; enqueues still land. A row every worker's next claim reads, so it holds **fleet-wide within one poll interval**. Idempotent. Answers the paused list as the queue now holds it. A queue outside `jobs.queues` and the registered jobs' queues is `X_CLI_BAD_FLAG`, its fix the nearest name, before any row is written (`As of 2026-11-19`); an app that does not load is never refused on a guess |
| `resume <queue>` | undo it; a queue that is paused always resumes, else the same queue check as `pause` |

`show`, `retry`, `cancel`, `delete` and `promote` each take **one id positional**, `resolve-step` an id and a step name; `pause` and `resume` take **one queue positional**. Beside a live `x dev` holding the embedded database, the writing verbs (`retry`, `cancel`, `delete`, `promote`, `resolve-step`, `pause`, `resume`) are refused `X_DEV_ALREADY_RUNNING`, the fix stopping it, running the verb and starting it again; `list` and `show` still read (`As of 2026-11-19`). There is no bulk verb here — bulk is `requeueMany` / `removeMany` on `JobIntrospection`, which a dashboard calls. `--queue`, `--state`, `--name`, `--limit` and `--after` narrow `list` only. A bare `x jobs` is `list`. One verb each, no alias: `ls` and `rm` are `X_CLI_UNKNOWN_COMMAND` since 26.0.0.

```bash
x jobs cancel 019ff1c5-0000-7000-8000-000000000001 --reason "wrong tenant" --json
```

Runs against the app's own driver — the ambient one when a process already installed it, otherwise the same embedded Postgres queue `x dev` boots. `show`, `retry` and `cancel` load the app first, `As of 2026-10`: a trace is the row read through the job's own declaration, so unloaded every run showed `concurrencyKey: null` and no retry delays. An app that half-loads still answers, with those two fields degraded. An `<id>` that is not a uuid is `X_JOB_UNKNOWN` before any statement is sent — `x jobs show nosuch` used to reach Postgres and come back `X_DB_STATEMENT_FAILED [22P02]`.

`list` reports only the sweeps still **running**, because it is a live view of the queue; the whole
ledger, finished passes included, is `x db backfill --list`. A driver that ships no backfill ledger
answers with no passes rather than failing the command — the queue is still the question here.

Errors: `X_JOB_UNKNOWN`, `X_JOB_NOT_CANCELLABLE`, `X_JOB_NOT_REMOVABLE`, `X_JOB_NOT_PROMOTABLE`, `X_CLI_BAD_FLAG` (a `--limit` over 200 names the walk), and `X_NOT_IMPLEMENTED` from a driver with no introspection.

A run refused by its concurrency key reads `state: failed` with `X_JOB_KEY_BUSY` in `lastError`; the fix it carries is `x jobs list --name <job> --state running --json` — the runs holding the key.

## x tasks

```bash
x tasks [list|show <name>|run <name>] [--count n] [--production] [--json]
```

| Subcommand | Does |
|---|---|
| `list` | every registered `task`: cron, timezone, catch-up policy, the jobs it enqueues, the occurrence it **last** fired and its next one |
| `show <name>` | the same plus the cron in words and the next `--count` occurrences (default 5, max 50) |
| `run <name>` | fire the task now: each job its occurrence enqueues goes onto the app's queue, through `TaskHandle.enqueue()` (the admin's run-now path). The scheduler's watermark is untouched, so the next scheduled occurrence still fires. Where the environment resolves `production` it fires only when asked by name — `--production`, or `ULTIMATE_TASK_RUN=<name>` for a container whose command line is fixed — as `x db seed --tier` / `ULTIMATE_SEED_TIER` do (`X_TASK_RUN_PRODUCTION` otherwise, nothing queued); beside an `x dev` holding the embedded database it is refused `X_DEV_ALREADY_RUNNING` with the stop–run–restart fix. `--json`: `data` = `{ task, jobs: [{ job, id, runId, deduped }] }`. `x g cron-job <name>` prints `bunx x tasks run <name>.schedule` as its next step. `As of 2026-11-19` |

| `--json` field | Is |
|---|---|
| `nextMs` · `next` | the next occurrence: epoch ms, and ISO-8601 in the task's zone |
| `lastMs` · `last` | the occurrence the scheduler last **dispatched** — what it was scheduled for, same two renderings. `null` (`-` in the table) for a task that has never fired |
| `lastFiredAtMs` | when that dispatch happened, on the queue's clock. `lastFiredAtMs - lastMs` is the scheduler's lag |

The last fire is read from the app's queue (`JobIntrospection.taskFires()`), so `x tasks` opens it
the way `x jobs list` does: the running one inside `x dev`, the app's own otherwise — about 0.6 s on
an embedded database already initialised, and nothing in an app that declares no task. It is the last
occurrence that enqueued, never the scheduler's watermark — arming and skipping move that.
`As of 2026-10`.

Every instant is rendered in the task's **own** `tz`, never a machine-local default: a `0 3 * * *` in `America/New_York` reads `2026-03-06T03:00:00-05:00` before the spring-forward and `2026-03-09T03:00:00-04:00` after it. Same wall clock, different instant — the ambiguity the required `tz` exists to remove.

Errors: `X_DECLARATION_UNKNOWN` (with the nearest name as its fix), `X_CLI_BAD_FLAG`.

## x cache

`As of 2026-11`.

| Subcommand | Does |
|---|---|
| `graph` (default) | per tag: the actions whose `invalidates` name it, the queries cached under it and the routes revalidated by it, read off the manifest. `data.neverEvicted` lists the tags something reads and no action invalidates — fresh only until their TTL |
| `bust <tag>` | boots the app's declared tiers and bus as a role does (`startServices`), then `invalidateTags`: shared tiers dropped, the edge purged, every replica told. With an in-process bus (no `NATS_URL`, no `REDIS_URL`) the summary says no running server heard it. A tier that failed is `X_CACHE_DRIVER_UNAVAILABLE`, exit 1; an undeclared tag is `X_CACHE_TAG_UNKNOWN` |
| `clear` | the same bust over every declared tag. An entry cached under no tag waits for its TTL |
