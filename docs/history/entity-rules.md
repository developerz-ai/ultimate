# entity: rule text moved out of `packages/entity/CLAUDE.md`

`As of 2026-11-10`. Plan 101 wave G cut the package file toward a 20 KB working target (the
enforced ceiling is 24,576 B, `bun run scripts/claude-md-size.ts`). Each section below is a bullet
as it stood, verbatim; the package file keeps a one-line rule marked `†`. Where the two disagree,
`packages/entity/CLAUDE.md` wins. The older long form is [`entity.md`](entity.md).

## `entityDriverConformance` write rules

- **`entityDriverConformance` (`@ultimat3/testing/conformance`) runs every write against memory, PGlite, a server and a `defineDriver` store**: a patch property present with
  `undefined` is ABSENT (only `null` clears); memory refuses a duplicate PK, a duplicate non-partial
  unique — index OR `c.unique([…])` invariant, the one list in `unique-constraints.ts` — and a PK
  patch onto another row with `X_DB_UNIQUE_VIOLATION` (partial uniques are not checked in memory);
  each kind's stored spelling: `docs/history/entity.md`.
  The suite asks the app and the driver; `invariant-check.test.ts` asks the raw CHECK the same question.

## A predicate's meaning is the column's kind

- **A PREDICATE's meaning is decided by the column's KIND** (`memory-match.ts`); `compareByKind` /
  `sameValueOfKind` are EXPORTED — `@ultimat3/query` calls them. **ONE numeric comparison,
  `numericOrder`**: `DECIMAL_TEXT` columns by VALUE (`'2.50' = 2.5`), `number`/`bigint` numerically
  (`compare-by-kind.test.ts`, the suite). A `uuid` is a value, compared lower-cased and
  stored lower-case (`keyOf`, `parseUuid`, `narrowUuid`; text is never narrowed); `LIKE` (`like.ts`)
  uses Postgres' default `\` escape, refuses a trailing escape, counts CHARACTERS and is a bounded
  two-pointer walk — never a regex; `in` takes a
  list or nothing, and a NULL in it emits `(col in (…) or col is null)`; a column the row never NAMED
  is NULL for `eq`/`neq`/`in`.

## Point lookups batch

- **A point lookup batches itself** (`coalesce.ts`): `findById` calls in one microtask of one request
  are one `in` statement, keyed by ctx (`WeakMap`) and a scope key covering every input but the id;
  it declines rather than guesses; past `MAX_IDS_PER_STATEMENT` it is several statements; no caller is
  ever left unsettled (`coalesce.test.ts` races a deadline).

## JIT preload

- **A page batches the loop it causes** (`jit-preload.ts`): a preloaded row is served only under the
  SAME `scopeKey` (a security boundary), same client, dropped by any write to ANY entity — triggers
  and FK actions rewrite rows a statement never named (`forgetPreloaded` in `writing()`;
  `jit-preload-db-writes.test.ts`), keyed by id, bounded (`MAX_SIBLING_KEYS`, oldest page first). One switch:
  `postgresDriver({ jitPreload: false })` — never an `app.config.ts` key. Shared pieces live in
  `batch-read.ts`.

## Cursor codec

- **The codec is `@ultimat3/core`'s**, reached through `cursorFor(entity, plan, row, id)` and
  `seekFrom(entity, plan)`; **`assertSeekable` runs in `planFor`**, before a statement exists, and refuses `jsonb`, `bytea`, `array` (`UNSEEKABLE`). A
  `timestamptz` sort key is refused when its `<column>$US` alias would pass 63 bytes. A cursor is bound
  to `planScope(plan)` (entity, filters, sort); a bad one is `X_CURSOR_INVALID`, never "from the top".

## Nullable sort keys

- **A NULLABLE sort key orders** `asc nulls last` / `desc nulls first`; the cursor tags
  `~` for NULL and `!` for present; the seek reaches NULLs; a nullable key has no row comparison. Only a
  nullable PRIMARY-KEY column is refused. `pg-null-order.live.test.ts`.

## JSON and array filters

- **`json()` / `arrayOf()` are filterable** (`contains`, `contained-by`, `overlaps`, `has-key`) with
  Postgres' measured meaning in `containment.ts`; `has-key` emits `operator(pg_catalog.?)` (indexable)
  and takes a STRING key, else no rows; a NULL array element equals nothing. No jsonpath operator.

## GIN indexes

