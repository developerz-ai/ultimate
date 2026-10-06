# @ultimat3/db — agent notes

Tier 1 — it imports `@ultimat3/core` and nothing else. That placement is load-bearing:
`@ultimat3/entity` (tier 2) owns the Postgres driver and reaches down to this package for it.
**Never** import `entity`, `jobs`, `http` or anything higher — entity snapshots arrive as a parameter
(`EntityDescriptionLike`), never as an import.

| Rule | |
|---|---|
| Deps | none. `@electric-sql/pglite` is an **optional peer**, imported by variable specifier inside `loadPgliteDriver()`. **No ORM** — `entity`'s hand-written `postgresDriver()` is the production backing |
| SQL | `sql` binds `$n`; anything non-scalar and non-fragment throws `X_SQL_UNSAFE` |
| A name reaching a `fix:` | `shellInertIdentifier()` (`sql.ts`), the ONE screen (`identifier()` accepts a backtick and `$`). A refused name is left OUT of the command, never escaped into it. `migration-errors.ts` (which `sql.ts` imports from) screens through core's `renderFixShellArg` instead |
| Escape hatches | `raw()`, `identifier()`, `literal()` — each call is an audit point. `literal()` is the tree's ONE SQL-string-literal escape (`scripts/sql-literal-copies.ts`, pinned at zero); it emits `E'…'` only when the value carries a backslash |
| SQLSTATE | one reader, `sqlState()` (`sqlstate.ts`). Never read `error.code` for a SQLSTATE |
| Reading a caught value | `renderThrowable()` from core (`checkDb` backs `/readyz`) |
| Errors | subclass `DbError`; never `throw new Error` in source. A test simulating a database failure throws `dbUnavailable()`; one simulating the caller's body failing throws a bare `Error` on purpose |
| New code | `bun run new-error-code <CODE> --package db --title '…' --fix '…'` writes `DB_OWNED_ERROR_CODES`, `DB_ERROR_TITLES` and the wiki row together; then add it to `errors.test.ts`'s pinned list. The constructor lives where its imports allow (`migration-errors.ts`, `invariant-errors.ts`, `drift-errors.ts`, `dump-drift.ts`); `src/index.ts` re-exports all |
| A value ambient across an `await` | `asyncContext<T>(subject)` from core — never `new AsyncLocalStorage`. Three scopes: `transaction.ts`, `attribution.ts`, `expected-loop.ts` |
| Exports | explicit in `src/index.ts`; no `export *` |
| Files | < 200 LOC (the `packages/db/src/**/*.ts` path instruction), one responsibility, `kebab-case.ts`, test beside source |

Pinned public seam — `@ultimat3/auth`, `@ultimat3/entity` and `@ultimat3/jobs` are written against
these exact names: `SqlFragment`, `sql`, `raw`, `identifier`, `join`, `DbClient`, `DbTx`, `db`,
`setDbClient`, `withTransaction`, `currentTx`.

Deliberate cycle (safe): `client.ts ⇄ transaction.ts`, and `pglite.ts → transaction.ts`. `db()`
consults `currentTx()`; `withTransaction` uses `baseClient()`, never `db()`. Keep both sides
`function` declarations.

## Connections and transactions

- **`pglite.ts` is a pool of exactly one**; `reserve()` (`pglite-turns.ts`) serialises `BEGIN`s. Three
  rules: the plain path takes a turn; a statement inside a LIVE transaction on THIS client
  (`liveTxConnection()`, never `currentTx() !== undefined`) skips the queue; a reservation runs direct
  only while its turn is held. `pglite-embedded.test.ts`, `pglite.test.ts`,
  `pglite-two-clients.test.ts`, `pglite-observer.test.ts`.
- **The third rule is both drivers'**: `client.ts`'s pinned handle also runs direct only while held.
  `release()` is idempotent on both; `DbConnection` and `Turn` are `Disposable`.
- **A pin is held by `using`, never a hand-rolled `try/finally`** (`withTransaction`,
  `readOnlyQuery`); `BEGIN` lives inside the guarded scope.
- **`sqlstate.ts`**: `errno` first, `code` second, shape AND provenance (`isState`: `severity` =
  server; `syscall`/numeric `errno` = socket; else needs a digit). `DB_SQLSTATE_CODES` is closed; `driverError()` is its one consumer, `sendOn` its one caller.
- **`DbTx.origin` is the client the scope was opened on**, never the pin (entity's pinned-repository
  check reads it); a nested scope reports the root's.
