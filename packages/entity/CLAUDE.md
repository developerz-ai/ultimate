# @ultimat3/entity

Columns + invariants; the row type is derived from the columns. Tier 2.

## Boundary

- May import `@ultimat3/core`, `@ultimat3/schema`, `@ultimat3/db` and `@ultimat3/time` (tier 1 — `columns.ts` and `columns-data.ts` read its `isValidTimeZone`, so a zone this package accepts is one `@ultimat3/time` can do arithmetic in). Nothing else — `http`,
  `policy` and `auth` are the same tier.
- `db` is tier 1 (it imports only `core`), which is what lets the Postgres driver live **here**
  rather than in a tier-3 package: `Driver` and its production implementation stay in one place.
  See [`docs/architecture/01-package-map.md`](../../docs/architecture/01-package-map.md).
- No `drizzle-orm` dependency, and none is the production backing — `postgresDriver()`
  (`pg-driver.ts`/`pg-sql.ts`) is a hand-written SQL driver. `types.ts` declares the narrow
  structural column vocabulary this package consumes so the generated SQL stays readable and
  an agent can self-correct against it.

## Do not regress — two drivers, one meaning

- **`repo.ts` is the contract** (`Repo`, `Page`, `FindManyArgs`, `Transactor`); `memory-repo.ts` is
  `memoryRepo()`.
- **Two drivers, one meaning.** `memoryDriver()` and `postgresDriver()` share `plan.ts`, `cursor.ts`
  and the `Repo` contract. Every bulk or read feature carries BOTH a `*-parity.test.ts` (identical rows
  into both drivers, identical output) and a `pg-driver-<feature>.live.test.ts` against a real server.
  Both are the bar.
- **`write-parity.test.ts` runs every write against memory AND PGlite**: a patch property present with
  `undefined` is ABSENT (only `null` clears); memory refuses a duplicate PK, a duplicate non-partial
  `unique` and a PK patch onto another row with `X_DB_UNIQUE_VIOLATION` (`memory-unique.ts`; partial
  uniques are not checked in memory); `.transition()` filters on `singleKeyOf(entity)`;
  `decimal()`/`bigint()` store Postgres's spelling (never rounded); a seed `upsert` compares only named
  columns; `text({ max })` counts code points; `integer()` holds int4; `url()` lower-cases its scheme.
- **`min`/`max` over a `timestamptz` crosses as epoch ms** (`aggregate-time-parity.test.ts`). A whole
  row read under a non-UTC session still fails on PGlite — recorded, not fixed.
- **Text ordering: byte (`C`) order is the parity target** — a linguistic production collation is a
  known divergence; never `collate "C"` in generated SQL (defeats the index). Create the database with
  `LC_COLLATE=C` when byte order must hold.
- **Money's write shape is wider than its row shape** (`MoneyInput` takes a `bigint`; `MoneyValue`
  holds a `number`); `RowWrite<Row>` types `insert`/`insertAll`/`upsertAll`; `narrowRow` (`columns.ts`)
  narrows at each write method's ENTRY, before `$assert`/`upsertPlan`. `pg-money-write.live.test.ts`,
  `money-write-parity.test.ts`, `type-pins.ts`.
- **A PREDICATE's meaning is decided by the column's KIND** (`memory-match.ts`): decimal-text columns
  compare through core's `compareDecimalText` (`DECIMAL_TEXT` decides who asks); a `uuid` is a value
  stored lower-case (`keyOf`, `parseUuid`, `narrowUuid`; text is never narrowed); `LIKE` uses
  Postgres' default `\` escape and refuses a trailing escape; a run of `%` is one `.*`; `in` takes a
  list or nothing, and a NULL in it emits `(col in (…) or col is null)`; a column the row never NAMED
  is NULL for `eq`/`neq`/`in`.
- **The Postgres driver is proved against a real Postgres** (`pg-driver.live.test.ts`, skipped without
  `TEST_DATABASE_URL`). A new operator, column kind or write path is not done until it round-trips.
