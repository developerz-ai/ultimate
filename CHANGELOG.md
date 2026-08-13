# Changelog

All notable changes to Ultimate. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Framework packages version in **lockstep** — a release bumps every package to the same version, in one commit, under one tag. Pin `@ultimat3/*` exactly; a mixed-version install is a combination nobody tested. See [PUBLISHING.md](PUBLISHING.md).

Semver applies from 1.0.0. A breaking change to a documented API needs a major — [Upgrading](https://github.com/developerz-ai/ultimate/wiki/Upgrading) says what "documented API" covers.

## [Unreleased]

### Changed

- **BREAKING — `invariants` is a function, and `invariant()` takes a built expression.** `invariants: (c) => [...]` receives the column proxy once, so `invariant(name, expr)` no longer carries a `(c) => Expr` builder of its own. The array form is gone; there is one way to write a rule.

  The defect it fixes: `InvariantColumns` was an index-signature type, so under `noUncheckedIndexedAccess` every `c.title` was `ColumnExpr | undefined` and **every** entity `x new`, `x g entity` and `x g resource` write failed `typecheck` until the author added `!`. Typing the proxy from the declared columns only reaches `c` when the whole `invariants` argument is context-sensitive — a per-element `invariant(name, build)` is a call TypeScript checks before `entity()`'s `C` is fixed. `InvariantColumns<C>` is now a mapped type over `C`, so `c.title` is a `ColumnExpr` and `c.titel` is `TS2551: Property 'titel' does not exist … Did you mean 'title'?`. `unique()` and `satisfies()` take `keyof C & string`, so a typo in a column *list* is caught too.

  Before:

  ```ts
  invariants: [
    invariant('post_title_not_blank', (c) => c.title!.trimmed().minLength(1)),
    invariant('post_price_non_negative', (c) => c.price!.minor.atLeast(0)),
  ],
  ```

  After:

  ```ts
  invariants: (c) => [
    invariant('post_title_not_blank', c.title.trimmed().minLength(1)),
    invariant('post_price_non_negative', c.price.minor.atLeast(0)),
  ],
  ```

  Mechanical migration: move the `[` to after `(c) => `, drop each `(c) =>` inside `invariant()`, drop every `!`. `indexes[].where` is unchanged — it was already a callback, and its `c` is now typed too. Nothing else changes: a rule still runs in the app on every write **and** emits its `CHECK`/`UNIQUE` through `toSql()`, and an untranslatable JS predicate still reports `kind: 'assert'` with `sql: null`. The runtime Proxy stays, so a JS caller still gets `no column "titel"; declared columns are …` at declaration time.

- **BREAKING — the framework's version is a call, not a constant.** `FRAMEWORK_VERSION` is gone; `frameworkVersion()` from `@ultimat3/core` replaces it, and `@ultimat3/mcp`'s `DEFAULT_SERVER_INFO` becomes `defaultServerInfo()` and `@ultimat3/cli`'s `CLI_VERSION` becomes `cliVersion()` for the same reason — a constant holding the result is the module-scope read again, one import away.

  ```ts
  import { FRAMEWORK_VERSION } from '@ultimat3/core';   // before
  import { frameworkVersion } from '@ultimat3/core';    // after — call it: frameworkVersion()
  ```

  The defect it fixes is below under *Fixed*: read at module scope, the version resolved before `main` in every process that imported core, so `x build --target binary` produced an executable that threw at import. Resolution order is manifest → build define → throw, and the throw is unchanged in the case it was written for: a manifest that exists and declares no semver is still a broken publish, still `X_INVARIANT`, define or no define. The value is resolved once and cached, so a call site pays one `existsSync` for the process.

- **`x verify` counts skips apart from passes, and names them.** A step with nothing to check here is recorded green so the run continues, and the summary counted it among the passes — so a repo whose `job` and `eval` suites do not exist printed the same `all 17 steps passed` as a repo where both ran. The line is now `12 of 17 steps passed in 53224ms — 5 skipped: job, eval, drift, contract-diff, budgets` in this repo, and `14 of 17 steps passed in 11153ms — 3 skipped: e2e, contract-diff, roadmap` in the scaffolded app of [tutorial 2](https://github.com/developerz-ai/ultimate/wiki/Tutorial-02-First-Feature); `all {n} steps passed` survives only when nothing was skipped. `--json` gains `data.skipped`, the list of names beside `data.failed` (`steps[].skipped` is unchanged). Exit codes are untouched: a skipped step is still not a failure — it is now just impossible to mistake one for a passing one.

### Added

- **`findById` batches itself — one microtask of point lookups is one `where "id" in (…)`.** A page that resolves an author per row sent one `select … where "id" = $1` per row. Inside a request, `postgresRepo()` now collects the lookups issued in the same microtask and sends one statement for all of them:

  ```ts
  // One statement, not one per post. findById's signature and its meaning are unchanged.
  const authors = await Promise.all(posts.map((post) => users.findById(post.authorId, { orgId })));
  ```

  No `dataloader()`, no `batch()`, nothing to opt into: the capability lives inside the method that already exists, which is the only place it can reach code already written. The batch is keyed by context identity — a `WeakMap`, so it dies with the request, the shape `@ultimat3/query`'s request memo has one tier up — and by a scope key covering every input to the statement except the id, so another tenant, another soft-delete visibility, another projection, another entity or another client is a different statement and never joins one. What goes out is the statement each single lookup would have been served by, `in` instead of `=`: the tenant predicate and the `deleted_at is null` clause are inside it, so an id whose row is missing, soft-deleted or another tenant's still reads as `null`. Past 500 ids it becomes several whole statements rather than one Postgres refuses for its bind count, and it declines outright — sending exactly what it always sent — with no request in scope (a job, a script), on a composite primary key, or on a scope it cannot compare. The window is one microtask and closes before the statement is sent, so a sequential `for … of` loop shares nothing through this path — what batches one is the sibling preload below. Proved against a real Postgres in `pg-driver.live.test.ts`: five lookups, one statement, the same five answers.
- **A `for … of` loop over a page is two statements — the sibling-aware preload.** A microtask window cannot see a sequential loop: its `await` closes the window before the next lookup exists. `findMany` now leaves its page's foreign key **values** behind for the request, so the first `findById` for any one of them resolves that key for **every** row of the page in one statement and the rest of the loop is served from memory. On by default; `postgresDriver({ jitPreload: false })` is the one switch that turns it off, where the driver is already constructed — not an `app.config.ts` key, because nothing reads config at the seam that builds a repository and a switch the framework cannot read is a switch that does nothing:

  ```ts
  const page = await posts.findMany({ orgId });
  for (const post of page.rows) {
    // Two statements for the whole loop: the page, then one `select … where "id" in (…)` over
    // every author on it. Every lookup after the first is memory.
    const author = await users.findById(post.authorId, { orgId });
  }
  ```

  Nothing new to write — the relation is the `references()` already declared, and `findById` keeps its signature, so the fix reaches loops that are already written. The scope guard is a security boundary, not a tuning knob: a preloaded row is served only to a lookup with the same scope key the batch above uses (tenant predicate, soft-delete visibility, projection, entity), the same client, and no write to that entity since — anything else reads the statement it always read. The preload statement is that same statement widened to the page's ids, so its tenant predicate and `deleted_at is null` clause are in the SQL Postgres runs; a page's ids can therefore never resolve rows outside the reader's own scope. The index holds values and not rows, keyed by context identity, so it pins nothing and dies with the request; a page of a hundred rows by one author is still one bind; a nullable key that resolved to nothing is not a row to go looking for; past 500 ids it becomes whole statements; and with no request in scope (a job, a script) a page leaves nothing behind at all.
- **`preload(name)` — the join a `for … of` loop would have earned, without writing the loop.** The two paths above catch a lookup pattern already written; `preload()` is the same join, named on the chain instead of triggered by a loop:

  ```ts
  export const db = database({ orgs, posts, members });

  // Two statements: the page, then one `select … where "id" in (…)` over its authors.
  const page = await db.posts.where({ orgId }).preload('author').page();
  page.rows[0].author;        // the member row, or null — always present
  ```

  One vocabulary, `preload('<relation>')` — no `include`, `join` or `with`, and nothing new to declare: the name is the `references()` already written, resolved by `relationNamed()` when `preload()` is called, so an unknown one is `X_PRELOAD_UNKNOWN_RELATION` on the chain and not a page later. A `belongsTo` attaches the row or `null`, a `hasMany` an array — always present, so "no author" and "nobody preloaded the author" never read the same. Several `preload()` calls resolve concurrently, never one after the other, and naming one relation twice is one statement; keys are chunked at `MAX_IDS_PER_STATEMENT` (500) exactly as a coalesced point read already is, so past 500 keys a relation costs several statements rather than one Postgres refuses for its bind count, and a relation with more rows than one page holds costs another keyset page rather than a silent truncation. The page's own tenant predicate carries onto the related read only when the other entity's tenant column has the same name — a value that scopes one entity is a guess on another, and a guess here is a cross-tenant read — so a differently-named tenant column carries nothing, and carrying nothing is not silent: the related read builds its own plan and `assertScoped` refuses it there as `X_TENANCY_UNSCOPED`. The related read is `findMany`, so `deleted_at is null` applies exactly as it does anywhere else. Attached to a copy of each row — `{ ...row }`, because the in-memory driver hands back the row it stores — after `select()`, which is widened internally with the relation's local key so a projection can drop neither the key a preload reads nor the relation it attaches; `plan().select` reports the widened list. `page()`, `all()` and `one()` preload; `count()` and `plan()` do not, since a count reads no rows. A table reaches only the entities its own `database()` call named, through the driver that call was given, so a preload against memory means what a preload against Postgres means — a relation whose other end is outside the set is `X_INVARIANT_VIOLATED` naming the `database({ … })` call that fixes it, and `tableFor(entity, repo)` built by hand reaches no other table. `preload('author')` returns `ReadBuilder<Row & { readonly author: unknown }>` — `unknown`, not a generated type, because the name is a string resolved at runtime and the row on the other side is parsed by its own entity.
- **`insertAll(rows)` and `upsertAll(rows, { onConflict })` — the write loop, as one statement.** Three bullets above make a read loop stop being N statements; a loop of `insert()` calls still was. Both land on `Repo`, on `Table` and on **both** drivers:

  ```ts
  // One `insert into … values (…), (…), (…) returning *`, not three round trips.
  await db.tags.insertAll(names.map((name) => ({ orgId, name })));

  // The like nobody can like twice, without a read to find out first.
  await db.likes.upsertAll(rows, { onConflict: ['orgId', 'postId', 'memberId'], onMatch: 'nothing' });
  ```

  `insertStatement` builds every insert in the framework now, one row or ten thousand, so `insertAll([row])` compiles to the text `insert(row)` always compiled to and there is no second builder for the two to drift apart in. Rows are `Insertable`, parsed by `$parse` exactly as one row is — declared defaults are filled here, not by the caller — and `upsertAll` also stamps `onUpdateNow()` columns through `touch()`, the one place that happens, because an upsert that lands on a stored row *is* an update. The result is the rows the call actually **wrote**: under `onMatch: 'nothing'` a row already stored is skipped and absent, which is what `returning *` says on the server and is therefore how a caller counts what it inserted. A collision overwrites every column in the batch except three closed sets — the conflict target, which is how the stored row was found, the primary key, which is where it lives, and the soft-delete stamp, which is whether the row is there at all; moving either of the first two would move a row nobody asked to move and every foreign key pointing at that id would miss it, and writing the third would bring back a row the app had deleted. A soft-deleted row still occupies its conflict target — the unique index it collides with is not partial — so `excluded."deleted_at"` is the resurrection `update(id, patch)` and `updateWhere` both refuse by carrying `deleted_at is null`, which an `on conflict` clause cannot carry; it is dropped from the set list rather than refused, because `$parse` fills `deletedAt: null` into every row before the plan is built, so that value is the framework's and not the caller's. `insertAll` is untouched: a row that collides with nothing writes the stamp it carries, exactly as `insert` does. Past Postgres's 65535 bind parameters the batch becomes several whole statements rather than one the server refuses, so an all-or-nothing caller wraps the call in `withTransaction`. Four refusals precede the statement, each of them a `42P10`, a cross-tenant write or a silent surprise otherwise: a conflict target no declared unique constraint matches, a target that omits the tenant column under `onMatch: 'update'` (`X_TENANCY_UNSCOPED` — another tenant's row would match and be rewritten, so an updating upsert must be scoped by the constraint itself), a batch that repeats one conflict target under `'update'` (Postgres answers that `ON CONFLICT DO UPDATE command cannot affect row a second time`), and a batch whose rows name different columns under `'update'`, where `excluded.<column>` is that column's default and not "leave it alone". The in-memory driver answers all four the same way and judges the whole batch before storing any of it, so a test that passes against memory still says something about Postgres — including `NULLS DISTINCT`: a null in the conflict target collides with nothing, there and here.
- **`inBatches(size)` — reading a whole table is a terminal on the chain, not a loop around `page()`.** A page is bounded on purpose, so every backfill, export and reindex hand-rolled the cursor loop, and the hand-rolled ones are where an `offset` creeps back in. `ReadBuilder` now ends in one:

  ```ts
  // One statement per batch, one page of rows in memory at a time.
  for await (const batch of db.posts.where({ orgId }).preload('author').inBatches(500)) {
    await search.index(batch);
  }

  // Stopping early keeps the position, so a job resumes where it ran out of time.
  await using batches = db.posts.where({ orgId }).after(checkpoint).inBatches(500);
  for await (const batch of batches) {
    await search.index(batch);
    if (ctx.clock.now() > deadline) break;
  }
  await db.checkpoints.update(id, { cursor: batches.cursor });
  ```

  A batch **is** the page `page()` would have returned at that position — same filters, same tenancy, same soft-delete visibility, same `select()`, same `preload()` — so there is no second read path to learn or to drift, and both drivers inherit it from the one they already share. The handle is the iteration: `break`, `return`, a throw and `await using` all stop the *next* statement (`close()` is the generator's own `return()`, so it is idempotent by construction), a second `for await` continues it rather than re-reading the table from the top, and an empty batch is never yielded. `.cursor` is where the next batch starts and advances before the yield, so a consumer that breaks reads the position it stopped at and `.after(cursor)` resumes it. Three refusals land on the chain instead of one batch later: a size that is not a whole number of rows, a chain that also called `limit()` — one number with two meanings, and honouring it reads a fraction of a batch while dropping it reads the whole table the caller thought they had bounded — and an ordering no cursor can carry, which is the one that matters most: a nullable sort column mints no cursor when the result fits in a single batch, so it would pass every test and fail once the table grew.
- **`countBy(column)` — a `count()` per row is one grouped count.** Recounting a page of posts' likes sent one `select count(*)` per post, and no batch above reaches those: each of them asks a different question. This asks all of them at once, on `Repo`, on the chain and on **both** drivers:

  ```ts
  // Before: one statement per post.
  for (const id of ids) {
    const likeCount = await db.likes.where({ orgId, postId: id }).count();
    await db.posts.update(id, { likeCount });
  }

  // After: one statement for every post in `ids`.
  const counts = await db.likes.where({ orgId }).andWhere('postId', 'in', ids).countBy('postId');
  for (const id of ids) await db.posts.update(id, { likeCount: counts.get(id) ?? 0 });
  ```

  It counts the whole predicate and never the page, exactly as `count()` does: the chain's filters, its tenancy (`X_TENANCY_UNSCOPED` on a tenant-scoped entity with no org predicate) and its `deleted_at is null` visibility are all in the statement, and `limit()`/`after()` bound it no more than they bound a `count()`. **A value nothing matched is absent, never `0`** — that is what `group by` returns, and it is what lets a caller tell "none" from "never asked"; the default is the caller's `?? 0`. **NULL is one group**, keyed `null`, in both drivers: in memory a property the row never carried is `?? null`, so it lands in the group Postgres files its NULL rows under, while `0`, `''` and `false` stay the values they are. Entries come back biggest group first, ties by the value — numbers and bigints numerically, everything else by its text — and `null` last; the order is applied in `count-by.ts` after the rows are in rather than in the statement, because a hash aggregate returns groups in whatever order it built them and a `Map` filled row by row returns insertion order, so an `order by` there would let the two drivers disagree about a result they agree on. Groupable columns are a closed set — `uuid`, `text`, `char`, `boolean`, `integer`, `bigint` — and a `timestamptz`, a `jsonb` or `money` is `X_INVARIANT_VIOLATED` whose `fix` names a column of that entity that *is* groupable: a `Map` compares a non-primitive key by identity, so such a map could only ever answer `undefined`. The number of groups is bounded at `MAX_GROUPS` (1000), and going past it is a **refusal, not a truncation** — the statement asks for one group more than the bound, the trick a page already uses when it reads one row past its limit, and that extra group fires `X_INVARIANT_VIOLATED` spelling `andWhere('<column>', 'in', <values>).countBy('<column>')`, because a map that silently lost its tail reads exactly like a complete one and a caller recounting from it would write the wrong number to every row it missed. One statement: `select "post_id" as group_value, count(*) as group_count from "likes" where … group by "post_id" limit $n`. Both output names are fixed aliases, so they cannot collide with each other whatever the table declares — an entity is free to have a column called `count` — and the grouped value is re-parsed by the column that declared it, since `int8` arrives as a string and would otherwise key the map by text where the in-memory driver keys it by a `bigint`. No new error code, no `groupBy()` builder, nothing to declare: it is a terminal on the chain that already exists. Pinned in both drivers — in memory, and against the recording client.
- **`relationMap()` — the foreign keys an entity already declared, readable at query time.** `ColumnMeta.references` was resolved in exactly one place, `describe.ts`, to spell a DDL constraint; at query time nothing could answer "what is a post's author". `@ultimat3/entity` now derives a named map from the same thunks — `belongsTo` from an entity's own foreign keys, `hasMany` from the inbound ones:

  ```ts
  relationMap().posts;
  // { org:    { kind: 'belongsTo', to: 'orgs',    localKey: 'orgId',    remoteKey: 'id' },
  //   author: { kind: 'belongsTo', to: 'members', localKey: 'authorId', remoteKey: 'id' },
  //   likes:  { kind: 'hasMany',   to: 'likes',   localKey: 'id',       remoteKey: 'postId' } }

  relationsFor('posts');              // one entity's relations
  relationNamed('posts', 'author');   // one relation, or X_PRELOAD_UNKNOWN_RELATION listing the rest
  ```

  No new declaration syntax, and there will not be one: a `hasMany: […]` init key would be a second copy of a fact the foreign key already states, free to drift from the constraint the migration emits. `local*` is always a property of `from` and `remote*` of `to`, so a traversal reads the same in both directions. Names come off the key (`authorId` ⇒ `author`) and, for a `hasMany`, off the entity the rows come from; when two keys want one name **every** member of that group takes its long form (`author`/`authorId`, `postsByAuthor`/`postsByReviewer`), so adding a second foreign key never renames an existing relation by declaration order. Two keys differing only by an `Id` suffix are `X_INVARIANT_VIOLATED` naming both columns, never one relation swallowing the other. A money column declares no relation, since one property is two physical columns.

  The relations reach query time through the registry, not through a list the caller assembles: `RegistryEntry` gains `references()`, the resolved records, and `ColumnDescription.references` is now *rendered* from them, so the `"<table>.<column>"` string a migration reads and the record a traversal reads cannot disagree. It is a method because a `references()` thunk may point at an entity two modules of an import cycle have not finished evaluating. `relationMap()` memoises against a registry generation, so a schema module imported late rebuilds the map instead of being missed by it; `relationsOf(entries)` is the same derivation over a named subset. A name that resolves to nothing is `X_PRELOAD_UNKNOWN_RELATION`, and its `fix` is a `relationNamed()` call on one that does exist with the rest named after it — they are derived, so there is no schema file listing them to go and read; an entity with no foreign key at all gets `x entities list --json`, since the declaration it needs names a target the error cannot know. Additive — nothing consumes the map yet; a preload is what will.
- **`x.verify.json` — the suite floor, so a step that once applied must keep applying.** Counting the skips made a vacuous gate visible; nothing made one fail. Delete a suite and its step goes from passing to skipped, and `x verify` still exits 0. The floor is this repo's committed claim about which steps it already runs — hand-written, read by the gate, written by nothing, because a gate that edits its own floor ratchets both ways:

  ```json
  {
    "steps": [
      "typecheck", "lint", "boundaries", "filesize", "package-shape", "errors",
      "unit", "contract", "live", "e2e", "manifest", "roadmap"
    ]
  }
  ```

  A step named there that reports nothing to check is recorded **failed and not skipped**, with `X_VERIFY_SUITE_VANISHED` and both edits that resolve it — so it lands in the failure count, in `data.failed`, and in every step table another gate parses. Not a breaking change for an existing app: a repo that commits no floor is not ratcheted and behaves exactly as before. A floor naming a step the gate does not run enforces nothing and is refused by the `manifest` step (`X_CONFIG_INVALID`), because a typo covering no suite is the same false green. This repo's own floor pins 12 of 17; `job`, `eval`, `drift`, `contract-diff` and `budgets` are the honest skips.
- **`setStatementObserver()` — the seam a statement-level diagnostic installs into.** `@ultimat3/db` emits no span, no counter and no log for a statement, so nothing above it can count one: the dev timeline's `repeatedSql` groups span names and has never seen a repository read, which makes an N+1 invisible by construction. The seam is one process-wide observer, the `setDbClient` shape, with a `StatementEvent` carrying `{ text, values, durationMs, rows, error?, attribution?, expected? }`:

  ```ts
  setStatementObserver({ onStatement: (e) => ledger.count(e.text) });
  setStatementObserver(undefined);   // production, and what every test must leave behind
  ```

  `attribution` — the `{ entity, op }` pair that lets a report read `50× findById on members` instead of 50 copies of one `select` — is produced, `As of 2026-08`: `@ultimat3/entity`'s `postgresRepo` is the one producer, the last caller that still knows both once the SQL exists, and it wraps every repository method around its send through `withStatementAttribution()`. Hand-written SQL, a migration, a health probe and `@ultimat3/jobs`' own queue statements still carry none — nothing above them knows an entity to name — which is why the field stays optional rather than required.

  Uninstalled costs one property read and one branch, which is why the accessor hands back the installed observer itself instead of notifying through a wrapper: no event object is built for nobody to receive (axiom 6). One observer, not a list — a second install replaces the first, so "which diagnostic saw this statement" is never order-dependent, and the one consumer that needs several composes them itself, where that order is reviewable. A throw from `onStatement` reaches whoever ran the statement, deliberately: strict test mode is an observer that fails the test its N+1 happened in, and containment here would make that impossible.

  It is invoked from the two funnels every statement already passes through, and from nowhere else: `runOn` in `client.ts` — pooled and pinned alike — and `statement()` in `pglite.ts`, which is the queued path, the pinned path and the in-transaction path that skips the queue. Both settle paths notify, so a statement that failed is reported with `rows: 0` and the `X_DB_UNAVAILABLE` its caller is about to be thrown: fifty identical timeouts are still fifty statements. `rows` is the count `execute()` answers with, off the same helper, so the report and the return value cannot disagree about one statement. Reserving a connection, booting PGlite and closing a pool are not statements and emit nothing.

  **Installing an observer is also what puts the database in the trace.** Both funnels now open one span per statement around the send alone — named `db.<verb>` (`db.select`, `db.begin`; a text opening with a comment is `db.statement`), OTel kind `client`, carrying the statement under `STATEMENT_ATTRIBUTE` (`db.statement`), now exported from `@ultimat3/db` so the CLI's recorder imports the key instead of restating it — a third copy of that string is a rename that leaves the timeline grouping nothing with every test still green. That is the attribute `x dev`'s recorder already preferred over the span name, and `db.` joins `query.`/`cache.`/`job.` in the prefix table that gives the `/_x` timeline its kind — so a request's flame gains the DB children `packages/http/src/pipeline.ts` has claimed since 1.0, and `repeatedSql` counts one SQL text fifty times instead of one `query.feed` once. It is one switch, not two: with no observer installed the branch that skips the event skips the span, so a production process mints no span id and allocates no span object for the hottest path it has.

- **`expectedQueryLoop(reason, fn)` — the one way to say a loop of queries is deliberate.** Some loops are optimal and a detector counting repeats cannot know which: the admin's cross-entity search issues one indexed lookup per text field because the query IR is a conjunction and three small indexed reads beat one unindexed `OR`, and `migrate()` applies one migration per transaction because a failure has to leave the ledger describing exactly what ran. Both are now declared at source, in the loop, with the argument for it:

  ```ts
  return expectedQueryLoop('admin search runs one indexed lookup per text field', async () => {
    for (const field of fields) hits.push(...(await repo.list({ where: [match(field)] })));
    return hits;
  });
  ```

  One mechanism, and deliberately not two: no comment pragma, no config list of exempt call sites, no per-code threshold table (axiom 1) — each of those puts the argument somewhere other than the loop it defends, where the next reader will not find it. `reason` is required and non-blank (`X_INVARIANT` otherwise), because an exemption with no argument is a pragma with extra steps.

  The scope rides an `AsyncLocalStorage`, so it survives every `await` at any depth and two loops running at once never read each other. Both funnels stamp the innermost reason onto the `StatementEvent` as `expected` at settle time — captured with the statement rather than read later, because a diagnostic that judges a whole request judges it after every scope in it has closed. What is suppressed is a **verdict**, never a statement: the SQL is still sent, still observed, still a span on the trace, so everything that measures still sees the loop and only the thing that warns is told the author already answered. Production is unchanged: the reason is read inside the branch that already checks for an installed observer, so an app with no diagnostic pays nothing.

- **`withStatementAttribution(entity, op, fn)` — the `{ entity, op }` pair behind `StatementEvent.attribution`, produced.** The field shipped with `setStatementObserver()` (above) and no producer: every event in every running process read `attribution: undefined`. `@ultimat3/entity`'s `postgresRepo` is now the one producer — the last caller that still knows both once the SQL exists — and every repository method wraps its send:

  ```ts
  const attributed = <T>(op: string, send: () => Promise<T>) =>
    withStatementAttribution(entity.$name, op, send);

  async findById(id, options) {
    const op = 'findById';   // the same string idPlan(entity, id, options, op) reports on refusal
    return attributed(op, () => coalesceFindById(entity, client(), plan, shapeOf(args), id) ?? one(plan, args));
  }
  ```

  A scope, not a parameter: the statement leaves several frames and at least one microtask below the repository call that caused it — the coalescer flushes its batch from a `queueMicrotask`, a wide write is a chunked loop, a preload sends through `readByIds` — and threading a parameter through all of those is the same fact written five times, with every path an author forgot it emitting unattributed SQL instead. `withStatementAttribution` rides an `AsyncLocalStorage`, `expectedQueryLoop`'s own shape, so it survives every one of those `await`s; nesting keeps the innermost pair for the same reason `expectedQueryLoop` keeps the innermost reason — a relation preloaded during `findMany` reads through the *related* repository, so its statement is attributed to the related entity and its own operation, never to the read that triggered the preload. `findById`'s coalesced batch is flushed from a microtask scheduled inside the scope, so the one statement sent on behalf of fifty lookups carries the pair every one of those fifty would have carried.

  With no observer installed the scope is never entered — one property read, one branch, no object allocated, on the path every statement in the process takes (axiom 6), which is also why the pair arrives as two strings rather than a `StatementAttribution` literal: a literal at the call site would be allocated before the branch could decline it. An observer installed *during* `fn` therefore sees the statements that follow unattributed — installation happens once, at boot. Both funnels call `statementAttribution()` inside the branch that already found an observer, next to `expectedQueryLoopReason()`, and stamp it onto the event on **both** settle paths — the same argument as `expected`: a diagnostic that judges a whole request runs long after every scope in it closed. Hand-written SQL, a migration, a health probe, `x db` commands and `@ultimat3/jobs`' own queue statements stay unattributed — nothing above them knows an entity to name, which is why the field stays optional and a detector must still fall back to the statement text. Additive — nothing reads `attribution` yet; the N+1 detector is what will.

- **`x dev` counts repeated statement shapes per request — and it is the only process that does.** `x dev` now installs a `StatementObserver` at boot, next to the span exporter and for the same reason: an installed observer is the single switch that turns statement instrumentation on at all, so the `/_x` timeline's SQL rows and the repeat counts arrive together instead of through two toggles. `serve.ts` installs neither — a production process still pays the one `undefined` branch the seam costs uninstalled, and nothing more (axiom 6), which is the same line `serve.ts` already draws for `/_x` itself.

  The visible half is immediate: **`/_x/timeline` has DB children.** Before this, no process in the framework installed an observer, so `@ultimat3/db`'s funnels opened no span, the panel's `repeatedSql` grouped span names, and a repository loop was invisible in the one panel built to show it. A `x dev` trace now carries one `db.<verb>` span per statement with the SQL under `db.statement`.

  The ledger behind it counts one shape per request. A shape is `entity.op` when the statement is attributed — `members.findById` fifty times is the report an author can act on, and the SQL is one sample of it — and the statement's own text, whitespace collapsed, when it is not. Counting state hangs off the request's own `Ctx` in a `WeakMap`, so it is collected with the request and never swept, and a statement issued outside a request (a migration, a boot probe, a script) is not counted at all: "five of one shape" only means something inside one unit of work. Five is the default threshold, a shape is promoted to a verdict exactly once — a loop of fifty is one verdict reading `count: 50`, not forty-six verdicts — and the verdict list is bounded so a dev server up for a week retains the recent loops rather than every loop it ever saw. `expectedQueryLoop` silences the verdict and nothing else: the statement is still sent, still observed and still a span, because that scope suppresses a judgement and this ledger *is* the judgement. A statement that threw still counts — fifty identical timeouts are fifty statements, and a detector that went quiet there would go quiet exactly when the loop cost the most.

  What renders those verdicts is the entry below: the ledger counts and warns once, and the four surfaces read one projection of it.

- **`X_N_PLUS_ONE_QUERY` and `X_N_PLUS_ONE_WRITE`, whose `fix` is a line that already compiles.** Both are owned by `@ultimat3/entity`, because the fix speaks that package's vocabulary — `preload`, `insertAll`, `updateWhere` — and a code owned by the process that detects loops would put the one sentence an author acts on in a package the entity layer cannot see. `nPlusOne(loop)` takes a ledger's verdict and returns the error; it counts nothing, holds no threshold and installs no observer.

  ```ts
  nPlusOne({ kind: 'read', subject: 'members.findById', count: 50, entity: 'members', op: 'findById' });
  // X_N_PLUS_ONE_QUERY: a read repeated once per row
  //   cause: members.findById ran 50 times in one request — one read per row
  //   fix:   db.posts.preload('author')   # one statement for the whole page
  ```

  The relation in that `fix` is **derived, never invented**: `preloadsFor(entity, op)` reads the same `relationMap()` `preload()` resolves against, so the pasted line resolves against the schema that produced the loop. The operation picks the side — a point lookup per row is the `belongsTo` edge (`posts.preload('author')`), a filtered read per row the `hasMany` edge (`posts.preload('comments')`) — and every other operation falls back to the batched form of the statement that repeated, `db.members.andWhere('id', 'in', ids).all()`. Edges are read by their `to` end, because the loop repeated on the entity being *looked up* and the ledger only ever saw the statement, never the `for … of` above it: two entities may both reference it, so both pages are named, the first pasteable and the rest after it, exactly as `X_PRELOAD_UNKNOWN_RELATION` spells its names. A write loop names the bulk form of the same call — `insertAll(rows)`, `updateWhere(filter, patch)`, `deleteWhere(filter)`, and both of the first two when the operation has no single bulk form of its own — and hand-written SQL, which is attributed to no entity, names the statement's own `any($1)` form instead of a chain that does not exist.

  A schema whose relations cannot be named still reports the loop it was asked about: `relationMap()` throws `X_INVARIANT_VIOLATED` on two foreign keys it cannot tell apart, and a diagnostic that let that escape would replace the N+1 with a schema complaint the loop did not cause — in a dev process, as an uncaught throw — so the derivation falls back to the `in` form. Neither code is ever thrown and neither carries a flag to turn the warning off: `expectedQueryLoop(reason, fn)` from `@ultimat3/db` is the one way to declare a loop deliberate, and it silences the count upstream of the error rather than answering it.

- **A loop in `x dev` reaches four surfaces, and no surface counts a second time.** The ledger's verdicts now arrive wherever a diagnostic is already read, through the channels that already existed:

  | Surface | What it shows |
  |---|---|
  | `x dev` findings | the verdict as a `Finding`, located by request id — text and `--json` render it for free |
  | `/_x/timeline` | `nPlusOne`, the loops of the request on screen, beside the flame that drew them |
  | the browser overlay | the same code/cause/fix under the error, on the page the author is looking at |
  | the log | one `logger.warn` per request per code, carrying `requestId`/`traceId` automatically |

  **One detector, four renderers.** `statement-loop.ts` in `@ultimat3/cli` is the single projection: it hands a verdict to `nPlusOne()` and every surface reads what comes back, so the `fix:` the timeline prints is the `fix:` the terminal prints is the `fix:` in the log. The count is read when a surface asks, not frozen at promotion — a loop of fifty reads `ran 50 times` — while the log line names the count at the moment the threshold was crossed, because that is when it was emitted.

  The timeline keeps **two** fields on purpose. `repeatedSql` stays what it was, a measurement over the recorded trace: every SQL text that appeared twice. `nPlusOne` is the verdict, counted per request with attribution applied and `expectedQueryLoop` honoured. A measurement that started warning would be a second detector — blind to a declared loop, grouping fifty point lookups by their bind values — disagreeing with the one whose `fix:` an author pastes. A host that installed no ledger gets `null` there, never `[]`: "nobody counted" is not "this request was clean".

  New seam, dev-only: `ServerHooks.devNotices` in `@ultimat3/http`, called **inside** the `config.dev && wantsOverlay` branch and nowhere else, so a production process and an agent asking for `problem+json` never pay for it. `OverlayNotice` is declared structurally there for the reason `AuthzDecision` is — tier 2 can never import the package that owns the codes. `x dev` is the only host that supplies one; `serve.ts` boots through the same `startRoles` and passes nothing.

- **`statements` — the fixture that fails a test on its own N+1.** A warning in a dev server is a warning nobody is looking at during CI. Destructuring `statements` installs the detector in **throw** mode for the length of one test, and the loop's fifth statement rejects where it was issued:

  ```ts
  import { expect, test } from '@ultimat3/testing';

  test('the feed reads its authors once', async ({ statements }) => {
    await renderFeed();                              // a per-row findById throws here:
    //   X_N_PLUS_ONE_QUERY: members.findById ran 5 times in one request — one read per row
    //   fix: db.posts.preload('author')   # one statement for the whole page
    expect(statements.count('posts.findMany')).toBe(1);
  });
  ```

  Opting in is naming it: a fixture nobody destructures is a fixture nobody built, so there is no `strict: true` to remember and no suite-wide switch to forget. The threshold is `N_PLUS_ONE_THRESHOLD` from `@ultimat3/entity` — the same number `x dev` warns at, now exported, because a loop that fails a test and a loop that warns in dev have to be the same loop — and the error is `nPlusOne()`'s, so the `fix:` names the `preload()` the schema's own relations spell.

  Two differences from the dev ledger, both deliberate. **The unit of work is the test, not the request**: the ledger keys its tally on the `Ctx` object and ignores a statement issued outside a request, and a unit test calling `posts.findById(id)` with no request anywhere is exactly the loop it was written to catch. **It throws once per shape and keeps counting**, so a test that catches the error gets one failure at the statement that crossed the threshold rather than one per statement after it — and `statements.all()`, `.count(fingerprint?)` and `.shapes()` still measure the whole loop, expected statements included. `expectedQueryLoop(reason, fn)` remains the one way to declare a loop deliberate: it suppresses the verdict, never the measurement. The seam is handed back on disposal like `network` and `runJobs` — the observer that was installed before, not a fixed default.

- **`statementFingerprint()`, `statementKind()` and `statementVerb()` from `@ultimat3/db`.** What shape a statement is — `entity.op` when attributed, its own whitespace-collapsed text when not; read or write from the leading verb — is now one rule next to the `StatementEvent` it reads, rather than a copy per detector. `x dev`'s ledger and the `statements` fixture group by the same identity by construction, and `statementSpanName` reads its verb from the same scanner.

### Fixed

- **A row with a money column can be returned from an action again — `Money` is one declaration, and its `minor` is a `number` everywhere.** The framework carried three structural restatements of one shape: `Money` in `@ultimat3/money`, `MoneyValue` in `@ultimat3/schema`, and a third in `@ultimat3/entity` whose `minor` was a `bigint`. The third was not a stylistic difference. `JSON.stringify` throws on a bigint, so returning a decoded row from an `action`, a `query`, a job payload or an MCP tool result **crashed the response**; `t.money` — the node that becomes the OpenAPI contract — rejected the row this framework's own driver produced; and `@ultimat3/realtime` normalised the *same column* to a `number`, so two readers of one column disagreed about what it held.

  `number` is the decision, and it is the one every other surface already made: `@ultimat3/money`'s whole arithmetic, allocation and `Intl` surface, `t.money`'s IR, `@ultimat3/ai`'s budgets, `@ultimat3/ui`'s `<Money>`, `@ultimat3/admin`'s widgets, the `x new` scaffold and this repo's own root convention. `@ultimat3/schema` (tier 0 — the only tier every package may import) now owns the single declaration; `Money` and `entity`'s `MoneyValue` are **aliases** of it, so a row a `money()` column decodes *is* a `Money` and goes to `add()`, `formatMoney()` or `<Money>` with no cast.

  What the wide column bought is kept, honestly. `<name>_minor` is still `bigint`, and a stored value past ±2^53 — written by a psql session, a backfill, another service — is now **refused where it is read** (`X_INVARIANT_VIOLATED`, naming the value it could not carry) rather than rounded into the row or carried as a bigint that crashes three layers later. That is the same refusal `@ultimat3/realtime` already made, so the two readers agree.

  Additive on the write side: `MoneyInput` still takes a `bigint | number`, so a minor unit read straight off a `bigint` column reaches an insert with no conversion at the call site. `narrowMoney` is called by **both** drivers — `bindValues` before a statement, `memoryRepo`'s `write` before it stores — so a row's money never depends on which driver produced it; previously the in-memory driver stored the caller's bigint verbatim and produced the one row in the framework `JSON.stringify` refused.

  `Money.minor` and `Money.currency` are now `readonly`, which the type's own documentation had asked for and nothing enforced. Type-only, and pinned in `packages/entity/src/type-pins.ts`: re-declaring the alias, widening `minor` back to a `bigint`, or dropping either `readonly` is a build error rather than a review comment.

- **A rotating-address scan can no longer grow a rate limiter until the process dies.** Both in-memory limiters keyed a `Map` by the connection address and never removed an entry: `@ultimat3/http`'s `memoryRateLimitStore` only deleted on an explicit `reset(key)`, and `@ultimat3/auth`'s `createAuthLimiter` only on a successful login. A scan walking an IPv6 /64 mints a fresh key per request against both, so the table grew for as long as the scan ran — the throttle that exists to survive a flood was the thing the flood consumed. Neither had a sweep, and neither had a cap.

  Both now hold one rule: **an entry that answers exactly as a missing one is forgotten, not evicted.** Each entry carries the instant it reaches that state — a token bucket back at capacity, or an auth key whose failure window has emptied *and* whose lockout has expired — and a sweep drops everything past it. That alone flattens a scan: a one-request bucket on the default route refills in half a second.

  The cap is the backstop for what the sweep cannot claim, and it decides *which* live entry goes with the same care, because getting that backwards is a rate-limit bypass. The entries nearest to being forgotten anyway go first, so the most-throttled key is the last to go — and in `@ultimat3/auth` a live lockout outranks its own deadline, so filling the table is not a way to buy back attempts against the account you just locked:

  ```ts
  memoryRateLimitStore({ maxKeys: 20_000 });                      // DEFAULT_MAX_RATE_LIMIT_KEYS
  createAuthLimiter(clock, { ...DEFAULT_AUTH_RATE_LIMIT, maxKeys: 10_000 });
  ```

  Defaults are `DEFAULT_MAX_RATE_LIMIT_KEYS` (20,000 — an http key is `route|subject`, so one subject throttled on N routes is N entries) and `DEFAULT_MAX_AUTH_LIMIT_KEYS` (10,000 — an auth key is one identity). A few megabytes, held, instead of an unbounded map. Both are also observable now: `memoryRateLimitStore()` and `createAuthLimiter()` return their interface plus a `size`, so the bound is something a test can assert rather than something a comment claims. Sweeping is amortized — a sort is paid once per 10% of the cap, never per request — and a key that is dropped throttles again from a clean bucket, never a half-written one. Nothing about the decisions themselves changed: same buckets, same window, same lockout, same headers.

- **`{constructor}` in a translated string no longer renders a function's source into the page.** `interpolate` read a variable as `vars?.[name]`, an ordinary property access, so every member of `Object.prototype` was a variable a catalog could reach: `{constructor}` rendered `function Object() { [native code] }`, `{toString}`, `{valueOf}` and `{hasOwnProperty}` rendered their own source, and `{__proto__}` rendered `[object Object]` — all through the path that is supposed to render `⟦name⟧` for anything the caller did not pass. Only an **own** property is a variable now, which is the guard `catalog.ts` already applies from the other side by nesting keys into null-prototype nodes. A caller that genuinely passes `{ toString: 'ok' }` still gets `ok`.

  The same function's fast path returned early on a template with no `{`, which skipped `}}` un-escaping — so one escape had two meanings: `'{{a}}b'` collapsed to `'{a}b'` while `'a}}b'` came back untouched. It now tests both braces.

