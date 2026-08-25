# Entities and migrations

An `entity` is a table + its domain type + its invariants. The single source of the DB schema, the TS type, and the parse boundary.

| Aspect | Rule |
|---|---|
| Projects to | SQL DDL, domain type (`typeof posts.$row`), migration, repo type, admin screen, seed factory |
| Owns | column types, defaults, invariants, tenant column |
| Never | business logic, I/O, HTTP awareness, policy decisions |

One `entity()` call per table, in `packages/db/src/schema/<name>.ts`; a feature's own `entity.ts` holds only that feature's view schemas. Migrations sit beside the entities in `packages/db/migrations/` as plain SQL. Neither holds **any business logic**. Reads and writes go through `@ultimat3/entity`'s own `postgresDriver()`, which compiles a query plan to parameterised SQL — no ORM in the request path ([`pg-driver.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/entity/src/pg-driver.ts)).

## Six projections

| Projection | Where it lands | Consumed by |
|---|---|---|
| SQL DDL | the generated migration — columns, CHECKs, indexes | Postgres |
| Domain type | `export type Post = typeof posts.$row` | actions, queries, Solid component props |
| Migration | `packages/db/migrations/*.sql` | `x db migrate`, `ROLE=migrate` |
| Repo type | the feature's `repo.ts` signature | `ctx.<service>` inside `handle` |
| Admin screen | `apps/admin/` | operators, and the admin app's MCP surface |
| Seed factory | `seed(name)` fixtures | all six test types |

One inferred chain, no hand-typed link:

```text
entity('posts', { columns })  →  typeof posts.$row + invariants  →  action input/output  →  typed client + MCP tool  →  component props
```

Rename a column and the entity type changes, the action's output stops matching, and the component prop errors — all at typecheck, before a test runs.

## Shape

`As of 2026-08`:

```ts
export const posts = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().references(() => orgs.id, { onDelete: 'cascade' }).tenant(),
    title: text({ max: TITLE_MAX }),
    body: text(),
    status: enumerated(POST_STATUSES).default('draft'),
    likeCount: integer().default(0),
    publishedAt: timestamp().nullable(),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  tenant: 'orgId',   // said out loud; inferred from `.tenant()` or an `orgId` column if omitted
  invariants: (c) => [
    invariant('post_title_present', c.title.trimmed().minLength(1)),
    invariant('post_like_count_non_negative', c.likeCount.atLeast(0)),
  ],
  indexes: [{ on: ['orgId', 'publishedAt'], order: 'desc' }],
});

export type Post = typeof posts.$row;
```

The entity name is the first argument. Everything else is the init object:

| Field | Meaning |
|---|---|
| `columns` | types + defaults + FKs. Money is `bigint` minor units + `char(3)` currency, never a float; timestamps are `timestamptz`, stored UTC |
| `table` | the physical table, when it is not the entity's own name. For a schema this framework did not generate — see [Adopting an existing database](#adopting-an-existing-database) |
| `tenant` | the tenant column. Omitted, it is inferred from `.tenant()` or a column named `orgId` — silence never means unscoped |
| `invariants` | `(c) => [invariant(name, expr), …]` — named predicates enforced on write, projected to a CHECK or UNIQUE constraint where expressible. `c` is typed from `columns`, so a typo is a compile error |
| `indexes` | composite and partial indexes; a single unique or indexed column declares it on the column instead |
| `primaryKey` | composite keys only — a single key is `.primaryKey()` on the column |
| `tags` | extra cache tags this entity participates in, beyond its own `entity:<name>` |

Presence of a `deletedAt` column is what makes an entity soft-deletable — not a flag.

## The fluent surface

Every projection is a method on the entity — `posts.$view(['id', 'title'])`, never `view(posts, ['id', 'title'])` — and every declared field is lifted onto it under a `$`. An entity has no `.def`.

| Member | Is | Rule |
|---|---|---|
| `posts.title` | a column reference | the columns are the entity's own properties, which is what forces the `$` sigil onto every framework member |
| `$row` | the phantom that carries the row type | `export type Post = typeof posts.$row`. Reading it as a value throws `X_INVARIANT_VIOLATED` — a type was meant |
| `$schema` | the Standard Schema the columns already describe | forms and actions hand input to it; the row shape is never declared a second time |
| `$parse(value)` | the parse boundary | fills declared defaults, then validates every column through the column that owns it. Throws on a bad value |
| `$view(keys)` | the row projection | `const PostView = posts.$view(['id', 'title'])` — what an action names as its `output`. An unknown key is a compile error, and `X_INVARIANT_VIOLATED` at declaration for a JS caller |
| `$assert(row)` | every invariant, run | called by the repo on insert and on update; reports **every** failing invariant at once, so one round trip fixes all |
| `$describe()` | the manifest row | name, table, primary key, physical columns, invariants, indexes (name **and** column list, uniqueness, predicate, direction — a name cannot be parsed back into columns), tags, `cacheTag`, `softDelete`, `orgScoped` |
| `$cacheTag` | `entity:<name>` | the string `@ultimat3/cache` invalidates by |
| `$tagFor(id)` | `entity:<name>:<id>` | row-level invalidation for live queries |
| `$tenantColumn` | the tenant column's property key, or `null` | presence is what turns tenancy on — resolution order under **Tenant column rule** below |
| `$name` `$table` `$columns` `$primaryKey` `$indexes` `$invariants` `$tags` `$softDelete` | the declaration, lifted | readable. `$table` is `$name` verbatim — the first argument to `entity()` is the physical table name, never pluralised or snake-cased for you |