- **`withTransaction(fn, { retry })` re-runs `fn` only on `40001`/`40P01`**, default 0; each attempt
  its own pin, `BEGIN` and undo list (`runRoot`); a nested `retry` is `X_INVARIANT`. A re-run waits
  (`transaction-backoff.ts`: 10 ms → 500 ms, full jitter; `{ sleep, random }` are seams).
- **Four codes are `retryable`** (`DB_ERROR_RETRY`); terminal ones stay unclassified
  (`errors-retry.test.ts`). Core's `retry()` executor is NOT adopted.
- **`BEGIN` re-derives its isolation level from the closed set** (`isolationMode`; else `X_SQL_UNSAFE`).
- **An aborted transaction is reported** (`X_DB_TRANSACTION_ABORTED`; README "Transactions that end
  badly"): a failure carrying a SQLSTATE marks the root's `abort`, only a successful `ROLLBACK TO`
  clears it (a failed one sets it), and `COMMIT` is then refused unsent. `commit-tag.ts` reads the
  COMMIT tag in BOTH funnels. `COMMIT` rejecting with no SQLSTATE is `X_DB_COMMIT_UNKNOWN`: neither
  list runs. `transaction-errors.ts`; `transaction-options.ts` holds `DbTx`, options, `BEGIN` text.
- **Sibling nested scopes take turns** (`TxState.children`; savepoints are a stack) under a deadline
  (`sibling-turn.ts`, `siblingWaitMs`, `X_DB_SIBLING_SCOPE_TIMEOUT`). A nested
  `isolation`/`readOnly`/`deferrable`/foreign `client` is `X_INVARIANT`.
- **`close()` is BOUNDED by the driver's own `{ timeout }` in SECONDS** (`drainTimeoutMs / 1000`; `0`
  sends none); the verdict is elapsed `performance.now()` (`X_DB_DRAIN_TIMEOUT`). It clears the
  cached driver before awaiting the teardown. `pool-drain{,.live}.test.ts`.
- **`client.listen` is ONE session beside the pool** (`listen.ts`; `Bun.SQL.listen`, PGlite's
  `listen` under a turn), never a reserved pin. `onListening` fires on every re-dial; a channel is
  refused unless it is a plain identifier. `listen.test.ts`, `listen.live.test.ts`.
- `execute()` trusts the command tag only when `> 0`, in both drivers (`rowsOf`, `affectedBy`).
- **`pool-gauge.ts` derives `db_pool_max` / `db_pool_in_use` / `db_pool_waiting` from DEMAND**
  (`Bun.SQL` publishes no occupancy). `client.ts` is the one counter: `run()` from send to settle, a
  pin from ask to release; a statement ON a pin is not counted again. Declared on the first pool.
- **`client.ts` connects, holds the client and the ambient `db()`**, and opens no socket at import;
  `pool-profile.ts`, `connection-url.ts`, `bun-sql.ts`, `pool-reserve.ts`, `db-health.ts` (`checkDb`)
  and `statement-funnel.ts` (`sendOn`/`runOn`) hold the rest.
- **`libpq-options.ts` merges the framework's `options` into the operator's**: the framework wins
  on the names it sets, the operator keeps the rest; emitted for all six roles.
- **`DATABASE_URL`'s scheme is screened at boot** (`POSTGRES_SCHEMES`: `postgres:`, `postgresql:`); the
  received scheme is never echoed (it may be a credential).
- **A JS array bound as a parameter is rendered here** (`array-parameter.ts`, `bound-parameters.ts`,
  called only by `sendOn`) — `Bun.SQL` joins elements with commas. `NULL` bare vs `"NULL"`; quoting by
  content; a `Uint8Array` is BYTEA, in an array too; a ragged nest and an Invalid Date are refused
  (`X_INVARIANT`), ABOVE the driver's `try` in both funnels. `array-parameter.live.test.ts`;
  `packages/cli/src/pg-array.live.test.ts` is the composition test.
- **Every numeric option is screened** through core's `finiteCount` (`replicaClient`'s breaker,
  `migrate`'s `lockWaitMs`, `readonlyQuery`'s `timeoutMs` — only an explicit `0` disables it — the pool
  profile, `reapBranches`' `maxAgeMs`).

## Observation

- **`observe.ts`: one process-wide `StatementObserver`** (`setStatementObserver()`). Guard at the
  call site; one observer, not a list; the seam swallows nothing; `onStatement` is synchronous and
  must not issue SQL. Only `runOn` (`statement-funnel.ts`) and `statement()` (`pglite.ts`) invoke
  it; both observe success and failure, and notify outside the statement's own `try`.