- **One bad date no longer takes the whole feed down.** `buildFeed` parsed item timestamps straight into `new Date(...).toISOString()`, so a `published` that would not parse — a CMS column holding prose, a hand-typed front-matter line — reached `toISOString()` as `NaN` and threw a bare `RangeError` out of the feed route. The same line spread its work into `Math.max(...times)`, one argument per item, so a feed that grew past the engine's argument limit crashed in proportion to how well the blog did; and the empty-feed branch called `Date.now()` directly, the one clock read in the package no test could freeze.

  All three are gone. `feed-dates.ts` is now the only place a feed timestamp is parsed or formatted, `buildFeed` resolves every date once, and the three builders only ever see instants:

  ```ts
  const feed = buildFeed(channel, [{ ...post, published: 'sometime last spring' }]);
  // renders: the item keeps its title, link and guid — only the date is missing
  ```

  A date that will not parse is treated as **absent**, never invented: RSS drops that item's `<pubDate>`, Atom drops its `<published>`, JSON Feed drops `date_published`, and Atom's *required* `<updated>` falls back to the feed's own instant, which is always real. An unparseable date sorts last instead of turning the comparator into `NaN` and handing the feed's order to the engine's sort. An unparseable `channel.updated` falls back to the newest item rather than poisoning `lastBuildDate`. Every timestamp the three formats emit is now normalised to UTC from one instant, so an offset-bearing input means the same moment in all three.

  "Now" is a seam: `buildFeed(channel, items, { clock })` takes a `Clock` — `frozenClock(at)` makes a feed with no usable dates byte-for-byte reproducible — and defaults to `systemClock`.