`entity` is the one primitive whose surface is `$`-prefixed, and the type says why: `type Entity<Row, C> = EntityCore<Row, C> & C` — the entity **is** its columns. `posts.title` is a column reference, so an unprefixed member would make `view`, `name` or `tenant` an illegal column name; with the sigil, a column called `name` and the entity's own name coexist as `posts.name` and `posts.$name`. `action`, `query` and `job` carry no sigil because nothing is merged into them. Reaching for `posts.view([…])` after reading [Actions](Actions) does not typecheck — there is no such member, only `$view`, and there is no free `view(entity, keys)` to import either. Nothing is hidden the way an action's `handle` is: an entity has no body to protect, so the whole declaration reads back, and the sigil protects the column namespace instead. Registration is not a second step — `entity()` registers itself as it is declared, which is why a duplicate name is `X_ENTITY_DUPLICATE` at import rather than a silent last-one-wins.

`$view()` is what closes the type chain. `output: posts.$view(['id', 'title', 'excerpt'])` returns a Standard Schema over `Pick<Row, K>`, so renaming a column stops the key list itself from compiling, and the action's output type and every consumer of it fail in the same pass — not at runtime as a missing field. What it catches is the key list and the projected type; a value is still checked at runtime, by the column that owns it rather than by a second copy of its rule. A view never invents a default: it projects a row that already exists, so an absent required column is missing data.

## Tenant column rule

Every multi-tenant entity declares `tenant`. Every query against it is tenant-scoped or it fails:

```
X_TENANCY_UNSCOPED: query is not scoped to a tenant
  cause: select on "posts" has no predicate on tenant column "orgId"
  fix:   query through posts repo (ctx.posts.*) — it applies the tenant scope from ctx.actor
```

Which column that is, in order — first match wins:

| Order | Source | Detail |
|---|---|---|
| 1 | `tenant: 'workspaceId'` | the declaration, said out loud. It need not be named `orgId` and need not carry `.tenant()`. Declared, it wins outright — a `.tenant()` mark elsewhere is not a conflict, just not the winner |
| 2 | `.tenant()` on a column | the first column marked, in declaration order |
| 3 | a column named `orgId` | literal property name, no mark needed |
| 4 | none of those | `$tenantColumn` is `null` and the entity is not tenant-scoped |

Omitting `tenant` keeps steps 2–4, so silence never means unscoped. A `tenant` key naming no column is a declaration error — because the alternative is a silently unscoped table. The error lists the columns to pick from and both edits that resolve it, so the declaration is repaired without opening the entity file:

```
X_INVARIANT_VIOLATED: a domain invariant rejected this row
  cause: posts.tenant: tenant: 'workspaceId' names no column — pick from: id, title, body, orgId
  fix:   set tenant to one of id, title, body, orgId in entity('posts'), or remove the tenant key — inference then takes the .tenant() column, else one named orgId
```

Removing the key is a real option, not a hedge: inference (steps 2–4) still applies, so the table stays scoped whenever a column is marked `.tenant()` or named `orgId`.

| Consequence | Detail |
|---|---|
| Repo methods | inject the tenant predicate from `ctx.actor.orgId`; a raw `db.*` call in a service is a boundary error |
| Cache keys | framework-generated from the query name, its parsed input and its tags — never hand-built. The tenant reaches the key through the **input**, so a `cache:` read must take it there ([Caching and invalidation](Caching-And-Invalidation)) |
| Live queries | the tenant predicate is part of the matcher, not a post-filter |
| Vector search | tenant + policy filters applied **in SQL**, so similarity search cannot leak across tenants |

## Point lookups batch themselves

`findById` called several times in one microtask of one request is **one** statement, `As of 2026-08`:

```ts
// One `select … where "id" in ($1, $2, $3, …)`, not one statement per post.
const authors = await Promise.all(posts.map((post) => users.findById(post.authorId, { orgId })));
```

Nothing to opt into — no `dataloader()`, no `batch()`. `findById` keeps its signature and its meaning, which is the only way the fix reaches code that is already written.

| Property | Behavior |
|---|---|
| Window | one microtask, closed before the statement goes out. A sequential `for … of` loop shares no microtask — its `await` ends the window — so what batches one is the page it is looping over (below) |
| Lifetime | one request. The batch is keyed by context identity, so it dies with the request and never crosses one |
| Never shared with | another tenant, another soft-delete visibility, another projection, another entity, another client. The coalesced statement has to be one each single lookup would have been served by |
| Scope | the tenant predicate and `deleted_at is null` are **inside** the statement, so an id that is missing, soft-deleted or another tenant's still reads as `null` — never another caller's row |
| Wide batches | past 500 ids, several whole statements rather than one Postgres refuses for its bind count |
| Outside a request | a job, a script, a migration: the single statement it always was |

## A page batches the loop it causes

A `for … of` loop awaits between iterations, so no two of its lookups share a microtask. The page
they came from batches them instead, `As of 2026-08`:

```ts
const page = await db.posts.findMany({ orgId });
for (const post of page.rows) {
  // Two statements for the whole loop: the page, then one `where "id" in (…)` over every author
  // on it. Every lookup after the first is memory.
  const author = await db.users.findById(post.authorId, { orgId });
}
```

Nothing new to write, and nothing to opt into: the relation is the `references()` the column
already declares, so the fix reaches loops that are already written.

