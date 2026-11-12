# @ultimat3/entity

Columns + invariants; the row type is derived from the columns. Tier 2.
A rule marked `†` has its full text in [`docs/history/entity-rules.md`](../../docs/history/entity-rules.md).

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
  and the `Repo` contract. Every bulk or read feature is proved by `entityDriverConformance`
  (`@ultimat3/testing/conformance`) and, where only a server shows it, a
  `pg-driver-<feature>.live.test.ts`.
- **`entityDriverConformance` runs every write on memory, PGlite, a server and a `defineDriver`
  store**: `undefined` is ABSENT (only `null` clears); memory refuses duplicate non-partial uniques. †
- **`min`/`max` over a `timestamptz` crosses as epoch ms** (the suite; under four session zones, `entity-driver-conformance-pglite.test.ts`). A whole
  row read under a non-UTC session still fails on PGlite — recorded, not fixed.
- **Text order is the database's collation; memory's is code point, which is `C`** (`byCodePoint`) — a
  linguistic production collation orders differently, by decision (the suite checks it on PGlite only); never `collate "C"` in generated SQL (defeats the
  index). Create the database with `LC_COLLATE=C` when byte order must hold.
- **Money's write shape is wider than its row shape** (`MoneyInput` takes a `bigint`; `MoneyValue`
  holds a `number`); `RowWrite<Row>` types `insert`/`insertAll`/`upsertAll`; `narrowRow` (`columns.ts`)
  narrows at each write method's ENTRY, before `$assert`/`upsertPlan`. `pg-money-write.live.test.ts`,
  `pg-money-bind.test.ts`, the suite, `type-pins.ts`.
- **A numeric key has one spelling** (`keyOf`): batches, conflict targets and memory's uniques. **A null test on a whole money property reads `<p>.minor`; any other predicate on it, or an unknown operator, is refused at plan time (`predicate-screen.ts`).** Why: `docs/history/entity.md` (31.0.0).
- **A PREDICATE's meaning is decided by the column's KIND** (`memory-match.ts`; `compareByKind` /
  `sameValueOfKind` exported for query); ONE numeric comparison, `numericOrder`; `LIKE` never a regex. †
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

- **A point lookup batches itself** (`coalesce.ts`): one microtask's `findById`s are one `in`;
  no caller left unsettled. †
- **A page batches the loop it causes** (`jit-preload.ts`): served only under the SAME `scopeKey`,
  dropped by any write; off only via `postgresDriver({ jitPreload: false })`. †
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
- **The cursor codec is core's**; `assertSeekable` runs in `planFor`; a bad cursor is
  `X_CURSOR_INVALID`, never "from the top". †
- **A NULLABLE sort key orders** `asc nulls last` / `desc nulls first`; the cursor tags NULL. †
- **A `timestamp` cursor carries MICROSECONDS** (`seekPrecision`, `instant.ts`). Full rule: `docs/history/entity.md`.
- **The four aggregates** (`sum`, `avg`, `min`, `max`) share `aggregate.ts`:
  never a float; `null` for an empty set; refusals `X_AGGREGATE_UNSUPPORTED`,
  `X_AGGREGATE_MIXED_CURRENCY`. Full rule: `docs/history/entity.md`. **`approximateCount()` is `reltuples`**; a filtered chain or tenant-scoped entity is
  `X_APPROXIMATE_COUNT_FILTERED`; `null` for an unanalysed table.
- **`series`, views**: `time-bucket.ts` (zone rules, measured), `view-repo.ts` (read-only); `time-bucket.test.ts`, `view-entity.test.ts`.
- **`json()` / `arrayOf()` are filterable** (`containment.ts`); no jsonpath operator. †
- **A GIN index is declarable** (`using: 'gin'`); never unique or ordered. †

## Do not regress — schema and DDL

- **A relation is a foreign key read a second way** (`relations.ts`); never parse
  `"<table>.<column>"` back. †
- **An index is described whole** (`IndexDescription`); names bounded at 63 BYTES
  (`index-name.ts`). †
- **Every physical name is checked, including the DERIVED one** (`assertColumnName` at `bindColumn`,
  and on the entity-name table fallback).