- **`Pipeline.handle()` keeps its one promise: a Response, always.** The lifecycle absorbed a throw from every stage that runs *before* the response exists, and then ran the two that finish it — `cache-headers` and `response` — in a bare loop outside that guard. A stage refusing the response it was handed (headers that cannot be set, on a `Response.redirect` or anything else a handler returned) rejected `handle()` against the contract written on it, and the caller got whatever the runtime prints instead of a document naming the defect. The recover stage had the same hole from the other side: it is the single place a throw becomes a status, so an app's `onError` sink or a `devNotices` producer throwing inside it left nothing to render its own throw.

  Both are now guarded in `finalize.ts`, and a refusal degrades to the new **`X_PIPELINE_FINALIZE_FAILED`** — 500, with the stage name and the underlying message in `cause`:

  ```json
  { "code": "X_PIPELINE_FINALIZE_FAILED",
    "cause": "the \"response\" stage threw while finishing the response: immutable headers" }
  ```

  The degraded answer is finished, not shipped bare: the finalize chain runs a second time over the problem document, whose headers *are* writable, so `x-request-id`, CORS and the security headers still reach the client that has to report this. A second failure keeps its 500 and stops — two passes, never a loop. The failure travels through the recover stage rather than around it, so it is reported, logged and rendered by this package's one call site for each, and `x dev` still shows it in the overlay. A request the stages *can* finish is byte for byte what it was.