| Property | Behavior |
|---|---|
| Trigger | the first `findById` whose id is a foreign key value on a page this request read. It resolves that key for **every** row of the page, in one statement |
| Never shared with | a different scope key (another tenant, another soft-delete visibility, another projection, another entity), another client, or the same entity after a write to it |
| Scope | the tenant predicate and `deleted_at is null` are inside the preload statement — it is the statement each single lookup would have sent, widened to the page's ids — so a page's ids can never resolve rows outside the reader's own scope |
| A write | drops what was preloaded for that entity before the statement goes out, so a row this request changed is re-read, never served from a page read before it |
| Lifetime | one request. What is held is the ids, not the rows, keyed by context identity |
| Wide pages | past 500 ids, whole statements — the same bound the microtask batch has |
| Outside a request | a job, a script: a page leaves nothing behind, and every lookup is the statement it always was |

## Preload states a relation the loop would infer

The eager, declarative third of the family: the relation is named on the chain and resolved
before the caller sees a row, `As of 2026-08`:

```ts
export const db = database({ orgs, posts, members });

// Two statements: the page, then one `select … where "id" in (…)` over its authors.
const page = await db.posts.where({ orgId }).preload('author').page();
page.rows[0].author;        // the member row, or null — always present
```

Nothing new to declare: `'author'` is the relation the `authorId` foreign key on `posts` already
produces — `preload()` names it, it does not define it. A name no foreign key produces is
`X_PRELOAD_UNKNOWN_RELATION`, resolved and thrown when `preload()` is called, on the chain and not
a page later.

| Property | Behavior |
|---|---|
| Shape | a `belongsTo` attaches the row or `null`; a `hasMany` attaches an array, empty when there are none. Always present, so "no author" and "nobody preloaded the author" cannot read the same |
| Statements | one extra statement per named relation, resolved **concurrently** — two `preload()` calls are two statements in flight, never one after the other. Naming one relation twice is one statement |
| Terminals | `page()`, `all()`, `one()` resolve every named relation. `count()`, `countBy()` and `plan()` do not — a count reads no row to attach one to |
| Projection | attached after `select()`. `select()` is widened internally with the relation's own key, so a projection can drop neither the key the preload reads nor the relation it attaches — `plan().select` reports the widened list, the one that actually ran |
| Tenancy | the page's own tenant predicate carries onto the related read only when **both** entities are scoped by a column of that same name — a value that scopes one entity is a guess on another, and a source scoped by `workspaceId` may carry an ordinary `orgId` predicate that is a filter and not its tenancy. Carrying nothing is not silence: the related read builds its own plan, so it is refused as `X_TENANCY_UNSCOPED` rather than answered with a guess |
| Soft delete | the related read is `findMany`, so `deleted_at is null` applies exactly as it does to any other read |
| Wide relations | past 500 ids, whole statements — the same bound the two batches above share. A `hasMany` wider than one page costs another keyset page rather than a silent truncation |
| Reach | a table reads only the entities its own `database()` call named. A relation to one outside the set is `X_INVARIANT_VIOLATED`; the fix names the missing entity in that same `database({ … })` call |

Reach for it when the relation is part of what the page *is* — a list rendered with its authors,
rows handed to something that will not call back into the repo, or a read a reviewer should see
stated rather than inferred from a loop. The other two members of the family ask for nothing:
`findById` batches a same-microtask fan-out for itself, and a `for … of` loop over a page is
already two statements, above.

## Reading a whole table is a loop of pages

A page is bounded on purpose, so reading everything is iteration — and the iteration is a terminal
on the same chain, not something written around `page()`, `As of 2026-08`:

```ts
// One statement per batch, one page of rows in memory at a time.
for await (const batch of db.posts.where({ orgId }).preload('author').inBatches(500)) {
  await search.index(batch);
}
```

A batch **is** the page `page()` would have returned at that position: same filters, same tenancy,
same soft-delete visibility, same `select()`, same `preload()`. Nothing here is a second read path.

Stopping early keeps the position, which is what makes a long backfill a job that can run out of
time and pick up where it stopped:

```ts
await using batches = db.posts.where({ orgId }).after(checkpoint).inBatches(500);
for await (const batch of batches) {
  await search.index(batch);
  if (ctx.clock.now() > deadline) break;
}
await db.checkpoints.update(id, { cursor: batches.cursor });   // resume with .after(cursor)
```

| Property | Behavior |
|---|---|
| Statements | one per batch, each asking for one row past it exactly as a page does. An empty batch is never yielded, so a consumer never checks `batch.length` |
| Position | keyset, never OFFSET — a row written mid-iteration cannot make the loop skip or repeat one. `.after(cursor)` starts it, `.cursor` is where the next batch starts, `null` once exhausted |
| Closing | `break`, `return` and a throw all stop the next statement; `await using` is the same guarantee for a handle held in a variable, and `close()` is idempotent. One handle is one iteration — a second `for await` continues it rather than restarting the table |
| Batch size | a whole number of rows, at least one. A chain that also called `limit()` is `X_INVARIANT_VIOLATED`: one number with two meanings, and neither reading is safe to guess |
| Sort order | an ordering no cursor can carry is refused at `inBatches()`, not one batch later — a result that fits in a single batch mints no cursor, so deferring it would hide the mistake until the table grew. **An ordinary nullable sort column is no longer one of them, `As of 2026-08-24`**: NULL has a written-down place (`asc nulls last` / `desc nulls first`), the cursor carries it and the seek reaches it. What is refused is a **nullable primary-key column** — the tiebreak `totalOrder` appends precisely so two rows sharing a sort value cannot straddle a page boundary, and `null = null` is unknown, so it cannot do that job. Reachable only through `primaryKey: [...]`; drop `.nullable()` from the column |
| Tenancy | the plan's, as everywhere else: an unscoped chain is `X_TENANCY_UNSCOPED` on its first batch |