- **A repository call rejects, never throws synchronously** (`tableFor`'s writes are `async`).
- **`defaultDriver()`** is the process default; `Driver.reset?()` is optional (memory only), resets
  repositories in place. Test seam only.
- **A repository pinned to its own client refuses to run inside a transaction**
  (`X_REPO_CLIENT_PINNED`, in `client()` in `pg-driver.ts`); the fix names `setDbClient(client)` plus
  an unpinned repository.

## Do not regress — reading

- **A point lookup batches itself** (`coalesce.ts`): `findById` calls in one microtask of one request
  are one `in` statement, keyed by ctx (`WeakMap`) and a scope key covering every input but the id;
  it declines rather than guesses; past `MAX_IDS_PER_STATEMENT` it is several statements; no caller is
  ever left unsettled (`coalesce.test.ts` races a deadline).
- **A page batches the loop it causes** (`jit-preload.ts`): a preloaded row is served only under the
  SAME `scopeKey` (a security boundary), same client, dropped by any write (`forgetPreloaded` in
  `writing()`), keyed by id, bounded (`MAX_SIBLING_KEYS`, oldest page first). One switch:
  `postgresDriver({ jitPreload: false })` — never an `app.config.ts` key. Shared pieces live in
  `batch-read.ts`.
- **`preload(name)` shares `batch-read.ts` and keeps no request cache.** Tenancy is CARRIED only when
  both entities are scoped by a column of that same name, else the related read refuses
  (`X_TENANCY_UNSCOPED`). Reach is the `database()` call's `RelatedTables`; `select()` widens with each
  preloaded relation's local key; attachment copies (`{ ...row }`); only `page()`/`all()`/`one()`
  preload.
- **Every repository method attributes its statement** through `@ultimat3/db`'s
  `withStatementAttribution(entity.$name, op, send)` via `attributed(op, send)`, `op` declared once per
  method and passed to the plan builders; `writeRows(op, …)` for the three inserts; `aggregate` names
  the function. Never entered with no observer. A preloaded relation is attributed to the related
  entity. `memoryRepo` sends no statement. `pg-driver-attribution.test.ts` — one case per method.
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
- **`inBatches(size)` is the same page in a loop** (`batch.ts`): the handle is its own iterator
  (`close()` = `AsyncGenerator.return()`), `.cursor` is advanced before the yield, no empty batch, and
  three refusals on the chain (size, `limit()` alongside, an order no cursor can carry — judged by
  exported `totalOrder`).
- **A grouped count means one thing in both drivers, and `count-by.ts` is where that one thing is
  written.** `countBy(column)` is the aggregate a `count()` per row is the N+1 of, so both drivers
  call `groupColumnOf` before their statement exists and `countsFrom` after their rows are in — a
  rule added to `pg-driver.ts` or to `memory-repo.ts` alone is exactly the drift that file exists
  to prevent. **Groupable kinds are a closed set**: `uuid`, `text`, `char`, `boolean`, `integer`,
  `bigint`. A `timestamptz` is a `Date`, a `jsonb` is an object and `money` is two physical columns
  — a `Map` compares a non-primitive key by identity, so any of those would file rows under a key
  no caller can look up again and the result would be a map that only ever answers `undefined`. The
  refusal is `X_INVARIANT_VIOLATED` naming a column of *this* entity that is groupable, never
  `x entity explain`: what repairs it is one edit to the call, and the entity is the only place the
  replacement column lives. **The bound is a refusal, not a truncation.** The statement asks for
  `MAX_GROUPS + 1` groups — the trick a page already uses when it reads one row past its limit — and
  that extra group is what says the answer was never going to fit, so `countsFrom` throws with the
  `andWhere(…, 'in', <values>)` that bounds it. Truncating would hand back a map that reads exactly
  like a complete one, and a caller recounting from it would write the wrong number to every row it
  missed. **Absent is not `0`**: a value nothing matched has no entry, because that is what
  `group by` returns and it is the only way a caller can tell "none" from "never asked" — the
  `?? 0` is theirs to write, and inventing it here would answer for keys the table has never seen.
  **NULL is one group**, keyed `null`: the memory driver reads the property as `?? null` so it lands
  where Postgres puts its NULL rows, while `0`, `''` and `false` stay the values they are. **The
  order is applied after the rows are in, never in SQL** — a hash aggregate returns groups in
  whatever order it built them and a `Map` filled row by row returns insertion order, so an
  `order by` in the statement would let the two drivers disagree about a result they agree on;
  sorting groups (never rows) costs nothing at this size and is what puts the largest bucket at the
  front. **Both output names are fixed aliases** — `group_value` and `group_count` in
  `countByStatement` (`pg-sql.ts`) — because an entity is free to declare a column called `count`,
  and the un-aliased form would then return two outputs of one name; the grouped value is re-parsed
  by the column that declared it, since `int8` arrives as a string and would otherwise key the map
  by text where memory keys it by a `bigint`. **Nothing new to declare**: no `groupBy()` builder and
  no error code of its own — it is a terminal on the chain that already exists, over exactly the
  rows `count()` counts.
- **The codec is `@ultimat3/core`'s**, reached through `cursorFor(entity, plan, row, id)` and
  `seekFrom(entity, plan)`; **`assertSeekable` runs in `planFor`**, before a statement exists. A
  `timestamptz` sort key is refused when its `<column>$US` alias would pass 63 bytes. A cursor is bound
  to `planScope(plan)` (entity, filters, sort); a bad one is `X_CURSOR_INVALID`, never "from the top".
- **A NULLABLE sort key orders** `asc nulls last` / `desc nulls first` (written down); the cursor tags
  `~` for NULL and `!` for present; the seek reaches NULLs; a nullable key has no row comparison. Only a
  nullable PRIMARY-KEY column is refused. `pg-null-order.live.test.ts`.
- **A `timestamp` cursor carries MICROSECONDS**: `seekPrecision` projects `(col at time zone
  'UTC')::text as "<col>$US"`; `sortPrecision` reads it; the seek binds a six-digit ISO instant
  (`col < $1::timestamptz`). `instant.ts` is where the two representations meet.
  `pg-cursor-precision.live.test.ts`.
- **The four aggregates** (`sum`, `avg`, `min`, `max`) share `aggregate.ts`
  (`aggregate-fold.ts` memory, `aggregate-decode.ts` Postgres): never a float; `avg` at `AVG_SCALE` (6),
  half away from zero; `null` for an empty set. Refused: `min`/`max` on text, `avg` over money
  (`X_AGGREGATE_UNSUPPORTED`), mixed currency or scale (`X_AGGREGATE_MIXED_CURRENCY`), a money total
  past ±2^53. **`approximateCount()` is `reltuples`**; a filtered chain or tenant-scoped entity is
  `X_APPROXIMATE_COUNT_FILTERED`; `null` for an unanalysed table.
- **`json()` / `arrayOf()` are filterable** (`contains`, `contained-by`, `overlaps`, `has-key`) with
  Postgres' measured meaning in `containment.ts`; `has-key` emits `operator(pg_catalog.?)` (indexable),
  pinned by `pg-sql.test.ts`. No jsonpath operator.
- **A GIN index is declarable** (`using: 'gin'`; the set is `@ultimat3/db`'s `INDEX_METHODS`); absent
  is `btree` byte for byte; the method joins the name discriminator only when declared; GIN cannot be
  unique or ordered (refused here). `pg-containment.live.test.ts`.
- **Full-text search** (`search.ts`): one generated `tsvector` per entity, `websearch_to_tsquery`, a
  closed `SEARCH_LANGUAGES` set spliced, `coalesce(col, '')` per source, NOT NULL vector column; the
  memory driver refuses (`X_SEARCH_IN_MEMORY`); relevance is not a served order.
  `pg-search.live.test.ts`.

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
  CHECK/UNIQUE DDL is `@ultimat3/db`'s `invariant-ddl.ts` reading `$describe()` (`$migration()` and the
  local renderers are deleted). An untranslatable predicate is `kind: 'assert'`, `sql: null`.
  **`InvariantDescription.columns` is projected** (`describe-invariant.test.ts`).
- **The two halves must AGREE, term by term** (`expr.ts`): `matches(/…/i)` is `~*`, other flags are
  refused (`matchOperator`); `minLength` counts code points. **`isNull()`/`isNotNull()` are the only
  total members**; `iff(a, b)` renders `(a) = (b)` — measured as the safe direction
  (`pg-invariant-null.live.test.ts`); `iff` is a function, and a `unique` operand is refused with the
  `c.unique([…])` fix built through `JSON.stringify`. One app-only operand makes the whole rule
  app-only.
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
- **Money is three columns**: `<p>_minor bigint`, `<p>_currency char(3)`, `<p>_scale integer null`.
  NULL scale decodes to an ABSENT key (never `0`); the scale bound is `@ultimat3/schema`'s
  (`isMoneyScale`, `scaleCheck`); scale is not addressable (`MONEY_PARTS`). The currency bound is
  schema's in both halves (`isCurrencyCode`, `CURRENCY_CODE_PATTERN`; `currency-check.live.test.ts`).
  `MoneyValue` is re-exported from `@ultimat3/schema` — one declaration (`type-pins.ts`). `parseMinor`
  refuses past ±2^53; `narrowMoney` runs in both drivers. `money({ columns })` merges per part and
  `scale: null` means a two-column amount (`decodeRow` branches on `$meta.kind === 'money'`).
- **Timestamps are `timestamptz`.** A naive timestamp stays inexpressible.
- **A `jsonb` value is bound `::text::jsonb`** (load-bearing); an array is written as a quoted `{…}`
  literal. **Wide column types are normalised in `$parse`** to one row type per driver (`bigint()` and
  `decimal()` are strings).
- **Every framework member on an entity is `$`-prefixed.** Row types are derived, never re-declared.
  **A branded id survives to the signature** (`IdOf<Row>`). `type-pins.ts` enforces all of it.
- **`$parse` tells absence from `null`** (`raw === undefined ? defaultValue(...) : raw`).
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim** (`index.test.ts`).
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
- **`crossTenant(reason, fn)` is the ONE way to read across tenants** — an `asyncContext` scope from
  core (`scripts/async-context-guard.ts`), `CROSS_TENANT_SCOPE` (`tenancy:cross`) proven at the call
  and at every plan (`X_TENANCY_CROSS_DENIED`), refused outside a request, blank reason `X_INVARIANT`.
- **`deleteWhere` / `updateWhere` are the only filtered writes**: empty filter `X_WRITE_UNFILTERED`,
  empty patch `X_PATCH_EMPTY` (undefined values dropped first); soft delete respected; both return a
  count; rows come back only when a JS-only invariant needs them (`hasJsOnlyInvariant`), counted first
  and refused past `MAX_ASSERTED_ROWS` (50,000) in BOTH drivers. `updateStatement`'s `returning` is
  required.
- **Every instant the write path stamps comes from `entityNow()`** (`clock.ts`, `ctx.clock`).
  **`touch()` in `query.ts` is the ONE place `onUpdateNow()` columns are stamped.**
- **A many-row write is one statement** (`insertStatement` builds every insert; `bulk-write.ts`
  decides in property space): a collision overwrites everything but the conflict target, the PK and the
  soft-delete stamp; the target must be a declared non-partial unique constraint (PK, `$indexes`, or a
  `kind: 'unique'` invariant); under `'update'` the tenant column must be in the target
  (`X_TENANCY_UNSCOPED`), a repeated target and an uneven batch are refused; NULL in the target
  collides with nothing; memory judges the whole batch first; past `MAX_BIND_PARAMETERS` it is several
  statements.
- **A seed is replayable**: `SeedContext.insert` is one `upsertAll(…, { onMatch: 'nothing' })` per
  call; a generated PK the row does not name is refused. `upsert(entity, { by }, values)` keys on a
  natural key, reads first for the report, writes one `on conflict … do update`, preserves `createdAt`.
  **The environment guard is the CLI's** (`seedTiersFor`; `run()` stays permissive).
- **`setRowObserver` reports committed row changes above the driver** — one per process (returns the
  replaced one), applied by `database()`, one comparison per write when unset, `before` only when the PK
  is `id`, a filtered write is `onBulk`. Not a second change-feed path.
- **A state machine is the MECHANISM only** (`.transitions()` on `enumerated()`, a mapped
  `TransitionTable<S>`): a terminal state is one with no outgoing moves; the move is ONE statement with
  `from` in the predicate (`pg-transition.live.test.ts`: 1 winner of 20); `X_STATE_CONFLICT` is read
  after the refusal from a tenant-scoped `findById`; no DDL beyond `enumerated()`'s CHECK; a machine
  column may not be nullable; `whyNot` asks unknown → terminal → legal list.

## Do not regress — records and tests

- **An entity row on the client is a RECORD, derived** (`row-schema.ts`, `ENTITY_BRAND` =
  `Symbol.for('ultimate.entity')` on the NODE, re-branded by the five copying methods; a partial row is
  never a record — `rows-of.test.ts`). `rowsOf` answers type → record key → row (null-prototype).
  `persist` defaults `false`, read only off the projection. **The browser path is
  `@ultimat3/entity/record`**, whose modules import `entity-error.ts`, never `errors.ts`
  (`record-bundle.test.ts`).
- Never throw a bare `Error` — use `errors.ts`.
- **Tests restore the registry with a FILE-scope `afterAll(() => { clearRegistry(); })`** — matched on
  exact text by `live-registry-cleanup.test.ts`; never inside a skippable suite's teardown.

## Files

Each file's header states its one job. The map, by area: `types.ts` (derivation; `COLUMN_KINDS`),
`column.ts` / `columns.ts` / `columns-data.ts` / `array-element.ts` / `enum-column.ts` /
`column-values.ts` (builders, `columnName`, `narrowMoney`), `refuse.ts`, `expr.ts` / `invariants.ts`,
`entity.ts` / `describe.ts` / `index-name.ts` / `search.ts`, `state-machine.ts` / `transition.ts`,
`feature-errors.ts`, `view.ts` / `row-schema.ts` / `record-projection.ts` / `record-key.ts` /
`rows-of.ts` / `record-table.ts` / `record.ts`, `entity-error.ts` / `errors.ts`, `query.ts` /
`database.ts` / `clock.ts`, `memory-match.ts` / `repo.ts` / `memory-repo.ts` / `tenancy.ts` /
`cross-tenant.ts`, `plan.ts` / `cursor.ts` / `batch.ts`, `pg-driver.ts` / `coalesce.ts` /
`batch-read.ts` / `bulk-write.ts` / `count-by.ts` / `jit-preload.ts` / `preload.ts` / `pg-sql.ts` /
`pg-row.ts`, `row-observer.ts` / `write-tag.ts` (a keyed request's write names itself in the WAL via
`pg_logical_emit_message`), `registry.ts` / `relations.ts` / `n-plus-one.ts` / `seed.ts`,
`type-pins.ts`, `live-registry-cleanup.test.ts`.

## Commands

`bun test packages/entity` · `bun run --filter @ultimat3/entity typecheck`

Why each rule above is shaped the way it is: [`docs/history/entity.md`](../../docs/history/entity.md).