- **A mis-encoded path is a 400, not a 500 and a page for the on-call.** `decodeURIComponent('%ZZ')` throws a bare `URIError`, and the router called it unguarded on every `:param` and `*wildcard` segment it walked past. A client typo — a lone `%`, a truncated `%A`, a value concatenated into a URL instead of run through `encodeURIComponent` — escaped `matchRoute` as an uncoded throw, so the pipeline mapped it to `X_INTERNAL`, answered **500**, and reported it to the error monitor (`error-map` pages on `status >= 500`). The caller was told nothing about a request only the caller could fix.

  `matchRoute` now answers with the fourth `MatchResult` variant instead of throwing, and the pipeline turns it into the new **`X_PATH_INVALID`** — 400, with the offending segment in `cause` and `encodeURIComponent` in `fix`:

  ```ts
  const match = matchRoute(table, 'GET', '/posts/%ZZ');
  // { ok: false, reason: 'path-invalid', segment: '%ZZ' }
  ```

  Only the branch that would have decoded can fail: static segments are compared raw, so a path that reaches no param or wildcard is the 404 it always was, a static route still wins the precedence it always won, and a sibling that does match still wins over one that could not decode. `X_PATH_INVALID` is registered in `HTTP_ERROR_TITLES` and mapped to 400 in `ERROR_STATUS`; `pathInvalid()` is exported for a host that matches routes itself.

