# @ultimat3/entity

Columns + invariants; the row type is derived from the columns. Tier 2.

## Boundary

- May import `@ultimat3/core`, `@ultimat3/schema` and `@ultimat3/db`. Nothing else — `http`,
  `policy` and `auth` are the same tier.
- `db` is tier 1 (it imports only `core`), which is what lets the Postgres driver live **here**
  rather than in a tier-3 package: `Driver` and its production implementation stay in one place.
  See [`docs/architecture/01-package-map.md`](../../docs/architecture/01-package-map.md).
- No `drizzle-orm` dependency, and none is the production backing — `postgresDriver()`
  (`pg-driver.ts`/`pg-sql.ts`) is a hand-written SQL driver. `types.ts` declares the narrow
  structural column vocabulary this package consumes so the generated SQL stays readable and
  an agent can self-correct against it.

## Do not regress

- **Two drivers, one meaning.** `memoryDriver()` and `postgresDriver()` share `plan.ts` (scope,
  sort order, page size), `cursor.ts` (one codec, values included) and the `Repo` contract, so a
  test that passes against memory says something about Postgres. A guard, an operator or a sort
  rule added to one and not the other is the bug this split exists to prevent — `pg-driver.test.ts`
  pins the parity, and every bulk method added since carries the same two files: a
  `*-parity.test.ts` seeding identical rows into both drivers and asserting identical output
  (`batch-parity.test.ts`, `preload-parity.test.ts`, `count-by-parity.test.ts`, and the
  `insertAll`/`upsertAll` cross-driver assertions inside `pg-driver-bulk.test.ts`), and a
  `pg-driver-<feature>.live.test.ts` proving the same call against a real server
  (`pg-driver-batch.live.test.ts`, `pg-driver-preload.live.test.ts`, `pg-driver-count.live.test.ts`,
  `pg-driver-bulk.live.test.ts`). A method with only the first is unproven against Postgres itself;
  a method with only the second is unproven against memory. Both are the bar, not either one.
- **The Postgres driver is proved against a real Postgres, not only against a recording client.**
  `pg-driver.live.test.ts` runs the whole chain — `entity()` -> `$describe()` ->
  `generateMigration()` -> a live server -> `postgresDriver()` -> decoded row — and skips when no
  `TEST_DATABASE_URL` is set. Asserting statement *text* cannot catch a statement Postgres refuses:
  that is how a `unique()` column shipped a migration failing on `42P07` and money's currency
  shipped as `char(1)`. A new operator, column kind or write path is not done until it round-trips
  there.
- **A point lookup batches itself, and the batch is never wider than the statement it replaces.**
  `findById` called several times in one microtask of one request is one `select … where "id" in
  (…)` — `coalesce.ts`, keyed by ctx identity (a `WeakMap`, so the batch dies with the request, the
  shape `@ultimat3/query`'s request memo has one tier up) and by a scope key covering **every**
  input to the statement except the id. Two tenants, two soft-delete visibilities, two projections,
  two entities or two clients therefore never share one: a coalesced statement has to be one each
  of the singles would have been served by, or a caller is answered with rows their own statement
  could never have returned. It declines rather than guesses — no request in scope, a composite
  key, a predicate value it cannot render — and declining is just the statement `findById` always
  sent, which is why `findById` keeps its signature and there is no `batch()` to opt into. The
  window closes before the statement goes out, so a lookup arriving mid-flight opens the next batch
  instead of joining ids already on the wire, and past `MAX_IDS_PER_STATEMENT` a batch becomes
  several whole statements rather than one Postgres refuses for its bind count. A sequential
  `for … of` loop shares no microtask — its `await` ends the window — which is what the sibling
  preload below is for.
- **A page batches the loop it causes, and a preloaded row is only ever served to the statement
  that read it.** `findMany` leaves its page's foreign key *values* behind (`jit-preload.ts`,
  `tagSiblings`), so the first `findById` for any one of them resolves that key for every row of
  the page in one `in` statement and the rest of a `for … of` loop is memory. Five rules, none
  optional. **The scope guard is a security boundary**: a preloaded row is served only under the
  *same* `scopeKey` the coalescer uses — same tenant predicate, same soft-delete visibility, same
  projection, same entity — and the preload statement is that scope widened to the page's ids, so
  a page read under one tenant can never resolve another tenant's rows, whichever tenant asks.
  **Same client, or nothing**: a bucket filled through the ambient pool is not read through a
  pinned one, which is also what stops a row read inside a transaction being served after it —
  `db()` hands back a different client once the transaction is over, rolled back or not.
  **A write drops it**: `postgresRepo`'s `writing()` is the one place every write goes out, and it
  calls `forgetPreloaded(entity.$name)` *before* the statement, so a row a request changed is
  re-read and never served from a page read before it. **Values, not rows**: the index is keyed by
  id and holds ids, so a page early in a long request pins its keys and not its rows, and it dies
  with the request like every other per-ctx store here. **Declining is the old behaviour**: no
  request in scope, an id no page indexed, a key that resolved to nothing — the caller reads the
  statement it always read. `MAX_IDS_PER_STATEMENT` bounds the preload exactly as it bounds a
  batch. What both share — the scope key, `keyOf`, the one `in` statement — lives in
  `batch-read.ts` so the two can never disagree about when a shared statement is legal.
  **One switch, where the driver is built**: `postgresDriver({ jitPreload: false })` /
  `postgresRepo(entity, { jitPreload: false })` turns the tagging off. Never an `app.config.ts`
  key — nothing reads config at the seam that builds a repository, so a `database.jitPreload`
  field would be a switch the framework cannot read, which is a switch that does nothing.
