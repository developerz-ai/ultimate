# @ultimat3/entity

Columns + invariants; the row type is derived from the columns. Tier 2.

## Boundary

- May import `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/db` and `@ultimat3/time` (its
  `isValidTimeZone`). Nothing else.
- `db` is tier 1, which lets the Postgres driver live **here**: `Driver` and its production
  implementation in one place ([`01-package-map.md`](../../docs/architecture/01-package-map.md)).
- No `drizzle-orm`: `postgresDriver()` (`pg-driver.ts`/`pg-sql.ts`) is hand-written SQL;
  `types.ts` declares the narrow column vocabulary it consumes.

## Do not regress — two drivers, one meaning

- **`repo.ts` is the contract** (`Repo`, `FindManyArgs`, `Transactor`); `memory-repo.ts` is
  `memoryRepo()`.
- **Two drivers, one meaning.** `memoryDriver()` and `postgresDriver()` share `plan.ts`, `cursor.ts`
  and the `Repo` contract. Every bulk or read feature carries BOTH a `*-parity.test.ts` (identical rows
  into both drivers, identical output) and a `pg-driver-<feature>.live.test.ts` against a real server.
  Both are the bar.
- **`write-parity.test.ts` runs every write against memory AND PGlite**: a patch property present with
  `undefined` is ABSENT (only `null` clears); memory refuses a duplicate PK, a duplicate non-partial
  unique — index OR `c.unique([…])` invariant, the one list in `unique-constraints.ts` — and a PK
  patch onto another row with `X_DB_UNIQUE_VIOLATION` (partial uniques are not checked in memory);
  each kind's stored spelling: `docs/history/entity.md`.
  `invariant-parity.test.ts` asks the app, the driver and the raw CHECK the same question.
- **`min`/`max` over a `timestamptz` crosses as epoch ms** (`aggregate-time-parity.test.ts`). A whole
  row read under a non-UTC session still fails on PGlite — recorded, not fixed.
- **Text ordering: byte (`C`) order is the parity target** — a linguistic production collation is a
  known divergence; never `collate "C"` in generated SQL (defeats the index). Create the database with
  `LC_COLLATE=C` when byte order must hold.
- **Money's write shape is wider than its row shape** (`MoneyInput` takes a `bigint`; `MoneyValue`
  holds a `number`); `RowWrite<Row>` types `insert`/`insertAll`/`upsertAll`; `narrowRow` (`columns.ts`)
  narrows at each write method's ENTRY, before `$assert`/`upsertPlan`. `pg-money-write.live.test.ts`,
  `money-write-parity.test.ts`, `type-pins.ts`.
- **A numeric key has one spelling** (`keyOf`): batches, conflict targets and memory's uniques. **A null test on a whole money property reads `<p>.minor`.**
- **A PREDICATE's meaning is decided by the column's KIND** (`memory-match.ts`); `compareByKind` /
  `sameValueOfKind` are EXPORTED — `@ultimat3/query` calls them. **ONE numeric comparison,
  `numericOrder`**: `DECIMAL_TEXT` columns by VALUE (`'2.50' = 2.5`), `number`/`bigint` numerically
  (`compare-parity.test.ts`). A `uuid` is a value, compared lower-cased and
  stored lower-case (`keyOf`, `parseUuid`, `narrowUuid`; text is never narrowed); `LIKE` (`like.ts`)
  uses Postgres' default `\` escape, refuses a trailing escape, counts CHARACTERS and is a bounded
  two-pointer walk — never a regex; `in` takes a
  list or nothing, and a NULL in it emits `(col in (…) or col is null)`; a column the row never NAMED
  is NULL for `eq`/`neq`/`in`.
- **The Postgres driver is proved against a real Postgres** (`pg-driver.live.test.ts`, skipped without
  `TEST_DATABASE_URL`). A new operator, kind or write path is not done until it round-trips.
