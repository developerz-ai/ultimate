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

## Do not regress

- **The CONTRACT and the in-memory DRIVER are two files, `As of 2026-08-24`.** `repo.ts` is
  `Repo`, `Page`, `FindManyArgs` and `Transactor` — what `postgresRepo` implements too — and
  `memory-repo.ts` is `memoryRepo()`. Split when `repo.ts` passed the 500-line ceiling; nothing
  about storing rows in a `Map` belonged in the interface `pg-driver.ts` answers to.
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
  `pg-driver-bulk.live.test.ts`, `pg-driver-tenancy.live.test.ts`). A method with only the first is
  unproven against Postgres itself; a method with only the second is unproven against memory. Both
  are the bar, not either one.
- **Money's write shape is wider than its row shape, and both drivers narrow it at the WRITE
  METHOD'S entry — `As of 2026-08-25`.** `MoneyInput` lets a writer hand a `bigint` minor unit read
  straight off a `bigint` column; `MoneyValue` is what a row holds, because `JSON.stringify` refuses
  a `bigint` and money crosses every wire this framework projects. `RowWrite<Row>` is the type that
  says so at `Repo.insert`/`insertAll`/`upsertAll`, which took the ROW type instead — so the
  widening this package documents, narrows and stores correctly was a **compile error at the only
  call an app makes**, `postgresRepo()` being exported, and it was the last two entries on
  `scripts/lib/test-typecheck-pins.ts`. `narrowRow` (`columns.ts`) is the narrowing, called at each
  entry rather than deep inside `bindValues`/`write`, and the POSITION is the rule. `entity.$assert`
  and `upsertPlan` both run before a statement exists, so an invariant reading `total.minor` was
  handed the caller's `bigint` and never the `number` the row would hold — it rejected rows both
  drivers then stored correctly. And it decides whether a refusal costs a row: Bun's client binds a
  `bigint` verbatim (measured), so a minor unit past ±2^53 narrowed any later is INSERTed,
  committed, and only then refused by the decode of its own `returning *` — a row the app wrote and
  can never read. `pg-money-write.live.test.ts` is the proof, because only a real table can see
  that; `money-write-parity.test.ts` pins both drivers together, and `type-pins.ts` fails the build
  if those three writes stop taking `RowWrite` or start answering with it.
