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
| New code | add to `DB_ERROR_CODES` **and** `DB_ERROR_TITLES` in `errors.ts`, whichever file holds the constructor (`migration-errors.ts`, `invariant-errors.ts`, `drift-errors.ts`); `src/index.ts` re-exports all |
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
  `release()` is idempotent on both; `DbConnection` and `Turn` are `Disposable` (`[Symbol.dispose]` is
  `release()`).
- **A pin is held by `using`, never a hand-rolled `try/finally`** (`withTransaction`,
  `readOnlyQuery`); `BEGIN` lives inside the guarded scope.
- **`sqlstate.ts`**: `errno` first, `code` second, both shape-tested (`^[0-9A-Z]{5}$`).
  `DB_SQLSTATE_CODES` is closed; `driverError()` is its one consumer, `sendOn` its one caller.
- **`DbTx.origin` is the client the scope was opened on**, never the pin (entity's pinned-repository
  check reads it); a nested scope reports the root's.
- **`withTransaction(fn, { retry })` re-runs `fn` only on `40001`/`40P01`**, default 0; each attempt
  its own pin, `BEGIN` and undo list (`runRoot`); a nested `retry` is `X_INVARIANT`. A re-run waits
  (`transaction-backoff.ts`: core's `backoffDelay`, 10 ms → 500 ms, full jitter; `{ sleep, random }`
  are injection seams); nothing waits at retry 0 or after the last attempt.
- **Four codes are classified `retryable`** (`DB_ERROR_RETRY`: `X_DB_SERIALIZATION_FAILURE`,
  `X_DB_LOCK_TIMEOUT`, `X_DB_POOL_EXHAUSTED`, `X_MIGRATE_CONCURRENT`); terminal ones are deliberately
  unclassified (`errors-retry.test.ts` asserts the absence). Core's `retry()` executor is NOT adopted.
- **`BEGIN` re-derives its isolation level from the closed set** (`isolationMode` switch with a `never`
  default; anything else `X_SQL_UNSAFE`).
- Transaction control: `ROLLBACK` / `ROLLBACK TO SAVEPOINT` are best-effort; `SAVEPOINT` and
  `RELEASE SAVEPOINT` are deliberately uncaught.
- **`close()` is BOUNDED by the driver's own `{ timeout }` in SECONDS** (`drainTimeoutMs / 1000`);
  `drainTimeoutMs: 0` sends no option; the verdict is elapsed time on `performance.now()`
  (`X_DB_DRAIN_TIMEOUT`). `pool-drain.test.ts`, `pool-drain.live.test.ts`. `close()` clears the cached
  driver before awaiting the teardown.
- `execute()` trusts the command tag only when `> 0`, in both drivers (`rowsOf`, `affectedBy`).
- **`client.ts` connects, holds the client and the ambient `db()`**, and opens no socket at import;
  `pool-profile.ts`, `connection-url.ts`, `bun-sql.ts`, `pool-reserve.ts`, `db-health.ts` (`checkDb`)
  and `statement-funnel.ts` (`sendOn`/`runOn`) hold the rest.
- **`libpq-options.ts` merges the framework's `options` into the operator's**: the framework wins on
  the names it sets, the operator keeps every other flag; the bound is emitted for all six roles.
- **`DATABASE_URL`'s scheme is screened at boot** (`POSTGRES_SCHEMES`: `postgres:`, `postgresql:`); the
  received scheme is never echoed (it may be a host or a credential). `connection-url.test.ts`.
- **A JS array bound as a parameter is rendered here** (`array-parameter.ts`, `bound-parameters.ts`,
  called only by `sendOn`) — `Bun.SQL` joins elements with commas. `NULL` bare vs `"NULL"`; quoting by
  content; a `Uint8Array` is BYTEA; a ragged nest is refused. `array-parameter.live.test.ts`;
  `packages/cli/src/pg-array.live.test.ts` is the composition test.
- **Every numeric option is screened** through core's `finiteCount` (`replicaClient`'s breaker,
  `migrate`'s `lockWaitMs`, `readonlyQuery`'s `timeoutMs` — only an explicit `0` disables it — the pool
  profile, `reapBranches`' `maxAgeMs`).

## Observation

- **`observe.ts`: one process-wide `StatementObserver`** (`setStatementObserver()` /
  `statementObserver()`). Guard at the call site; one observer, not a list; the seam swallows nothing;
  `onStatement` is synchronous and must not issue SQL. Only `runOn` (`statement-funnel.ts`) and
  `statement()` (`pglite.ts`) invoke it; both observe success and failure, and notify outside the
  statement's own `try`.
- **`attribution.ts`**: `withStatementAttribution(entity, op, fn)` — guard first (two strings, no
  allocation), a scope not a parameter, innermost pair wins; the funnels stamp it on both settle paths.
  `@ultimat3/entity`'s `postgresRepo` is the one producer.
- **`statement-shape.ts`**: `statementFingerprint(event)` (`entity.op` when attributed, else collapsed
  text) and `statementKind(text)` off `statementVerb(text)`. Read by `x dev`'s ledger and
  `@ultimat3/testing`'s `statements` fixture. It counts nothing.
- **`statement-span.ts`**: `withStatementSpan` wraps the send alone — `db.<verb>`, attribute
  `STATEMENT_ATTRIBUTE` (exported; `@ultimat3/cli`'s `dev-traces.ts` imports it), OTel kind `client`,
  opened only when an observer is installed.
- **`expected-loop.ts` is the ONLY suppression**: `expectedQueryLoop(reason, fn)`, innermost reason,
  blank is `X_INVARIANT`; the funnel stamps `expected`; it suppresses a verdict, never a statement. The
  framework's own loops declare themselves (`migrate()`, `rollback()`, `@ultimat3/admin`'s
  `search.ts`).