- **`verifySignedUrl` keeps its promise never to throw.** `parseConstraints` decoded each key segment with a bare `decodeURIComponent`, so a signed URL whose path carried `%ZZ` raised a `URIError` out of a function whose header says verification never throws — an uncoded 500 on the storage read path, for a URL this package would never have minted (`buildSignedUrl` percent-encodes every segment). A segment that will not decode is now `'malformed'`, already a `SIGNED_URL_FAILURES` member, and it is refused before the signature is computed. Nothing is loosened: the reason is the same one an off-base URL gets, and it leaks nothing about the secret.

- **A cache tier that refuses no longer fails the read it was supposed to speed up.** `createCacheStack` walked the ladder with every tier call unguarded, so a tier throwing anywhere on the value path threw straight out of `read()` — the caller saw a failed business read where the source had already answered correctly. The common one needs no outage to reproduce: `LruCache.set` raises `X_CACHE_TOO_LARGE` for any entry over the tier's whole byte budget, so a page that grew past `maxBytes` stopped *loading* rather than stopping *caching*. A `get` was the same shape — a Redis with no socket failed every read that walked past it, including ones the memo or the LRU would have answered.

  Every `get`/`set`/`del` the stack makes now goes through `bestEffort()`, which reads a refusal as "that tier did not answer": the walk continues, later tiers are still populated, `write` and `drop` still reach the tiers behind the refusing one, and the value still comes back.

  ```ts
  const hit = await bestEffort(tier.name, 'get', key, () => tier.get<T>(key));
  if (hit === undefined) continue;                  // a miss and a refusal read the same here
  ...
  const value = await load();                       // the one call still left to throw
  ```

  `load()` stays unguarded on purpose — it *is* the business read, and absorbing it would hand back `undefined` as though it were the value. Silence is the other half of the bug, so the absorbed refusals are readable: **`recentTierFailures()`** returns the last 100, newest first, each carrying the tier, the operation, the key, the message and the `X_*` code when there is one, and each one is logged as `cache.tier.failed`. That is `report.errors` applied to the path that has no report to return, and `resetTiers()` clears it alongside the invalidation log. `LruCache.set` is unchanged and still throws for a direct caller: the stack is the layer that degrades, not the tier.