- **`preload(name)` shares `batch-read.ts` with the coalescer and the JIT preload above, but
  keeps no request-scoped cache of its own.** `keyOf`, `MAX_IDS_PER_STATEMENT` and
  `statementChunks` come from the same file, so a bind-count bound and a key's identity can
  never disagree across the three — but `preload()` reads its scope straight off the chain's
  own `where` and issues its statement every call; nothing here declines to an old statement
  the way the coalescer or the JIT preload can, because there is no old statement to decline
  to — a chain that calls `preload('author')` always gets the extra statement. **Tenancy is
  carried, never inferred, and that is a security boundary, not a convenience**:
  `tenantScope()` carries the page's own tenant predicate onto the related read only when
  **both** entities are scoped by a column of that same name — a value that scopes one entity
  is a guess on another, and serving a guessed scope is a cross-tenant read. Both ends are
  checked, never the target's alone: a source scoped by `workspaceId` may still carry an
  ordinary `orgId` predicate of its own, and matching on the target's column name would lift
  that filter into the target's tenant scope and attach rows from a tenant nobody proved this
  reader owns. A differently-named column carries nothing, on purpose, so the related read
  builds an unscoped plan of its own and `assertScoped` refuses it as `X_TENANCY_UNSCOPED`
  rather than let it pass. **Reach is the same `database()` set the two bullets above already answer
  to**: `RelatedTables` is the resolver `database()` hands every table it builds, an
  entity-name → `{ entity, repo }` map closed over the same call, so `preload('author')`
  resolves `author` only when that call named the entity the relation points at — outside it
  is `X_INVARIANT_VIOLATED`, never a reach around the handle. `tableFor(entity, repo)` built
  by hand takes no `related` resolver, so the identical call fails the identical way with
  `related` itself `undefined`. **A projection cannot drop what a preload needs**:
  `select()` widens its own field list with each preloaded relation's local key, so
  `plan().select` — the projection that actually runs — always carries it, though the row
  type the caller sees still names only what they picked. **Attachment copies, never
  mutates**: a preloaded relation is written onto `{ ...row }`, because the in-memory driver
  hands back the row it stores and attaching directly would leak the relation into the table
  itself. **Preloading terminals only**: `page()`, `all()` and `one()` resolve every named
  relation; `count()`, `countBy()` and `plan()` do not, since none reads a row to attach one to.
