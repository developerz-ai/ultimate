# Migrations and backfills

One engine per concern. A **migration** changes the shape of a table — schema, in one ledger, applied identically from a laptop to a release phase. A **backfill** changes the rows already in it — data, as a `job`, with resume, ledger, throttle and progress built in. Confusing the two is the usual mistake: a schema change that also needs to touch every existing row is a migration *and* a backfill, never one artifact doing both.

`As of 2026-08`. Source: [`packages/db/src/migrate.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/db/src/migrate.ts), [`generate.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/db/src/generate.ts), [`destructive.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/db/src/destructive.ts); [`packages/jobs/src/backfill.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/jobs/src/backfill.ts) and its siblings.

## When to write which

| Change | Write |
|---|---|
| Add, rename, retype, drop a column or table; add an index or constraint | a **migration** — `x db gen "<name>"` |
| Rewrite, normalize, re-derive or backfill values in rows that already exist | a **backfill** — `backfill({ … })` |
| Add a nullable column, then populate every existing row before making it required | both: the migration adds the column, the backfill sweeps the rows, a second migration adds the `not null` once the sweep is done (expand → migrate → contract) |

## Migrations: one engine, one ledger

**This page documents the code at 2.0.0 and two majors have shipped since** — `npm view @ultimat3/core version`, `As of 2026-08-20`. Three things shipped in 3.0.0 that this page does **not** yet describe: `x db seed` (run `x db seed --help`), `rollback({ steps: -1 })` reverting every migration but the last, and a migration deleted from the tree being invisible to the audit. **And four in 4.0.0**, three of which change generated DDL: `on delete` now reaches the emitted SQL — so any app that ever declared `references(…, { onDelete })` generates a **different** migration and should read `x db gen`'s diff before applying it — a `references()` *removed* from a column now emits a `drop constraint`, drift reports `changed-foreign-key` for a key whose rule moved, and the `x_jobs` idempotency index gains `tenant_id`. Read [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md)'s `3.0.0` and `4.0.0` sections beside this page until it is rewritten, and [Upgrading](Upgrading) for the edits. On a pin still at 1.x, take [Known gaps → `x db gen` / `x db migrate`](Known-Gaps) and its 1.1.0/1.2.0 workarounds instead.

`x db gen` and the `ROLE=migrate` release-phase container run the **same** engine — `packages/db`'s `migrate()`/`generateMigration()` — not two. **In 1.1.0** they did not: `x db gen`'s subcommands shelled out to `bunx drizzle-kit`, a second schema engine with its own journal, declared in no `package.json` and fetched unpinned at run time, which is why a 1.1.0 scaffold's own `bin/setup` fails. That shelling-out is gone from current source — `cmd-db.ts` calls `generateAppMigration` and `runMigrations` from `@ultimat3/db`/`@ultimat3/cli` directly, and the only remaining mention of `drizzle-kit` anywhere is a file header comment recording the history.

```
x db gen "initial"            # a new app's first database command — x new writes no migration
x db gen "add publish_at"     # diffs entities against migrations, writes a named migration + its down
x db migrate                  # applies pending migrations, dev or prod, through migrate()
ROLE=migrate                  # the same migrate() as a release-phase container, one image
```

`x db gen` is the **only** writer of `packages/db/migrations`, `As of 2026-08`. `x new` scaffolds no
`0000_initial.sql`, so a scaffold that **declares an entity** — the default `--example` slice does —
is red on `x verify`'s `drift` step until that one command runs: *packages/db has a schema but no
migration recorded it*, fix `x db gen "initial"`. Zero entities against zero migrations is
agreement, not drift, so `x new --no-example` is green until its first `entity()`. A
scaffold that hand-wrote the first migration was a second writer of the same directory: the file
carried no `.snapshot.json`, which only the generator can produce, so the app's first `x db gen` and
its first `x db migrate` both refused (axiom 1).

### The `x_migrations` ledger

Every migration applies inside its own transaction, recorded into `x_migrations` (`LEDGER_TABLE`) as one row: id, name, checksum, `applied_at`, `app_version`, `duration_ms`. A few properties are load-bearing:

- **Checksum-pinned.** An applied migration's `up` text is hashed once; if the file on disk hashes differently later, `auditLedger` throws `X_MIGRATION_CONFLICT` rather than silently re-running edited SQL — the fix is a new migration, never an edit of one already shipped.
- **App-version fenced.** A ledger row from a build this process does not ship is also `X_MIGRATION_CONFLICT` — the contract a rolling deploy needs: a pod must refuse to migrate a database another build already owns, or two schemas race during the rollout.
- **Advisory-locked, on one pinned session.** An advisory lock is scoped to a Postgres *session*, not a statement, so the lock is taken and held on a single reserved connection for the whole run (`withAdvisoryLock`) — see [Resource management](Resource-Management) for the general `using`-pin shape this follows. `lock: false` is declared as an escape hatch on both option types and, `As of 2026-08`, is passed by nothing in the repo — every shipped migration path takes the lock.
- **Acquired by a bounded poll, never a blocking wait.** `acquireLock` tries `pg_try_advisory_lock` once per 500ms (`MIGRATION_LOCK_POLL_MS`) against a 60s budget (`MIGRATION_LOCK_WAIT_MS`, overridable per call as `lockWaitMs`), then raises `X_MIGRATE_CONCURRENT`. So a genuinely slow migrator ahead of you is waited out and two overlapping deploys still serialise — but a wedged one becomes an exit code inside the deploy window. Blocking `pg_advisory_lock` has no timeout at all: it held `helm upgrade --wait` inside one statement, printing nothing, with the job never failing so `backoffLimit` never fired.
- **One statement per `up`/`down` send, script-split.** `applyScript` runs `statementsOf(script)` one at a time inside the migration's own transaction, because the two drivers (PGlite, pooled Postgres) disagree about sending a multi-statement script as one call.
- **Every migration's own transaction.** `migrate()`/`rollback()` apply and reverse one migration at a time, each in its own transaction, on purpose — a failed `up` must leave the ledger describing exactly the migrations that *did* run, not an all-or-nothing batch. This loop is declared with `expectedQueryLoop` at the source, so the N+1 detector never flags it.

### `generateMigration()` — one diff engine

`x db gen` diffs the app's entity snapshots against the schema the newest migration's `.snapshot.json` sidecar recorded, and writes the migration text plus that sidecar for the *next* diff. A migration missing its sidecar — deleted, or hand-written without one — is `X_MIGRATION_SNAPSHOT_MISSING`: refused rather than defaulted to an empty schema, which would emit `create table` for every table the database already holds. No migration at all is a different answer and not a refusal: zero migrations declare the empty schema, which is what makes `x db gen "initial"` work in an app that has never generated one.

Its two remedies, in the order they are safe to run: `git checkout -- packages/db/migrations/<id>.snapshot.json`, or, when the file was never written, `rm packages/db/migrations/<id>.* && x db gen "<name>"`. The delete comes first because `x db gen` against the migration that is still there raises this same code. Until 2026-08 the `fix:` said "restore … from version control" alone while `x db migrate`'s `unknown-schema` difference answered `x db gen "snapshot <name>"` — each naming the command that raises the other, with nothing to restore in an app whose sidecar was never written.

### Foreign keys are their own statement

Every foreign key is `alter table … add constraint`, emitted **after** every table statement, and
never a `references` clause inside `create table` — decided 2026-08. Inline, the constraint is
created with the table, so the referenced table has to exist already; the order `generateMigration`
walks is `describeEntities()`, which is the app's *import* order and says nothing about where a
`references()` points. Measured against PGlite on a scaffolded app: `create table "comments" (…
references "posts" …)` ahead of `create table "posts"` is `relation "posts" does not exist` on
statement one, and `down` had the mirror fault — `drop table "posts"` while `comments` still
references it is `2BP01`. `down` is reversed as a whole, so the constraint drops pushed last come
out first.

**No topological sort and no cycle error**, deliberately: separate constraints need no ordering at
all, and two tables referencing each other cannot be expressed inline in any order. The same call
site answers the second half — a `references()` added to a column that **already exists** now emits
its own `add constraint`, where before the `up` came out empty, `x db gen` wrote no file, and the
`drift` step stayed red forever behind a fix that did nothing.

**Removing a `references()` emits the `drop constraint`**, `As of 2026-08-19` — it used to emit
nothing, and that is not the harmless omission a removed index is. A removed index leaves the
snapshot correct by omission; a removed key left the constraint on the database *and* wrote
`foreignKeys: []` beside it, so the record actively denied a constraint the catalog held, and
`compareForeignKeys` judges only the declared side. The drop names the constraint the **previous
snapshot** recorded rather than the name this generator would have chosen, so a hand-written
`fk_legacy` is dropped by its own name instead of `42704`. A column being dropped in the same
migration takes its constraint with it, and no second `drop constraint` is emitted for it.