- **One resolver decides a physical name: `columnName(property, meta)`** (with
  `entity(name, { table })` and `.column(name)`); a second `snake(property)` is a bug. **The entity
  NAME and the TABLE are different things** — cache tags and policies key on the name; index names are
  the table's.
- **Invariants run twice and only ONE side is rendered here**: app-side `assertInvariants`, and the
  CHECK/UNIQUE DDL is `@ultimat3/db`'s `invariant-ddl.ts` reading `$describe()`. An untranslatable predicate is `kind: 'assert'`, `sql: null`.
  **`InvariantDescription.columns` is projected** (`describe-invariant.test.ts`).
- **The two halves must AGREE, term by term** (`expr.ts`, `pg-invariant-null.live.test.ts`); one app-only operand makes the whole rule app-only. **NULL is judged in three values in both** (`expr-verdict.ts`): an operand NULL is unknown, a rule holds unless false, `isNull`/`isNotNull` total (`invariant-null.test.ts`, 31.3). Full rule: `docs/history/entity.md`.
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

- **A tenant column means every query runs under the ACTING ACTOR's tenant** (`scopedPlan`); a
  caller's `orgId` is an assertion (`X_TENANCY_ACTOR_MISMATCH`), never an override. †
- **Tenancy applies to writes in two places**: the plan bounds WHICH rows; `assertRowTenant`
  judges the VALUE at every write seam — refuse, never stamp. †
- **A reference stays inside its tenant** (`sameTenantOf`, `describe.ts`, at describe time): `sameTenant` is `null` on the record and ABSENT on the column otherwise (the hash). `entity()` never resolves a thunk at declaration. Memory (`memory-same-tenant.ts`) refuses only a target FOUND elsewhere. The suite, `same-tenant.live.test.ts`.
- **`lock`/`lockKey`**: optional on `Repo`, required on `Table` (`table-locks.ts`, `X_LOCK_UNSUPPORTED`); `pg-lock.ts`, `memory-lock.ts` (`update`/`delete` queue too, the filtered writes do not), one tenant derivation (`lock-key.ts`, via `readPlan`). the suite, `pg-lock-attribution.test.ts`, `lock.live.test.ts`, `lock-seams.test.ts`. Why: `docs/history/entity.md` (2026-11-02).
- **`crossTenant(reason, fn)` is the ONE way to read across tenants** — an `asyncContext` scope from
  core (`scripts/async-context-guard.ts`), `CROSS_TENANT_SCOPE` (`tenancy:cross`) proven at the call
  and at every plan (`X_TENANCY_CROSS_DENIED`), refused outside a request, blank reason `X_INVARIANT`.
- **`deleteWhere` / `updateWhere` are the only filtered writes** — a chain's `updateAll`/`deleteAll` (`query-write.ts`) IS one, its predicates in `FilteredWriteOptions.where`, one plan (`write-where.ts`). `updateMany`/`insertAllCount`/`upsertAllCount`/`copyAll` are `Repo`-optional with typed-handle fallbacks; every wrapper (sealed, append-only, view, mirror, observer, memory-observed) handles each (`query-write-wrappers.test.ts`). Empty filter `X_WRITE_UNFILTERED`,
  empty patch `X_PATCH_EMPTY` (undefined values dropped first); soft delete respected; both return a
  count; a JS-only invariant is judged
  in the statement's transaction (`judged-write.ts`), refused past `MAX_ASSERTED_ROWS`. Full rule: `docs/history/entity.md`.