- **`attribution.ts`**: `withStatementAttribution(entity, op, fn)` — guard first (two strings, no
  allocation), a scope not a parameter, innermost pair wins; the funnels stamp it on both settle paths.
  `@ultimat3/entity`'s `postgresRepo` is the one producer.
- **`statement-shape.ts`**: `statementFingerprint(event)` (`entity.op` when attributed, else collapsed
  text) and `statementKind(text)` off `statementVerb(text)`. Read by `x dev`'s ledger and
  `@ultimat3/testing`'s `statements` fixture. It counts nothing.
- **`statement-span.ts`**: `withStatementSpan` wraps the send alone — `db.<verb>`, attribute
  `STATEMENT_ATTRIBUTE` (`@ultimat3/cli`'s `dev-traces.ts` imports it), OTel kind `client`, opened
  only when an observer is installed.
- **`expected-loop.ts` is the ONLY suppression**: `expectedQueryLoop(reason, fn)`, innermost reason,
  blank is `X_INVARIANT`; the funnel stamps `expected`; it suppresses a verdict, never a statement.
  The framework's own loops declare themselves (`migrate()`, `rollback()`, admin's `search.ts`).
- `@ultimat3/jobs` never imports this package; its statements pass the observer only as
  `packages/cli/src/runtime-queue.ts` wraps a real client for its `PgExecutor`, unattributed.

## Migrations

- **The migration lock is polled** (`pg_try_advisory_lock` every `MIGRATION_LOCK_POLL_MS` until
  `MIGRATION_LOCK_WAIT_MS`, then `X_MIGRATE_CONCURRENT`), declared with `expectedQueryLoop`;
  `createRecordingClient` stubs the lock as `locked: true`.
- **`lock_timeout` is the migration's** (`SET LOCAL` inside each migration's transaction, from the
  `migrate` profile's 3 s).
- **The advisory lock is held by one pinned session, and `migrate()`/`rollback()` run every statement
  on it.** `lock: false` reserves nothing and takes no lock; no shipped path passes it
  (`migrate-pin.test.ts`). `migrate.live.test.ts` pins concurrent and failed-midway runs.