- **Every repository method attributes the statement it sends, and each op is named exactly
  once.** `postgresRepo`'s `attributed(op, send)` wraps `findById`, `findMany`, `insert`,
  `insertAll`, `upsertAll`, `update`, `delete`, `deleteWhere`, `updateWhere`, `count` and
  `countBy` — every method, not a subset — through `@ultimat3/db`'s
  `withStatementAttribution(entity.$name, op, send)`. Each method declares `const op = 'findById'`
  (or its own name) once, and that same local is what everything else downstream of it gets too:
  the plan builder (`idPlan(entity, id, options, op)`, `readPlan(entity, args, op)`,
  `deletePlan`/`updatePlan`), and in `countBy`, `groupColumnOf` and `countsFrom` besides — so the
  operation a refusal names and the operation a diagnostic reports can never drift apart, one
  string read as many times as a method needs it and never retyped by hand a second time. The
  three insert paths do not call `attributed` themselves: `writeRows(op, batch, conflict)` does,
  once, because a batch wide enough to split (past `MAX_BIND_PARAMETERS`) is several statements
  sent inside its own loop and every one of them belongs to the call that asked for it — `op` is
  therefore `writeRows`'s own parameter, passed as the literal `'insert'`, `'insertAll'` or
  `'upsertAll'` by each of the three callers, never a constant closed over the helper. **The scope
  is never entered with no observer installed** — `withStatementAttribution` reads
  `statementObserver()` first, so an app running with no diagnostic pays the one property read and
  one branch every other statement on this path already pays, and nothing more (axiom 6). **A
  preloaded relation is attributed to the related entity and its own operation, never to the read
  that triggered it** — `preload()`'s related read (`preloaded()` in `preload.ts`) calls
  `target.repo.findMany(...)`, the related entity's own `postgresRepo`, so a `posts` page's
  preloaded author carries `{ members, findMany }`, never `{ posts, findMany }` borrowed from the
  page: it is a full call through that entity's own repo, not a fact copied across. **`findById`'s
  coalesced flush carries its opener's pair without anyone threading it there** — `coalesce.ts`'s
  `queueMicrotask` inside `openBatch` is scheduled synchronously while `coalesceFindById` is still
  running inside `attributed('findById', …)`'s scope, so the statement the flush eventually sends
  on behalf of every lookup that shared the microtask is attributed exactly as each of them would
  have been alone. **This is the one rule the two drivers do not share**, and not a drift:
  `memoryRepo` sends no statement, so there is nothing for a pair to name — the parity bar
  (`*-parity.test.ts`) applies to what a call *answers*, and attribution changes no answer.
  `pg-driver-attribution.test.ts` is the pin: a client that reads `statementAttribution()` at send
  time, one case per method — a twelfth method added without `attributed` is a failing test, not a
  review comment — plus the coalesced flush, the sibling preload, a relation's own read, a chunked
  batch's every statement, hand-written SQL (no pair), a refusal (no statement) and the
  no-observer-installed branch.
- **The two N+1 codes are owned here, and their `fix` is a call the schema already answers.**
  `X_N_PLUS_ONE_QUERY` and `X_N_PLUS_ONE_WRITE` live in this package rather than in the process
  that detects them, because the fix speaks this package's vocabulary — `preload`, `insertAll`,
  `updateWhere` — and a code owned by the CLI would put the one sentence an author acts on in a
  package the entity layer cannot see. **Detection is somebody else's**: `n-plus-one.ts` counts
  nothing, holds no threshold and installs no observer; it takes a verdict (`StatementLoop`) and
  returns the error. **The relation is derived, never invented** — `preloadsFor()` reads the same
  `relationMap()` `preload()` resolves against, so the pasted line compiles; the operation picks
  the side (`findById` → `belongsTo`, `findMany` → `hasMany`), and anything else takes the `in`
  form rather than a relation that would attach the wrong rows. **Edges are read by their `to`
  end**, because the loop repeated on the entity being looked up and the ledger never saw the
  `for … of` above it — so every page that could preload it is named, first one pasteable and the
  rest after it, exactly as `preloadUnknownRelation` spells its names. **A schema whose relations
  cannot be named still reports the loop**: `relationMap()` throws `X_INVARIANT_VIOLATED` on two
  keys it cannot tell apart, and a diagnostic that let that escape would replace the N+1 with a
  schema complaint the loop did not cause — in a dev process, as an uncaught throw — so the
  derivation falls back to the `in` form. **`expectedQueryLoop` is the only way to declare a loop
  deliberate**, and it silences the count upstream; there is no flag on these errors and no fix
  that turns the warning off.
- **Cursor pagination only.** OFFSET is wrong under concurrent writes: an insert before the
  offset shifts every later page, so a client silently skips and repeats rows. No `offset` on
  `FindManyArgs` or the builder; the primary key is always the last sort key, so the order is
  total. The cursor carries the sort **values**, not just an id — seeking by an id that was
  deleted between two requests would restart pagination at the top.