- **Two identical reads in one request are one read, even when they race.** The request memo behind a cached `query` stored the *value*, and stored it only after the read had settled — so two holes rendering concurrently both missed the memo, both asked the cache tier, and both executed the source. The memo now holds the read **in flight**, published before `readThrough`'s first await: the second reader joins the first instead of starting a competing one, and five concurrent readers cost one execution and one tier round trip.

  ```ts
  const memo = requestMemo(ctx);          // Map<string, Promise<unknown>> — was Map<string, unknown>
  const joined = memo.get(key);
  if (joined !== undefined) return (await joined) as T;
  ```

  A promise is never `undefined`, so the same change fixes a second defect for free: a read that legitimately resolves `undefined` now memoizes, where a value-keyed map read it back as a miss on every subsequent call. A rejection is evicted rather than memoized — a failed read is not the request's answer, so the next read in the same request retries instead of replaying one failure until the request ends. `requestMemo()` is exported, and its entries are now promises; nothing in the framework reads them but `readThrough`.

- **A query with no `cache:` block is memoized per request too.** The memo only ever ran for a query that declared `cache:` — `readRows` returned straight from the source on the `fresh || def.cache === undefined` branch, without so much as looking at `requestMemo`. So the reads that most need deduplicating were the ones that never got it: an uncached lookup called once per row of a list cost one round trip per row, and the request memo, the thing that exists to collapse exactly that, sat unused beside it.

  The memo is now what every read goes through, and the tier is the half a query opts into:

  ```ts
  if (options.fresh === true) return (await read()) as readonly TRow[];   // no cache may answer
  const key = cacheKeyFor(name, raw, def.cache?.tags ?? []);
  return (def.cache === undefined
    ? await readOnce(ctx, key, read)                                      // memo only
    : await readThrough(ctx, key, def.cache.ttlMs ?? null, read)          // memo, then the tier
  ) as readonly TRow[];
  ```

  `readOnce(ctx, key, run)` is the single-flight half of `readThrough`, split out and exported; `readThrough` is now `readOnce` plus the tier fill and nothing else, so there is one place a key is joined and one place it is stored. What the memo holds is the **execution**, never the decision: `readRows` parses the input, evaluates the policy and calls `sql()` before it reaches the memo on every call, and `.as()` reads in a child context whose identity is its own memo — so a memoized answer is still one that actor was allowed to ask for, and an impersonated read can never join one made as someone else.

  `fresh: true` now skips the memo as well as the tiers, a memo being a cache whose lifetime is the request. That makes it the one way to read past a write made earlier in the same request: an action's `invalidates` drops tier entries, not memo entries. It skips the memo on the way *in* and publishes to it on the way *out* — `readFresh` is `readOnce` minus the join, both sharing one publish step — so the read it just made is the request's answer from then on. Returning the rows early instead would leave the pre-write entry standing and end the guarantee at the one call that asked for it, handing the next plain read of that key the answer the write had already moved past.

- **A read filtered on NULL matched every row in memory and no row in the database.** `@ultimat3/query`'s source emitted `"col" = $n` whatever the value was, and `= $n` with a NULL argument is *unknown* in Postgres, never true — so `where({ deletedAt: null })` selected every live row from `from()` and nothing at all from a driver. The keyset predicate had the same defect one page later: `"publishedAt" > $n` is unknown for every draft, so page two stopped at the first NULL and the rows behind it could not be reached through a cursor at all.

  NULL now means one thing across the SQL, the in-memory execution and the live matcher, and `null` and a column the row omits are the same absence:

  | Operator | NULL is | Emitted as |
  |---|---|---|
  | `=` `!=` `in` | a value — it matches itself and nothing else | `is null` · `is not null` · `is distinct from` · `in (…) or is null` |
  | `>` `>=` `<` `<=` | unknown — a NULL on either side matches nothing | unchanged; `matchesFilter` now answers the same |
  | `order by`, the cursor | the largest value: last ascending, first descending | `asc nulls last` · `desc nulls first` |

  ```sql
  -- before                                    -- after
  where "deletedAt" = $1                       where "deletedAt" is null
  order by "publishedAt" asc                   order by "publishedAt" asc nulls last
  ("publishedAt" > $1)                         (("publishedAt" > $1 or "publishedAt" is null))
  ```

  Two behaviour changes ride along, both making the memory path answer what Postgres answers: an ordering operator against a NULL no longer compares the string `"null"` (a null `score` used to sort past `5` and land in a `score > 5` feed), and `compareValues` sorts NULL after every value instead of between `"m"` and `"o"`, which is what `compareRows`, `isAfterKey` and the live matcher's insertion position all read. `!=` compiles to `is distinct from`, the pair `@ultimat3/entity`'s `predicateSql` already emitted. An empty `in` list is `1 = 0` rather than `in ()`, which Postgres refuses outright — and so is an `in` handed something that is not a list at all, which used to fall through to `"col" in $1`: a syntax error from the driver where `matchesFilter` had quietly answered no rows. `isNull` is exported beside `isAfterKey`, for the same reason: a custom `SqlSource` has to agree on what NULL is rather than re-decide it.

  A generated `order by` now carries `nulls last`/`nulls first` explicitly. It is Postgres' own default — no plan changes, and `asc nulls last` is still the default btree order — but an assertion on exact SQL text needs updating.

- **The live matcher places a new row where the database would put it.** A page is served `order by <declared keys>, "id" asc` and `isAfterKey` reads the next one the same way, but the incremental matcher compared the declared keys alone — so a row tied on every one of them was appended after the whole tie group rather than placed by its id. The client rendered an order no re-read agrees with, and the cursor cut from that window's tail skipped every tie the matcher had pushed past it.

  `totalOrder(orderBy)` is now the one definition of that list — the declared keys, then `id asc` unless the ordering already names `id` — and `positionFor`, `Builder.seek()` and the in-memory sort all read it:

  ```ts
  // window [b(t=10), c(t=10)], insert a(t=10)
  positionFor(shape, window, a);   // 0, was 2 — the database returns a, b, c
  ```

  A row with no `id` is now `X_QUERY_NOT_PAGEABLE` at the matcher, as it already was at `seekKeyOf`: `String(undefined)` is `"undefined"`, an id every id-less row shares, so one row's patch landed on another's position and a `remove` named a row no client held. An unordered query still appends — SQL promises no position there to get wrong. `totalOrder` is exported for the reason `isNull` and `isAfterKey` are: a custom `SqlSource` has to serve the order the cursor assumes rather than re-decide it.

  **And the live window is now served in that order too.** Placing the patch by `totalOrder` fixed two of the three readers and left the third: the initial window came from the query's own `sql()` unpaged, so it arrived ordered by the declared keys alone and a tied row sat wherever the database returned it — the matcher then inserted by id into a list that was not sorted by id, and the resume `seek()` read the next page as though it had been. `SqlSource` gains an optional `total()` — the same read, no cursor and no window, ordered `<declared keys>, "id" asc` — and `sourceFor` calls it for `surface: 'live'` and nothing else:

  ```sql
  -- a live feed's window, before          -- after
  order by "createdAt" asc nulls last      order by "createdAt" asc nulls last, "id" asc nulls last
  ```

  `Builder.total()` implements it (`seek()` already implied it, and the private `pageOrder()` is now `servedOrder()` because a live window is not a page). A source that does not implement `total()` is untouched, as is every non-live read: a plain `from()` over rows with no `id` still generates exactly the SQL it was asked for. An assertion on a live query's `sqlText` needs updating.

- **A `BEGIN` that fails no longer leaks the connection it was going to run on.** `withTransaction` reserved a connection, ran `BEGIN` *above* its `try`, and released the pin in the block's `finally` — so the one statement that opens the transaction was the one statement not covered by the guard that closes it. A `BEGIN` that rejected (a connection killed mid-pool, a server in recovery, `statement_timeout` on a hung `SET`) returned the pin to nobody: one leaked pool connection per failure on Postgres, and on PGlite the single session's turn, which every later statement in the process then waits for forever.

  The pin is now held by a `using` declaration and `BEGIN` runs inside the guarded scope — the shape `readOnlyQuery` already had, and it too is converted, so both sites read the same:

  ```ts
  using reserved = isReservable(client) ? await client.reserve() : undefined;
  try {
    await connection.execute(raw(beginStatement(options)));   // inside the guard, not above it
    ...
  }
  ```

  One visible consequence: a failed `BEGIN` now also emits a best-effort `ROLLBACK`, which the server answers with a notice — cheaper than a second exit path for the statement that opened nothing. Nothing else changes: the same statements, in the same order, on the same connection.
- **A failing `ROLLBACK TO SAVEPOINT` no longer masks the error that caused the rollback.** A nested `withTransaction` whose body threw rolled back to its savepoint *uncaught*, so when the failure was the connection itself the caller got `X_DB_UNAVAILABLE: statement failed: ROLLBACK TO SAVEPOINT x_sp_1` instead of the error the unit of work actually died of — and the `onRollback` undos never ran. It is best-effort now, matching the root's `ROLLBACK`. `SAVEPOINT` and `RELEASE SAVEPOINT` stay uncaught on purpose and are documented as such: a savepoint that was never taken means the scope never opened, and a release that failed means its work is not durable in the outer scope. Both are failures the caller has to see.
- **A released `DbConnection` is inert, and releasing it twice releases it once.** `createPostgresClient().reserve()` returned a handle whose `query`/`one`/`execute` kept issuing on the pinned connection after `release()` — but the pool had already handed that physical connection to another unit of work, so a `tx` leaked past its transaction scope wrote its row inside *their* transaction, committed or rolled back with it, with no error anywhere to explain it. The handle now runs direct **only while the pin is held**; a late statement takes its own connection out of the pool like any other caller. That is the rule `pglite.ts` already enforced with its turn queue, so the two drivers finally mean the same thing. `release()` is idempotent for the same reason it needed to be there: two owners reach it on one exit path, and the second was freeing a pin that was no longer ours.

  `DbConnection` is `Disposable` — `[Symbol.dispose]` **is** `release()`, not a second code path — so the pin can be held by a declaration instead of a hand-rolled `finally`:

  ```ts
  using connection = await client.reserve();
  await connection.execute(raw('BEGIN'));
  // released on every exit path, including the one nobody wrote a test for
  ```

  Not a breaking change: `release()` stays, with the same signature and the same semantics on the first call. An implementer of `DbConnection` outside the framework — there is no supported reason to have one — must add `[Symbol.dispose]`.