## A count per row is one grouped count

The batching family above collapses a *lookup* repeated per row. A `count()` per row is not a
lookup — each statement asks a different question, so no batch reaches it. One statement asks all of
them, `As of 2026-08`:

```ts
// One statement for all of `ids`, not one `select count(*)` per post.
const counts = await db.likes.where({ orgId }).andWhere('postId', 'in', ids).countBy('postId');
for (const id of ids) await db.posts.update(id, { likeCount: counts.get(id) ?? 0 });
```

A `ReadonlyMap` keyed by the column's own values and typed from the row, so `counts.get(postId)` is
a `number | undefined` — and the `undefined` is load-bearing.

| Property | Behavior |
|---|---|
| Counts | the whole predicate, exactly as `count()` does: the chain's filters, its tenancy and its soft-delete visibility are in the statement. `limit()` and `after()` bound a page, never a count |
| A value nothing matched | absent, never `0`. That is what `group by` returns, and it is what tells "none" apart from "never asked" — the default is the caller's `?? 0` |
| NULL | one group, keyed `null`, in both drivers: a property a row never carried is read as `null`, so it lands where Postgres puts its NULL rows. `0`, `''` and `false` stay the values they are |
| Order | biggest group first, ties by the value — numbers and bigints numerically, everything else by its text — and `null` last. Applied after the rows are in, not in the statement: a hash aggregate returns groups in whatever order it built them, so an `order by` there would let the two drivers disagree about a result they agree on |
| Groupable columns | `uuid`, `text`, `char`, `boolean`, `integer`, `bigint`. A timestamp, a `jsonb` or a `money` column is `X_INVARIANT_VIOLATED`, whose `fix` names a column of that entity that *is* groupable — a `Map` compares a non-primitive key by identity, so such a map could only ever answer `undefined` |
| More than 1000 groups | `X_INVARIANT_VIOLATED`, never a truncated map: the statement asks for one group past the bound, exactly as a page reads one row past its limit, and the `fix` spells the `andWhere('<column>', 'in', <values>)` that bounds it. A map that lost its tail reads like a complete one, and recounting from it writes the wrong number to every row it missed |
| Statement | `select "post_id" as group_value, count(*) as group_count … group by "post_id"` — both names are fixed aliases, so an entity may still declare a column called `count`, and the grouped value is re-parsed by the column that declared it |
| Tenancy | the plan's, as everywhere else: an unscoped chain on a tenant-scoped entity is `X_TENANCY_UNSCOPED`, never a count across tenants |

There is no `groupBy()` builder and no error code of its own: `countBy` is a terminal on the chain
that already exists, over exactly the rows `count()` counts.

## Writing many rows is one statement

The sections above make a read loop stop being N statements. A loop of `insert()` calls is
the same defect on the write side, and `insertAll`/`upsertAll` are its answer, `As of 2026-08`:

```ts
await db.tags.insertAll(names.map((name) => ({ orgId, name })));   // one statement, n rows

await db.likes.upsertAll(rows, {                                  // insert, or leave what is there
  onConflict: ['orgId', 'postId', 'memberId'],
  onMatch: 'nothing',
});

await db.counters.upsertAll(rows, { onConflict: ['orgId', 'day'] });   // insert, or overwrite
```

Rows are `Insertable` and go through `$parse` exactly as one row does, so declared defaults are
filled here rather than by the caller; `upsertAll` also stamps `onUpdateNow()` columns through the
same `touch()` `update(id, patch)` uses, because an upsert that lands on a stored row *is* an
update. Both resolve with **the rows this call wrote**, in order — under `onMatch: 'nothing'` a row
already stored is skipped and absent, which is how a caller counts what it actually inserted.

| Property | Behavior |
|---|---|
| One builder | every insert in the framework compiles through the same function, so `insertAll([row])` is the text `insert(row)` always produced. There is no second insert path to drift |
| What a collision writes | every column the batch names, minus the conflict target (how the row was found), minus the primary key (where it lives) and minus the soft-delete stamp (whether the row is there at all). Moving either of the first two moves a row nobody asked to move, and every foreign key pointing at that id misses it |
| A soft-deleted row it lands on | stays deleted, and takes the batch's other columns. A stamped row still occupies its conflict target — that unique index is not partial — so writing `deletedAt` from the incoming row would bring back a row the app deleted, which is the resurrection `update()` and `updateWhere()` refuse by carrying `deleted_at is null`. `insertAll` is unaffected: a row that collides with nothing writes the stamp it carries |
| Conflict target | properties of a **declared** unique constraint — the primary key, a `unique()` column, an `indexes: [{ on, unique: true }]` entry, or an `invariant(name, c.unique([…]))`. Anything else is `X_INVARIANT_VIOLATED` here rather than `42P10` from the server |
| Tenancy | on a tenant-scoped entity, `onMatch: 'update'` requires the tenant column *inside* the conflict target, else `X_TENANCY_UNSCOPED`: an upsert builds no read plan, so a target that omits it matches another tenant's row and rewrites it. `'nothing'` is allowed — it writes nothing to a row it does not own |
| A batch repeating itself | two rows with one conflict target under `'update'` is refused: Postgres answers that statement `ON CONFLICT DO UPDATE command cannot affect row a second time`, so it cannot pass in memory either |
| Uneven batches | under `'update'` every row names the same columns — `excluded.<column>` for a row that omitted one is that column's *default*, not the stored value. `insertAll` and `'nothing'` accept an uneven batch and render `default` in the missing cell |
| Nulls | a null in the conflict target collides with nothing, in both drivers — a Postgres unique index is `NULLS DISTINCT` |
| Size | past 65535 bind parameters the batch is several statements, never one the server refuses. Wrap the call in `withTransaction` when all-or-nothing matters |