- `@ultimat3/jobs` never imports this package; its statements pass the observer only because
  `packages/cli/src/dev-queue.ts` wraps a real client for its `PgExecutor`, unattributed.

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
  filtered in JS, and `X_MIGRATION_VIEW_DEPENDS` carries the `drop view` / `create view` from
  `pg_get_viewdef` (built through `identifier()` inside a `try`).
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
  defaulted refused; an expression change is `set expression as (…)`; a retype carries no `using`; a NOT
  NULL add is one statement; generated → plain is `drop expression`; plain → generated rebuilds the
  column (`regenerate` answers `rebuilt`) and moves its dependents aside; a generated column's own type
  change deliberately does not. `introspect` never reads `generation_expression` back.
  `generate-generated-column.live.test.ts`, `generate-generated-rebuild.live.test.ts`.
- **`REPLICA IDENTITY FULL` is emitted by a PARAMETER** (`GenerateOptions.replicaIdentityFull`, passed
  by `@ultimat3/cli`'s `db-generate.ts` from `describeQueries()`' `subscribes:`), in
  `replica-identity.ts`: recorded as `replicaIdentityFull: true` or absent; the snapshot records the
  union; dead last in `up`; never destructive; a name no entity declares is skipped; never reverted;
  `down` is `replica identity default` except on a table this migration creates.
- **A foreign key is `alter table … add constraint`**, collected into a bucket merged after every table
  statement (`foreign-key-plan.ts`); **dropping a table has its own bucket emitted BEFORE the table
  statements** (`preDrops`), ordered children-first by `drop-order.ts`, which breaks a two-table cycle
  by dropping one key first. `foreignKeyPlan` walks both directions, drops the name the previous
  snapshot recorded, and rebuilds a key whose `onDelete` moved. **`on delete` reaches the SQL**
  (`onDeleteRule`, `foreign-key.ts`; an unknown rule is `X_INVARIANT`).
- **`entity-shape.ts` holds the three `*Like` interfaces** (optional `onDelete` / `generated`).
- **`snapshot-json.ts` writes bytes that are a fixed point of Biome** (arrays collapse when they fit at
  `<= 100` counting the trailing comma); `snapshot-json.test.ts` runs the repo's own `biome format`.
- **`declaredSchema()` answers the NEWEST migration's snapshot or `undefined`**; `checkDrift` turns
  that into `unknown-schema`, and `x db gen` refuses with `X_MIGRATION_SNAPSHOT_MISSING`. Both lead with
  the same two remedies in the same order: restore the sidecar (`git checkout --`), or delete the
  migration's files FIRST and only then run `x db gen`. `snapshotSiblings` / `migrationNameOf` build
  the second command from the caller's path; both commands are screened (`unknownSchema` through
  `shellInertIdentifier`, `migrationSnapshotMissing` through `renderFixShellArg`), degrading the whole
  line to prose.

## Drift and introspection

- **`checkDrift()` is the post-migrate verification** (live catalog vs the ledger just written, asked
  by `@ultimat3/cli`'s `runMigrations`), returned never thrown. The OTHER `X_DB_DRIFT` is the CLI's
  `checkSourceDrift`. Neither grows the other's half.
- `compareTable` compares existence and **nullability** (primary-key columns excluded by the union of
  both sides' keys); the type is not compared. The `fix:` is the `alter table … set not null` itself.
- **A missing CHECK is drift, compared by NAME**: `TableDescription.checks` (declared: name and
  expression) vs `TableDescription.checkNames` (catalog: `conname` for `contype = 'c'`, always written
  by `introspect()`, `[]` included). Only the declared side is judged; no `changed-check`, ever.
  `drift-check.live.test.ts`.
- `compareTable` judges declared indexes (`missing-index`, `changed-index` over method, column list,
  uniqueness, predicate presence and direction; `asc` normalises to `null`); never the predicate text.
- `compareForeignKeys` matches on where a key points (`foreignKeyTarget`, the one copy) and compares
  `onDelete` through `onDeleteRule` (`changed-foreign-key`, fix = drop/add pair).
- `introspect()` reads index columns in key order (`indkey`) and a foreign key's two column lists
  together (`unnest(a, b) with ordinality`), pinned by `introspect-embedded.test.ts`.
- **`appTables()`** excludes the whole `x_` namespace for drift; `introspect()` alone excludes
  `x_migrations` by default. **`app-relation.ts`**: `nonAppRelations(client, schema)` — extension
  ownership from `pg_depend` (`deptype = 'e'`) plus views, materialised views and foreign tables —
  merged into `excluded` unconditionally.
- **`unexpectedTable`'s `fix:` never names `x db gen`**: a `create table if not exists` in a migration
  (accepted by `@ultimat3/cli`'s `acceptCreatedTables`) or dropping a table nothing owns.
- **`dbDrift()` lives in `drift-errors.ts`** (it needs `shellInertIdentifier`); the `X_DB_DRIFT`
  rendering and title are duplicated in `@ultimat3/entity`, held equal by
  `packages/entity/src/errors.test.ts`. `errors.ts` registers `DB_ERROR_TITLES` unconditionally.
- `drift-findings.ts` holds every `DriftDifference` constructor and `DriftKind`; `drift.ts` keeps the
  comparisons.

## Branches, replicas, read-only

- **`reapBranches` sweeps branches of THIS database**: the marker is `ultimate:branch:<base>:<iso>`
  (`BranchInfo.base`), split on the ISO tail; an older one-segment marker is skipped, never dropped; an
  unparseable `createdAt` is skipped. `@ultimat3/cli`'s `ls`/`drop` scope by name prefix.
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
