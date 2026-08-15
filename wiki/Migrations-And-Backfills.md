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

**This page documents `main`, not the published 1.1.0 packages** — see [Known gaps → `x db gen` / `x db migrate`](Known-Gaps), which carries the 1.1.0 workaround.

`x db gen` and the `ROLE=migrate` release-phase container run the **same** engine — `packages/db`'s `migrate()`/`generateMigration()` — not two. **In 1.1.0** they did not: `x db gen`'s subcommands shelled out to `bunx drizzle-kit`, a second schema engine with its own journal, declared in no `package.json` and fetched unpinned at run time, which is why a 1.1.0 scaffold's own `bin/setup` fails. That shelling-out is gone from current source — `cmd-db.ts` calls `generateAppMigration` and `runMigrations` from `@ultimat3/db`/`@ultimat3/cli` directly, and the only remaining mention of `drizzle-kit` anywhere is a file header comment recording the history.

```
x db gen "add publish_at"     # diffs entities against migrations, writes a named migration + its down
x db migrate                  # applies pending migrations, dev or prod, through migrate()
ROLE=migrate                  # the same migrate() as a release-phase container, one image
```

### The `x_migrations` ledger

Every migration applies inside its own transaction, recorded into `x_migrations` (`LEDGER_TABLE`) as one row: id, name, checksum, `applied_at`, `app_version`, `duration_ms`. A few properties are load-bearing:

- **Checksum-pinned.** An applied migration's `up` text is hashed once; if the file on disk hashes differently later, `auditLedger` throws `X_MIGRATION_CONFLICT` rather than silently re-running edited SQL — the fix is a new migration, never an edit of one already shipped.
- **App-version fenced.** A ledger row from a build this process does not ship is also `X_MIGRATION_CONFLICT` — the contract a rolling deploy needs: a pod must refuse to migrate a database another build already owns, or two schemas race during the rollout.
- **Advisory-locked, on one pinned session.** `pg_advisory_lock` is scoped to a Postgres *session*, not a statement, so the lock is taken and held on a single reserved connection for the whole run (`withAdvisoryLock`) — see [Resource management](Resource-Management) for the general `using`-pin shape this follows. `lock: false` is the one deliberate exception, for `x db branch` against a private database nothing else can be migrating.
- **One statement per `up`/`down` send, script-split.** `applyScript` runs `statementsOf(script)` one at a time inside the migration's own transaction, because the two drivers (PGlite, pooled Postgres) disagree about sending a multi-statement script as one call.
- **Every migration's own transaction.** `migrate()`/`rollback()` apply and reverse one migration at a time, each in its own transaction, on purpose — a failed `up` must leave the ledger describing exactly the migrations that *did* run, not an all-or-nothing batch. This loop is declared with `expectedQueryLoop` at the source, so the N+1 detector never flags it.

### `generateMigration()` — one diff engine

`x db gen` diffs the app's entity snapshots against the schema the newest migration's `.snapshot.json` sidecar recorded, and writes the migration text plus that sidecar for the *next* diff. A migration missing its sidecar — deleted, or hand-written without one — is `X_MIGRATION_SNAPSHOT_MISSING`: refused rather than defaulted to an empty schema, which would emit `create table` for every table the database already holds.

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
}): JobHandle<{ force?: boolean }>
```

`source` returns a `ReadBuilder` — the same chain type [Batching and preloading](Batching-And-Preloading) documents `preload()`/`inBatches()` on — so tenancy, soft delete, the projection and every `.preload()` on it mean exactly what they mean anywhere else. It is read fresh each attempt and never enqueued, so what a run visits cannot drift from what was declared. `handle` is deliberately handed no `step`: a step name minted inside a per-batch body would collide with itself on the second batch. `BackfillBatch<Row>` carries `rows`, `ctx`, `signal` (the run's cancellation composed with this batch's own ceiling) and `index` (0-based position, also the step name — `batch:<index>`).

### Idempotency — `handle` is at least once

The batch runs inside its own durable step, and the checkpoint is written **after** it returns — never the other way round. An attempt cancelled between the last row and the checkpoint replays that whole page on the next attempt. `handle` must therefore be idempotent: `upsertAll`, `updateWhere`, or any statement whose second run changes nothing — never `count + 1`. What a step persists across a replay is the **cursor and a row count**, never the page itself; `steps.ts` retains a completed step's output for the whole run, and a page held there for every batch of a million-row sweep is every processed row kept in memory until the job ends.

Re-enqueueing a backfill that has already run to completion is a no-op that reports what happened, not a second sweep:

```ts
const first = await normalizePostTitles.enqueue({});
first.deduped;   // false — this is the run