There is no `updateAll`: `updateWhere(filter, patch)` and `deleteWhere(filter)` are already the
bulk forms of `update` and `delete`, and a second spelling of one of them would be a second path.

The composite unique index the tenancy rule requires is emitted correctly since 2.0.0 — declare it
on the entity and generate. Through 1.2.0 `indexes: [{ on: ['orgId','createdAt'] }]` emitted one
mangled name (`("org_id_created_at")`) and the SQL would not apply, so an app pinned there writes
that `create unique index` by hand.

## Seeding

A seed is the fixture graph, written once and **replayed anywhere**: run it twice and the second
run writes nothing and raises nothing. `x db seed [<name>]` applies it; `defineSeed` declares it,
in `packages/<pkg>/seeds/<name>.ts` or `packages/<pkg>/src/seed.ts` — the two places `x db seed`
looks.

```ts
export const dev = defineSeed('dev', async ({ insert, upsert, exists, id }) => {
  // The table owns the id, so the NATURAL key is the only key: insert, or update what is there.
  await upsert(plans, { by: ['code', 'currency'] }, { code: 'team', currency: 'EUR', monthly });

  // The SEED owns the id, so a replay finds its own rows: `id('org:acme')` is a uuid v5 of the
  // label — the same value on every machine, in CI and in the container.
  await insert(orgs, [{ id: id('org:acme'), slug: 'acme', name: 'Acme Editorial' }]);

  // Bulk volume data has no natural key worth upserting ten thousand rows against. The unit of
  // idempotency is the FILE, and the guard is a sentinel.
  if (await exists(reports)) return;
  await insert(reports, generated);
});
```

| Verb | Use it when | What a replay does |
|---|---|---|
| `insert(entity, rows)` | the seed chose the ids (`id('label')`) | one `on conflict … do nothing` statement per call — a stored row is left exactly as it is, and counted `skipped` |
| `upsert(entity, { by }, values)` | the table owns the id and a natural key identifies the row | reads first so an unchanged row answers `'skipped'` with no statement, then one `on conflict … do update` — never a read-decide-write race between two containers booting at once |
| `exists(entity, where?)` / `count(entity, where?)` | volume data, where the file is the unit | the sentinel returns early and nothing is written |
| `deleteWhere(entity, where)` | a scoped wipe before a regenerate | **refused on a soft-deleting entity** — see the trap below |

Rows go through `entity.$parse` and the invariants either way, so a seed is a test of the schema as
well as data for one.