- **One send is one statement**: `applyScript` sends `statementsOf(script)` one at a time inside the
  same transaction. **`statement-split.ts` is the only splitter** (a left-to-right scan; `$1` is never a
  `$tag$`; `\` escapes only inside `E''`; comment-only chunks dropped). **`sql-scan.ts` is the one
  lexer** (`noiseAt`, source order; a `$tag$` needs separating from the identifier before it);
  `sql-noise.ts` holds `stripSqlNoise`.
- **`destructive.ts` decides WHAT is destructive**: only `up`, a closed list of four (`drop table`,
  `drop column`, `truncate`, `alter column … type`), decided on blanked text and reported on the
  original; the `-- destructive: true` marker is a top-level line comment (`hasDestructiveMarker`
  walks `sql-scan.ts`). `X_MIGRATION_DESTRUCTIVE` (ship) and `X_MIGRATION_IRREVERSIBLE` (generate) are
  two questions.
- **The ledger audit asks one question** — `auditLedger`'s `foreign` filter is `!known.has(row.id)`;
  the app version lives in the cause.
- **`rollback({ steps })` refuses anything but a positive safe integer**, before the lock
  (`rollbackStepsInvalid`, `X_INVARIANT`).
- **`refuseDependentViews(tx, script)`** (`dependent-view.ts`) runs before each migration's first
  statement: a word scan over `sql-scan.ts` finds retyped columns, one catalog round trip, the pair
  filtered in JS (visible tables only), and `X_MIGRATION_VIEW_DEPENDS` carries the `drop view` /
  `create view` from `pg_get_viewdef` (built through `identifier()` inside a `try`).
- `runningAppVersion()` delegates to core's `appVersion()`.

## Generation (`x db gen`)

- **`generate.ts` reads an index, never re-derives one** — `IndexDescriptionLike` carries columns,
  unique, `where`, `order`, `using`; an index naming no column is `X_INVARIANT`.
- **An index's ACCESS METHOD is carried end to end** (`index-method.ts`): closed at `btree` and `gin`;
  declared is CLOSED, live is OPEN (`indexMethodOf` passes the catalog through; `declaredMethod`
  refuses); absent is `btree` through one function; `snapshotOf` records `using` only when declared;
  `indexMethodSql` re-derives the literal (`X_SQL_UNSAFE` default); a unique or ordered GIN is
  `X_INVARIANT`. `introspect()` reads `pg_am` (`introspect-embedded.test.ts`).
- **`index-plan.ts` walks both directions** (declared first, removed last). `dropRecordedIndex` emits
  `alter table … drop constraint if exists` then `drop index` for a shape a constraint could back
  (`mayBeConstraintBacked`); four names are skipped (primary, moved aside, rebuilt, over a dropped
  column). `index-ddl.ts` writes the statements; `index-removal.live.test.ts`.
- **An entity's INVARIANTS reach the DDL** (`invariant-ddl.ts`): a `check` is a named constraint, a
  `unique` a unique INDEX on the one `declaredIndexes` list, an `assert` nothing; `checks` is recorded
  absent-never-`[]`; the name `<table>_<name>_<check|key>` is re-derived, bounded at 63 bytes and
  validated (`constraintNameUnsafe`). **An `assert` is an unrendered loss when a migration recorded its
  CHECK**: `unrenderedOf(entities, current)` takes the recorded schema (required, nullable) and
  `namesConstraint` matches both spellings.
- **A COLUMN's CHECK is a named constraint too** (`check-ddl.ts`): one list (`declaredChecks` =
  `columnChecks` then `invariantChecks`), named `<table>_<column>_check` (Postgres' own name); an add on
  an existing column is `drop constraint if exists` then `add constraint`; two declarations naming one
  constraint are refused. `checkPlan` takes the `rebuilt` set.
- **A default's VALUE crosses the seam** (`ColumnDefaultLike`, `defaultExpression`); a description
  carrying only `hasDefault` is reported on `GeneratedMigration.unrendered` and a `-- UNRENDERED`
  comment block — never a refusal, never on an empty diff.
- **`literal()` DOES receive caller input** (`column-default.ts`); `E'…'` only with a backslash, so
  every migration on disk stays byte-identical (`generate-default.live.test.ts`, `sql.test.ts`).
  `readonly-role.ts` and `branch.ts` are safe only by their ordering after `identifier()`.
- **A retype moves its dependents aside** (`retype-dependents.ts`): only expressions that MENTION the
  column (partial-index predicates, CHECKs), over-approximated on purpose (`referencesColumn` walks
  `sql-scan.ts`); a plain btree survives. `generate-retype.live.test.ts`. What is moved is put back by
  the ordinary diff (`MovedAside`), never twice. **Foreign keys over a retyped column**
  (`retype-keys.ts`): the retype set is derived once for the whole schema (`retypedColumns`), drops go
  in `preAlters` at the top of `up`, re-adding is `foreignKeyPlan`'s, both `breaksOn` ends are needed
  (`generate-retype-key.live.test.ts`). `sql-type.ts` reads `SQL_TYPES` with `Object.hasOwn`.
- **A generated column** (`generated-column.ts`): the clause right after the type; generated-and-
  defaulted refused; an expression change is `set expression as (…)`; a retype has no `using`; a NOT
  NULL add is one statement; generated → plain is `drop expression`; plain → generated rebuilds
  (`rebuilt`) and moves dependents aside, its own type change does not. `introspect` never reads
  `generation_expression`.
  `generate-generated-{column,rebuild}.live.test.ts`.
- **`REPLICA IDENTITY FULL` is a PARAMETER** (`GenerateOptions.replicaIdentityFull`, from the CLI's
  `db-generate.ts`; `replica-identity.ts`): recorded `true` or absent, as a union; last in `up`; an
  undeclared name skipped; `down` reverts it unless this migration created the table.
- **`appendOnly: true` is a trigger** (`generate-append-only.ts`): one `create or replace` function
  (SQLSTATE `23001`, message leads `X_ENTITY_APPEND_ONLY`) and a fixed-name `ultimate_append_only`
  `before update or delete … for each row`; recorded `true` or absent; no `truncate`. Drift:
  enabled `triggerNames` (`drift-append-only.ts`, `X_APPEND_ONLY_TRIGGER_MISSING`).
- **A foreign key is `alter table … add constraint`**, collected into a bucket merged after every table
  statement (`foreign-key-plan.ts`); **dropping a table has its own bucket emitted BEFORE the table
  statements** (`preDrops`), ordered children-first by `drop-order.ts`, which breaks a two-table cycle
  by dropping one key first. `foreignKeyPlan` walks both directions, drops the name the previous
  snapshot recorded, and rebuilds a key whose `onDelete` moved. **`on delete` reaches the SQL**
  (`onDeleteRule`, `foreign-key.ts`; an unknown rule is `X_INVARIANT`).
- **`entity-shape.ts` holds the `*Like` interfaces** (every later field optional).
- **`snapshot-json.ts` writes a fixed point of Biome** (an array collapses when it fits at `<= 100`
  with its trailing comma); `snapshot-json.test.ts` runs `biome format`.
- **`declaredSchema()` answers the NEWEST migration's snapshot or `undefined`** (`checkDrift`:
  `unknown-schema`; `x db gen`: `X_MIGRATION_SNAPSHOT_MISSING`). Both fixes: restore the sidecar
  (`git checkout --`), else delete the migration's files FIRST, then `x db gen`; both screened.

## Drift and introspection

- **`checkDrift()` is the post-migrate verification** (live catalog vs the ledger just written, asked
  by `@ultimat3/cli`'s `runMigrations`), returned never thrown. The OTHER `X_DB_DRIFT` is the CLI's
  `checkSourceDrift`. Neither grows the other's half.
- `compareTable` compares existence, **nullability** (the DECLARED key's columns excluded) and the
  **primary key** in column order (`changed-primary-key`, fix = one `psql -c` of the pair; `primary-key.ts`
  holds `x db gen`'s arm, its `drop not null`s, its two refusals). The type is not compared.
- **A missing CHECK is drift, compared by NAME**: `TableDescription.checks` (declared: name and
  expression) vs `TableDescription.checkNames` (catalog: `conname` for `contype = 'c'`, always written
  by `introspect()`, `[]` included). Only the declared side is judged; no `changed-check`, ever.
  `drift-check.live.test.ts`.
- `compareTable` judges declared indexes (`missing-index`, `changed-index` over method, column list,
  uniqueness, predicate presence and direction; `asc` normalises to `null`); never the predicate text.
- `compareForeignKeys` matches on where a key points (`foreignKeyTarget`, the one copy) and compares
  `onDelete` through `onDeleteRule` (`changed-foreign-key`; its fix, `changed-column`'s and
  `missing-check`'s are one `psql -c` too — `repair()`, schema-scoped off `public`).
- `introspect()` reads index columns in key order (`indkey`) and a foreign key's two column lists
  together (`unnest(a, b) with ordinality`), pinned by `introspect-embedded.test.ts`.
- **`appTables()`** excludes the whole `x_` namespace for drift; `introspect()` alone excludes
  `x_migrations` by default. **`app-relation.ts`**: `nonAppRelations(client, schema)` — extension
  ownership from `pg_depend` (`deptype = 'e'`) plus views, materialised views and foreign tables —
  merged into `excluded` unconditionally.
- **`unexpectedTable`'s `fix:` never names `x db gen`**: `psql -c '\d "T"'`, commented with the two
  repairs (claim it with `create table if not exists`, or drop it).
- **`dbDrift()` lives in `drift-errors.ts`** (it needs `shellInertIdentifier`) and is the only one —
  `@ultimat3/entity`'s copy is deleted. `errors.ts` registers `DB_ERROR_TITLES` unconditionally.
- `drift-findings.ts` holds every `DriftDifference` constructor and `DriftKind`; `drift.ts` keeps the
  comparisons.

## The schema dump

- **Its own entry: `@ultimat3/db/schema-dump`** (`schema-dump-entry.ts`). The barrel is in every
  role's boot graph and must evaluate none of this family — `schema-dump-entry.test.ts`.
- **Two readings of one catalog, never mixed.** `introspect()` → `SchemaDescription`, the entity
  vocabulary a snapshot is diffed in. `introspectCatalog()` (`catalog.ts`; queries in `catalog-relations.ts` and
  `catalog-objects.ts`; the pure fold in `catalog-fold.ts`) → `CatalogDescription`, Postgres' own `pg_get_*def` text, compared only to
  itself. A catalog spelling on a `SchemaDescription` field is the `checks`/`checkNames` mistake.
- **Sorted in JS** (`byCodeUnit`), never `order by` and never `localeCompare`: collations differ.
- **`renderSchemaDump()` is pure**; `schema-dump-table.ts` spells one table. `quoted()` escapes any
  catalog name — `identifier()` refuses whitespace and `"`, which a migration may have created.
- **`x_` owner → `framework/` twin** (`FRAMEWORK_TABLE_PREFIX`). No list is handed in.
- **What cannot be rendered is named** (`unrenderedRows`, a closed list → `unrendered.sql`; a trigger
  on an unrendered relation is named by the fold). A kind rendered later leaves that list in the
  same diff. Never render a partition as a plain table. `generated` carries `stored`/`virtual`.
- **`loadSchemaDump()`**: one transaction, `check_function_bodies` off, a savepoint per file, and
  only `42P01`/`42883`/`42704` are retried. Its refusal is `X_SCHEMA_DUMP_DRIFT` (`dump-drift.ts`).
- **`object-drift.ts`**: `unexpectedObjects(live, expected)` compares IDENTITY (kind, table, name,
  arguments). The live side is the operator's Postgres, the expected side a PGlite replay.
- **No app path here.** Where the dump lives, which engine replays, and when it is written are
  `@ultimat3/cli`'s (`db-schema-dump.ts`). `schema-load.contract.test.ts` reads the reference app's
  migrations as text and runs on Postgres when `TEST_DATABASE_URL` is set.
- **`pglite-extensions.ts` is the one linker** (`linkPgliteExtensions` → `{ linked, missing }`):
  `contrib/<name>` then the package root; the name is data (read from migration text), screened
  by `pgliteExtensionExport` before it reaches a specifier; `plpgsql` is built in, never missing.
  Only a not-found import is `missing`; a bundle that throws is `X_DB_UNAVAILABLE`.
- **`pglite-snapshot.ts`**: `snapshotDir` makes a `memory://` boot a restore. Key = PGlite version
  (unreadable = no cache), never the extension set. One file, checksum in its header; unsound or
  unopenable → deleted and rebuilt; unreadable → a miss. Temp name + `rename`. Uncompressed.
- **Embedded boots for dump tests**: `schema-dump.test.ts` and `schema-dump-fidelity.test.ts`.

## Branches, replicas, read-only

- **`reapBranches` sweeps branches of THIS database**: the marker is `ultimate:branch:<base>:<iso>`,
  split on the ISO tail; an older one-segment marker or an unparseable `createdAt` is skipped, never
  dropped. `@ultimat3/cli`'s `ls`/`drop` scope by name prefix.
- **Read replicas are opt-in twice**: a pool when `DATABASE_REPLICA_URL` names one
  (`default-client.ts`), and a read offered only inside `withReplicaReads(fn)` (`replica-scope.ts`);
  read-your-writes is `ReplicaScope.wrote`, never a request-id map. **`withTransaction` is on the
  primary structurally** (`replicatedClient` delegates `reserve()`; `isReservable` answers about the
  database); `runRoot` calls `markScopeWrote()` unless `readOnly`. **`isPlainRead` is an allow-list**,
  never `statementKind()` (`replica-route.test.ts` asserts they disagree). A standby refusal (`25006`)
  re-runs on the primary; the breaker (3 failures, 10 s, `Clock.monotonic()`) parks the replica;
  `ReplicaStats`; `db.replica_fallback`. The URL must name a read-only standby — nothing checks it.
  `@ultimat3/cli`'s boot opens the per-request scope.
- **This package owns no "is this SQL a write?" lexer** — `readonly.ts` and `X_READONLY_VIOLATION`
  are deleted; `errors.test.ts` pins `DB_OWNED_ERROR_CODES`. The layers are `ensureReadOnlyRole()`
  (layer 1, returns `null` on a missing permission) and `readOnlyQuery()` (layer 2: `BEGIN READ ONLY`
  + statement timeout; it THROWS), with `@ultimat3/mcp` as layers 3–4. **`readOnlyQuery` takes ONE
  statement** (`multipleStatements`, via `statementsOf`) and splices the splitter's `statements[0]`.

```bash
bun test                      # from packages/db
bun run typecheck
```

Gotchas:

- `exactOptionalPropertyTypes` — declare optional fields as `x?: T | undefined`.
- `noUncheckedIndexedAccess` — array reads are `T | undefined`; `chunks[i] ?? ''` everywhere.
- Tests use `createRecordingClient()` + `setDbClient()`; no test may need a live database.
- A test that must prove a pin came back uses `reservableOver()` (`fake-reservable.ts`), never a copy.
- `ALTER DEFAULT PRIVILEGES` is scoped to an object's creator, so layer 1 covers future tables only for
  the roles in `creators` (default: the connected user).
- `Bun.SQL` is reached lazily inside `connect()` — importing `client.ts` must not open a socket.

Why each rule above is shaped the way it is: [`docs/history/db.md`](../../docs/history/db.md).