- **`inBatches(size)` is that same page in a loop, and the loop owns it.** `batch.ts` holds no
  driver of its own: a batch is the `findMany` the chain would have sent at that position, so
  filters, tenancy, soft delete, the projection and every `preload()` mean there what they mean in
  `page()` and there is no second read path to drift. Properties, none optional. **The handle is
  the iteration**: it is its own iterator, so `break`, `return`, a throw and `await using` all stop
  the *next* statement — `close()` is `AsyncGenerator.return()` and therefore idempotent by
  construction, never a flag two paths could disagree about — and a second `for await` continues it
  instead of re-reading the table from the top. **The position is readable**: `.cursor` is where
  the next batch starts, advanced *before* the yield, so a consumer that breaks reads the position
  it stopped at and `.after(cursor).inBatches(size)` resumes it; stopping early is then cheap
  rather than wasted. **An empty batch is never yielded** — a consumer forced to check
  `batch.length` is reading around the iterator. **Three refusals, all on the chain**: a size that
  is not a whole number of rows ≥ 1, a chain that also called `limit()` (one number, two meanings —
  honouring it reads a fraction of a batch, dropping it reads the whole table the caller thought
  they had bounded), and an ordering no cursor can carry. That last one is why
  `totalOrder(entity, orderBy)` is exported from `plan.ts` rather than inlined in `planFor`: the
  guard has to judge the order the driver will *send*, primary key included, and a result that fits
  in one batch mints no cursor — so a nullable sort key would otherwise pass in every test and fail
  once the table grew. `State.limit` is `number | undefined` for the same reason: only "the caller
  named a page size" can be told apart from the default, which the driver already applies.
- **A grouped count means one thing in both drivers, and `count-by.ts` is where that one thing is
  written.** `countBy(column)` is the aggregate a `count()` per row is the N+1 of, so both drivers
  call `groupColumnOf` before their statement exists and `countsFrom` after their rows are in — a
  rule added to `pg-driver.ts` or to `repo.ts` alone is exactly the drift that file exists to
  prevent. **Groupable kinds are a closed set**: `uuid`, `text`, `char`, `boolean`, `integer`,
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
- **The codec is `@ultimat3/core`'s, and both drivers reach it through exactly two functions**:
  `cursorFor(entity, plan, row, id)` and `seekFrom(entity, plan)` in `cursor.ts`. Both call
  `assertSeekable`, so an ordering that cannot carry a position — a nullable key, an undeclared
  column, a money property named without `.minor`/`.currency` — is refused when the cursor is
  *minted*, not one page later where the page size decides whether anyone finds out. This package owns only
  what a cursor is *bound* to — `planScope(plan)`: the entity, its filters and its sort order,
  hashed. Not the page size (a bigger next page is the same query) and not `select` (a projection
  cannot move a row). A cursor that fails either the signature or the scope is `X_CURSOR_INVALID`;
  it must never decode to "start from the top", which is what the old codec's `null` did.
- **A relation is a foreign key read a second way, never a second declaration.** `relations.ts`
  derives `belongsTo` from an entity's own `references()` columns and `hasMany` from the inbound
  ones; there is no `hasMany: […]` init key and adding one would put two declarations of one fact
  in the schema. A thunk is resolved in exactly one place — `referenceBinding()` in `column.ts` —
  so the DDL projection (`describe.ts`) and the relation map can never disagree about what a
  `references()` points at. Naming is order-independent by construction: when two keys want one
  name, **every** member of that group takes its long form, so declaring a second foreign key
  never renames the first relation behind a caller's back. What the two tiers cannot separate is
  refused with `X_INVARIANT_VIOLATED` naming both columns — never collapsed into one relation.
- **Relations reach query time through `RegistryEntry.references()`, and the DDL string is
  rendered from it.** The resolved records are the source; `ColumnDescription.references` spells
  `"<table>.<column>"` out of one for the migration generator, which is in tier 1 and cannot
  import this package. Never parse that string back — it carries physical names and a traversal
  reads row *properties*, so the parse would be a second, lossy resolver. `references()` is a
  method, not a field: a thunk may point at an entity two modules of an import cycle have not
  finished evaluating. `relationMap()` memoises the whole-registry derivation against
  `registryGeneration()`, which every registration bumps — a schema module imported late must
  rebuild the map, never be missed by it. The derivation is **one pass** over the foreign keys,
  filed under both ends as it goes — a rescan per entity is the schema squared, paid again after
  every late registration. `relationNamed()` refuses an unknown name with
  `X_PRELOAD_UNKNOWN_RELATION` whose `fix` is a `relationNamed()` call on a relation that does
  exist, the rest by name after it; a relation is derived, so there is no file a reader could open
  to find them. An entity with no foreign key at all gets `x entities list --json` instead — the
  declaration it needs names a target this error cannot know.