**`on delete` reaches the SQL too**, `As of 2026-08-19`. `references(() => orgs.id, { onDelete:
'cascade' })` has type-checked since 1.0 and the clause it produced was `references "orgs" ("id");`
— a declared cascade that the database refuses the delete under instead. `ColumnDescription` and
`ReferenceDescription` carry `onDelete`, `addForeignKey` writes the clause, and a rule changed on
either side is `changed-foreign-key` drift whose `fix:` is the drop/add pair, because Postgres has
no `alter constraint` for it.

The sidecar is written through `snapshotJson()`, not `JSON.stringify(value, null, 2)`. Biome
collapses a short array onto one line and `JSON.stringify` never does, so an app whose `lint` step
read that directory failed `x verify` on a file no author typed — *Formatter would have printed the
following content* — as `X_LINT_FAILED`. Two fixes, both in 2.0.0: the serialiser is a
fixed point of Biome 2.5.5 at `lineWidth: 100`, and `x new`'s `biome.json` excludes
`**/migrations`, the glob this repo's own config already carried.

## The destructive-migration rail

A generated migration that drops a column or table, retypes a column, or truncates a table needs an explicit marker in the file, or `x verify`'s `drift` step refuses to ship it:

```sql
-- 20260814120000_drop_legacy
-- destructive: true

alter table "posts" drop column "legacy";

-- down
alter table "posts" add column "legacy" text; -- data is not restored
```

`destructive.ts` owns the classification — a closed list of four kinds (`drop-table`, `drop-column`, `retype-column`, `truncate`), decided against noise-stripped SQL so a comment or a string literal mentioning "drop table" is never mistaken for the operation.

The criterion is **persisted row data**, not table rewrites: an operation is destructive when applying it removes rows or the values in them. That is why `alter table … drop` names a column and is destructive, while the sub-clauses that name what they drop are excluded — `drop constraint` removes constraint metadata, `drop default`, `drop not null`, `drop identity`, `drop expression` and `drop generated` change column metadata, and a standalone `drop index` removes an auxiliary structure. Every row survives all of them. `retype-column` is on the list for the opposite reason: rewriting a column's type can lose the values it held, whether or not the type is narrower.

Only `up` is ever judged — reversing a `create table` is a `drop table`, so a rail reading `down` would mark every migration ever generated, and a marker on all of them marks none.

Two separate questions, two codes, asked at two different times:

| Code | Asked | Means |
|---|---|---|
| `X_MIGRATION_IRREVERSIBLE` | at **generation** | can this migration's `down` restore the rows? A generated drop refuses here first — `x db gen "<name>" --allow-destructive` to proceed anyway |
| `X_MIGRATION_DESTRUCTIVE` | at the **gate** (`x verify`'s `drift` step) | does the committed `up` destroy data with no `-- destructive: true` line saying so? `x db gen` writes the marker itself when asked to generate a destructive migration |

`X_MIGRATION_CONFLICT` is the ledger's own refusal (checksum or app-version mismatch, above) — a third, unrelated code, not a spelling of either of these two.

The marker is SQL the migration's checksum covers, so it must be added **before** the migration is applied: marking an already-applied file is an edit, and reaches `X_MIGRATION_CONFLICT` on the next apply, correctly. Full wording for all four codes: [Error codes](Error-Codes).

## Backfills: `backfill()` is a factory over `job()`, not a ninth primitive

Same rule `llm()` follows for a model call ([`docs/idea/02-primitives.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/02-primitives.md)): a one-pass sweep over a table is durable background work with an input schema, a retry policy, an idempotency key and a queue — the definition of a `job` — so `backfill()` *returns* one instead of the framework growing a ninth kind of thing. That single line is what gives a backfill `.enqueue()`, the worker's cancellation, the dead-letter path, `x jobs show` and a manifest row for free, with nothing declared twice. See [Jobs and workflows](Jobs-And-Workflows) for the `job` primitive itself.

```ts
export const normalizePostTitles = backfill({
  name: 'normalize-post-titles',
  tenant: 'none',   // a sweep spans every tenant; the PASS opens the cross-tenant scope, not you
  source: ({ ctx }) => db.posts.where({ orgId: ctx.actor.orgId }),
  handle: async ({ rows, signal }) => {
    signal.throwIfAborted();
    await db.posts.upsertAll(
      rows.map((row) => ({ ...row, title: row.title.trim() })),
      { onConflict: ['id'] },
    );
  },
  batch: 1_000,   // rows per statement and per durable step — default DEFAULT_BACKFILL_BATCH
  rate: 5,        // batches per second — default DEFAULT_BACKFILL_RATE, there is no unthrottled mode
});
```

### Signature

```ts
backfill<Row>({
  name: string,                                        // REQUIRED — a durable key, unlike a job's
  source(args: { ctx: Ctx }): ReadBuilder<Row>,         // the chain to sweep; read once per attempt
  handle(batch: BackfillBatch<Row>): Promise<void> | void,
  batch?: number,                                       // default DEFAULT_BACKFILL_BATCH (1000)
  rate?: number,                                         // default DEFAULT_BACKFILL_RATE, batches/sec
  queue?: string,
  retry?: RetryPolicy,                                   // default DEFAULT_RETRY
  timeout?: DurationInput,                                // per attempt, not per pass
  requires?: string,                                      // a migration id, checked before a run
  environments?: readonly Environment[],                  // omitted = every environment
  count?(args: { ctx: Ctx }): Promise<number> | number,    // the same predicate, counted
}): JobHandle<{ force?: boolean }>
```

`source` returns a `ReadBuilder` — the same chain type [Batching and preloading](Batching-And-Preloading) documents `preload()`/`inBatches()` on — so tenancy, soft delete, the projection and every `.preload()` on it mean exactly what they mean anywhere else. It is read fresh each attempt and never enqueued, so what a run visits cannot drift from what was declared. `handle` is deliberately handed no `step`: a step name minted inside a per-batch body would collide with itself on the second batch. `BackfillBatch<Row>` carries `rows`, `ctx`, `signal` (the run's cancellation composed with this batch's own ceiling) and `index` (0-based position, also the step name — `batch:<index>`).

### Idempotency — `handle` is at least once

The batch runs inside its own durable step, and the checkpoint is written **after** it returns — never the other way round. An attempt cancelled between the last row and the checkpoint replays that whole page on the next attempt. `handle` must therefore be idempotent: `upsertAll`, `updateWhere`, or any statement whose second run changes nothing — never `count + 1`. What a step persists across a replay is the **cursor and a row count**, never the page itself; `steps.ts` retains a completed step's output for the whole run, and a page held there for every batch of a million-row sweep is every processed row kept in memory until the job ends.

Re-enqueueing a backfill that has already run to completion runs a **real job** whose pass is the no-op. The two are different facts and only the second one is dedupe:

```ts
const first = await normalizePostTitles.enqueue({});
first.deduped;   // false — this is the run

// While the first is still LIVE: one live run per name, forced or not.
const live = await normalizePostTitles.enqueue({});
live.deduped;    // true — the partial index covers ready | delayed | running | suspended

// Once the first has COMPLETED: a completed job is in none of those states, so this is not a
// dedupe. A real job row is created and a worker runs it — the PASS then reads x_backfills and
// returns { skipped: true, previousRunId }, having touched no row.
const after = await normalizePostTitles.enqueue({});
after.deduped;   // false
```

The dedupe is the live-run index; the ledger is what makes the second pass do nothing.

`--force` (or `{ force: true }`) is the only override, and it rides the **input**, not the idempotency key — `idempotencyKey` is always `() => definition.name`, so "kick it again" stays one live pass rather than becoming a second writer racing the first. A forced rerun writes a **new** ledger row: history is never overwritten, so what each pass swept stays readable. A completed row is the only one that blocks a rerun — a `running` row is this pass resuming (or the one live idempotency key already holding it), and a `failed` row is an attempt the queue is about to retry anyway.

### The `x_backfills` ledger — `x_migrations`' twin, one level up

Keyed by **run**, not by name, because a backfill may legitimately run again where a migration never does. Mirrors the shape of the migration ledger:

| Column | Meaning |
|---|---|
| `runId` | the job run this pass belongs to — also the ledger's primary key |
| `name`, `checksum` | the declared name, and a hash of `source`'s and `handle`'s source text (`NUL`-separated, never `batch`/`rate` — pacing is a tuning change, not a different sweep) |
| `status` | `running` \| `completed` \| `failed` — only `completed` blocks a rerun |
| `appVersion` | the build that **started** the pass; a redeploy mid-pass does not rewrite it |
| `rows`, `cursor` | absolute progress — a replayed batch reports the same number, never a delta; `cursor` is `null` before the first batch and once the pass is over |
| `startedAt`, `completedAt` | epochs; `completedAt` is stamped for `failed` too, and cleared when a retried attempt puts the row back to `running` |

A moved checksum **warns** and does not block the run — a bundler that reformats a function body moves its source text with no line of behaviour changed, so this hash is fuzzier than a migration's SQL checksum on purpose, where `@ultimat3/db`'s `auditLedger` throws on the same kind of drift because SQL text is what was actually applied.

The ledger is a **report an operator reads**, never a resume source — the step checkpoints inside `backfill-pass.ts` are transactional with the work and decide where a resumed pass restarts; a resume driven off the ledger's own `cursor` would be a second, non-transactional answer to "where were we."

### Throttling

`rate` (batches per second, default `DEFAULT_BACKFILL_RATE`) is spent as the **first statement inside the batch's own step**, never wrapped around it — an attempt resuming at batch 500 replays 500 already-completed checkpoints that run no body and touch no database, and paying the full throttle for all of them again before reading a new row would make every resume slower than the original pass. There is no way to turn the throttle off: a backfill that saturates the pool has no correct value here, since it shares that pool with the requests the app is still serving live.

### Progress observability

One projection, four surfaces, so none of them can disagree about how far a pass has got:

| Surface | Shows |
|---|---|
| `x db backfill --list` | the whole ledger, newest first, filterable by name/status |
| `x jobs ls` | ordinary job rows, plus the `backfill()` passes whose ledger row is **`running`** — `jobs-report.ts` filters `{ status: 'running' }`, so a completed or failed pass is not on this surface |
| `x jobs show <id>` | one job's full state — step trace, next retry — plus this run's ledger row under `backfill` when the job is one |
| `/_x` jobs panel | the same ledger, live |

All four read `inspectBackfills(driver, filter?)` from `backfill-inspect.ts` — there is no second reader. It answers `[]`, never a throw, for a driver whose `JobDriver.backfills` is absent (a driver that ships no ledger, e.g. `driver-redis`/`driver-nats`): the surfaces asking about the *queue* must not fail over a fact nobody asked for, though `x db backfill --list` — the surface that **is** the question — says so in its own summary.

### Declared, and never run — the other half of the ledger

`x_backfills` answers "which passes have run". Nothing answered "which passes exist", so a cleanup could be authored with `x g backfill`, merged and deployed, and **never run**, with no surface anywhere saying so. `backfill()` now stamps its own handle — through the same `origin` `WeakMap` `task()` uses, with no `registerBackfill()` call for an app to forget — and the diff between the two halves is a command:

```
x db backfill --pending --json
```

Non-zero exit when anything is unswept, so a cron or a deploy check reads the exit code and never the table.

| State | Means | Counts as pending |
|---|---|---|
| `pending` | declared, and `x_backfills` holds no row under this name | yes |
| `failed` | the newest pass failed — the queue may already have dead-lettered it | yes |
| `running` | a pass is in flight | no — an alarm red for the whole of every sweep gets muted within a week |
| `completed` | a completed row exists, so nothing re-runs without `--force` | no |
| `excluded` | `environments` does not include this one | no |

`orphaned` is the mirror image: a ledger name no declaration carries, i.e. a sweep whose module was deleted after it ran.

### Three optional declarations, all of them data

| Field | Rail | Enforced where |
|---|---|---|
| `requires: '<migration id>'` | `X_BACKFILL_MIGRATION_PENDING` | `x db backfill`, which is where `x_migrations` is readable — `@ultimat3/jobs` holds no `@ultimat3/db` dependency and does not grow one to read a ledger |
| `environments: [...]` | `X_BACKFILL_ENVIRONMENT` | **the pass itself**, ahead of the ledger open, so a `.enqueue()` from app code is covered too — and again in `x db backfill` as a pre-check, which refuses before queueing work that would only dead-letter |
| `count()` | `X_BACKFILL_STALLED` | the pass, once, after the last batch |

`environments` ships as declared **data** and never as a hardcoded "cleanups are production": a staging rehearsal is correct practice, so which deploys a sweep belongs to is the app's own convention and this field is only the mechanism carrying it. There is deliberately **no** `dependsOn` graph over other backfills — the real dependency is almost always "after code that tolerates both shapes is serving", which the framework cannot observe and would therefore encode wrongly.

`count()` is the same predicate `source` selects on, counted rather than read. It is what makes a dry run honest and turns "did it converge" into arithmetic: a pass that exhausts its source while `count()` still answers above zero has two predicates that disagree, so it **fails** rather than writing a completed row that stops the next deploy re-running it. Left out, the pass converges by definition — the framework will not guess a number on the author's behalf.

The **result** is parsed, not trusted: a non-negative safe integer, or `X_INVARIANT` where the count was returned. `NaN > 0` and `-1 > 0` are both false, so an unchecked bad number reads as "nothing left" and writes exactly the completed ledger row this detector exists to prevent.

### Running one — `x db backfill`

```
x db backfill --list                        # the x_backfills ledger, newest first
x db backfill --pending                     # declared minus completed; non-zero when unswept
x db backfill normalize-post-titles         # DRY RUN — --write is never implied
x db backfill normalize-post-titles --write # gate, then enqueue; the workers sweep
x db backfill --all --write                 # every pending one, isolated per name
x db backfill normalize-post-titles --write --force   # a completed name, into a NEW ledger row
```

A bare `x db backfill` is refused rather than defaulted: the four shapes answer four different questions.

`--write` **enqueues** — it never runs the pass inside the CLI process, because the queue is a job's execution surface. `--all` isolates per name and continues past a failure, exiting non-zero and naming each, so one wedged cleanup cannot block every later one forever.

`requires` is checked against `x_migrations` here, and the three answers are distinct on purpose: the ids that are applied, `[]` when the table does not exist (nothing has ever been applied, so every `requires` is unsatisfied and the sweep is refused), and a **propagated error** when the read itself failed. A permission error or a timeout read as "nothing to check" would let a sweep run against exactly the shape it was declared to wait for.

### `ROLE=backfill` triggers; it never gates

`DEPLOY_ROLES` is `migrate → web → sync → worker → scheduler → backfill`, and the position is the design:

| Role | Shape | Why there |
|---|---|---|
| `migrate` | `run --rm`, **first** | a schema change must land before anything serves it, and drift after it fails the deploy |
| `backfill` | `run --rm`, **last** | a slow `UPDATE` inside a release gate holds the deploy open against a database still serving the *previous* release — so the sweeps are enqueued after the new pods serve, and the workers already draining the queue perform them |

Backfills are therefore **never** wired into `runMigrations()`. The `backfill` container runs `x db backfill --all --write --json` and exits.

Position in the plan is **necessary and not sufficient**: `docker compose up -d` returns when a container has started, not when the app inside it serves. The barrier that makes "after" true is declarative — the `backfill` service carries `depends_on: { web: { condition: service_healthy } }`, which `docker compose run` honours. `As of 2026-08` that service ships with the barrier in both committed compose files: [`docker/docker-compose.prod.yml`](https://github.com/developerz-ai/ultimate/blob/main/docker/docker-compose.prod.yml) and the one `x new` scaffolds. In the scaffolded app the condition is satisfied by the image's own `HEALTHCHECK` on `/healthz`, so an app that removes it also removes the barrier.

### `x g backfill` — the generator

Scaffolds a working pair, never a stub: `x g backfill <name>` writes `<feature>/backfills/<name>.ts` — a `backfill()` declaration reading the feature's own table through `tableFor(entity, postgresRepo(entity))`, sweeping with `.where({ orgId })` guarded by an `assert` that the actor carries one, and writing back through `upsertAll` — plus `<name>.test.ts` asserting the declaration (name, retry, idempotency key), the manifest projection, and that the row transform is genuinely idempotent — `expect(<name>Row(once)).toEqual(once)`, deep value equality, since a transform that returns a fresh object every pass is still idempotent and `===` would fail it — and actually enqueues/dedupes against a memory job driver. A generated no-op handler that checkpoints a page it never wrote would report rows swept that nobody touched, which is why the template ships a real (if trivial) row transform rather than a `throw new Error(…)`.

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_MIGRATION_CONFLICT` | the ledger disagrees with this build — a foreign app-version row, or an applied migration whose checksum moved | deploy the version `cause` names, or `x db gen "fix <migration>"` — never edit an applied migration |
| `X_MIGRATION_IRREVERSIBLE` | a generated plan drops a column or table and its `down` cannot restore the rows | `x db gen "<name>" --allow-destructive`, or keep the column and deprecate it |
| `X_MIGRATION_DESTRUCTIVE` | a committed migration's `up` destroys data with no `-- destructive: true` line | add the marker, or regenerate with `--allow-destructive` — before the migration is applied |
| `X_MIGRATION_SNAPSHOT_MISSING` | the newest migration on disk carries no `.snapshot.json` sidecar to diff against | `git checkout -- packages/db/migrations/<id>.snapshot.json` — or, when it was never written, `rm packages/db/migrations/<id>.* && x db gen "<name>"`, the delete first |
| `X_MIGRATION_VIEW_DEPENDS` | a view is compiled against a column this migration retypes — Postgres answers `0A000` and rolls the whole migration back | `drop view "<v>";` then `x db migrate`, then re-create it from the `create view` the `fix` line carries verbatim. Caught by a **preflight** inside the migration's own transaction, before its first statement, so nothing partial is applied |
| `X_DB_DRIFT` | the live schema, or the source, disagrees with the migrations | `x db gen "<name>"` — see [Entities and migrations → Drift is a `x verify` failure](Entities-And-Migrations#drift-is-a-x-verify-failure) |

Seven codes, and each one exists because it sends the reader somewhere different — run it, force it, change environment, migrate first, wait, fix the predicates, fix the name. All are `@ultimat3/jobs`': the CLI throws the framework package's errors rather than minting a parallel set, and the pass enforces two of them itself.

| Code | Cause | Fix |
|---|---|---|
| `X_BACKFILL_PENDING` | declared, and `x_backfills` holds no completed pass for it in this environment | `x db backfill <name> --write --json` |
| `X_BACKFILL_APPLIED` | the ledger already records a completed pass and `--force` was not given | `x db backfill <name> --write --force --json` — a rerun is a NEW row, never an edit |
| `X_BACKFILL_ENVIRONMENT` | `environments` does not include the one this process resolved | run it where `ULTIMATE_ENV` matches, or add this environment to the declaration |
| `X_BACKFILL_MIGRATION_PENDING` | `requires` names a migration `x_migrations` does not record as applied | `x db migrate --json` |
| `X_BACKFILL_RUNNING` | the enqueue deduped — one live pass per name, and this name already has one | `x jobs show <id> --json`; a pass that is not advancing is a worker that lost its lease |
| `X_BACKFILL_STALLED` | the source is exhausted and `count()` still matches rows — the two predicates disagree | make `count()` select on exactly what `source()` selects on |
| `X_BACKFILL_UNKNOWN` | no declaration in this app carries that name | `x db backfill --pending --json` lists every declared name |

`X_BACKFILL_WRITE_UNCONFIRMED` was considered and **rejected**: a dry run that wrote nothing did exactly what it was asked to, and a code whose fix line duplicates another one's is code inflation.

A bad `batch`/`rate` throws `@ultimat3/core`'s `assert`, which is `X_INVARIANT` — borrowed, not declared, and it carries its own cause and fix at the declaration site:

| Code | Cause | Fix |
|---|---|---|
| `X_INVARIANT` (bad `batch`) | `backfill "<name>" declares batch: <n> — a batch is a whole number of rows, at least one` | `set batch: 1000 on backfill("<name>") — the rows one statement reads and one durable step handles` |
| `X_INVARIANT` (bad `rate`) | `backfill "<name>" declares rate: <n> — a rate is batches per second, greater than zero` | `set rate: 0.5 on backfill("<name>"), or leave it out — to sweep faster raise the number, there is no unthrottled mode` |

Both throw at import, not at the first batch, so a bad number is a failed build rather than a dead-lettered job. Everything past that runs the same retry/dead-letter path as any other `job` ([Jobs and workflows → Errors](Jobs-And-Workflows)).

Full list with `--json` shapes: [Error codes](Error-Codes). Migration workflow, drift and the reversible/destructive distinction in full: [Entities and migrations](Entities-And-Migrations). The `job` primitive, steps, retries and the outbox: [Jobs and workflows](Jobs-And-Workflows).