- **The migration advisory lock is held by one session, so migrators actually serialise.** `migrate()` issued `pg_advisory_lock(MIGRATION_LOCK_KEY)` on the *pool*, and `pg_advisory_lock` is scoped to a Postgres session, not to a statement: the pool lent a connection for that one statement and took the session back. Both halves of the lock then failed. The unlock ran later on whatever connection the pool lent next, answered `false`, and left the lock held until that backend died — the next `ROLE=migrate` container waited on a lock nobody would ever release. And the session actually holding it sat idle for the whole run, so the pool's idle timeout (`migrate`'s is 10s) closed it and released the lock *mid-migration*, which is the case the lock exists to prevent. `ROLE=migrate` masked the first half by accident — its pool is `max: 1`, so every statement found the same connection; no other role and no test has that.

  The lock scope now pins one connection (`using`, so it comes back on every exit path), takes the lock on it, and hands that session down — `ensureLedger`, the ledger read and every migration's `withTransaction` run on it, which is also the only thing that can work on `max: 1`. The unlock stays best-effort and now reaches the session that took the lock. `rollback()` took **no** lock at all and takes the same one, with the same `lock: false` escape hatch as `migrate()` for a private branch database.
- **PGlite's turn queue holds its turn with `using`, matching `DbConnection`.** `TurnQueue.run()` gave the turn back in a hand-rolled `finally`, the same shape `withTransaction` had before its own fix above — one exit path a future edit can still slip above. `Turn` (`pglite-turns.ts`) is now `Disposable`: `release()` and `[Symbol.dispose]` are the same call, idempotent for the same reason `DbConnection.release()` is, and `run()` holds it with `using turn = await take()` instead. `reserve()` in `pglite.ts` cannot do the same — its turn outlives the function, released later by the caller's own `release()` — so it calls `turn.release()` explicitly where it used to call `turn()` directly. Not a breaking change: both functions are package-internal, and the queue's public shape (`take()`/`run()`) is unchanged.
- **A `close()` that rejects no longer caches a dead pool.** `PostgresClient.close()` awaited the driver's teardown and *then* dropped its handle, so a teardown that threw — a connection already terminated, a socket that never drained — skipped the drop and left the corpse cached. The next `connect()` handed it straight back, every statement after that failed for a reason no caller could see, and a second `close()` could not clear it because it threw in the same place. The handle is now read and cleared **before** the await, matching `pglite.ts`: the rejection still reaches the caller — a shutdown that could not drain wants to know — but the client is empty either way, so the next statement opens a live pool. Clearing first also settles the race: a `connect()` arriving while the teardown is in flight gets a new pool rather than joining the one draining.
- **`x build --target binary` produces an executable that boots.** It compiled and then died on `ENOENT … '/$bunfs/package.json'` before any role started: a single-file executable carries no `package.json`, and `FRAMEWORK_VERSION` read one at module scope. The read is now lazy and accepts a second source — `x build` compiles the version in as `--define ULTIMATE_FRAMEWORK_VERSION="<version>"`, which is the only thing inside `/$bunfs` that can answer. A binary built any other way exits `X_INVARIANT` at the first version read, naming the flag, rather than reporting a version it does not have. `packages/core/e2e/version.e2e.test.ts` compiles a real executable and runs it, with the define and without, on every push — the gap lasted two releases because nothing ever executed the artifact. Still unproven, and still named in [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps): the target end to end. Booting is not serving, and no scaffolded app has been compiled and run from a bare VM.
- **`@ultimat3/cli`'s command registry no longer reads a manifest at import.** The same eager read survived one file over: `export const CLI_VERSION = loadVersion()` sits at the module scope of `registry.ts`, and `index.ts` re-exports it — so importing the package for `runRole` alone, which is all a compiled `apps/web/server.ts` does, died on `ENOENT … '/$bunfs/package.json'` before the first role started. `cliVersion()` resolves at the call and caches, and falls back to the same `ULTIMATE_FRAMEWORK_VERSION` define `x build` already passes — the packages ship one version, one commit, one tag, so a second define would be a second version fact to hold in step, and without the fallback `x --version` inside a binary answered `X_INVARIANT` for a version the build knew. `packages/cli/e2e/registry-boot.e2e.test.ts` compiles the registry into an executable and runs it: the binary builds the whole command list, reports the defined version when the build passed one, and throws only when something asks for a version the artifact does not carry. Its last test compiles the module-scope read and asserts the binary dies before it boots — the fix and the defect are both executable, so neither can regress silently.
- `@ultimat3/cli` declares `@ultimat3/schema`, which `error-catalog.ts` has always imported — an undeclared dependency that resolved only because the workspace hoisted it.
- **`Invariant<T>.holds` is a method, not a function-typed property.** A property is checked contravariantly, so `Invariant<Post>` was not assignable to `Invariant<unknown>`, `Entity<Post, C>` did not satisfy `EntityCore`, and every `database({ posts, orgs })` call silently degraded to `Table<unknown>` — 36 cascading errors in the reference app from one position.
- Both regressions are pinned by `packages/entity/src/type-pins.ts`, which is source rather than a test: `tsconfig.json` excludes `src/**/*.test.ts`, so a type-level assertion written in a test file is never read by `tsc` and can never fail.
- `KNOWN_GAPS` in the scaffold typecheck gate is **empty**: every file `x new` and `x g` write now compiles with no diagnostic to excuse.
- **One `timingSafeEqual`, not two.** `@ultimat3/auth`'s `tokens.ts` and `@ultimat3/storage`'s `signed-url.ts` carried byte-identical constant-time string comparisons — the kind of duplication that drifts silently, since a fix to one copy's branch-free XOR loop would say nothing about the other. The implementation now lives in `@ultimat3/core` (`timingSafeEqual`), tier 0 and reachable from both; each package re-exports it so every existing `from '@ultimat3/auth'` and `from '@ultimat3/storage'` import keeps working unchanged.
- **`@ultimat3/schema`'s error codes render their real titles in every process, not just the CLI's.** `X_VALIDATION_FAILED` and `X_SCHEMA_UNSUPPORTED` were exported as data from `SCHEMA_ERROR_CODES` and registered nowhere except `@ultimat3/cli`'s `error-catalog.ts` — a process that never loads the CLI (a worker, a job runner, a plain script importing `@ultimat3/schema` on its own) rendered the humanised fallback (`X_VALIDATION_FAILED: validation failed`) instead of the authored title. `@ultimat3/core` now registers both at import time (`schema-error-codes.ts`) — every process gets them just by importing core, which is unconditional. Schema is tier 0 alongside core and cannot register its own codes or have core import it back to read them, so the titles are a deliberate, tested duplicate: `schema-error-codes-pin.test.ts` (in `@ultimat3/cli`, a package that may import both) pins core's copy equal to schema's own declarations. `error-catalog.ts`'s CLI-only registration is gone — it is now redundant with what core already does for every process.

## 1.2.0

### Added

- **`/metrics` is served by every role**, on its own port (`METRICS_PORT`, default 9090) rather than the role's HTTP port — the Helm ingress routes `/` with no path exclusion, so mounting it beside `/healthz` would publish route patterns, request volumes and error rates to the internet. `worker`, `scheduler` and `replicator` open no HTTP socket at all, so a separate listener is the only thing they could ever be scraped on.
- **The three recorders are wired**, each in the package that owns the event: `recordRequest` in the HTTP pipeline's `finally` (counts a request whose finalize stage throws, which the happy path misses), `recordConnection` in `SocketRegistry.add`/`remove` (the idle sweep now routes through `remove()` — that was the one leaking path), `recordQueueDepth` at the top of the worker's `tick()`, throttled to 15s because `stats()` aggregates the whole jobs table.
- **Six tutorials** in the wiki, first app through deploying free and growing up. Every command and every pasted output was executed against the published 1.1.0 packages.
- **`wiki/Known-Gaps.md`**, plus `Observability` and `UI-Components` reference pages.

### Changed

- **The GitHub Pages site is gone.** The wiki is the single public documentation surface. `site/`, `.github/workflows/pages.yml` and the custom domain are removed, and the repo homepage points at the wiki.

### Fixed

- Metric labels use the route **pattern** (`/posts/:id`), never the concrete path, and unmatched paths collapse to one `unmatched` series — a scanner hitting `/wp-admin` and `/.env` cannot mint unbounded series.
- **Documentation that had drifted from the code.** `wiki/Theming.md` and the admin dev server both hardcoded the pre-retune palette, including the `line` value that measured 1.16:1 in dark; the admin server now derives from `colorTokens` so it cannot drift again. `ROLE=all` was documented in three places and does not exist (`X_ROLE_UNKNOWN` at boot). `x status`, `x deploy static --to`, and `x build --target docker --helm` were documented as shipped and are not. `X_MIGRATE_CONCURRENT` was described as "no advisory lock" — the lock is real (`pg_advisory_lock`), the code simply has no throw site because concurrent migrators *wait*.

### Known gaps found while writing the tutorials