- **A repository call rejects, never throws synchronously** (`tableFor`'s writes are `async`).
- **`defaultDriver()`** is the process default; `Driver.reset?()` is optional (memory only), resets
  repositories in place. Test seam only.
- **`testDriver()` (`test-driver.ts`) follows `@ultimat3/db`'s `dbClientInstalled()` on every call.**
  A plain object of forwarders, never a `Proxy`; a side change inside `transactor().run` rejects
  `X_TEST_DRIVER_CLIENT_CHANGED`. Full rule: `docs/history/entity.md`.
- **A repository pinned to its own client joins a transaction opened ON that client** (`tx.origin`)
  **and refuses any other** (`X_REPO_CLIENT_PINNED`, in `client()` in `pg-driver.ts`); the fix names
  `setDbClient(client)` plus an unpinned repository.

## Do not regress — reading

- **A point lookup batches itself** (`coalesce.ts`): `findById` calls in one microtask of one request
  are one `in` statement, keyed by ctx (`WeakMap`) and a scope key covering every input but the id;
  it declines rather than guesses; past `MAX_IDS_PER_STATEMENT` it is several statements; no caller is
  ever left unsettled (`coalesce.test.ts` races a deadline).
- **A page batches the loop it causes** (`jit-preload.ts`): a preloaded row is served only under the
  SAME `scopeKey` (a security boundary), same client, dropped by any write to ANY entity — triggers
  and FK actions rewrite rows a statement never named (`forgetPreloaded` in `writing()`;
  `jit-preload-db-writes.test.ts`), keyed by id, bounded (`MAX_SIBLING_KEYS`, oldest page first). One switch:
  `postgresDriver({ jitPreload: false })` — never an `app.config.ts` key. Shared pieces live in
  `batch-read.ts`.
- **`preload(name, { max })` shares `batch-read.ts`, keeps no request cache and is BOUNDED**
  (`preload-ceiling.ts`: default `MAX_PRELOADED_ROWS`, refused past it, never truncated). Tenancy is CARRIED only between
  entities scoped by a same-named column (`X_TENANCY_UNSCOPED`). Full rule: `docs/history/entity.md`.
- **Every repository method attributes its statement** through `@ultimat3/db`'s
  `withStatementAttribution(entity.$name, op, send)` via `attributed(op, send)`, `op` declared once per
  method and passed to the plan builders; `memoryRepo` reports one event per operation (`memory-observed.ts`)
  under the same pair. `pg-driver-attribution.test.ts` — one case per method. Full rule: `docs/history/entity.md`.
- **The two N+1 codes are owned here** (`X_N_PLUS_ONE_QUERY`, `X_N_PLUS_ONE_WRITE`, `n-plus-one.ts`):
  it detects nothing, takes a `StatementLoop` verdict, and derives the fix from `relationMap()`
  (`preloadsFor()`), falling back to the `in` form. `N_PLUS_ONE_THRESHOLD` (5) is shared by `x dev`'s
  ledger and `@ultimat3/testing`'s `statements` fixture. `expectedQueryLoop` is the only opt-out.
- **A page is bounded**: `DEFAULT_PAGE_SIZE` (50), `MAX_PAGE_SIZE` (10,000) in `plan.ts`;
  `assertFinitePageSize` runs in `limit()` and both `plan()` builders, and bounds `inBatches(size)` too.
- **Cursor pagination only** — no `offset`; the primary key is the last sort key; the cursor carries
  sort VALUES. **The tiebreak takes the LAST DECLARED key's direction**; `seekSql` sends a ROW
  comparison when every key sorts one way and the or-chain otherwise
  (`pg-driver-cursor.live.test.ts`).
- **`inBatches(size)` is the same page in a loop** (`batch.ts`). Full rule: `docs/history/entity.md`.
- **A grouped count means one thing in both drivers, written in `count-by.ts`**: both call
  `groupColumnOf` before the statement and `countsFrom` after the rows. The bound is a REFUSAL at
  `MAX_GROUPS + 1`, never a truncation; it names a groupable column of THIS entity, never
  `x entity explain`. Full rule: `docs/history/entity.md`.
- **The codec is `@ultimat3/core`'s**, reached through `cursorFor(entity, plan, row, id)` and
  `seekFrom(entity, plan)`; **`assertSeekable` runs in `planFor`**, before a statement exists, and refuses `jsonb`, `bytea`, `array` (`UNSEEKABLE`). A
  `timestamptz` sort key is refused when its `<column>$US` alias would pass 63 bytes. A cursor is bound
  to `planScope(plan)` (entity, filters, sort); a bad one is `X_CURSOR_INVALID`, never "from the top".
- **A NULLABLE sort key orders** `asc nulls last` / `desc nulls first`; the cursor tags
  `~` for NULL and `!` for present; the seek reaches NULLs; a nullable key has no row comparison. Only a
  nullable PRIMARY-KEY column is refused. `pg-null-order.live.test.ts`.
- **A `timestamp` cursor carries MICROSECONDS** (`seekPrecision`, `instant.ts`). Full rule: `docs/history/entity.md`.
- **The four aggregates** (`sum`, `avg`, `min`, `max`) share `aggregate.ts`:
  never a float; `null` for an empty set; refusals `X_AGGREGATE_UNSUPPORTED`,
  `X_AGGREGATE_MIXED_CURRENCY`. Full rule: `docs/history/entity.md`. **`approximateCount()` is `reltuples`**; a filtered chain or tenant-scoped entity is
  `X_APPROXIMATE_COUNT_FILTERED`; `null` for an unanalysed table.
- **`series`, views**: `time-bucket.ts` (zone rules, measured), `view-repo.ts` (read-only); `time-bucket.test.ts`, `view-entity.test.ts`.
- **`json()` / `arrayOf()` are filterable** (`contains`, `contained-by`, `overlaps`, `has-key`) with
  Postgres' measured meaning in `containment.ts`; `has-key` emits `operator(pg_catalog.?)` (indexable)
  and takes a STRING key, else no rows; a NULL array element equals nothing. No jsonpath operator.
- **A GIN index is declarable** (`using: 'gin'`; the set is `@ultimat3/db`'s `INDEX_METHODS`); absent
  is `btree` byte for byte; the method joins the name discriminator only when declared; GIN cannot be
  unique or ordered (refused here). `pg-containment.live.test.ts`.

## Do not regress — schema and DDL

- **A relation is a foreign key read a second way** (`relations.ts`): `belongsTo` from own
  `references()`, `hasMany` from inbound; `referenceBinding()` resolves a thunk in one place; colliding
  names all take their long form; ambiguity is `X_INVARIANT_VIOLATED`. `relationMap()` memoises on
  `registryGeneration()`, in one pass. `relationNamed()` refuses with `X_PRELOAD_UNKNOWN_RELATION`
  (fix: a real `relationNamed()` call, or `x entities list --json`). `onDelete` rides on both
  descriptions; never parse the `"<table>.<column>"` string back.
- **An index is described whole** (`IndexDescription`: columns, uniqueness, predicate, direction,
  method); `on: []` refused. **The NAME carries predicate and direction** (8 hex of sha256) only when
  one is present; the dedup is on the whole `IndexDef`; names are bounded at 63 BYTES
  (`MAX_IDENTIFIER_BYTES`, `index-name.ts`).
- **Every physical name is checked, including the DERIVED one** (`assertColumnName` at `bindColumn`,
  and on the entity-name table fallback).
- **One resolver decides a physical name: `columnName(property, meta)`** (with
  `entity(name, { table })` and `.column(name)`); a second `snake(property)` is a bug. **The entity
  NAME and the TABLE are different things** — cache tags and policies key on the name; index names are
  the table's.
- **Invariants run twice and only ONE side is rendered here**: app-side `assertInvariants`, and the
  CHECK/UNIQUE DDL is `@ultimat3/db`'s `invariant-ddl.ts` reading `$describe()`. An untranslatable predicate is `kind: 'assert'`, `sql: null`.
  **`InvariantDescription.columns` is projected** (`describe-invariant.test.ts`).
- **The two halves must AGREE, term by term** (`expr.ts`, `pg-invariant-null.live.test.ts`); one app-only operand makes the whole rule app-only. Full rule: `docs/history/entity.md`.
- **A `matches()` pattern reaches the CHECK as the same string or is refused**
  (`pattern-portability.ts`, every entry measured; `pg-invariant-pattern.live.test.ts` asserts kept
  constructs agree and refused ones disagree).
- **A declared string is spliced by `@ultimat3/db`'s `literal()` only** (`E'…'` when a backslash is
  present); `bun run sql-literal-copies` enforces it; `expr.test.ts` pins all four splice sites against
  quote- and backslash-bearing values.
- **`invariants` is ONE callback** and `InvariantColumns<C>` a mapped type; the Proxy in
  `invariantColumns()` stays for JS callers. **`Invariant<T>.holds` is a method** (variance).
- **Nothing is interpolated into SQL** (`pg-sql.ts`): `raw()` only for `asc|desc` and the `default`
  cell. The seek operator is chosen in TypeScript.
- **Money is three columns**: `<p>_minor bigint`, `<p>_currency char(3)`, `<p>_scale integer null`; a NULL scale decodes to an ABSENT key, never `0`. Full rule: `docs/history/entity.md`.
- **A `jsonb` value is bound `::text::jsonb`** (load-bearing); an array is written as a quoted `{…}`
  literal, read by its DECLARATION (`pg-array-decode.ts`); `column-matrix-fixture.ts` is every kind
  on both drivers. **Wide types are normalised in `$parse`** (`bigint()`, `decimal()`: strings).
- **Every framework member on an entity is `$`-prefixed.** Row types are derived, never re-declared.
  **A branded id survives to the signature** (`IdOf<Row>`). `type-pins.ts` enforces all of it.
- **`$parse` tells absence from `null`** (`raw === undefined ? defaultValue(...) : raw`).
- **A rejected column value is rendered as its SHAPE** (`got(value)` over `describeValue`); only
  `parseMinor`'s two messages echo a provably numeric value.
- **A refusal raised before any entity exists carries an EDIT** (`refuse.ts`,
  `refuseColumn(rule, detail, fix)`); `refuse.test.ts` scans for a literal entity name and a
  placeholder. The builders construct `EntityError` inline so `fix-scan.ts` can read the fix.

## Do not regress — tenancy and writes

- **A tenant column means every query runs under the ACTING ACTOR's tenant** (`scopedPlan`,
  `tenancy.ts`, from `tryUseContext()?.actor.orgId`); inference applies when undeclared; **the column
  may not be nullable** (`resolveTenantColumn`). A caller-supplied `orgId` is an assertion
  (`X_TENANCY_ACTOR_MISMATCH` when different, `eq` only, refused never overridden); an actor with no
  org is `X_TENANCY_ACTOR_ORG_REQUIRED`; outside a request the caller names the tenant and
  `X_TENANCY_UNSCOPED` still refuses an unscoped plan.