- **A repository call rejects, never throws synchronously** — `tableFor`'s writes are `async` for
  that reason alone: `$parse` throws, and a call site should not need two error paths for one
  mistake.
- **Tenancy applies to writes too.** `update(id, patch)`, `delete(id)`, `deleteWhere(filter)` and
  `updateWhere(filter, patch)` build the same plan a read does, so an id or a filter alone never
  addresses a row on a tenant-scoped entity. Another tenant's id reads as `X_NOT_FOUND`, never as
  their row.
- **`deleteWhere(filter)` and `updateWhere(filter, patch)` are the only filtered writes, and they
  are bounded by construction.** `delete(id)` and `update(id, patch)` need a single-column primary
  key, so on a composite key — `likes`, `blocks`, `participants`, any join table — the filtered
  pair is the only write path that exists; without them the entity is create-only and a row can be
  written and never unwritten. They are also the bulk forms of `delete`/`update` for the ordinary
  case — one statement for a `for … of` loop that would otherwise delete or patch one row at a
  time — the same role `insertAll`/`upsertAll` (below) play for a per-row insert loop; a
  write-loop detector's `fix:` names one of these four, never a hand-rolled loop. Properties, none
  of them optional:
  - an empty filter is `X_WRITE_UNFILTERED` and never every row; an empty patch is `X_PATCH_EMPTY`
    and never a counted no-op. An `undefined` value is dropped *before* either count, so a
    forgotten variable lands on the error rather than on the table.
  - **one code for both verbs**, because it is one situation with one remedy. Splitting it into
    `X_DELETE_UNFILTERED`/`X_UPDATE_UNFILTERED` would give two codes the same `fix` and make a
    caller choose which to catch. The situations that genuinely differ — no filter, no patch —
    are what get separate codes.
  - the filter guard runs before tenancy is applied, because one tenant's every row is still
    every row.
  - soft delete follows the entity's `deletedAt` column exactly as `delete(id)` does: stamped rows
    are not matched twice, and `updateWhere` carries the same `deleted_at is null` clause
    `update(id, patch)` does, so a deleted row is never patched back into shape.
  - both return a count, never `void`: a filtered write that silently matches nothing is
    indistinguishable from one that worked.
- **`touch()` in `query.ts` is the ONE place `onUpdateNow()` columns are stamped**, for
  `update(id, patch)` and `updateWhere(filter, patch)` alike — a second copy is how one of them
  ends up writing a stale `updatedAt`. It returns an empty patch untouched, so whether
  `X_PATCH_EMPTY` fires depends on the call and not on whether the entity happens to declare the
  column.