Not fixed, and each one hit by actually running the command. Full list in [Known gaps](https://github.com/developerz-ai/ultimate/wiki/Known-Gaps).

- **`x db gen` and `x db migrate` fail in every scaffolded app** — both shell out to `bunx drizzle-kit`, which `x new` neither installs nor configures. This also breaks `bin/setup`, the scaffold's own documented first command.
- `generateMigration` mangles composite indexes; a migration `up` holding two statements cannot be applied.
- Every generated entity fails `typecheck` on its `invariant()` calls, not just the `x new` example slice.
- The Helm chart still cannot reach `/metrics`: no role declares a metrics container port and no scrape target ships, so the HPAs read `<unknown>`.

## 1.1.0

**The first release published by the workflow.** 1.0.0 was the manual bootstrap; every `@ultimat3/*` package now carries an OIDC trusted publisher for `developerz-ai/ultimate` → `release.yml`, so this version reaches npm with no `NPM_TOKEN` and provenance attached automatically.

### Added

- **`x` serves in production.** `serve.ts` boots a role without the dev watcher, `/_x` or `dev: true`. `ROLE=migrate` applies migrations through the db ledger and exits — the release phase a PaaS asks for. `x new` now writes `apps/web/server.ts`, `apps/web/prerender.ts`, a Dockerfile, a `.dockerignore` and `docker-compose.prod.yml`.
- **Metrics.** `metrics.ts` — counter, gauge and histogram on the OpenTelemetry data model, a `MetricExporter` seam, and `/metrics` in Prometheus text with no dependency. The Helm chart's `connections` and `queue_depth` are emitted verbatim; `rps` is derived from the monotonic `http_requests_total`, because a rate is not a series.
- **`Secret`.** Redacts by value — `toString`, `toJSON`, `Symbol.toPrimitive`, the inspect symbol and the logger — at any depth, under any key, frozen so a spread cannot unwrap it.
- **`resolveEnvironment()`** in core: `development | test | staging | production`, from `ULTIMATE_ENV`.
- **`renderEnvExample()`** generates `.env.example` from the typed env declaration, so the two cannot drift.
- **Page-level UI composites** — `AppShell` (with a working skip link), `PageHeader`, `Section`, `Toolbar`.
- **`defineTheme()`** — the one brand-override seam. Values are validated, never escaped; a `;` or a `</style>` is a refusal.
- **`CATALOG.md`** — 46 components with every prop and the token vocabulary, generated from source and drift-tested, so an agent picks a component without reading it.
- **Factory traits, associations and `create()`**, plus `sharedExamples` / `behavesLike` in the test harness.
- **`docs/ops/`** — running an Ultimate app for real: the PaaS → Compose → Kubernetes ladder, secrets, observability, datastore sizing, disaster recovery, runbooks. Recommendations only; the framework depends on none of it.
- **`scripts/trust-publishers.ts`** — attaches and verifies the OIDC trusted publisher for every published package. `--check` is the read-only form.

### Fixed

- **A scaffolded app produced no deployable artifact.** `x build --target binary|static` pointed at entry files nothing created, and `--target docker` routed through the same missing file.
- **Eight colour pairings failed WCAG AA.** `line` on `surface-raised` scored **1.16:1** in dark — an input border nobody can see. Seven channels retuned; `tokens/contrast.ts` measures every pairing so it cannot regress.
- **Secrets leaked through the log.** Redaction was by key name, so `{ dsn: 'postgres://user:pw@host/db' }` printed the credential. `checkEnv().values` carried plaintext too; `maskedEnvValues` is now the printing path.
- **Every registry factory defaulted to `seed: 1`**, so two tables minted the same uuid and a join assertion could pass for the wrong reason.
- A scaffolded `biome.json` carried `//` comments Biome rejects; the root tsconfig never mapped `@app/*` for paths the scaffold itself writes; the scaffolded `package.json` had no `version`; `resolveServices` created `.x/` unconditionally, which is `EACCES` in a non-root container.
- `IconButton`'s primary variant hardcoded `accent-fg`, so a danger icon button used accent's on-colour.

### Known gaps

- `x build --target binary` compiles but crashes at import: `FRAMEWORK_VERSION` reads `package.json` at module scope and a single-file executable has none.
- `docker-compose.prod.yml` declares a host port and `replicas: 3` together — two processes cannot bind one port. This is the rung-1 ceiling.
- The shared cache tier's Lua invalidation `DEL`s keys it never declared in `KEYS`, so it fails on Dragonfly and on Redis Cluster.
- `resolveEnvironment` now exists in both `core` and `seo` with different return types.

## [1.0.0] - 2026-08-10

First release. 27 `@ultimat3/*` packages plus the unscoped `create-ultimate` — 28 in all — publish at 1.0.0 to npm, in tier order.

1.0.0 itself is the **manual bootstrap**: a trusted publisher can only be attached to a package that already exists, so this one version is published by hand by an npm org member. Every release after it goes through the workflow over OIDC trusted publishing, no `NPM_TOKEN` — see [PUBLISHING.md](PUBLISHING.md).

### Added

- **The eight primitives**, shapes frozen under semver: `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task`. There is no ninth — a new capability arrives as a factory over an existing primitive, which is why `llm()` returns an `action`.
- **One authz object across every surface.** A `policy` decides the HTTP call, the typed client call, the job run, the MCP tool call and the live-query subscription. No trusted-tool mode, no second permission table.
- **`@ultimat3/core`** — `UltimateError` and the error contract, ALS request context, `defineEnv`, roles, clock, structured logging, OpenTelemetry spans, graceful drain, signed cursors, `defineService`.
- **`@ultimat3/schema`** — Standard Schema over a built-in default provider, JSON Schema projection, and one `formatIssues` shared by every package that reports a validation failure.
- **`@ultimat3/entity` + `@ultimat3/db`** — a Postgres driver (`postgresDriver()`) and an in-memory one over one shared plan/cursor layer, so the two cannot drift; PGlite and database branching, so `x dev` needs no Docker.
- **`@ultimat3/action` + `@ultimat3/query`** — one declaration projecting to an HTTP route, an OpenAPI operation, a typed client method, a job handle, an MCP tool and contract tests, all through a single `invoke` path.
- **`@ultimat3/http`** — the owned `Bun.serve` lifecycle with an explicit, ordered request pipeline.
- **`@ultimat3/jobs`** — Postgres queue driver, durable steps with memoized replay, transactional outbox on by default, cron `task`s with a required IANA timezone and leader election.
- **`@ultimat3/realtime`** — tiers 1–2: channels, presence, live queries with per-subscriber policy, an incremental matcher, a Postgres logical-replication change feed (`pgoutput` over `Bun.connect`), and a NATS bus for fanout.
- **`@ultimat3/render` · `pwa` · `seo`** — five render modes with `stream` the default, the `site/` → `app/` surface boundary as a build error, a generated service worker, and SEO gates that fail the build rather than the audit.
- **`@ultimat3/cache`** — four tiers and one tag invalidation graph; an untagged cached query fails the gate.
- **`@ultimat3/mcp` · `ai` · `manifest`** — the AI-first surface: an MCP dev server whose tool catalog is per-connection and fail-closed, a read-only SQL guard with four independent defenses, `x.manifest.json`, `llm()` with token-and-money budgets and a scope-partitioned semantic cache, `PgVectorStore` fusing pgvector cosine and Postgres FTS through RRF, and evals that gate on score delta from a committed baseline.
- **`@ultimat3/auth` · `mail` · `storage`** — OAuth authorization-code exchange with id-token verification, ESMTP and Resend transports, S3 storage.
- **`@ultimat3/i18n` · `money` · `time`** — enforced, not documented: no hardcoded user-facing string, no float money, no date without an explicit IANA `timeZone`.
- **`@ultimat3/ui` · `admin`** — an SCSS-module design system on semantic tokens for both colour schemes, and the `/_x` dashboard.
- **`@ultimat3/cli`** — the `x` binary. `x dev` boots the real app in any role, and every fact it reports comes from a framework package rather than a second implementation inside the CLI.
- **`create-ultimate`** — `bunx create-ultimate myapp` scaffolds a monorepo whose unmodified generated code passes `x verify`.
- **`x verify`, 17 steps**, with no way to run fewer: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, manifest, roadmap.
- **The error contract, as gate steps.** Every failure carries a stable `X_*` code, a cause, a runnable `fix:` and a `--json` form. `x verify` fails a `fix:` that names no command, and an `X_*` code with no documented row.

### Fixed

- A lockstep release now rewrites sibling `@ultimat3/*` pins, not only each package's own version. Moving versions alone would have published `@ultimat3/jobs@1.0.0` naming `@ultimat3/core@0.0.1` — a version that is not on the registry, so every install of the release would fail.
- Version skew is a `package-shape` finding (`X_RELEASE_VERSION_SKEW`), so it fails the gate instead of reaching npm.
- A changelog entry inserts under `[Unreleased]` instead of appending, which keeps the file newest-first past the second release.

### Notes

Not claimed at 1.0.0, named here rather than left to be discovered:

| Open | Where it stands |
|---|---|
| Realtime capacity | no published benchmark. The 50k-socket forced-restart number is unmeasured; documented capacity figures are targets, not results |
| Two-platform deploy proof | `x build --target docker\|binary\|static`, both compose files and the Helm chart ship. The demo app on Compose **and** K8s from one image, with an invisible rolling restart, is [milestone 11](docs/idea/14-roadmap.md) and is not yet demonstrated |
| Deferred to v2 | realtime tier 3 local-first (`persist: true`), the plugin API, multi-region replication, and the Redis/NATS **job** drivers — each behind an interface that ships today, throwing `X_NOT_IMPLEMENTED` with a runnable `fix:` rather than pretending to work |

## [0.0.1] - 2026-07-26

Repository bootstrap: monorepo layout, tier-enforced package boundaries, Biome and strict TypeScript, free-runner CI, npm OIDC trusted publishing, and the design docs. Never published to npm.