- **Tenancy applies to writes in two places**: the plan bounds WHICH rows; `assertRowTenant` judges the
  VALUE at every write seam (both drivers), a filtered update judging the PATCH before any row; refuse,
  never stamp; all or nothing; the incoming rows too; before the statement exists
  (`write-tenancy-parity.test.ts`, `pg-driver-tenancy.live.test.ts`). With the conflict-target rule, a
  cross-tenant upsert is unrepresentable.
- **A reference stays inside its tenant** (`sameTenantOf`, `describe.ts`, at describe time): `sameTenant` is `null` on the record and ABSENT on the column otherwise (the hash). `entity()` never resolves a thunk at declaration. Memory (`memory-same-tenant.ts`) refuses only a target FOUND elsewhere. `same-tenant-parity.test.ts`, `same-tenant.live.test.ts`.
- **`lock`/`lockKey`**: optional on `Repo`, required on `Table` (`table-locks.ts`, `X_LOCK_UNSUPPORTED`); `pg-lock.ts`, `memory-lock.ts` (`update`/`delete` queue too, the filtered writes do not), one tenant derivation (`lock-key.ts`, via `readPlan`). `lock-parity.test.ts`, `lock.live.test.ts`, `lock-seams.test.ts`. Why: `docs/history/entity.md` (2026-11-02).
- **`crossTenant(reason, fn)` is the ONE way to read across tenants** — an `asyncContext` scope from
  core (`scripts/async-context-guard.ts`), `CROSS_TENANT_SCOPE` (`tenancy:cross`) proven at the call
  and at every plan (`X_TENANCY_CROSS_DENIED`), refused outside a request, blank reason `X_INVARIANT`.