- **Sweep 5b seams** (`read-wrappers.test.ts`, `history-purge.test.ts`): `Repo.latestBy?`/`aggregates?`/`lockKeys?` optional, each forwarded by sealed (refuses sealed group/order/measure/filter columns, opens rows), search-repo and memory-observed; `countBy`'s 3rd arg `{ where }` forwarded everywhere. `defineDriver` composes filtered `countBy` and `aggregates` from existing capabilities; a versioned entity there takes the judged path, one CAS store write per row. `update(id)` calls `assertVersionedUpdate` in all three drivers. `purgingHistory` (`history-purge.ts`) is the only door out of a history table. `IndexDef` carries `expression`/`orders`/`include`/`operatorClass` (types.ts; checked in `declared-index-keys.ts`, rendered by db); one covering rule for implicit indexes (`coveringIndexOf`). Files: `latest-by*.ts`, `measures.ts`, `text-contains.ts`, `version-lock*.ts`, `lock-key.ts`, `counter-observed.ts`, `all-truncated.ts`.
- **`text().collate('C')`** (`sealed-column.ts`'s `makeTextColumn`): `ColumnMeta.collation`, `'C'` only (else `X_INVARIANT_VIOLATED`), projected on `ColumnDescription.collation` only when declared; db renders/diffs it. `@ultimat3/query`'s `live-collation.ts` exempts it from the live-order warning.
- **A write past a coded abort is refused on both drivers**: `refuseAbandoned()` in `writing()` and each `memoryRepo` write. `write-abandon.test.ts`.
- **Every instant the write path stamps comes from `entityNow()`** (`clock.ts`, `ctx.clock`).
  **`touch()` in `touch.ts` is the ONE place `onUpdateNow()` columns are stamped.**
  **Both repositories parse a patch at the door** (`$parsePatch`): `$parse`'s issues, no default, a fragment refused.
- **A many-row write is one statement** (`bulk-write.ts`); the conflict target is a declared
  non-partial unique; `upsertAll` overwrites what the caller NAMED. †
- **`memoryTransactor().run` is ambient** (`memory-journal.ts`): a write naming no `tx` joins it; a nested
  commit hands its undos and effects up; a write after the root ended is `X_DB_TRANSACTION_CLOSED`; a
  row lock taken with no tx is held to the root. `memory-journal.test.ts`, `memory-transactor.test.ts`.
- **Every tenant table is indexed `(tenant, pk)`** (`tenant-index.ts`, `concurrently`), inferred or
  declared; it replaces the tenant column's own index; none when the PK, an index, a unique or a
  same-tenant key already starts with it.
- **Custom stores: `defineDriver` from `@ultimat3/entity/adapter` only** — scoped plan in, rows
  re-checked, `X_DRIVER_UNSUPPORTED` per capability; the store owns its schema, `x db`/drift are
  Postgres-only. README "Custom drivers". **One row identity: `rowKey`** (`row-key.ts`).
- **`shared: '<why>'` is the one way an untenanted child of a tenant-owned table says so**
  (`assertShared`, `describe.ts`); the reach check is the CLI's `exercise-static.ts`
  (`X_ENTITY_TENANT_UNDECLARED`), over `EntityDescription.shared`.
- **`scan: '<why>'`**: a table read whole (`assertScan`).
- **A seed is replayable**; a dry run is the real run rolled back (`Driver.transactor()`). †
- **`row-observer.ts` emits committed row changes above the driver** as `entity.row` on core's bus
  (`EntityRowEvent`), applied by `database()`; one map read per write with no subscriber, `before`
  only when the PK is `id`, a filtered write is `entity.bulk`. No slot (v31,
  `X_INSTRUMENT_SLOT_FORBIDDEN`). Not a second change-feed path. `crossTenant()` emits
  `entity.cross_tenant` once the capability is proven; `memory-observed.ts` emits `db.statement`
  for the memory driver.
- **Search mirroring is `search-mirrored-repo.ts`, beneath the observer and at commit**
  (`write-commit.ts`), never the bus; a driver answers a delete's or filtered write's rows only inside
  `collectWrittenRows` (`search-written-rows.ts`). `search-mirror-batch.ts` merges a transaction's ops
  per key; `committed` documents replace tombstones; `rowKey` spells an instant in ISO (`keyOf`). A
  searchable entity's version is STRICTLY increasing per row: `advanceVersion` (memory, `defineDriver`,
  `DriverRepo.update`'s `advance`) and `greatest(…, col + interval '1 millisecond')` (`pg-write-sql.ts`)
  — `search-version-monotonic.test.ts`.
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
| `history: true` · `{ ignore }` | `history.ts`, `history-actor.ts` | `<table>_history` is a REAL registered entity (`$historyOf`), tenant column copied without its key. `ignore` (typed column names, refused otherwise) joins the counters in `$describe().history.ignore` — the trigger's, memory's (`historyIgnored`) and `history-order`'s one list. Written by `@ultimat3/db`'s trigger; `stampHistoryActor` sets `x.actor`/`x.request` once per transaction, never on a pinned repository — no transaction records `null`. `bigint`/`decimal`/`timestamp` columns ride `text`/`instants`: the image is the memory driver's strings (`history-values.test.ts`) |
| `history(table, id)` | `history-read.ts`, `history-order.ts` | the history table's ordinary read (tenant scope, `inBatches`), then ONE ordering: the before→after walk (Hierholzer) across EVERY version — `at` is a transaction's start, so it only breaks ties — counted columns left out; no single walk: by `at`, the walk inside each instant. `{ limit }`: newest-first window, ties at its edge kept, numbered via `count`. `version` is a position, never stored — no schema change. `history-read.test.ts` (memory + PGlite), `.live.` |
| `countedIn` on a key | `counter.ts` | the target is a NOT NULL `integer()` of the entity the key points at (Postgres' `NULL + 1` stays NULL), by its single primary key (`X_ENTITY_COUNTS_INVALID`); resolved at describe time, memoised on `registryGeneration()` |
| all three, described | `lifecycle.ts` | each `$describe()` key ABSENT unless declared, so no other entity's hash moves |
| the memory driver | `memory-lifecycle.ts` | mirrors both triggers through the table's raw store |
| `partitionBy` | `partition.ts` | Postgres' rules, at declaration (`X_ENTITY_PARTITION_INVALID`); SQL in db |

- **Known gap: the row observer does not see trigger writes.** A history row and a counter move
  are the trigger's (memory: `memoryLifecycle`'s raw store), never a repository write, so
  `entity.row` reports neither; a live counter on PGlite or memory moves on the parent's next
  write. The WAL replicator reports them. As of 2026-11.
- **`read-capture.ts` is failure capture's read half**: `observedRepo`'s `findById`/`findMany` hand
  rows to core's `recordFailureFact` — sealed properties dropped first; one check when off.

## Do not regress — sealed columns

- **`sealed-repo.ts` is the ONE seam**: `memoryRepo()` and `postgresRepo()` both return through
  `sealedRepo(entity, repo)`, which seals rows and patches going in, opens rows coming out and
  rewrites or refuses every predicate. A driver never seals for itself; an entity with no sealed
  column gets its repository back untouched. The cipher is core's (`scripts/seal-calls.ts`).
- **A sealed column's `$parse` passes a sealed string and judges a plaintext**; `sealValue` parses
  the plaintext BEFORE sealing. †
- **No reading of an unsealed value.** Not sealed is `X_SEAL_INVALID`; existing plaintext is
  expand → `backfill()` → contract (README). No `legacy` option.
- **Purpose is `entity:<table>.<column>`; sealing is not on `$describe()`** (no drift move). †
- **A sealed property on a repository row is SERVER-ONLY**, not enumerable (`sealed.ts`): above the seam copy with `copyRow` / `pickRow`, never `{ ...row }`. Full rule: `docs/history/entity.md`.
- **Nothing sealed leaves**: `$schema` (node and parsed value; typed `WireRow` on `Entity`,
  `unknown` on `EntityCore`), `$view` (`X_ENTITY_SEALED_IN_VIEW`), `rowsOf`, the row observer, and
  the repository row itself (above). `sealed-egress.test.ts` here and one per consuming package.
- **Opaque: NULL tests only. `lookup`: also `eq` / `in`** — refused at the type and at runtime
  (`X_ENTITY_SEALED_PREDICATE`). †

## Do not regress — records and tests

- **An entity row on the client is a RECORD, derived** (`row-schema.ts`); the browser path is
  `@ultimat3/entity/record`, importing `entity-error.ts`, never `errors.ts`. †
- Never throw a bare `Error` — use `errors.ts`. `X_DB_DRIFT` is `@ultimat3/db`'s, factory included.
- **Tests restore the registry with a FILE-scope `afterAll(() => { clearRegistry(); })`** — matched on
  exact text by `live-registry-cleanup.test.ts`; never inside a skippable suite's teardown.

## Files

Each file's header states its job; `ls packages/entity/src` is the map.

## Commands

`bun test ./packages/entity/` · `bun run --filter @ultimat3/entity typecheck`

Why each rule above is shaped the way it is: [`docs/history/entity.md`](../../docs/history/entity.md).