| Rule | Detail |
|---|---|
| Tier | `reference` ships to production through this same command; `dev` is fixture data and is the default. `x db seed` runs `reference` alone under `ULTIMATE_ENV=production` — naming `--tier dev` (or `ULTIMATE_SEED_TIER=dev`) is both the selection and the consent → [CLI reference](CLI-Reference#x-db) |
| Transaction | one per seed, never one around the run: a seed that throws must not roll back the seeds that already landed |
| `createdAt` | an `upsert` that lands on a stored row does **not** overwrite it. A replay must not move when a row first arrived; `preserve: [...]` names other columns to spare |
| Tenancy | `upsert` on a tenant-scoped entity needs the tenant column inside `by`, else `X_TENANCY_UNSCOPED` — the same rule `upsertAll` carries. `insert` has no such requirement: `do nothing` writes nothing to a row it does not own |
| Generated key | `insert` refuses a row that leaves a `uuid().primaryKey()` unnamed. `$parse` would fill it with a fresh uuid, the conflict target would match nothing, and run five would leave five copies — the one duplication nothing else can see |
| `now` | one instant per run, so every row a bulk pass stamps carries the same timestamp |
| `metrics` | `{ inserted, updated, skipped }`, returned by `run()` and reported per seed by `x db seed --json` |

**The soft-delete trap, and why `deleteWhere` refuses.** Deleting a seeded row on a soft-deleting
entity *stamps* it rather than removing it. The stamped row still occupies its unique key — that
index is not partial — and `upsertPlan` spares the soft-delete column on purpose, so no replay can
clear the stamp: the rows are invisible to every read and no re-seed brings them back. A wipe-then-
replay that looked idempotent left a demo's feed permanently empty. Inside a seed the call is
therefore `X_INVARIANT_VIOLATED` naming `x db reset`, which is the only wipe such an entity has.

## Column types

The blessed set is a decision the framework made for a table it was going to create. The wide set
is the shape a table already has, `As of 2026-08`.

| Builder | Postgres | Row type |
|---|---|---|
| `uuid()`, `uuid<PostId>()` | `uuid` | `string`, branded if declared. `.primaryKey()` generates a v7 when omitted |
| `text({ max })` · `integer()` · `boolean()` · `url()` | `text` · `integer` · `boolean` · `text` + CHECK | `string` / `number` / `boolean` |
| `enumerated(v)` · `tz(zones)` · `locale(tags)` | `text` + CHECK | the union of the declared values |
| `timestamp()` | `timestamptz` | `Date` — an instant, stored UTC |
| `money()` | `<n>_minor bigint` + `<n>_currency char(3)` + `<n>_scale integer null` | `MoneyValue` |
| `json(schema)` | `jsonb` | whatever the schema infers. The schema is **required** — a `json()` returning `unknown` is an `any` hole, and the value arrives from the database as often as from a caller |
| `decimal({ precision, scale })` | `numeric(p, s)` | `string`, the exact digits. A value with more decimal places than the column stores is refused, not rounded |
| `date()` | `date` | `PlainDate` — a calendar date, no time, no zone |
| `bigint()` | `bigint` | `string`. A JS `bigint` is what `JSON.stringify` throws on and a `number` loses digits past 2^53, which is where a legacy `int8` key lives |
| `bytes()` | `bytea` | `Uint8Array`, normalised across both drivers |
| `arrayOf(column)` | `<element>[]` | `readonly T[]`, each member parsed by the element column |

Chain: `.primaryKey()` · `.nullable()` · `.unique()` · `.default(v)` · `.defaultNow()` ·
`.onUpdateNow()` · `.references(() => other.id, { onDelete })` · `.tenant()` · `.column(name)`.

**A date is not an instant.** `effective_on` is the date a rate applies, not a moment; stored as a
`timestamptz` it is a different date on either side of midnight for half the planet. `PlainDate`
(`@ultimat3/time`) is a branded `YYYY-MM-DD` string — it sorts chronologically because it sorts
lexicographically, round-trips through JSON as itself, and is the literal Postgres accepts. The
framework's "never a date without an IANA zone" rule is about instants: a calendar date needs no
zone because it names no instant.

## Adopting an existing database

Three overrides, `As of 2026-08`, and together they are what makes a schema Ultimate did not
generate declarable at all. An entity that uses none of them emits exactly what it always did.

```ts
export const accounts = entity('account', {
  table: 'legacy_accounts',
  columns: {
    id: uuid().primaryKey().column('account_id'),
    githubLogin: text({ max: 40 }).column('gh_login'),
    balance: money({ columns: { minor: 'amount_cents', currency: 'currency', scale: null } }),
    openedOn: date().column('opened_on'),
  },
});
```

| Override | What follows it | What does not |
|---|---|---|
| `entity(name, { table })` | every statement, index name and foreign key | the entity NAME stays the key: the registry, the cache tag `entity:account`, `x entities describe`, every relation and every policy |
| `.column(name)` | the DDL, the binding, the decoder, predicates, sort keys, cursors | nothing — name it LAST in a chain, since the link returns the general column; `uuid()` and `timestamp()` keep their own methods across it |
| `money({ columns })` | the three physical columns, per part, merged over the defaults | `scale: null` says the table has no scale column: every amount is then at the currency's own minor unit, which is what an absent scale already meant |

A physical name is validated where it is written — lower-case letters, digits and underscores, at
most the 63 bytes Postgres truncates at — because it is spliced into every statement as an
identifier.

**What is not adoptable yet**, `As of 2026-08`. Each of these is a real table shape that this
vocabulary cannot express, said precisely rather than approximated:

| Shape | Why, and what to do instead |
|---|---|
| a `numeric` money column with no currency column beside it | `money()` is an amount **and** a currency by construction, and a single implied currency is the bug it exists to prevent. Declare it `decimal()` and keep the currency where the app already keeps it, or add the column |
| a Postgres `enum` TYPE | `enumerated()` emits a CHECK, never `CREATE TYPE`, so a column of a real `pg_enum` type has no declaration. `text()` reads and writes it correctly today; what is missing is the DDL and the closed set |
| a composite type, a range, `hstore` | no builder, and no way to spell one |
| a live query over a renamed column | `@ultimat3/realtime` rebuilds a row from the physical names alone (it holds no dependency on this package) and would deliver `ghLogin` where the repository says `githubLogin`. Renamed columns are safe everywhere else |
| `x db gen` over an adopted table | the generator would emit `create table` for a table that exists. Baselining an existing schema is its own command and is not built |

## Invariants

| Rule | Behavior |
|---|---|
| Named | `inv('published-post-has-title', …)` — the name is the error text and the test name |
| Enforced on write | via the repo and, where expressible, a Postgres CHECK generated into the migration |
| Violation | throws `X_INVARIANT_VIOLATED` with the invariant name and the offending row id |
| Not authz | an invariant is about data shape. Permission belongs in [Policies and authz](Policies-And-Authz) |
| Duplicate entity | two entities on one table name is `X_ENTITY_DUPLICATE` — rename or merge |

## Embeddings

```ts
embed: { field: 'body', model: 'text-embedding-3-large' },
```

| Piece | What is generated |
|---|---|
| Column | a pgvector column sized from the model, in the same Postgres — no second datastore |
| Index | **HNSW**, created by the generated migration |
| Backfill | a `job` with steps: resumable, rate-limited per tenant, safe to re-run (at-least-once) |
| Re-embed | content-hash change enqueues a job; unchanged text is never re-embedded |
| Exact cache | embeddings cached by content hash + model in cache tier 3 |
| Search | one hybrid `query` fusing pgvector cosine + Postgres FTS with Reciprocal Rank Fusion; weights are config |

More in [MCP and AI](MCP-And-AI).

## Migration workflow

| Step | Command | Behavior |
|---|---|---|
| Generate | `x db gen "add publish_at"` | diffs entities vs migrations, writes a named, ordered migration + its `down` |
| Apply (dev) | `x db migrate` | runs pending migrations against the dev DB; live queries resubscribe |
| Check | `x db migrate --json` | the live schema against the ledger it just wrote; exits non-zero on a difference |
| Inspect | `x db studio` | tables, columns, indexes, FKs, generated SQL — also the `/_x` **Schema** panel |
| Pre-deploy | `ROLE=migrate` container | run-once hook, same image; waits on the session-pinned migration lock while another version's migration is in flight, then applies. The wait is bounded at 60s (`As of 2026-08`) — past that it exits non-zero with `X_MIGRATE_CONCURRENT` instead of hanging the rollout |
| Test template | automatic | migrate + seed once into `myapp_test_tpl`, then clone per worker |

Prod ordering is fixed: `ROLE=migrate` completes, then `web` / `sync` / `worker` / `scheduler` roll. Migrations are forward-compatible with the previous release so a rolling restart never serves a request against a schema it cannot read. See [Deployment](Deployment).

## Drift is a `x verify` failure

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

| Direction | Meaning | Caught by |
|---|---|---|
| Entity has what migrations lack | you edited an entity and did not generate — run the `fix` | `x verify` |
| DB has what migrations lack | someone changed the database by hand; generate a migration or revert the change | `x db migrate` |
| Migrations have what the entity lacks | a stale migration or a deleted column; reconcile before shipping. Deleting the **last** entity is this direction, not "nothing is declared so nothing drifts": `x db gen "<name>"` refuses with `X_MIGRATION_IRREVERSIBLE`, and the same command plus `--allow-destructive` writes the drop | `x verify` |
| Neither declares anything | not drift. Zero entities against zero migrations is agreement, which is what keeps a scaffold with no `entity()` green until its first one | — |

One code, two detectors, because one check cannot be both. `x verify`'s `drift` step reads the
entity source and the `.hash` a migration recorded — no database, which is what lets the gate run
in CI. `x db migrate` diffs the live catalog against the `x_migrations` ledger on the connection it
just migrated over — the only place a hand-edited column is visible at all. A pending migration is
not drift, and neither is a table in the framework's `x_` namespace.

### What the catalog diff compares

Eleven `DriftKind` values, `As of 2026-08-25` — the executable list is `DriftKind` in
[`packages/db/src/drift.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/db/src/drift.ts).
**Only the declared side is judged**: a live index or key no snapshot names is not drift, because
Postgres creates one for every primary key and every unique constraint and an index a DBA added is a
planner decision.

| Kind | Raised when |
|---|---|
| `unexpected-column` · `missing-column` · `changed-column` | a modelled table's columns disagree with the snapshot. A primary-key column reads as `NOT NULL` on both sides whether or not anything declared it |
| `unexpected-table` · `missing-table` · `unknown-schema` | a modelled table is absent, or a table outside `x_` is present that no migration declares |
| `missing-index` | the snapshot names an index the catalog does not hold |
| `missing-check` | the snapshot names a CHECK constraint the catalog does not hold. Compared **by name only** — `pg_get_constraintdef` answers Postgres' own rewriting (`status in ('draft','published')` comes back as `CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))`), so the predicate's text can never be compared, exactly as an index's `where` cannot. Only the **declared** side is judged, so a `NOT NULL`, an `enumerated()` column's old anonymous constraint and an extension's own are all silent |
| `changed-index` | the index is there and one of **four** facts about it differs: its column list, its uniqueness, its **direction**, or whether it is **partial**. The last two are new `As of 2026-08-19` — a `desc` index rebuilt ascending served a feed's newest page off the wrong end, and a partial index recreated as a total one silently widened the constraint, and both read `ok: true`. `asc` is normalised to `null` first, because Postgres stores an ascending index as not-descending. The predicate's **text** is deliberately never compared → [Known gaps](Known-Gaps) |
| `missing-foreign-key` | no key points those columns at that table. Matched on **where the key points**, never on its name: a hand-written `constraint fk_posts_org` is the same constraint as a generated `posts_org_id_fkey` |
| `changed-foreign-key` | new `As of 2026-08-19`. The key points where it was declared to point and one side's `on delete` rule is not the other's. Reported apart from `missing-foreign-key` because it is a different repair — the constraint is there, and what changed is what happens to the child rows. Its `fix:` is the **pair**, not `x db migrate`: a rule cannot be altered in place, `add constraint` alone is `42710` on a name already taken, and no `x db gen` diff emits either statement. Both sides go through one normalisation, so the catalog's `c` and a snapshot's `cascade` agree, and Postgres' `a` (`no action`) on every undeclared key reads as no rule |

There is no separate migration tool and no "regenerate types" step. `drift` is one of `x verify`'s twenty steps — the list, in order, is in [Testing](Testing).

## Reversible or marked

Two questions, two answers. **Reversible** is asked at generation: can the `down` put the rows
back? **Destructive** is asked at the gate: does applying the `up` destroy data, and does the file
say so? A retype is reversible in DDL and still rewrites every row, which is why one flag cannot
answer both.

| Rule | Detail |
|---|---|
| Every migration has a `down` | `x db gen` writes both halves of one file, split by a lone `-- down` line |
| A generated drop | refuses with `X_MIGRATION_IRREVERSIBLE` — its `down` cannot restore the rows. Re-run with `x db gen "<name>" --allow-destructive` |
| A destructive `up` | must carry `-- destructive: true` as a line in the file. `x db gen` writes it for you; an unmarked one fails `x verify`'s `drift` step with `X_MIGRATION_DESTRUCTIVE` |
| What counts as destructive | `drop table`, `drop column`, `truncate`, `alter column … type` — a closed list. `drop constraint`, `drop default`, `drop not null` and `drop index` do not: the database rebuilds those |
| Only `up` is judged | reversing a `create table` is a `drop table`, so a rail that read `down` would mark every migration ever generated |
| Mark it before it is applied | the marker is SQL the checksum covers, so adding it to an applied migration is an edit — `X_MIGRATION_CONFLICT`, correctly |
| Rollout | a marked drop still wants a rollout note; prefer expand → migrate → contract across two releases |

```sql
-- 20260814120000_drop_legacy
-- GENERATED by `x db gen` from the app's entities — do not edit.
-- Editing an applied migration changes its checksum: X_MIGRATION_CONFLICT on the next apply.
-- destructive: true