- **A GIN index is declarable** (`using: 'gin'`; the set is `@ultimat3/db`'s `INDEX_METHODS`); absent
  is `btree` byte for byte; the method joins the name discriminator only when declared; GIN cannot be
  unique or ordered (refused here). `pg-containment.live.test.ts`.

## Relations

- **A relation is a foreign key read a second way** (`relations.ts`): `belongsTo` from own
  `references()`, `hasMany` from inbound; `referenceBinding()` resolves a thunk in one place; colliding
  names all take their long form; ambiguity is `X_INVARIANT_VIOLATED`. `relationMap()` memoises on
  `registryGeneration()`, in one pass. `relationNamed()` refuses with `X_PRELOAD_UNKNOWN_RELATION`
  (fix: a real `relationNamed()` call, or `x entities list --json`). `onDelete` rides on both
  descriptions; never parse the `"<table>.<column>"` string back.

## Index descriptions

- **An index is described whole** (`IndexDescription`: columns, uniqueness, predicate, direction,
  method); `on: []` refused. **The NAME carries predicate and direction** (8 hex of sha256) only when
  one is present; the dedup is on the whole `IndexDef`; names are bounded at 63 BYTES
  (`MAX_IDENTIFIER_BYTES`, `index-name.ts`).

## Tenant scoping

- **A tenant column means every query runs under the ACTING ACTOR's tenant** (`scopedPlan`,
  `tenancy.ts`, from `tryUseContext()?.actor.orgId`); inference applies when undeclared; **the column
  may not be nullable** (`resolveTenantColumn`). A caller-supplied `orgId` is an assertion
  (`X_TENANCY_ACTOR_MISMATCH` when different, `eq` only, refused never overridden); an actor with no
  org is `X_TENANCY_ACTOR_ORG_REQUIRED`; outside a request the caller names the tenant and
  `X_TENANCY_UNSCOPED` still refuses an unscoped plan.

## Tenancy on writes

- **Tenancy applies to writes in two places**: the plan bounds WHICH rows; `assertRowTenant` judges the
  VALUE at every write seam (both drivers), a filtered update judging the PATCH before any row; refuse,
  never stamp; all or nothing; the incoming rows too; before the statement exists
  (the suite, `pg-driver-tenancy.live.test.ts`). With the conflict-target rule, a
  cross-tenant upsert is unrepresentable.

## Many-row writes

- **A many-row write is one statement** (`insertStatement` builds every insert; `bulk-write.ts`
  decides in property space): a collision overwrites everything but the conflict target, the PK and the
  soft-delete stamp; the target must be a declared non-partial unique constraint (PK, `$indexes`, or a
  `kind: 'unique'` invariant); under `'update'` the tenant column must be in the target
  (`X_TENANCY_UNSCOPED`), a repeated target and an uneven batch are refused; NULL in the target
  collides with nothing; memory judges the whole batch first; past `MAX_BIND_PARAMETERS` it is several
  statements in ONE transaction (`bulk-write-send.ts`). **`db.*.upsertAll` and `seed.upsert`
  overwrite what the caller NAMED** (`overwrittenBy`). Full rule: `docs/history/entity.md`.

## Seeds

- **A seed is replayable**: `SeedContext.insert` is one `upsertAll(…, { onMatch: 'nothing' })` per
  call; a generated PK the row does not name is refused; `upsert` reads with `includeDeleted` and
  SKIPS a soft-deleted match. **A dry run is the real run rolled back**
  (`Driver.transactor()`, REQUIRED). Full rule: `docs/history/entity.md`.

## Records

- **An entity row on the client is a RECORD, derived** (`row-schema.ts`, `ENTITY_BRAND` =
  `Symbol.for('ultimate.entity')` on the NODE, re-branded by the five copying methods; a partial row is
  never a record — `rows-of.test.ts`). `rowsOf` answers type → record key → row (null-prototype).
  `persist` defaults `false`, read only off the projection. **The browser path is
  `@ultimat3/entity/record`**, whose modules import `entity-error.ts`, never `errors.ts`
  (`record-bundle.test.ts`).

## Sealed `$parse`

- **A sealed column's `$parse` passes a sealed string and judges a plaintext**; `decodeRow` parses
  none. `sealValue` runs the UNWRAPPED plaintext parser (`$meta.sealed.plaintext`) BEFORE sealing — nothing
  after can, and the column's own `$parse` would pass a sealed-shaped lookalike.

## Seal purpose and description

- **Purpose is `entity:<table>.<column>`, physical names** (`sealed.ts`). **Sealing is not on
  `$describe()`**: it changes no DDL, so it must not move the drift hash — the manifest and
  `x doctor` read `sealedFields(entity)`. Only `check`/`length` leave the description.

## Sealed predicates

- **Opaque: NULL tests only. `lookup`: also `eq` / `in`, `.unique()`, an unordered index.**
  Refused at the type (`SealedKeysOf<C>` on `ReadBuilder`, `type-pins.ts`) AND at runtime
  (`X_ENTITY_SEALED_PREDICATE`). A filtered write's FILTER refuses both kinds. Declaration rules
  are `sealed-column.ts` (the chain) and `sealed-declaration.ts` (the entity).