const again = await normalizePostTitles.enqueue({});
again.deduped;   // true — one live run per name, forced or not
```

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
| `x jobs ls` | ordinary job rows, **plus** `backfill()` passes in flight with rows-so-far and cursor |
| `x jobs show <id>` | one job's full state — step trace, next retry — plus this run's ledger row under `backfill` when the job is one |
| `/_x` jobs panel | the same ledger, live |

All four read `inspectBackfills(driver, filter?)` from `backfill-inspect.ts` — there is no second reader. It answers `[]`, never a throw, for a driver whose `JobDriver.backfills` is absent (a driver that ships no ledger, e.g. `driver-redis`/`driver-nats`): the surfaces asking about the *queue* must not fail over a fact nobody asked for, though `x db backfill --list` — the surface that **is** the question — says so in its own summary.

### `x g backfill` — the generator

Scaffolds a working pair, never a stub: `x g backfill <name>` writes `<feature>/backfills/<name>.ts` — a `backfill()` declaration reading the feature's own table through `tableFor(entity, postgresRepo(entity))`, sweeping with `.where({ orgId })` guarded by an `assert` that the actor carries one, and writing back through `upsertAll` — plus `<name>.test.ts` asserting the declaration (name, retry, idempotency key), the manifest projection, and that the row transform is genuinely idempotent — `expect(<name>Row(once)).toEqual(once)`, deep value equality, since a transform that returns a fresh object every pass is still idempotent and `===` would fail it — and actually enqueues/dedupes against a memory job driver. A generated no-op handler that checkpoints a page it never wrote would report rows swept that nobody touched, which is why the template ships a real (if trivial) row transform rather than a `throw new Error(…)`.

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_MIGRATION_CONFLICT` | the ledger disagrees with this build — a foreign app-version row, or an applied migration whose checksum moved | deploy the version `cause` names, or `x db gen "fix <migration>"` — never edit an applied migration |
| `X_MIGRATION_IRREVERSIBLE` | a generated plan drops a column or table and its `down` cannot restore the rows | `x db gen "<name>" --allow-destructive`, or keep the column and deprecate it |
| `X_MIGRATION_DESTRUCTIVE` | a committed migration's `up` destroys data with no `-- destructive: true` line | add the marker, or regenerate with `--allow-destructive` — before the migration is applied |
| `X_MIGRATION_SNAPSHOT_MISSING` | the newest migration on disk carries no `.snapshot.json` sidecar to diff against | restore the sidecar from version control, or delete and regenerate that migration |
| `X_DB_DRIFT` | the live schema, or the source, disagrees with the migrations | `x db gen "<name>"` — see [Entities and migrations → Drift is a `x verify` failure](Entities-And-Migrations#drift-is-a-x-verify-failure) |

Backfills declare no error code of their own. A bad `batch`/`rate` throws `@ultimat3/core`'s `assert`, which is `X_INVARIANT` — borrowed, not declared, and it carries its own cause and fix at the declaration site:

| Code | Cause | Fix |
|---|---|---|
| `X_INVARIANT` (bad `batch`) | `backfill "<name>" declares batch: <n> — a batch is a whole number of rows, at least one` | `set batch: 1000 on backfill("<name>") — the rows one statement reads and one durable step handles` |
| `X_INVARIANT` (bad `rate`) | `backfill "<name>" declares rate: <n> — a rate is batches per second, greater than zero` | `set rate: 0.5 on backfill("<name>"), or leave it out — to sweep faster raise the number, there is no unthrottled mode` |

Both throw at import, not at the first batch, so a bad number is a failed build rather than a dead-lettered job. Everything past that runs the same retry/dead-letter path as any other `job` ([Jobs and workflows → Errors](Jobs-And-Workflows)).

Full list with `--json` shapes: [Error codes](Error-Codes). Migration workflow, drift and the reversible/destructive distinction in full: [Entities and migrations](Entities-And-Migrations). The `job` primitive, steps, retries and the outbox: [Jobs and workflows](Jobs-And-Workflows).