- **`deleteWhere` / `updateWhere` are the only filtered writes**: empty filter `X_WRITE_UNFILTERED`,
  empty patch `X_PATCH_EMPTY` (undefined values dropped first); soft delete respected; both return a
  count; a JS-only invariant is judged
  in the statement's transaction (`judged-write.ts`), refused past `MAX_ASSERTED_ROWS`. Full rule: `docs/history/entity.md`.
- **A write past a coded abort is refused on both drivers**: `refuseAbandoned()` in `writing()` and each `memoryRepo` write. `write-abandon.test.ts`.
- **Every instant the write path stamps comes from `entityNow()`** (`clock.ts`, `ctx.clock`).
  **`touch()` in `touch.ts` is the ONE place `onUpdateNow()` columns are stamped.**
  **Both repositories parse a patch at the door** (`$parsePatch`): `$parse`'s issues, no default, a fragment refused.
- **A many-row write is one statement** (`insertStatement` builds every insert; `bulk-write.ts`
  decides in property space): a collision overwrites everything but the conflict target, the PK and the
  soft-delete stamp; the target must be a declared non-partial unique constraint (PK, `$indexes`, or a
  `kind: 'unique'` invariant); under `'update'` the tenant column must be in the target
  (`X_TENANCY_UNSCOPED`), a repeated target and an uneven batch are refused; NULL in the target
  collides with nothing; memory judges the whole batch first; past `MAX_BIND_PARAMETERS` it is several
  statements in ONE transaction (`bulk-write-send.ts`). **`db.*.upsertAll` and `seed.upsert`
  overwrite what the caller NAMED** (`overwrittenBy`). Full rule: `docs/history/entity.md`.