- **What a PREDICATE means is decided by the column's declared KIND, and `memory-match.ts` is
  where that one meaning is written.** The database decides by the column's type, so a driver
  deciding by the JS `typeof` of the value in hand is answering a different question — four rules,
  each of them a place the two drivers used to disagree, `As of 2026-08`. **A decimal-string column
  orders by its digits**: `bigint()` and `decimal()` both hand back a STRING (deliberately —
  `JSON.stringify` throws on a `bigint` and a `number` loses digits past 2^53), so neither the
  `number`/`number` branch nor the `bigint`/`bigint` branch fired and both fell to
  `String(left) < String(right)` — `["10","100","2","9"]` against Postgres' `2, 9, 10, 100`, and a
  keyset page cut where the database cuts none, since the seek compares the stored string against
  a revived `BigInt`. The comparison is exact at any width (the fractions are padded and both sides
  become one integer), which no `Number()` is — and `As of 2026-08` it is **`@ultimat3/core`'s
  `compareDecimalText`**, not this file's, because the text arrives in more than one package while
  the declared kind does not. What stays here is `DECIMAL_TEXT` (which kinds are decimal text) and
  the decision to ask; core's function answers `undefined` for a pair that is not two plain
  decimals, so a caller with no kinds — `@ultimat3/query`, whose `OrderKey` is a name and a
  direction — deliberately never calls it: Postgres orders a `text` column of digits lexically, and
  a comparator guessing "both sides look like decimals" would trade this agreement for that
  disagreement. That residual gap is `@ultimat3/query`'s `shape-order.test.ts` `DECLARED_GAP`. **A `uuid` is a VALUE**: Postgres parses it and
  prints it lower-cased, so `findById(UPPER)` reads the row there and answered `null` here, and
  `update(UPPER)` was `X_NOT_FOUND` against a row that exists — `keyOf(kind, value)`
  (`batch-read.ts`), which already carried that rule for a batched read, now spells the memory
  store's key and its equality too. Text is NOT narrowed: lower-casing it would merge two rows
  Postgres keeps apart. **A `LIKE` pattern uses Postgres' default escape**: `\` escapes `%`, `_`
  or itself, so `like 'a\%b'` matches the literal `a%b` in both drivers rather than
  `a\<anything>b` in one — and a pattern ending in the escape character is refused here as
  Postgres refuses it (`22025`). A RUN of `%` is still one `.*`: twenty adjacent `.*` groups in an
  anchored regex is a CPU stall on a filter value forwarded from a search box. **`in` takes a list
  or nothing**, in both drivers and in `@ultimat3/query`: a scalar operand matches NO rows (it was
  wrapped into a one-element list for the SQL and refused in memory — 0 rows against one driver, 1
  against the other, from a call `andWhere(column, op, value: unknown)` compiles), and a list
  carrying a NULL emits `(col in (…) or col is null)` — `col = null` is UNKNOWN, so the null row
  the caller listed was the one row Postgres left out while memory included it. **A column the row
  never NAMED is NULL**, `As of 2026-08-23`: the table holds NULL whether a row spelled it out or
  omitted it, so `eq`, `neq` and `in` read the row side through `isNull` exactly as `is-null` and
  the ordering guard already did — `===` made the two rows different, and `eq null` skipped the
  absent one, `in [null]` missed it and `neq null` answered it, each the opposite of the same
  predicate in production. A `money()` column holding NULL reaches this with no hand-built row at
  all: `valueAt(row, 'price.minor')` has nothing to read, whatever `$parse` produced.
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
  several whole statements rather than one Postgres refuses for its bind count. **No caller of a
  batch is ever left unsettled** — every promise `coalesceFindById` returns was handed out before
  the flush was scheduled, so `flush` settles the whole of `waiting` in a catch of its own rather
  than only the chunk that failed, and the scheduled `flush` carries a `.catch`: a rejection there
  has nobody left to hand it to and an unhandled one ends the Bun process. Unsettled forever is
  strictly worse than failed — a rejection is a stack trace and a hang is a request that never
  answers — which is why `coalesce.test.ts` races its assertions against a deadline instead of
  letting the runner time out. `jit-preload.ts` has the same property by construction, settling
  with an `Answer` rather than a rejection. A sequential
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
  with the request like every other per-ctx store here. **And the store itself is BOUNDED**
  (`MAX_SIBLING_KEYS`, four statements' worth), `As of 2026-08`: "dies with the request" is a job's
  whole attempt, `MAX_IDS_PER_STATEMENT` bounded the statement and nothing bounded the store, and
  1,000 pages x 1,000 distinct keys measured **159.3 MB retained** against a 2.7 MB control — ~2 GB
  on a 12M-row `backfill()`, an OOM in the worker on the DEFAULT configuration, since `jitPreload`
  defaults to true and `backfill()` names no driver option. Oldest page first, for both maps: the
  key index AND the bucket, which holds rows and is therefore the worse of the two.
  **Declining is the old behaviour**: no request in scope, an id no page indexed, a key that
  resolved to nothing, a key the bound evicted — the caller reads the statement it always read. `MAX_IDS_PER_STATEMENT` bounds the preload exactly as it bounds a
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
  relation; `count()`, `countBy()`, the aggregate terminals and `plan()` do not, since none reads a
  row to attach one to.
- **Every repository method attributes the statement it sends, and each op is named exactly
  once.** `postgresRepo`'s `attributed(op, send)` wraps `findById`, `findMany`, `insert`,
  `insertAll`, `upsertAll`, `update`, `delete`, `deleteWhere`, `updateWhere`, `count`, `countBy`,
  `aggregate` and `approximateCount` — every method, not a subset — through `@ultimat3/db`'s
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
  **`aggregate` names itself by the FUNCTION, not by the method**: "50x aggregate on members" does
  not say which one, and `min` and `sum` are different statements with different costs, so the op
  is `'sum'`/`'avg'`/`'min'`/`'max'`.
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
  form rather than a relation that would attach the wrong rows. **The threshold is owned here too** —
  `N_PLUS_ONE_THRESHOLD` (5) sits with the codes because it is the number that decides a *verdict*,
  and there are two detectors reading it: `x dev`'s ledger and `@ultimat3/testing`'s `statements`
  fixture. Two numbers would make a loop that fails a test a different loop from one that warns in
  dev. What a *unit of work* is stays each detector's — a request there, one test here. **Edges are
  read by their `to` end**, because the loop repeated on the entity being looked up and the ledger never saw the
  `for … of` above it — so every page that could preload it is named, first one pasteable and the
  rest after it, exactly as `preloadUnknownRelation` spells its names. **A schema whose relations
  cannot be named still reports the loop**: `relationMap()` throws `X_INVARIANT_VIOLATED` on two
  keys it cannot tell apart, and a diagnostic that let that escape would replace the N+1 with a
  schema complaint the loop did not cause — in a dev process, as an uncaught throw — so the
  derivation falls back to the `in` form. **`expectedQueryLoop` is the only way to declare a loop
  deliberate**, and it silences the count upstream; there is no flag on these errors and no fix
  that turns the warning off.
- **A page is bounded whether or not the caller bounded it.** `DEFAULT_PAGE_SIZE` (50) answers the
  read nobody sized; `MAX_PAGE_SIZE` (10,000), beside it in `plan.ts` so both drivers read one
  number, answers the read they did. `limit(rows)` was `next({ limit: rows })` and nothing else —
  no integer check, no positivity check, no ceiling — so an action taking `pageSize` as input and
  passing it through bound whatever a client sent, and one request could ask for five million rows.
  `assertFinitePageSize` is `assertBatchable`'s three refusals in the other call, deliberately under the
  same code (`X_INVARIANT_VIOLATED`) because `limit(0)` and `inBatches(0)` are one mistake in two
  places. Called from **both** `limit()` on the chain (so the refusal lands on the line the author
  wrote) and both `plan()` builders, on the RESOLVED page — so `findMany({ limit })` straight at the
  repository cannot route around it, and `bun run finite-bounds` can see the repair, which it could
  not while the screen was spelled `assertPageSize` and took a parameter called `rows` —
  and `MAX_PAGE_SIZE` bounds `inBatches(size)` too — a batch IS a page, so the ceiling belongs to
  the range and not to one of the two calls.
- **A repository pinned to its own client refuses to run inside a transaction**
  (`X_REPO_CLIENT_PINNED`), `As of 2026-08`. `client()` in `pg-driver.ts` is the one place a
  connection is chosen, which is why the guard is there and not on each method. Unpinned, `db()`
  answers with the open transaction — that is how a call inside `withTransaction` joins it.
  Pinned through `postgresDriver({ client })` it cannot: `withTransaction` ran `BEGIN` on a
  connection it reserved, and a statement sent straight to `config.client` takes a different one
  out of the pool, so the write commits whatever the transaction decides and survives its rollback
  while the read misses what the transaction wrote — silent both ways. **Refused, not resolved**:
  a `DbTx` does not name the client it was opened on, so this layer cannot tell whether the open
  transaction is even on the same database, and on a sharded app it is not. Joining it instead
  would be the same guess with the worse outcome. The `fix` names `setDbClient(client)` plus an
  unpinned repository, because `db()` resolving `currentTx()` first is the only path a repository
  joins a transaction through.
- **Cursor pagination only.** OFFSET is wrong under concurrent writes: an insert before the
  offset shifts every later page, so a client silently skips and repeats rows. No `offset` on
  `FindManyArgs` or the builder; the primary key is always the last sort key, so the order is
  total. The cursor carries the sort **values**, not just an id — seeking by an id that was
  deleted between two requests would restart pagination at the top.
- **The tiebreak takes the LAST DECLARED key's direction — decided 2026-08-24.** `totalOrder`
  appended the primary key `asc` unconditionally, so `orderBy('createdAt', 'desc')` ran
  `created_at desc, id asc`. `IndexInit.order` is ONE direction for a whole index, so that pair was
  an order this framework's own DSL **cannot declare an index for**, whatever the author wrote. It
  also decided the seek's shape: a mixed order has no row comparison. Measured on Postgres 16 over
  20,000 rows with an index on `(org, at desc, id desc)` — `(at, id) < ($1, $2)` plans as an Index
  Only Scan carrying the whole seek as one Index Cond, while the or-chain the mixed order forces
  plans as a BitmapOr of two index scans plus a Sort over everything they matched. So `seekSql`
  sends the **row comparison** when every key sorts the same way and the spelled-out or-chain only
  when they do not; a caller who wants the mixed order still writes it — naming the key themselves
  is what turns the append off — and `pg-driver-cursor.live.test.ts` walks both shapes against a
  real server. One key stays a scalar comparison: `(("id") > ($1))` is the same plan spelled worse.
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
- **The codec is `@ultimat3/core`'s, and both drivers reach it through exactly two functions**:
  `cursorFor(entity, plan, row, id)` and `seekFrom(entity, plan)` in `cursor.ts`. Both call
  `assertSeekable`, and so does `planFor` — **the load-bearing one, `As of 2026-08-24`**. An
  ordering that cannot carry a position — a nullable key, an undeclared column, a money property
  named without `.minor`/`.currency` — is refused where the PLAN is built, before a statement
  exists. Refusing it only where the cursor is minted made the refusal depend on the TABLE:
  `cursorFor` runs only when a page found a row past its limit, so `orderBy('publishedAt', 'desc')
  .limit(20)` over a nullable column was green on fifteen seeded rows for as long as the suite
  existed and `X_INVARIANT_VIOLATED` on the first read past twenty in production. That file's own
  doc comment claimed the opposite for two majors. `assertBatchable` has always judged `inBatches()`
  this way. This package owns only
  what a cursor is *bound* to — `planScope(plan)`: the entity, its filters and its sort order,
  hashed. Not the page size (a bigger next page is the same query) and not `select` (a projection
  cannot move a row). A cursor that fails either the signature or the scope is `X_CURSOR_INVALID`;
  it must never decode to "start from the top", which is what the old codec's `null` did.
- **A NULLABLE sort key orders, `As of 2026-08-24` — `asc nulls last` / `desc nulls first`, and
  that is `@ultimat3/query`'s spelling read rather than invented.** It was refused outright for
  three majors while the sibling package had defined NULL ordering all along: two pagination
  systems in one framework disagreeing about whether a nullable column is orderable, which is the
  ambiguity axiom 1 forbids, and it made the canonical listing in
  [`docs/architecture/06-data-layer.md`](../../docs/architecture/06-data-layer.md) unwritable in the
  language that page documents. Four parts. **NULL's place is WRITTEN DOWN**, never inherited from
  the server's default, so a driver whose default differs cannot reopen the divergence. **The
  cursor can say "absent"**: a key is one character of tag then the value — `~` alone is NULL, `!`
  prefixes a present one — so a `text` column holding the four characters `null` encodes as `!null`
  and can never be read as an absence, which a bare sentinel would. **The seek reaches the NULLs**:
  descending, a NULL position is `col is not null` (every value follows it under `nulls first`);
  ascending, a value position is `(col > $1 or col is null)` and a NULL position DROPS its own term,
  because nothing sorts after a NULL under `nulls last` and the alternative is SQL the planner has
  to defeat on every page. The `or col is null` is emitted only on a column that can hold one.
  **And a nullable key has NO row comparison**: `(a, b) < ($1, $2)` is UNKNOWN when either side
  holds a NULL, so every NULL row would be excluded from the page the ordering puts it on —
  `rowComparable` therefore wants one direction *and* not-null columns. What is left of the old
  refusal is the one case with no total order: a nullable PRIMARY-KEY column, reachable only
  through `primaryKey: [...]`, where `null = null` is unknown and two such rows are one position to
  the seek. `pg-null-order.live.test.ts` walks both directions at four page sizes with NULLs on both
  sides of every boundary, and compares the walk against the unpaged read and against memory.
- **The four SQL aggregates ship, and `count(*)` is no longer the only one — `As of 2026-08-24`.**
  `sum`, `avg`, `min` and `max` are terminals beside `countBy`, over exactly the rows `count()`
  counts. Before them, "total spend this month" meant leaving the query language for hand-written
  SQL, which is the one read path here with no tenancy guard on it. **Never a float**: `sum` and
  `avg` answer decimal TEXT whatever the column was (the sum of a million `integer` rows is not an
  `integer`, and `Number()` past 2^53 loses digits), a money aggregate answers `MoneyValue` in
  integer minor units, and `min`/`max` answer the row's own type. `null` for an empty set in every
  one, because that is what SQL answers and a `0` would claim rows were seen. **The shared rules
  live in `aggregate.ts`** — which kinds each function takes, the exact decimal arithmetic — with
  `aggregate-fold.ts` the memory execution and `aggregate-decode.ts` the Postgres one, so the two
  cannot drift. **`avg` rounds at ONE fixed scale (`AVG_SCALE`, 6), half away from zero**, computed
  from the exact rational: `round(avg(...), 6)` in the statement and integer arithmetic in memory,
  because "whatever numeric division gives you" is not a rule two implementations can share — the
  first draft rescaled relatively instead of absolutely and answered `11000.000000` where the server
  said `1.100000`, which the live parity test caught. **Refused rather than answered**: `min`/`max`
  on `text` (ordering is the database's COLLATION there and JS code-unit order here, and a
  comparison that cannot be made to agree is not answered twice differently), `avg` over money
  (`X_AGGREGATE_UNSUPPORTED` — the mean of an integer number of minor units is not one, so every
  answer would be the silent rounding `MoneyValue.scale` exists to prevent), an amount covering more
  than one currency **or scale** (`X_AGGREGATE_MIXED_CURRENCY`, counted in its own statement before
  the aggregate is asked for — the scale half is the one with no symptom, since `{ minor: 5,
  currency: 'USD' }` and the same row at `scale: 6` differ by 10,000x), and a money total past
  ±2^53 minor units. **`approximateCount()` is `reltuples`**, one row out of `pg_class`, constant
  time — because `count(*)` walks every visible row and no index can help, which is what makes
  `X_DB_STATEMENT_TIMEOUT`'s "add the index this statement needs" unfollowable on a large table. It
  is the whole TABLE's number, so a filtered chain **and every tenant-scoped entity** are
  `X_APPROXIMATE_COUNT_FILTERED`; the guard runs BEFORE tenancy, or a scoped entity had no reachable
  call at all — unscoped it was `X_TENANCY_UNSCOPED` and scoped it was this. `null` for a table
  nobody has analysed (`-1` in `pg_class`), which is the absence of an estimate and not an estimate
  of zero. The in-memory driver answers the exact count and refuses the same two cases, so both
  drivers answer one QUESTION.
- **A `json()` or `arrayOf()` column is filterable, `As of 2026-08-24`.** `Operator` gained
  `contains` (`@>`), `contained-by` (`<@`), `overlaps` (`&&`) and `has-key`; before them the
  vocabulary could compare a column to a scalar and nothing else, so an app storing either had to
  leave the query language — the unguarded path again. **The meaning is Postgres', measured rather
  than summarised**, in `containment.ts`, read by both drivers. Three clauses are easy to state
  wrongly and two were wrong here first: the array-contains-a-primitive exception applies **at the
  top level only** (`'{"list":[1,2,3]}' @> '{"list":2}'` is FALSE) and **to primitives only**
  (`'[{"a":1}]' @> '{"a":1}'` is FALSE); `&&`'s empty operand overlaps NOTHING where `@>`'s is
  contained by everything. **`jsonb` and array `@>` are two operators sharing a symbol**: the first
  is recursive structural containment, the second is plain element membership, because an array's
  elements are scalars of one declared type — `arrayOf()` refuses `jsonb`, `bytea`, `money` and a
  nested array, which is what makes that true. A `Date` element compares by its instant, never by
  reference. **`jsonb_exists(col, $1)`, never the `?` operator**: a literal `?` is a parameter
  placeholder to more than one client on the way to the server. **No jsonpath expression operator**
  beside them, deliberately: `contains` already matches nested structure, and a path language
  inside the query language is a second way to ask one question. `&&` on a `jsonb` column is
  refused where it was written, since Postgres has no such operator and any answer would be one no
  statement can make. **`has-key` emits the `?` OPERATOR, schema-qualified
  (`operator(pg_catalog.?)`), and not `jsonb_exists(col, $1)`** — the two are the same test and only
  the first is INDEXABLE: measured on Postgres 16 with a GIN index and `enable_seqscan = off`,
  `data ? 'k'` plans as a Bitmap Index Scan and the function form is a Seq Scan the planner will not
  convert, because an index is matched against an operator expression and a bare function call is
  not one. The function form shipped first, on a stated fear of `?` being read as a placeholder;
  Bun's client passes it through verbatim (measured), and the qualified spelling is immune to a
  client that does not and to a `search_path` that shadows the operator.
- **A GIN index is declarable — `indexes: [{ on: ['tags'], using: 'gin' }]`, `As of 2026-08-24`.**
  Without one every containment operator above is a sequential scan, which is the whole reason they
  needed an index at all: measured over 20,000 rows, array `@>` / `<@` / `&&` and jsonb `@>` and
  `?` each become a Bitmap Index Scan with a GIN index and none touches it without.
  `pg-containment.live.test.ts` explains the driver's OWN statement rather than a lookalike — the
  `count` one, because a page's `order by "id"` plus `limit` lets a four-row table be served by the
  primary key whatever the predicate could have used. **The closed set is `@ultimat3/db`'s
  `INDEX_METHODS`, imported and never restated** (tier 1, downward): two members, `btree` and
  `gin`. **Absent is `btree`** — an index that names no method emits the statement it always
  emitted byte for byte and its snapshot entry carries no `using` at all, so nothing regenerates;
  proven by generating twice against the first generation's own snapshot and asserting the second
  is empty. **The METHOD joins the name discriminator**, beside `where` and `order`: a btree on an
  `arrayOf()` column answers `=` and an ordering while a GIN on the same column answers `@>`, so
  they are two distinct indexes that would otherwise be one name — the dedup drops one in silence,
  or, since that dedup is on the whole definition, two `create index` statements collide as `42P07`.
  It is appended to the hash only when declared, so every name minted before methods existed is
  unchanged. **Two Postgres rules are refused HERE**, where the author is: a GIN index cannot be
  unique and cannot order its keys. `@ultimat3/db`'s `createIndex` refuses both again — that is the
  guard for a description nobody declared through `entity()`, not a duplicate — but its refusal
  lands at `x db gen`, or inside `ROLE=migrate` as the server's own syntax error with none of the
  entity's words in it. **`jsonb <@` is not indexable and that is Postgres', not this package's**:
  `<@` is not in the default `jsonb_ops` operator class, so it is a sequential scan whatever index
  is declared — pinned in the live test so a reader is not left wondering whose doing it is.
- **A relation is a foreign key read a second way, never a second declaration.** `relations.ts`
  derives `belongsTo` from an entity's own `references()` columns and `hasMany` from the inbound
  ones; there is no `hasMany: […]` init key and adding one would put two declarations of one fact
  in the schema. A thunk is resolved in exactly one place — `referenceBinding()` in `column.ts` —
  so the DDL projection (`describe.ts`) and the relation map can never disagree about what a
  `references()` points at. Naming is order-independent by construction: when two keys want one
  name, **every** member of that group takes its long form, so declaring a second foreign key
  never renames the first relation behind a caller's back. What the two tiers cannot separate is
  refused with `X_INVARIANT_VIOLATED` naming both columns — never collapsed into one relation.
- **An index is described whole — columns, uniqueness, predicate, direction — never by its name
  alone.** `EntityDescription.indexes` is a list of `IndexDescription`, not of strings, because the
  `<table>_<a>_<b>_idx` name `entity()` mints joins with `_` and cannot be read back: a two-column
  index recovered from its own name became the single column `"org_id_created_at"`, so
  `generateMigration` emitted DDL Postgres answers `42703` and every composite index in the
  framework — including the composite unique one `upsertAll`'s `on conflict` is inferred against —
  had to be written by hand. `where` and `order` ride along for the same reason: a partial index
  emitted as a total one refuses rows the entity allows. `on: []` is refused at declaration
  (`X_INVARIANT_VIOLATED`), where the author can see it. **And the NAME carries the predicate and
  the direction too, `As of 2026-08-24`** — eight hex characters of sha256 over `order` and `where`,
  folded in as `<table>_<cols>_<hash>_idx`. Without it two DIFFERENT partial indexes on one column
  were one name (`posts_author_id_idx` for both `where status = 'published'` and
  `where status = 'draft'`), and the dedup below dropped the second with no error, no warning and
  no drift finding either, since `compareTable` matches a declared index by name. **Only when the
  index carries one of the two**: a plain index keeps `<table>_<cols>_idx`/`_key`, because
  `unique()` on a column is an inline column clause and Postgres names the index it creates exactly
  `<table>_<column>_key` — a discriminator there would make the generator emit a second
  `create unique index` for an index that already exists (`42P07`). The dedup itself is on the
  whole `IndexDef`, not on the name: a name is derived, and matching on a derived string is what
  made two indexes indistinguishable in the first place. **And the name is bounded at 63 BYTES**
  (`MAX_IDENTIFIER_BYTES`, `NAMEDATALEN - 1`), refused at declaration: Postgres truncates a longer
  identifier and says nothing, so two names sharing their first 63 bytes are one index on the
  server — the same silent collapse one layer down, and invisible to a drift check comparing
  DECLARED names, which still differ.
- **`isNull()`/`isNotNull()` are the ONLY total members of the invariant vocabulary, and `iff` is
  built out of them — `As of 2026-08-25`.** Postgres' `IS NULL` answers true or false for every
  input NULL included; every other operator here answers NULL for a NULL operand and **a CHECK
  PASSES on NULL**, so the database is the more permissive half wherever a predicate reads a
  nullable column. The app side reads an ABSENT key and a stored `null` as one value, which is
  `is-null.ts` — one rule, because `memory-match.ts` and `containment.ts` each had a private copy
  and `expr.ts` was about to be the third. `iff(a, b)` renders `(a) = (b)`, byte for byte the shape
  `examples/dummy`'s hand-written `0001_init.sql:67` already holds.
  **`=` and not `is not distinct from`, decided on a measurement, and the reasoning inverts the
  obvious one.** With both operands total the two spellings are identical on all four boolean pairs
  (measured, PG 18.4). They part only on a NULL operand, and there the TOTAL form is the DANGEROUS
  one: `(NULL) is not distinct from (false)` is false and refuses the row, while TypeScript reads a
  NULL operand as false and `false === false` ACCEPTS it — a raw `23514` in place of
  `X_INVARIANT_VIOLATED`, which is the exact failure `matchOperator`'s flag refusal exists against.
  `=` leaves the disagreement in the safe direction, where the app refuses first and no write ever
  reaches a CHECK that would have refused it. `pg-invariant-null.live.test.ts` measures both
  spellings on a real table, and `expr.test.ts` pins the permissive direction so a half-fix that
  flips it fails loudly. **`iff` is a FUNCTION, not a method on `Expr`**: `Expr` is exported, so a
  required member breaks a structural implementer, and `kind: 'unique'` is an `Expr` whose `toSql`
  is a column LIST — a `.iff()` there would be a method that cannot mean anything for some values
  of its own type. That operand is refused in one place, with the `c.unique([…])` invariant the
  author meant spelled out from its own columns — **each path through `JSON.stringify`, `As of
  2026-08-25`**: a `fix:` is TypeScript to PASTE, so a column name reaching it is a value spliced
  into source, and `'${column}'` produced `invariant('o'brien_unique', …)` on a name carrying a
  quote. `columns: { "o'brien": text() }` is a legal declaration and `unique()` is reached untyped
  by a JS caller besides; a backslash is the half that doubling the quote would still have missed.
  The same defect as an unescaped pattern, one layer up in the error message. **One app-only operand makes the WHOLE rule
  app-only** (`sql: null`, so `bindInvariant` lands it as `assert`): emitting half a biconditional
  would enforce something nobody wrote.
- **A `matches()` pattern reaches the CHECK as the SAME STRING `pattern.test` runs, or it is
  refused — `As of 2026-08-25`.** Nothing is translated and nothing ever may be: a "close enough"
  POSIX rewrite of a JavaScript-only construct ships two rules under one name, which is worse than
  the `assert` a predicate already gives you. What makes one string in front of two engines legal is
  `pattern-portability.ts`, a scanner over the source that names the first construct ARE and
  ECMAScript read differently, and every entry on it is a MEASUREMENT against a real server, not a
  reading of the docs. The flagship: `'foo' ~ '\bfoo'` is FALSE on Postgres 18.4 and
  `/\bfoo/.test('foo')` is true, because ARE reads `\b` as a BACKSPACE — both compile, neither
  errors, and the CHECK enforces a rule the entity never wrote. So are `.` (matches a newline there
  and never here), `\w` (the locale's alnum class, which matches `é`), `\s` (JavaScript adds
  U+00A0), `[[:alpha:]]`, a leading `]` in a class, `\x` (three hex digits there, two here), `\A`
  and `\Z`, and a named group. `\d` is IN, measured rather than assumed — POSIX fixes
  `[[:digit:]]` at the ten ASCII digits, so `'٣'` and `'５'` are false on both sides. `\uwxyz` is in
  for a reason that is not convenience: **Bun escapes a regex LITERAL's non-ASCII characters**,
  `/^é$/.source` is `^\u00E9$` while `new RegExp('^é$').source` is `^é$`, so refusing the escape
  would refuse every i18n pattern written the ordinary way. The refusal carries the portable
  spelling where one exists and the app-only predicate where none does, and it lands at DECLARATION
  beside `matchOperator`'s flag refusal, on the line that wrote it. `pg-invariant-pattern.live.test.ts`
  runs both halves against a server: every kept construct must AGREE and every refused one must
  still DISAGREE — so a future Postgres that grows JavaScript's `\b` turns the list red instead of
  leaving a stale exclusion in place. **The kept half is only as broad as its table, and the table
  was narrower than the claim from the day it landed, closed 2026-08-25**:
  `pattern-portability.ts` called `(?<=` and `(?<!`
  measured and neither had ever been run, and nor had a capturing group, a top-level `|`, `{n,}`,
  `{n,m}`, `\t`/`\f`/`\v`, an escaped punctuation outside a bracket expression, a bare `]`/`}`, or
  a trailing `-` in a class. All of them agree on 18.4 (73 pairs, 0 disagreements) and all of them
  now have rows; every row is also asserted to be a construct `unportableConstruct` KEEPS, since a
  row for a refused one measures something `matches()` can never emit. What remains unmechanised is
  the direction no source can enumerate — a construct added to the kept set with no row here.
- **A declared string is spliced by `@ultimat3/db`'s `literal()` and by nothing in this package —
  `As of 2026-08-25`, and doubling the quote is only HALF the rule.** `expr.ts` and
  `column-values.ts` each carried `'${v.replaceAll("'", "''")}'`; a CHECK takes no bind parameters,
  so a `matches()` pattern, a `contains()` needle and every `enumerated()` member an app declares
  reach statement text unescaped against the one character that is not a quote. With
  `standard_conforming_strings = off` — a SESSION setting, `SET`table by anyone — a backslash
  escapes the character after it inside an ordinary literal: measured on 18.4, `'dd' ~ '^\d+$'` is
  FALSE with the GUC on and **TRUE** with it off, because the server compiles `^d+$` and the CHECK
  silently enforces a pattern nobody wrote; and `'\''` leaves the literal UNTERMINATED, so
  following text becomes string data until the next `'` puts the remainder back into code position
  (reproduced as `syntax error at or near "x') > 0 , '"`). `E'…'` fixes the dialect in the TEXT
  rather than trusting the setting, and **only** when the value carries a backslash — without one
  there is no escape mechanism to disagree about, so every CHECK already generated stays byte for
  byte what it was and nothing regenerates; both tracked apps hold applied migrations whose
  checksums are taken over that text.
  **The rule lives in tier 1 and this package imports it down.** It was written here first, as
  `sql-literal.ts`, and that file is deleted: `@ultimat3/db`'s `literal()` now carries the same
  transformation and the same measurement, `packages/entity` already depends on `@ultimat3/db`, and
  `bun run sql-literal-copies` refuses any module outside `packages/db/src/sql.ts` that turns `'`
  into `''` — matched on the TRANSFORMATION, because the three copies were called `literal`,
  `literalText` and an unnamed inline splice, and a name-based rule reads past the third exactly as
  one spelled `RenderMode` read past `PwaRenderMode`. `expr.ts` keeps a four-type wrapper that
  delegates and unwraps `.text` — `Invariant.sql` is a bare string and a `SqlFragment` cannot
  survive that round trip — and it re-spells nothing. **The half that ratchet cannot see is a
  producer DROPPING the call**: `` `'${value}'` `` doubles no quote, so it matches no rule, which is
  why `expr.test.ts` pins all four splice sites (`contains`, `eq`, `matches`, `oneOf`) against a
  quote-bearing and a backslash-bearing value. A fifth producer added without the call fails there.
- **Every physical name is checked, including the DERIVED one — `As of 2026-08-24`, and it was a
  DDL injection.** `columnName` is `meta.name ?? snake(property)` and only the first branch reached
  `assertColumnName` for three majors, while `snake()` lower-cases and does nothing else. A column
  declared as `n" , "x" text); drop table t; --` therefore produced a `create table` carrying a real
  `drop table` — measured through `generateMigration`, not theorised — and an entity NAME did the
  same through `table: init.table === undefined ? name : assertColumnName(init.table)`, whose
  fallback is every entity that does not rename its table. Quoting is not a defence against a value
  that can close the quote, which is what `assertColumnName`'s own doc comment already said. Checked
  at `bindColumn` (once per column, at `entity()`) rather than in `columnName` (every statement).
- **Relations reach query time through `RegistryEntry.references()`, and the DDL string is
  rendered from it.** The resolved records are the source; `ColumnDescription.references` spells
  `"<table>.<column>"` out of one for the migration generator, which is in tier 1 and cannot
  import this package. Never parse that string back — it carries physical names and a traversal
  reads row *properties*, so the parse would be a second, lossy resolver. **`onDelete` rides
  beside it, on both `ColumnDescription` and `ReferenceDescription`, `As of 2026-08-19`**: the flat
  string has no room for a rule and neither record had a field for one, so a declared
  `{ onDelete: 'cascade' }` type-checked and reached no SQL for three majors — `@ultimat3/db` emits
  it now, and it can only see what the projection carries. Read off the resolved reference, never
  off `meta` a second time: a rule with no key is not a thing. `references()` is a
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
- **The process default driver has a name, and emptying it is optional on the seam.**
  `defaultDriver()` returns the one `database()` falls back to when a call names none — exported so
  a test harness seeds and empties the object the app actually reads through, since a second
  `memoryDriver()` of its own would be invisible to every `database()` call already made.
  `Driver.reset?()` is **optional**, implemented by `memoryDriver()` and by nothing else:
  `postgresDriver()` leaves it undefined because those rows are the app's, so a harness writes
  `driver.reset?.()`. The reset runs `MemoryRepo.reset()` on the repositories already handed out —
  in place, never a replacement — because `database()` resolves each table's repository once and a
  swapped-in repository is emptied where nothing is reading. Test seam only: no framework code path
  calls either, and neither is a fixture system.
- **A repository call rejects, never throws synchronously** — `tableFor`'s writes are `async` for
  that reason alone: `$parse` throws, and a call site should not need two error paths for one
  mistake.
- **Tenancy applies to writes too, and in two places.** `update(id, patch)`, `delete(id)`,
  `deleteWhere(filter)` and `updateWhere(filter, patch)` build the same plan a read does, so an id
  or a filter alone never addresses a row on a tenant-scoped entity — another tenant's id reads as
  `X_NOT_FOUND`, never as their row. That bounds WHICH rows a write touches; it cannot bound what
  they become, and `insert`/`insertAll`/`upsertAll` build no plan at all. So the VALUE is judged as
  well, by `assertRowTenant` (`tenancy.ts`) at the seams every write passes: `memoryRepo`'s
  `write()` plus its `insertAll`/`upsertAll` batch loops and its `updateWhere`, and
  `postgresRepo`'s `writeRows()`, `update` and `updateWhere`. **A filtered update judges the PATCH,
  before it reads a row** — `As of 2026-08-23`, in both drivers. `memoryRepo` judged the merged
  rows inside its loop, and a loop over no rows judges nothing, so
  `updateWhere(filter, { orgId: theirs })` over a filter matching nothing answered `0` in memory
  and `X_TENANCY_ACTOR_MISMATCH` in Postgres: whether the guard fired depended on what the table
  held rather than on what the caller asked for. A row or patch naming another tenant is `X_TENANCY_ACTOR_MISMATCH` —
  the same code the read path throws, because it is the same mistake in a different argument.
  Rules, none optional. **Refuse, never stamp**: a row that names no tenant is left alone and the
  column's `NOT NULL` answers it. Filling one in from the actor would change the column list
  `namedProperties` derives, silence the uneven-batch refusal (`excluded.<col>` is a default, not
  "leave it alone"), and let ambient state decide which stored row a collision lands on — a write
  that creates data from the ambient context is a bigger decision than a guard. **All or nothing**:
  the batch loops run before any row is stored, so memory cannot half-apply what Postgres refuses
  as one statement. **The incoming rows, not only what lands**: under `onMatch: 'nothing'` a
  colliding row never reaches `write()`, so a check only on stored rows would pass exactly the rows
  that collide. **Refused before the statement exists** — `pg-driver` sends nothing and `memoryRepo`
  stores nothing, which `write-tenancy-parity.test.ts` pins for both drivers together, and
  `pg-driver-tenancy.live.test.ts` proves against a real server — that file is where tenancy's live
  proof lives, reads and writes both, and where a new one goes. **Together with the conflict-target rule
  a cross-tenant upsert is unrepresentable**: the target must contain the tenant column under
  `'update'` (`X_TENANCY_UNSCOPED`, which decides which stored row is matched) and every incoming
  row must carry the actor's tenant, so the key can only hold this actor's value.
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
  - **the rows come back only when something here can still refuse them**, `As of 2026-08`.
    `updateWhere` ended its statement in `returning *` unconditionally and looped `$assert` over
    the result, on every entity — including the ones whose every rule is a CHECK Postgres already
    enforced on the statement, where the loop judges nothing. A tenant-wide sweep
    (`updateWhere({ orgId }, { marketingOptIn: false })`, twelve million rows) therefore streamed
    the whole table into a process sized for one request, and `deleteWhere` beside it was a count,
    which is what made the failure look arbitrary. `hasJsOnlyInvariant($invariants)`
    (`invariants.ts`, reading the same list `uniqueTargets` classifies a conflict target from) is
    the switch: no `assert` rule, no `returning *`, `execute()` and the command tag. When rows ARE
    needed the match is **counted first** and refused past `MAX_ASSERTED_ROWS` (50,000) naming
    `inBatches(1000)` — a refusal issued after `returning *` is already holding what it refuses.
    `updateStatement`'s `returning` is a required parameter with no default for the same reason:
    the three callers want three answers and the wrong one is invisible in the result. The soft
    delete inside `removal()` passes `false` too — both its callers read a count through
    `execute()`, so its rows were never readable by anyone.
- **Every instant the write path stamps comes from `ctx.clock`, through `entityNow()`**
  (`clock.ts`, `As of 2026-08`). `defaultNow()`, `touch()`'s `onUpdateNow()`, the soft-delete stamp
  in BOTH drivers and a seed's `now` each read `systemClock` directly, so a frozen test clock drove
  nothing the entity layer wrote — `createdAt`, `updatedAt` and `deletedAt` were the wall clock
  however the ctx was built, and a test could only assert a range where it wanted a value. The read
  path still reads no clock at all, which is what makes IT drivable (`@ultimat3/query`'s CLAUDE.md
  says so in as many words); this is the write half of the same property. Outside a request there
  is no ctx and the system clock IS the answer — a script, a worker boot and a seed take that
  branch exactly as before. Never read `systemClock` on the write path again: five sites is how the
  four stamps of one write ended up able to disagree.
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
  `raw()` appears exactly twice, for `asc|desc` and the `default` cell of a many-row `values` list —
  each a closed set of one word. The seek operator was the third: it is chosen in TypeScript
  (`seekSql`/`seekAfter`), because the seek's SHAPE is decided by the order and its bind's cast is
  part of the template, never a `raw()` argument.
- **A `timestamp` cursor carries MICROSECONDS, and every seek term is a plain comparison —
  decided 2026-08-24, and it replaces the millisecond window this file described for two majors.**
  A `timestamptz` column holds microseconds; Bun's client hands it back as a JS `Date`, which holds
  milliseconds. The window (`>= v and < v + 1ms`, ascending `>= v + 1ms`) made the SEEK cut on
  `date_trunc('milliseconds', col)` while the `order by` beside it still sorted on the bare column
  at microseconds — **two different equality classes on one page**, and the rows between them were
  served on **no page, ever**. Not a race: three rows inside one millisecond with uuid v7 ids, a
  `desc` page of one, and the two later rows are unreachable on every subsequent page, because
  under `desc` the boundary row always holds the largest id of its millisecond and the `id >`
  tiebreak can never match. Reproduced against Postgres 16 before the fix and pinned by
  `pg-cursor-precision.live.test.ts`. No predicate over `(col, id)` built from a FLOORED value can
  be correct — the information is gone — so the precision is carried instead. Three parts, none
  optional. **The statement asks for it**: `seekPrecision` (`pg-sql.ts`) projects
  `(col at time zone 'UTC')::text as "<col>$US"` beside every `timestamptz` sort key, under an
  UPPER-CASE alias no physical column name can be (`snake()` lower-cases, `assertColumnName`
  refuses the rest). `at time zone 'UTC'` and not a bare `::text`, or a page position would depend
  on the connection's `TimeZone`. **The cursor is minted from the PHYSICAL row**: `sortPrecision`
  (`pg-row.ts`) reads that output, and `cursorFor`'s optional `exact` map is how a driver hands
  over a value the decoded row cannot hold. **The seek binds an ISO instant with all six digits**:
  `col < $1::timestamptz`, the cast in the template rather than a `raw()` call, the column bare so
  the index still range-scans. `instant.ts` is the only place the two representations meet —
  microseconds since the epoch, as a `bigint`, in the cursor and in `compareByKind`. The memory
  driver stores millisecond `Date`s, which are exact in that domain, so the two drivers still agree
  without a second rule; `nextMillisecond` and `seekEqual`'s `Date` branch are gone. A cursor
  minted before this carries an ISO string and is `X_CURSOR_INVALID`, never a bare `SyntaxError`
  out of `BigInt`.
- **`MoneyValue.scale` PERSISTS, in a third physical column — decided 2026-08.** `<p>_scale integer
  null`, through `columnsOf` / `bindValues` / `moneyOf` / `parseMoney` / `describeColumn`. Until
  this branch the entity layer silently dropped it on **both** write and read: `parseMoney` rebuilt
  the value as `{ minor, currency }`, `bindValues` wrote two columns and `columnsOf` declared two,
  so `money().$parse({ minor: 2, currency: 'USD', scale: 6 })` — $0.000002 — was stored and read
  back as $0.02. A silent 10,000x reinterpretation, with no error anywhere, of a field the type
  system (`type-pins.ts` asserts `MoneyValue` is exactly `minor | currency | scale`), the wire
  schema (`t.money` validates and preserves it) and `@ultimat3/money` all carry. **The rejected
  alternative was making `parseMoney` refuse a scaled value**: `scale` exists precisely so a
  sub-cent amount can be named — the $0.00016 model call that rounded up to a whole cent and
  reported 62x the real spend — so refusing it at the persistence layer would delete the feature at
  the one layer that has to keep it. Rules, none optional. **`null` is not `0`**: the column holds
  NULL for "the currency's own minor unit", which is every amount written before the column
  existed, and it decodes to an ABSENT key — `0` means whole units and would be a 100x error on
  every ordinary price, so `bindValues` writes `money?.scale ?? null` and `moneyOf` omits the key
  rather than defaulting it. **Always nullable, whatever the property is**: a NOT NULL there would
  demand a scale on values that have none. **The bound is `@ultimat3/schema`'s** — `parseScale`
  calls `isMoneyScale`, never a restated `0…15`, and `scaleCheck` emits the matching CHECK so a
  psql session cannot write a scale the app would refuse to read. **`scale` is not addressable**:
  `MONEY_PARTS` in `pg-row.ts` and in `cursor.ts` still hold `minor` and `currency` only, because a
  scale says which units `minor` counts — ordering or filtering by it compares two different
  questions. Existing tables need `alter table <t> add column <p>_scale integer` (see the migration
  note in the PR); every existing row's NULL already means what it always meant.
- **The currency bound is `@ultimat3/schema`'s too, in BOTH halves — decided 2026-08.**
  `parseCurrency` calls `isCurrencyCode` and `currencyCheck` interpolates `CURRENCY_CODE_PATTERN`,
  the pattern source that predicate is built from, exactly as `scaleCheck` interpolates
  `MAX_MONEY_SCALE`. `^[A-Z]{3}$` had been restated four times across three packages — schema's
  private regex, its JSON Schema `pattern`, this column's parse and this CHECK — each individually
  correct, and a divergence between the last two is visible only to a psql session, as a row the
  app then refuses to read back. SQL cannot call a predicate, so what crosses the seam is the
  pattern **string**: legitimate only while the pattern stays inside the syntax ECMAScript and
  POSIX ARE spell identically, which is why `currency-check.live.test.ts` inserts the same corpus
  `columns.test.ts` runs into a real table carrying the emitted CHECK and demands the server accept
  exactly what `isCurrencyCode` accepts. That table is `text`, not `char(3)`, on purpose: a width
  refusal would answer for every over-long case and leave the pattern untested on them.
- **Money is a `bigint` + `char(3)` column pair, and a `number` + `char(3)` VALUE.** A float throws.
  Never one column, never an implied single currency — and never two declarations of the shape.
  `MoneyValue` is re-exported from `@ultimat3/schema`, which is also what `@ultimat3/money`'s
  `Money` is: **one** declaration, at the only tier every package may import. It was three
  structural restatements, and the entity layer's copy had a `bigint` `minor` — so a row this
  package decoded threw inside `JSON.stringify` (an action returning it crashed the response) and
  failed `t.money`, the node that becomes the OpenAPI contract. `type-pins.ts` fails the build if
  the alias is ever re-declared here, if `minor` widens back to a `bigint`, or if either field
  loses `readonly`. **The column is wider than the value on purpose, and the gap is a refusal, not
  a rounding**: `parseMinor` (`columns.ts`) takes the `bigint`, the `number` and the string int8
  arrives as, and refuses anything past ±2^53 with `X_INVARIANT_VIOLATED` naming the value — the
  same value `@ultimat3/realtime` refuses for the same reason, so the two readers of one column
  agree. **The write half stays wide**: `MoneyInput` takes a `bigint`, so a minor unit read off a
  `bigint` column needs no conversion at the call site — and `narrowMoney` is called by
  **both** drivers, `bindValues` before a statement and `memoryRepo`'s `write` before it stores, so
  a row's money never depends on which driver produced it. Applying it to one of them only is the
  drift the two-driver split exists to prevent: it would leave the in-memory row the one row in
  the framework `JSON.stringify` refuses.
- **Timestamps are `timestamptz`.** A naive timestamp must stay inexpressible.
- **A tenant column means every query runs under the ACTING ACTOR's tenant** — derived from
  `tryUseContext()?.actor.orgId` in `scopedPlan` (`tenancy.ts`), which every repository operation
  reaches through `readPlan`, so both drivers and every read, write and count pass one derivation.
  `tenant: 'orgId'` declares the column; omitted, inference still applies (`.tenant()`, else a
  column named `orgId`), so silence never means unscoped. Never make the declaration the only
  switch. **And the column may not be nullable** — refused in `resolveTenantColumn`, at
  declaration, on all three paths and not just the declared one, `As of 2026-08`. `.tenant()` sets
  `{ tenant: true, index: true }` and said nothing about nullability, so `uuid().nullable().tenant()`
  was legal — while `assertRowTenant` returns early on a row that names no tenant and explicitly
  delegates to the column's `NOT NULL`. On a nullable column that delegation has nothing behind it:
  the row lands with a null tenant, no `org_id = $1` matches it, and it is invisible to every
  tenant-scoped read — never exported, never swept on offboarding, owned by nobody for as long as
  the table exists. Five rules, none optional. **A caller-supplied `orgId` is an assertion, never the
  authority**: equal to the actor's it is a restatement (one predicate, not two), different from it
  — which is what an `orgId` taken from action input looks like — it is `X_TENANCY_ACTOR_MISMATCH`
  with both values in the cause. **Refused, never overridden**: rewriting the predicate to the
  actor's org would answer the wrong question correctly and ship the bug. **Every predicate on the
  tenant column is checked and `eq` only**, so `in [mine, theirs]` is a mismatch too. **An actor
  with no org is refused** (`X_TENANCY_ACTOR_ORG_REQUIRED`): anonymous is inside no org, so every
  tenant-scoped row is somebody else's, and letting the caller's value stand there would leave the
  hole open on exactly the unauthenticated path. **Outside every request context there is no actor
  to derive from** — a script, a seed, a test harness — so the caller names the tenant itself and
  `X_TENANCY_UNSCOPED` still refuses a plan that names none. There is no build-time tenancy step in
  `x verify` (its 20 steps check none) and the old comment in `tenancy.ts` claiming one was wrong:
  the tenant is a request-time value, so the seam is the enforcement.
- **`crossTenant(reason, fn)` (`cross-tenant.ts`) is the ONE way to read across tenants**, for the
  three cases that have no single one: an admin surface over every org, background reconciliation,
  support tooling. An async-context scope with a written reason, the same shape
  `@ultimat3/db`'s `expectedQueryLoop` has, never a boolean argument on a repository call — which
  reads exactly like forgetting the tenant — and never a config list of exempt entities (axiom 1).
  The scope opens through `asyncContext<string>('the cross-tenant reason')` from `@ultimat3/core`,
  **never a `new AsyncLocalStorage` here, and that is a build error rather than a convention `As of
  2026-08`** — `scripts/async-context-guard.ts` refuses the construction *and* the import that
  binds the class, anywhere but `packages/core/src/async-context.ts`, and
  `scripts/async-context-guard.test.ts` runs it over the tree in the gate's `unit` step. The
  module-scope `new` this replaced threw `TypeError: undefined is not a constructor` at module
  **evaluation** in a browser bundle, where the bundler stubs `node:async_hooks` to `{}`, taking
  every importer of `cross-tenant.ts` with it. Now the module evaluates and `crossTenantReason()`
  answers `undefined` there — in a browser nothing IS in flight, so that is the true answer. A
  write is the case that names itself: `storage.run` throws `X_ASYNC_CONTEXT_UNAVAILABLE` instead
  of a bare `TypeError`, though `crossTenant()` reaches it only past `assertCrossTenant`, which
  wants a request context a browser does not have. A server saves no allocation — the store is
  built on the first `get()` **or** `run()`, so a read constructs it too; what the laziness costs
  is nothing observable, since `getStore()` outside a scope answers `undefined` whether the storage
  existed or not.
  **The capability is proven twice**: `CROSS_TENANT_SCOPE` (`tenancy:cross`) on the actor, at the
  call and again at every plan built inside it, because `withChildContext({ actor })` swaps the
  actor without closing the scope and an impersonated caller must not inherit it —
  `X_TENANCY_CROSS_DENIED`. **Outside a request context it is refused too**: a sweep with nobody to
  attribute it to is ambient authority, so a script mints its own `serviceActor` and says who it
  is. A blank reason is `X_INVARIANT` through core's `assert`, exactly as `expectedQueryLoop`'s is.
- **Every framework member on an entity is `$`-prefixed** — the columns are `Object.assign`ed onto
  the core, so an unprefixed member would make `view`, `name` or `tenant` an illegal column name.
  `$view`, never `view`; no free `view(entity, keys)` either — one way to write a projection.
- **Invariants run twice, and only ONE side of the pair is rendered here.** In the app on write
  (`assertInvariants`), and as a Postgres CHECK/UNIQUE emitted by `@ultimat3/db` —
  `constraintNameFor`, `declaredChecks`, `declaredIndexes` (`invariant-ddl.ts`), reading
  `$describe()`. An untranslatable JS predicate reports `kind: 'assert'`, `sql: null` — never a
  pretend CHECK. **This package rendered a second copy of that DDL until 2026-08-25**
  (`toSql`/`invariantsToSql`/`constraintName`, reachable through `entity.$migration()`), and the
  copy is the argument: nothing but its own tests ever called it, so nobody noticed it passed the
  entity NAME where the table belongs — `entity('account', { table: 'legacy_accounts' })` rendered
  `ALTER TABLE "account" ADD CONSTRAINT "account_…_check"`, a relation Postgres answers `42P01` for
  and a constraint name no migration has ever written. All four are deleted; `$migration()` was on
  `EntityCore`, so this is a breaking change to a documented member. Never render constraint DDL
  here again — the entity's job is to DESCRIBE the rule, and `<table>_<name>_<check|key>` now has
  exactly one source.
- **`InvariantDescription.columns` is projected, `As of 2026-08-25`** — the physical names the rule
  reads, for every kind, straight off `Invariant.columns`. Same argument as `onDelete`, `generated`
  and `default` on `ColumnDescription`: `@ultimat3/db` is tier 1 and cannot import this package, so
  a fact this projection drops is a fact the generator must recover from a rendering. It was
  recovering it — `uniqueColumns()` split a `unique` rule's `sql` on commas and re-validated each
  part — which is the shape that made `posts_org_id_created_at_idx` read back as the single column
  `"org_id_created_at"`. `snapshotOf` derives from `declaredChecks`/`declaredIndexes` and not from
  this record, so the field changes no snapshot and nothing regenerates
  (`describe-invariant.test.ts` pins both halves).
- **And the two halves must AGREE, term by term** (`expr.ts`). A rule the app accepts and the CHECK
  refuses is not a stricter database: the write comes back as a raw constraint error instead of
  `X_INVARIANT_VIOLATED`, which is the framework's own invariant bypassed on the way out. Two
  divergences closed 2026-08, both proven. **`matches(/…/i)` compiles to `~*`** — `toSql` emitted
  `~ <pattern.source>` and nothing else, so `c.slug.matches(/^[A-Z]+$/i)` approved `'abc'` in the
  app while the CHECK refused it; every other flag is REFUSED at declaration (`matchOperator`),
  never dropped, because `m` and `s` change what the pattern matches and `g` makes `pattern.test`
  stateful so even `holds` stops being a function of the row. **`minLength` counts code points** —
  `[...value].length`, because `char_length('👍')` is 1 and `'👍'.length` is 2. Code points, not
  graphemes: agreeing with Postgres is the point, not agreeing with a human's idea of a letter.
- **`$parse` tells absence from `null`** (`entity.ts`). `input[property] ?? defaultValue(...)` read
  an explicit `null` as absence and wrote the column's declared default straight back, so a
  nullable-and-defaulted column could not be cleared at all — `{ status: null }` reported success
  and stored `'draft'`. It is `raw === undefined ? defaultValue(...) : raw`: a present `undefined`
  is still absence, which is what a spread of an omitted optional key produces.
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
- **A rejected column value is rendered as its SHAPE, never its content** — `got(value)` in
  `columns.ts`, one line over `@ultimat3/schema`'s `describeValue`, `As of 2026-08`. Every builder
  used to say `got ${String(value)}`, and a column rejection is not a private diagnostic: it
  becomes `X_INVARIANT_VIOLATED`'s `cause` and a `$view` issue, which `@ultimat3/http` folds into
  `X_BODY_INVALID` — returned to the caller AND written into the log line, where core's logger
  redacts by KEY and a value already baked into a message has no key left to redact. `text()` on a
  password field wrote the mistyped password to the log index in cleartext and into the user's own
  network tab. **A column is the worse half of that pair**: the value can arrive from the DATABASE,
  so the leak is not bounded by what somebody just typed. The renderer is schema's rather than a
  local copy, so a column and a schema describe one bad value the same way; `columns.test.ts` pins
  it with a secret-looking value and checks that not even its four-character prefix survives — a
  truncating "helpful" renderer would still name the vendor. **Two echoes are deliberate and both
  are provably numeric by the branch that reaches them**: `parseMinor`'s float message and its
  ±2^53 message, where the value is a `number`, a `bigint` or a digits-only string, the amount is
  the only fact that repairs the row, and `@ultimat3/realtime` renders the same value the same way
  for the same reason. Changing either means changing both.
- **A seed is replayable by construction, and `insert` is the verb that makes it so** — decided
  2026-08. `defineSeed`'s context offered `insert` and nothing else, and a plain insert meant two
  different things to the two drivers: the memory repository overwrites by primary key, Postgres
  raises `23505`. So a seed replayed twice passed every test in this repo and killed the SECOND
  boot of any container on a durable store, which is why both tracked apps had (or needed) a
  hand-written `Driver` decorator over `insert`. `SeedContext.insert` now writes one
  `upsertAll(rows, { onConflict: entity.$primaryKey, onMatch: 'nothing' })` per call. Four
  properties, none optional. **`'nothing'`, never `'update'`**: `upsertPlan` refuses an updating
  upsert whose target omits the tenant column (`X_TENANCY_UNSCOPED`), and a tenant-scoped entity
  whose only unique keys are global — `posts` in the reference app — has no legal updating target
  at all; `'nothing'` also skips the uneven-batch and nothing-to-set refusals, which a fixture
  graph would otherwise have to satisfy. **One statement per call**, so the per-row `insert` loop
  this replaced is no longer the N+1 of its own bulk form. **The metrics are the driver's answer**,
  not a count of the input: `upsertAll` under `'nothing'` resolves with the rows it actually wrote,
  so `skipped` is the replay, observed. **A generated primary key the row does not name is
  refused** — `uuid().primaryKey()` carries `GENERATED_UUID`, so `$parse` fills it with a fresh
  uuid, the conflict target matches nothing and run five leaves five copies; it is the one
  duplication no other rule in this package can see.
- **`upsert(entity, { by }, values)` is the second verb, and it exists because only the SEED AUTHOR
  knows the natural key.** A seed writing into a table whose ids already exist — `banks` keyed by
  `value`, `users` by `email`, `exchange_rates` by `(base, target, effective_on)` — cannot choose a
  primary key, so keying replay on `$primaryKey` would be keying it on something Postgres does not
  enforce. It reads first so an unchanged row can answer `'skipped'` with no statement, then writes
  through ONE `on conflict … do update`: the read is for the report, never for the decision, or two
  containers booting at once would race between the two. **`createdAt` is preserved on a match** —
  the row handed to the update omits it, so `namedProperties` leaves it out of the `set` — because
  a replay must not move when a row first arrived.
- **The environment guard is the CLI's, not `run()`'s.** `seedTiersFor(environment, requested)` is
  the one table (`reference` everywhere, `dev` everywhere but production) and `x db seed` is what
  refuses. `run()` stays permissive on purpose: `dummy/social-media-clone/apps/web/api/index.ts`
  seeds its own production demo database from its boot code and says out loud that this is an app
  decision (axiom 8) — a library refusal would break it. A seed declares its tier as DATA, the way
  a `backfill()` declares its environments.
- **One resolver decides a physical name, and it is `columnName(property, meta)`** — decided
  2026-08 with `entity(name, { table })` and `.column(name)`. Before them, `snake(property)` was
  called in nine places and `$table` was the entity name, so a schema this framework did not
  generate could not be declared at all: adoption meant a rewrite. Every projection now reads the
  resolver — the DDL (`describe.ts`), the binding and the decoder (`pg-row.ts`), the predicate and
  sort resolver, the index names, the invariant SQL, the soft-delete clause in `pg-sql.ts` and
  `pg-driver.ts`. **A second `snake(property)` anywhere is a statement naming a column the table
  does not have**, and the first table that proves it is somebody's production database. It is
  additive by construction: with no override the resolver IS `snake(property)`.
- **The entity NAME and the TABLE are different things.** The name stays the framework's key — the
  registry, the cache tag (`entity:account`), `$tagFor`, every relation and every policy — and the
  table is physical. Renaming a table must never move a cache tag. Index names are the TABLE's,
  because an index is a physical object.
- **Money's three columns are per-part and `scale: null` is a real answer.** `money({ columns })`
  merges over `<base>_minor`/`<base>_currency`/`<base>_scale` one part at a time, so a table that
  renamed one does not restate the other two. `scale: null` says the table has no scale column at
  all — the ordinary shape of an amount written before scale existed — and then `columnsOf`
  projects TWO names, `bindValues` writes two, and `decodeRow` folds two. That last one is why
  `decodeRow` branches on `$meta.kind === 'money'` and not on how many names came back: reading a
  two-column amount as a non-money column handed the caller a raw minor unit where a `Money` goes.
- **A `jsonb` value is bound as TEXT and cast back, `::text::jsonb`** — and the double cast is
  load-bearing, not defensive. The driver seam refuses a plain object as a parameter
  (`X_SQL_UNSAFE`; `isBoundValue` takes scalars, `Date`, `Uint8Array` and arrays of those). With
  `$1::jsonb` the server describes the parameter as `jsonb`, Bun's `sql` JSON-ENCODES the string it
  was handed, and `{"a":1}` is stored as the JSON *string* — `jsonb_typeof` says `string`
  (measured, Postgres 17.10). Pinning the parameter to `text` first makes the client send the
  characters and the server parse them. An ARRAY is the other value that cannot cross as itself:
  Bun serialises a JS array to `x,y`, which Postgres answers with `malformed array literal`, so
  `bindValues` writes the `{…}` literal with every element quoted.
- **The wide column types were chosen from what a driver actually returns, not from what reads
  well.** `int8` is a string from Bun's `sql` and a `bigint` from PGlite; `numeric` is a string
  from both; `date` is a `Date` at midnight UTC from both; `bytea` is a `Buffer` from one and a
  `Uint8Array` from the other. Every one of those is normalised in `$parse` to a single row type,
  because a row that means two things by driver is the drift this package's two-driver split exists
  to refuse. `bigint()` and `decimal()` are STRINGS for the same reason `money.minor` is a
  `number`: `JSON.stringify` throws on a bigint, and a `number` loses digits exactly where a legacy
  `int8` key lives.
- **`setRowObserver` reports committed row changes, above the driver, so memory and Postgres report
  the same thing.** It exists because a change feed needs a SOURCE and only production has one:
  `@ultimat3/realtime` decodes the write-ahead log, PGlite has no walsender and the memory driver has
  no log at all — so `InMemoryChangeFeed`, which that package calls "the blessed development and
  test feed", had nothing upstream of it. That is what left `@ultimat3/testing`'s `subscribe` fixture
  with no driver. Rules, none optional. **One observer per process**, exactly like `@ultimat3/db`'s
  `setStatementObserver`, and it hands back what it replaced so a nested harness restores rather than
  clears. **Applied by `database()`**, not by a driver, so an app opts in by installing an observer
  and never by choosing a different repository — the rows under test are the rows the app reads.
  **With none installed it is one comparison per write**, which is why the guard is the first line of
  every method rather than a flag read at wrap time. **`before` is read only when the primary key IS
  `id`** — on a composite key `findById` cannot name a row, and an `id` column that is not the key
  would read a DIFFERENT row than the write touched; `null` there is what logical replication reports
  without `REPLICA IDENTITY FULL`, and a consumer already handles it. **A filtered write is `onBulk`,
  never silence**: `deleteWhere`/`updateWhere` name a filter and not rows, and reading the matches
  first would turn one statement into two and change what the code under test issues — so a count is
  reported and a consumer re-reads. It is NOT a second change-feed path: `selectChangeFeed` still
  decides what a real node reads, and this is never in that decision.
- **A refusal raised before any entity exists carries an EDIT, never a lookup** — `refuse.ts`,
  `As of 2026-08-22`. Both `reject()` helpers called `invariantViolated('column', rule, detail)`,
  whose fix is `x entities describe <entityName> --json`, so 34 column and invariant refusals
  emitted `x entities describe column --json` — which answers `X_DECLARATION_UNKNOWN`, because no
  entity is named `column` and at declaration time there is no entity at all. A fix line that
  raises a second, unrelated error is worse than none: the reader debugs the wrong subsystem, and
  an agent follows it literally. So the fix is a PARAMETER — `refuseColumn(rule, detail, fix)` —
  and every site names the column form the author should have written, the shape
  `arrayElementRefused` already had. **`invariantViolated`'s entity name is a value, never a
  literal**, and `refuse.test.ts` scans this package's source for one; it also holds every refusal
  to naming a call or a command, carrying no `<placeholder>`, and having a case in its own table,
  so a refusal added without a repair is a failing test. **The two builders construct their
  `EntityError` inline** rather than delegating to a shared one, because `fix-scan.ts` reads a fix
  literal only at a call site whose callee builds the error itself — a wrapper would take all 34
  fix lines back out of `x verify`'s `errors` step (measured: `checked` 1040 -> 1071).
- **Full-text search is one generated `tsvector` per entity, and the TERM is never syntax.**
  `.searchable()` on a `text()` column puts it in the vector (`search.ts`); `entity()` derives the
  column, the `generated always as (…) stored` expression and the GIN index through the existing
  `IndexInit` path. Rules, none optional. **`websearch_to_tsquery`, never `to_tsquery`**: the term
  crosses as a bound parameter either way — that is what stops an injection — but bare `to_tsquery`
  reads `&`, `|`, `!`, `<->`, `:*` and parentheses as OPERATORS, so a search box sends either a
  `42601` or a query the caller did not write; `plainto_tsquery` is safe and throws the user's own
  quotes and `-negation` away in silence. **The configuration is spliced, from a CLOSED set**
  (`SEARCH_LANGUAGES`), because `regconfig` cannot be a bound parameter inside a generated column at
  all — and `to_tsvector(text)` with no configuration is not immutable, so Postgres refuses it there.
  **`coalesce(col, '')` on every source**: `to_tsvector(NULL)` is NULL and `NULL || tsvector` is
  NULL, so one nullable column would erase the whole row's vector. **The vector column is NOT NULL**,
  which is what makes a generator that does not render the `generated` clause fail on the first
  insert (`23502`) instead of leaving a table of NULL vectors under a search that quietly answers
  nothing. **The memory driver REFUSES** (`X_SEARCH_IN_MEMORY`) rather than emulating: stemming, stop
  words and a phrase parser are not a JS token comparison, and a green unit test over a different
  question is the one outcome the two-driver split exists to prevent — the parity rule inverted, and
  `predicateSql`/`matchesPredicate` are exhaustive switches over `Operator`, so neither can be given
  a case the other lacks. **RELEVANCE is not an order this chain serves**: `ts_rank` is a computed
  value and the cursor carries columns, so `.search()` filters and the declared `orderBy` pages —
  proven over 30 tied rows in `pg-search.live.test.ts`, which also explains the GIN index and pins
  the plan the tenant predicate produces.
- **A state machine on a column is the MECHANISM only, and the line is `19-mechanism-not-convention.md`'s.**
  What ships: the transition table, the refusal of a move not in it, the ATOMICITY of check-and-move,
  the terminal-state concept, and the stamp saying when the row moved. What never ships: the states,
  an approval chain, a role that may perform a move, a side effect on arrival. **There is no enum of
  state names anywhere in this package** — `.transitions()` hangs off `enumerated()`, so the states
  are the app's own set and `TransitionTable<S>` is a MAPPED type over it: a missing state, an
  unknown key and an unknown target are compile errors against a list the framework never saw.
  **A terminal state is one whose outgoing list is empty** — derived, never declared, so "nothing
  leaves cancelled" is structural and *which* state is terminal is not the framework's business.
  **The move is ONE statement.** `from` rides in the predicate (`where id = $1 and status = $2`), so
  the state that was OBSERVED and the state that was WRITTEN are one decision made under the row's
  lock, and no rows is the refusal. A read-then-check-then-write is the same code with a window in
  it: measured against a real server, twenty concurrent callers naming `pending` produced **14
  winners** that way and **exactly 1** this way (`pg-transition.live.test.ts`). Legality is asked
  BEFORE the statement, because the table is a property of the declaration and not of the database.
  **The refusal is a read, and only ever after the decision** — `X_STATE_CONFLICT` names the state
  the row is really in, from a tenant-scoped `findById` that runs once the statement has already
  refused. Another org's row reads as absent, so the answer is `X_NOT_FOUND` and never a conflict
  that would confirm it exists. **The machine adds no DDL**: `enumerated()` already emits the CHECK,
  so there is one declaration of what a legal value is. **A machine column may not be nullable** —
  NULL is not a state, and `= NULL` matches no row, so every move out of it would read as a
  conflict. **`whyNot` asks three questions in one order** — unknown state, then terminal, then the
  legal list — because an unknown state has no outgoing moves either, and a check that skipped it
  reported a typo as "the row is terminal in `pendign`".
- Never throw a bare `Error` — use `errors.ts`.
- **Tests restore the process-global registry in `afterAll` (`clearRegistry()`), and the hook is at
  FILE scope — a build error since 2026-08-25, because the prose form was violated by 19 of the 19
  live suites that had it.** A leaked registry breaks an unrelated package's tests, as it did in
  `@ultimat3/policy`. Bun evaluates a skipped file's module body and then runs no hook inside
  `describe.skipIf(true)` (measured in `live-registry-cleanup.test.ts`), so a `clearRegistry()`
  parked in the suite's teardown — beside `drop table`, where it reads as belonging — never ran in
  the ONE configuration a live suite is never deliberately run in: **36 entities stayed registered**
  across `packages/entity/src/*.live.test.ts` with `TEST_DATABASE_URL` unset, which is every CI run
  of the unit gate. An `if (!hasPostgres) return` above the call is the same hole by a second route.
  So the cleanup is its own top-level `afterAll(() => { clearRegistry(); })` at the end of the file,
  matched on exact text by `live-registry-cleanup.test.ts`, which also refuses a live suite that
  registers on import and imports no seam. Never put it back in the teardown.

## Files

| File | Job |
|---|---|
| `types.ts` | `Column`, `RowOf`, `Insertable`, `IdOf` — the type derivation. `COLUMN_KINDS` is the runtime array `ColumnKind` DERIVES from (the shape core's `PRIMITIVE_KINDS` uses), so a package answering "one case per kind" reads a real list rather than spelling its own |
| `column.ts` / `columns.ts` | the chain + property-key binding; the blessed builders; `columnName`/`moneyColumns`, the ONE physical-name resolver; `narrowMoney`, the one write-side narrowing both drivers run |
| `columns-data.ts` | the wide vocabulary an existing schema needs: `json`, `decimal`, `date`, `bigint`, `bytes`, `arrayOf` |
| `array-element.ts` | which element kinds `arrayOf()` refuses, and the one-line edit that repairs each |
| `refuse.ts` | `refuseColumn`/`refuseInvariant` — the refusals raised before any entity exists, each carrying the EDIT that repairs it |
| `expr.ts` / `invariants.ts` | the `invariants: (c) => …` rule language; `bindInvariant` resolves property paths to physical names. No DDL — that is `@ultimat3/db`'s `invariant-ddl.ts` |
| `entity.ts` / `describe.ts` | `entity()`, `$row`; the `EntityDescription` projection |
| `index-name.ts` | what an index is CALLED — the predicate/direction/method discriminator and the 63-byte bound |
| `search.ts` | the generated `tsvector` a `.searchable()` column set derives: the closed language list, the weights, the expression |
| `state-machine.ts` | the transition table, its five declaration rules, and what a terminal state IS |
| `transition.ts` | one atomic move: the legality question, the conditional statement, the diagnosis of a statement that matched nothing |
| `enum-column.ts` | `enumerated()` and its own chain — the one builder that may declare a machine |
| `column-values.ts` | `got()` and `oneOf()`, so `enum-column.ts` needs no import of the file that imports it |
| `feature-errors.ts` | the refusals search and the state machine raise at call time; the codes and titles stay in `errors.ts` |
| `view.ts` | `$view(keys)` — the row projection an action names as its `output` |
| `query.ts` / `database.ts` | chainable read to a cursor page; `database()` + `Driver` |
| `clock.ts` | `entityNow()` — the ONE clock read on the write path, `ctx.clock` else the system's |
| `memory-match.ts` | what a `Predicate` means in the memory driver: compare/equal/LIKE, by the column's kind. The decimal comparison itself is `@ultimat3/core`'s `compareDecimalText` |
| `repo.ts` / `tenancy.ts` | `Repo<T>` + `memoryDriver`'s repo, tx rollback; `QueryPlan` + `scopedPlan()` for a read and `assertRowTenant()` for a write — one actor-derived tenant guard, both halves |
| `cross-tenant.ts` | `crossTenant(reason, fn)` — the capability-gated scope that lifts it |
| `plan.ts` / `cursor.ts` | the plan both drivers execute; the one keyset cursor codec |
| `batch.ts` | `inBatches(size)` — the chain's page in a loop, closed by the loop that reads it |
| `pg-driver.ts` | `postgresDriver()`, `postgresRepo()`, `postgresTransactor()` — attributes every statement it sends |
| `coalesce.ts` | one microtask of `findById` calls → one `where id in (…)`, per request |
| `batch-read.ts` | what a shared point read is made of — the scope key, `keyOf`, the one `in` statement |
| `bulk-write.ts` | what a many-row write is made of — the column list, the conflict plan, the bind-count chunking |
| `count-by.ts` | what a grouped count is made of — the groupable kinds, the group bound, the key's decoding, the order |
| `jit-preload.ts` | a page's foreign key values → one `in` statement for the whole `for … of` loop |
| `preload.ts` | the relation `preload()` names → one related-rows statement → attached to the page |
| `pg-sql.ts` / `pg-row.ts` | plan → parameterised SQL; physical row ⇄ entity row (money is three columns) |
| `row-observer.ts` | `setRowObserver` — committed row changes, above the driver, for a change feed that has no log to read |
| `registry.ts` | duplicate detection, `describeEntities()` for the manifest, `references()` per entry |
| `relations.ts` | `relationMap()`/`relationsFor()`/`relationNamed()` — the FKs as a named `belongsTo`/`hasMany` map |
| `n-plus-one.ts` | a repeated statement → the error whose `fix` is the preload or bulk call that ends it |
| `seed.ts` | `defineSeed` — the replayable fixture graph: `insert` (the seed's own ids), `upsert` (a natural key), the sentinel reads, and the tier table `x db seed` refuses from |
| `type-pins.ts` | compile-time assertions `tsc` checks — the column proxy, `Invariant` variance, the branded id |
| `live-registry-cleanup.test.ts` | the build error behind the registry rule above: a live suite that registers on import clears unconditionally, in a top-level hook a skip cannot swallow |

## Commands

`bun test packages/entity` · `bun run --filter @ultimat3/entity typecheck`