alter table "posts" drop column "legacy";

-- down
alter table "posts" add column "legacy" text; -- data is not restored
```

```text
X_MIGRATION_DESTRUCTIVE: this migration destroys data and does not say so
  cause: packages/db/migrations/20260814120000_drop_legacy.sql drops a column and does not
         declare it: alter table "posts" drop column "legacy"
  fix:   add the line "-- destructive: true" to packages/db/migrations/20260814120000_drop_legacy.sql,
         or regenerate it: x db gen "<name>" --allow-destructive
```

## Branch DBs for agents

The shipped command is `x db branch`, and it takes a verb from a closed set — `ls`, `create <name>`, `drop <name>`. `x branch` (no `db`) is **planned** and exits `X_NOT_IMPLEMENTED`; the build and MCP-socket halves of the design below are what it will add.

```bash
x db branch create feat-new-billing --json
```

```json
{"ok":true,"command":"db","data":{"branch":"feat-new-billing",
 "database":"myapp_branch_feat_new_billing",
 "preview":"http://feat-new-billing.localhost:3000","mode":"external"}}
```

| Property | Detail | `As of 2026-08` |
|---|---|---|
| Mechanism | `CREATE DATABASE "<source>_branch_<slug>" TEMPLATE "<source>"` — Postgres file-copies, cheap, isolated, disposable. `<slug>` is the name with every character outside `[A-Za-z0-9_]` replaced by `_` (`branchDatabaseName`), because a hyphen is not legal in an unquoted identifier — hence `myapp_branch_feat_new_billing` above. On the embedded database it is `branchPglite()`, a data-directory copy named `pgdata-<name>`, which keeps the name as typed | **shipped** |
| Writes | the MCP `db.migrate` tool applies **only** in a branch DB, never the shared dev DB (`X_MCP_NOT_BRANCH_DB`) | **shipped** |
| Preview URL | reported in `data.preview`, subdomain-routed off `PORT` | **the URL is computed**; nothing routes that subdomain for you |
| Listing | `x db branch ls` — name, location, created-at, size, over either database. **Managed branches only**: external, a database carrying `createBranch()`'s marker comment (`listBranches()` is that read); embedded, a `pgdata-<name>` directory under the state dir (`listPgliteBranches()`, in the CLI). A branch cloned by the pre-1.2.x `psql` path carries no marker and is invisible → [Known gaps](Known-Gaps). `created-at` and `size` read `unknown` where nothing recorded one — always the size on the embedded side, since measuring it is a full directory walk | **shipped** |
| Teardown | `x db branch drop <name>`. It may only drop what `ls` shows, and that guard lives in the **CLI** (`runDrop` lists first, then drops): the shared database this session is connected to carries no marker, so it is not in the set, and there is no `--force` to get it wrong with. `@ultimat3/db`'s `dropBranch()` is the statement underneath, not the same operation — it takes the **database** name (`<source>_branch_<slug>`), reads no marker, and will drop any database but the current one. Its `force: true` means "terminate other sessions first", which the CLI always passes; it is not an override of the guard | **shipped** |
| Reaping | `reapBranches({ maxAgeMs })` drops **branches of this database only**, `As of 2026-08-19`. The marker is `ultimate:branch:<base>:<iso>` and `BranchInfo` carries `base`; a branch whose base is not `current_database()` is skipped, and so is a pre-3.x marker that records no base at all. A `createdAt` that is not finite, or that does not round-trip through `toISOString()`, is also skipped — a truncated comment used to read as an infinitely old branch and be dropped on the next sweep whatever `maxAgeMs` said | **shipped** |
| Build + scoped MCP socket | a per-branch build id scoping the service worker, and `ws://localhost:9229/<branch>` | **planned**, part of `x branch` |

The same clone mechanism powers test parallelism: each worker gets its own `ultimate_test_template_w<N>` cloned from the migrated template `ultimate_test_template`, typically 100–400ms. Never mock the database — clone it.

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_DB_DRIFT` | schema differs from migrations | `x db gen "<name>"` |
| `X_ENTITY_DUPLICATE` | two entities on the same table | rename one, or merge them |
| `X_INVARIANT_VIOLATED` | a write broke a named invariant | fix the caller, or change the invariant and generate a migration |
| `X_TENANCY_UNSCOPED` | a query without a tenant predicate | go through the repo |
| `X_PRELOAD_UNKNOWN_RELATION` | `preload('<name>')` named a relation no `references()` produces | pick one of the relation names the error lists, or add the `.references()` call that creates it |

Full list with `--json` shapes: [Error codes](Error-Codes). Source: [`docs/idea/02-primitives.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/02-primitives.md), [`docs/idea/10-testing.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/10-testing.md).