- **`memoryTransactor().run` is ambient** (`memory-journal.ts`): a write naming no `tx` joins it; a nested
  commit hands its undos and effects up; a write after the root ended is `X_DB_TRANSACTION_CLOSED`; a
  row lock taken with no tx is held to the root. `memory-journal.test.ts`, `memory-transactor.test.ts`.
- **`shared: '<why>'` is the one way an untenanted child of a tenant-owned table says so**
  (`assertShared`, `describe.ts`); the reach check is the CLI's `exercise-static.ts`
  (`X_ENTITY_TENANT_UNDECLARED`), over `EntityDescription.shared`.
- **`scan: '<why>'`**: a table read whole (`assertScan`).
- **A seed is replayable**: `SeedContext.insert` is one `upsertAll(…, { onMatch: 'nothing' })` per
  call; a generated PK the row does not name is refused; `upsert` reads with `includeDeleted` and
  SKIPS a soft-deleted match. **A dry run is the real run rolled back**
  (`Driver.transactor()`, REQUIRED). Full rule: `docs/history/entity.md`.
- **`setRowObserver` reports committed row changes above the driver** — one per process (returns the
  replaced one), applied by `database()`, one comparison per write when unset, `before` only when the PK
  is `id`, a filtered write is `onBulk`. Not a second change-feed path.
- **`appendOnly: true`** (`append-only.ts`): `appendOnlyRepo` wraps OUTSIDE `sealedRepo` in both
  drivers; every rewrite rejects before any statement (`X_ENTITY_APPEND_ONLY`). No bypass, backfills
  included. Full rule: `docs/history/entity.md`.