- **A many-row write is one statement, and every refusal it needs happens before that statement
  exists.** `insertStatement` (`pg-sql.ts`) builds *every* insert in the framework — one row or ten
  thousand — so `insertAll([row])` compiles to exactly the text `insert(row)` always compiled to
  and there is no second builder for the two to drift apart in. What both drivers have to agree on
  lives in `bulk-write.ts`, decided in **property** space and projected to physical columns for the
  SQL: the column list a batch writes (`Object.hasOwn`, exactly as `bindValues` decides it), what a
  collision overwrites, the conflict key, and the chunking. Rules, none optional. **A collision
  overwrites every column in the batch except three closed sets** — the conflict target, which is
  how the stored row was found, the primary key, which is where it lives, and the soft-delete
  stamp, which is whether the row is there at all; an upsert that moved either of the first two
  would move a row nobody asked to move and every foreign key already pointing at that id would
  miss it. **The stamp is the third because a soft-deleted row still occupies its conflict target**
  — the index it collides with is not partial — so `excluded."deleted_at"` would clear a delete the
  app made and hand the row back holding the batch's values, which is the resurrection
  `update(id, patch)` and `updateWhere` refuse by carrying `deleted_at is null` and an
  `on conflict` clause cannot carry. Excluded from the set list rather than refused, because
  `$parse` fills every declared column before a row reaches `upsertPlan`: that `deletedAt: null` is
  the framework's and not the caller's, so refusing it would make `onMatch: 'update'` impossible on
  every soft-deleting entity. `insertAll` is untouched — a row colliding with nothing writes the
  stamp it carries, exactly as `insert` does. **The conflict target must be a declared unique
  constraint** — because a target
  Postgres cannot infer an index for is `42P10` wrapped as `X_DB_UNAVAILABLE`, which names nothing
  the author can act on. All **three** of this framework's spellings of one count, or the refusal
  would tell an author to declare a constraint they already declared and ship two indexes: the
  primary key, a non-partial `unique: true` entry in `$indexes` (`unique()` on a column and
  `indexes:` both land there), and a `kind: 'unique'` entry in `$invariants`
  (`invariant(name, c.unique([…]))`, whose `CREATE UNIQUE INDEX` never touches `$indexes`). A
  partial one is deliberately not a target on either list, since its predicate would have to be
  repeated in the `on conflict` clause and this layer does not spell one — which is also why a
  soft-deleting entity's `c.unique()` invariant, stamped `deleted_at is null` by `bindInvariant`,
  is excluded by that same rule. **The tenant column is part of that
  constraint or `onMatch: 'update'` is refused** (`X_TENANCY_UNSCOPED`) — this is a security
  boundary, not ergonomics: `upsertAll` builds no read plan, so nothing else puts an org predicate
  in the statement, and a target that omits the tenant column matches a row stored by another tenant
  and rewrites it, tenant column included. `'nothing'` stays legal on such a target because it
  writes nothing to a row it does not own. **A batch that repeats one conflict target is refused
  under `'update'`** — Postgres answers that statement `ON CONFLICT DO UPDATE command cannot affect
  row a second time`, so passing it in memory and failing in production is the exact drift the two
  drivers exist to prevent — and **an uneven batch is refused under `'update'`** for the same
  reason: `excluded.<column>` for a row that omitted it is that column's *default*, not the stored
  value, so "leave it alone" is not what happens. `insertAll` and `'nothing'` accept an uneven batch
  and render `default` in the missing cell, which is what the same row means on its own.
  **Null is not a value here**: a null anywhere in the conflict target means the row collides with
  nothing, in both drivers, because a Postgres unique index is `NULLS DISTINCT`. **The memory
  driver judges the whole batch before storing any of it** — `$assert` over every row first — since
  Postgres refuses the statement as one and a half-applied batch would make the two disagree about
  what one call did. Past `MAX_BIND_PARAMETERS` (65535) the batch is several whole statements, so
  atomicity across them is `withTransaction`'s and never one statement's.
- **Nothing is interpolated into SQL.** `pg-sql.ts` binds every value through `sql` and resolves
  every identifier through the entity, so a column name can only be one the entity declared.
  `raw()` appears exactly three times, for `asc|desc`, the seek operator and the `default` cell of a
  many-row `values` list — each a closed set of one word.
- **Money is `bigint` minor units + `char(3)` currency.** A float throws. Never one column,
  never an implied single currency.
- **Timestamps are `timestamptz`.** A naive timestamp must stay inexpressible.
- **A tenant column means every query needs an org predicate** — runtime guard, not convention.
  Missing ⇒ `X_TENANCY_UNSCOPED`. `tenant: 'orgId'` declares it; omitted, inference still applies
  (`.tenant()`, else a column named `orgId`), so silence never means unscoped. Never make the
  declaration the only switch.
- **Every framework member on an entity is `$`-prefixed** — the columns are `Object.assign`ed onto
  the core, so an unprefixed member would make `view`, `name` or `tenant` an illegal column name.
  `$view`, never `view`; no free `view(entity, keys)` either — one way to write a projection.
- **Invariants run twice**: in the app on write AND as a Postgres CHECK/UNIQUE via `toSql()`. An
  untranslatable JS predicate reports `kind: 'assert'`, `sql: null` — never a pretend CHECK.
- **`invariants` is ONE callback, and `InvariantColumns<C>` is a mapped type.** `invariants: (c) =>
  [invariant(name, expr)]`, never an array of `(c) => …` builders: a per-element builder is a call
  TypeScript checks before `entity()`'s `C` is fixed, so `C` fell back to its constraint and `c`
  stayed open-keyed. Open-keyed means an index signature, and under `noUncheckedIndexedAccess` that
  made every `c.title` a `ColumnExpr | undefined` — every generated entity red until the author
  added `!`. The Proxy in `invariantColumns()` stays regardless: a JS caller and a dynamically
  built rule never see the compile error, and its message names the columns that do exist.