- **A state machine is the MECHANISM only** (`.transitions()` on `enumerated()`, a mapped
  `TransitionTable<S>`): the move is ONE statement with
  `from` in the predicate (`X_STATE_CONFLICT`). Full rule: `docs/history/entity.md`. **`move.observed`
  pins what a decision read** (#702, `transition-pins.ts`).

## Do not regress — lifecycle (retain, history, counters)

| Declaration | Here | The rule |
|---|---|---|
| `retain: { after, on }` | `retain.ts` | no default window; `on` a `timestamp()` some index STARTS with (`X_ENTITY_RETAIN_UNINDEXED`); refused beside `appendOnly` (`X_ENTITY_RETAIN_INVALID`). The sweep is `@ultimat3/jobs`' `retainTarget` |
| `history: true` | `history.ts`, `history-actor.ts` | `<table>_history` is a REAL registered entity (`$historyOf`), tenant column copied without its key. Written by `@ultimat3/db`'s trigger; `stampHistoryActor` sets `x.actor`/`x.request` once per transaction, never on a pinned repository — no transaction records `null`. `bigint`/`decimal`/`timestamp` columns ride `text`/`instants`: the image is the memory driver's strings (`history-values.test.ts`) |
| `countedIn` on a key | `counter.ts` | the target is a NOT NULL `integer()` of the entity the key points at (Postgres' `NULL + 1` stays NULL), by its single primary key (`X_ENTITY_COUNTS_INVALID`); resolved at describe time, memoised on `registryGeneration()` |
| all three, described | `lifecycle.ts` | each `$describe()` key ABSENT unless declared, so no other entity's hash moves |
| the memory driver | `memory-lifecycle.ts` | mirrors both triggers through the table's raw store, so a unit test answers what Postgres answers |

- **Known gap: the row observer does not see trigger writes.** A history row and a counter move
  are the trigger's (memory: `memoryLifecycle`'s raw store), never a repository write, so
  `setRowObserver` reports neither; a live counter on PGlite or memory moves on the parent's next
  write. The WAL replicator does report them. As of 2026-11.
- **`read-capture.ts` is failure capture's read half**: `observedRepo`'s `findById`/`findMany` hand
  rows to core's `recordFailureFact` — sealed properties dropped first; one check when off.

## Do not regress — sealed columns

- **`sealed-repo.ts` is the ONE seam**: `memoryRepo()` and `postgresRepo()` both return through
  `sealedRepo(entity, repo)`, which seals rows and patches going in, opens rows coming out and
  rewrites or refuses every predicate. A driver never seals for itself; an entity with no sealed
  column gets its repository back untouched. The cipher is core's (`scripts/seal-calls.ts`).
- **A sealed column's `$parse` passes a sealed string and judges a plaintext**; `decodeRow` parses
  none. `sealValue` runs the UNWRAPPED plaintext parser (`$meta.sealed.plaintext`) BEFORE sealing — nothing
  after can, and the column's own `$parse` would pass a sealed-shaped lookalike.
- **No reading of an unsealed value.** Not sealed is `X_SEAL_INVALID`; existing plaintext is
  expand → `backfill()` → contract (README). No `legacy` option.
- **Purpose is `entity:<table>.<column>`, physical names** (`sealed.ts`). **Sealing is not on
  `$describe()`**: it changes no DDL, so it must not move the drift hash — the manifest and
  `x doctor` read `sealedFields(entity)`. Only `check`/`length` leave the description.
- **A sealed property on a repository row is SERVER-ONLY**, not enumerable (`sealed.ts`): above the seam copy with `copyRow` / `pickRow`, never `{ ...row }`. Full rule: `docs/history/entity.md`.
- **Nothing sealed leaves**: `$schema` (node and parsed value; typed `WireRow` on `Entity`,
  `unknown` on `EntityCore`), `$view` (`X_ENTITY_SEALED_IN_VIEW`), `rowsOf`, the row observer, and
  the repository row itself (above). `sealed-egress.test.ts` here and one per consuming package.
- **Opaque: NULL tests only. `lookup`: also `eq` / `in`, `.unique()`, an unordered index.**
  Refused at the type (`SealedKeysOf<C>` on `ReadBuilder`, `type-pins.ts`) AND at runtime
  (`X_ENTITY_SEALED_PREDICATE`). A filtered write's FILTER refuses both kinds. Declaration rules
  are `sealed-column.ts` (the chain) and `sealed-declaration.ts` (the entity).

## Do not regress — records and tests

- **An entity row on the client is a RECORD, derived** (`row-schema.ts`, `ENTITY_BRAND` =
  `Symbol.for('ultimate.entity')` on the NODE, re-branded by the five copying methods; a partial row is
  never a record — `rows-of.test.ts`). `rowsOf` answers type → record key → row (null-prototype).
  `persist` defaults `false`, read only off the projection. **The browser path is
  `@ultimat3/entity/record`**, whose modules import `entity-error.ts`, never `errors.ts`
  (`record-bundle.test.ts`).
- Never throw a bare `Error` — use `errors.ts`. `X_DB_DRIFT` is `@ultimat3/db`'s, factory included.
- **Tests restore the registry with a FILE-scope `afterAll(() => { clearRegistry(); })`** — matched on
  exact text by `live-registry-cleanup.test.ts`; never inside a skippable suite's teardown.

## Files

Each file's header states its one job; `ls packages/entity/src` is the map, kept by no hand.

## Commands

`bun test packages/entity` · `bun run --filter @ultimat3/entity typecheck`

Why each rule above is shaped the way it is: [`docs/history/entity.md`](../../docs/history/entity.md).