- **`Invariant<T>.holds` is a method, never `readonly holds: (row: T) => boolean`.** A
  function-typed property is contravariant, so `Invariant<Post>` stopped being assignable to
  `Invariant<unknown>`, `Entity<Post, C>` stopped satisfying `EntityCore`, and every
  `database({ … })` degraded to `Table<unknown>` — one position, 36 cascading errors downstream.
- **A branded id survives to the signature, or it does not exist.** `uuid<PostId>()` declares the
  brand once; the derivation (`TypeOf`/`RowOf`/`Insertable`) always carried it, but the BUILDER
  hard-coded `Column<string>` so there was nothing to carry, and `Repo`/`Table` then took
  `id: string`, which erased the rest — two entities' ids were mutually assignable and
  `posts.update(someUserId, …)` compiled into a query that matched nothing. Both halves are
  pinned: fixing either alone leaves that call legal. Id parameters are `IdOf<Row>`, which is
  `string` for every unbranded row and every composite key, so this is additive.
- **`type-pins.ts` is where all of those are enforced.** Source, not a test: `tsconfig.json`
  excludes `src/**/*.test.ts`, so `tsc` never reads a test file and a type-level assertion written
  in one can never fail. It emits nothing and exports nothing anybody imports.
- **Row types are derived, never re-declared.** No `as unknown as` to fake the derivation.
- **`src/index.ts` re-exports `t` from `@ultimat3/schema` verbatim**, so an entity file that also
  hand-writes a view schema imports one package. Never wrap, spread or re-declare it: `t` delegates
  to `schemaProvider()` on every access, and a copy would freeze the provider at import time.
  `index.test.ts` asserts identity.
- Never throw a bare `Error` — use `errors.ts`.
- Tests restore the process-global registry in `afterAll` (`clearRegistry()`): a leaked registry
  breaks an unrelated package's tests, as it did in `@ultimat3/policy`.

## Files

| File | Job |
|---|---|
| `types.ts` | `Column`, `RowOf`, `Insertable`, `IdOf` — the type derivation |
| `column.ts` / `columns.ts` | the chain + property-key binding; the blessed builders |
| `expr.ts` / `invariants.ts` | the `invariants: (c) => …` rule language; bind + `toSql()` DDL |
| `entity.ts` / `describe.ts` | `entity()`, `$row`; the `EntityDescription` projection |
| `view.ts` | `$view(keys)` — the row projection an action names as its `output` |
| `query.ts` / `database.ts` | chainable read to a cursor page; `database()` + `Driver` |
| `repo.ts` / `tenancy.ts` | `Repo<T>` + `memoryDriver`'s repo, tx rollback; `QueryPlan` + `assertScoped()` |
| `plan.ts` / `cursor.ts` | the plan both drivers execute; the one keyset cursor codec |
| `batch.ts` | `inBatches(size)` — the chain's page in a loop, closed by the loop that reads it |
| `pg-driver.ts` | `postgresDriver()`, `postgresRepo()`, `postgresTransactor()` — attributes every statement it sends |
| `coalesce.ts` | one microtask of `findById` calls → one `where id in (…)`, per request |
| `batch-read.ts` | what a shared point read is made of — the scope key, `keyOf`, the one `in` statement |
| `bulk-write.ts` | what a many-row write is made of — the column list, the conflict plan, the bind-count chunking |
| `count-by.ts` | what a grouped count is made of — the groupable kinds, the group bound, the key's decoding, the order |
| `jit-preload.ts` | a page's foreign key values → one `in` statement for the whole `for … of` loop |
| `preload.ts` | the relation `preload()` names → one related-rows statement → attached to the page |
| `pg-sql.ts` / `pg-row.ts` | plan → parameterised SQL; physical row ⇄ entity row (money is two columns) |
| `registry.ts` | duplicate detection, `describeEntities()` for the manifest, `references()` per entry |
| `relations.ts` | `relationMap()`/`relationsFor()`/`relationNamed()` — the FKs as a named `belongsTo`/`hasMany` map |
| `n-plus-one.ts` | a repeated statement → the error whose `fix` is the preload or bulk call that ends it |
| `type-pins.ts` | compile-time assertions `tsc` checks — the column proxy, `Invariant` variance, the branded id |

## Commands

`bun test packages/entity` · `bun run --filter @ultimat3/entity typecheck`