# @ultimat3/entity 🗄️

An entity is **columns + the invariants that hold for every row**. The row type is derived from
the columns: `type Post = typeof posts.$row`. Declare the shape once — repos, migrations, the
admin screen, cache tags and the manifest are all projections of that one call.

```ts
import {
  entity, enumerated, integer, invariant, text, timestamp, url, uuid,
} from '@ultimat3/entity';

export const posts = entity('posts', {
  tenant: 'orgId',
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().references(() => orgs.id, { onDelete: 'cascade' }),
    slug: text({ max: 80 }),
    title: text({ max: 120 }),
    coverUrl: url().nullable(),
    status: enumerated(POST_STATUSES).default('draft'),
    likeCount: integer().default(0),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  invariants: (c) => [
    invariant('post_title_present', c.title.trimmed().minLength(1)),
    invariant('post_slug_unique_per_org', c.unique(['orgId', 'slug'])),
    invariant('post_like_count_non_negative', c.likeCount.atLeast(0)),
  ],
  indexes: [{ on: ['orgId', 'createdAt'], order: 'desc', where: (c) => c.status.eq('published') }],
});

export type Post = typeof posts.$row;

export const PostView = posts.$view(['id', 'title', 'coverUrl', 'status']);
export type PostView = typeof PostView.$row;
```

## `$view` is what leaves the server

`posts.$view([...])` returns a Standard Schema over a subset of the row, so an action names it
directly — `output: PostView` — and the projected type flows on to the client and the component.

| Rule | Detail |
|---|---|
| Keys are checked twice | unknown key ⇒ `tsc` error, and `X_INVARIANT_VIOLATED` at declaration for a JS caller |
| Values are the columns' | each key is parsed by the column that declared it; no second copy of the rule |
| Nothing is invented | a view projects a row that exists — an absent required key is missing data, not a default |
| `$name` | `posts.view.id_title_coverUrl_status` — stable, and legal as an OpenAPI `components.schemas` key |

There is no free `view(posts, [...])` function: a projection is reached through the entity, and
every framework member is `$`-prefixed so a column may still be called `name`, `view` or `tenant`.

A view the columns cannot express — a joined `authorName`, a computed `excerpt` — is a hand-written
`t.object({...})`. `t` is re-exported here, the same object `@ultimat3/schema` exports, so that file
still imports one package: `import { entity, t } from '@ultimat3/entity'`.

## Blessed columns

| Builder | Emits | Why it is the only way |
|---|---|---|
| `uuid()`, `uuid<PostId>()` | `uuid`; `.primaryKey()` defaults to v7 | time-ordered keys keep the pk index append-friendly; the optional brand is declared once and survives to every signature |
| `timestamp()` | `timestamptz` | UTC storage is not a per-table decision; there is no naive variant |
| `money()` | `<name>_minor bigint` + `<name>_currency char(3)` + `<name>_scale integer null` | never a float, never one implied currency. The row value is `@ultimat3/schema`'s `MoneyValue` — the same declaration `@ultimat3/money`'s `Money` is — so a decoded row goes straight to `add()`/`formatMoney()`. A writer may hand a `bigint`; a stored minor unit past ±2^53 is refused on read, never rounded. `scale` is the decimal exponent `minor` counts in when it is not the currency's own (`{ minor: 2, currency: 'USD', scale: 6 }` is $0.000002); NULL in the column means "the currency's own minor unit" and round-trips as an ABSENT key, never as `0` |
| `enumerated(v)` | `text` + CHECK | a variant is a one-line migration, not `ALTER TYPE` |
| `tz(zones)`, `locale(tags)` | `text` + CHECK, `Intl`-validated at declaration | an offset is not a time zone |
| `text({ max })`, `integer()`, `boolean()`, `url()` | `text`/`integer`/`boolean` + CHECK | format is enforced by the database too |

Chain: `.primaryKey()` · `.nullable()` · `.unique()` · `.default(v)` · `.defaultNow()` ·
`.onUpdateNow()` · `.references(() => other.id, { onDelete })` · `.tenant()`. Physical names are
derived from the property key (`orgId` → `org_id`); a name is written once, or never.

## Branded ids

```ts
export const posts = entity('posts', {
  columns: { id: uuid<PostId>().primaryKey(), authorId: uuid<UserId>().references(() => users.id) },
});

const post = await db.posts.findById(postId);   // PostId — a UserId here is a compile error
```

The brand is declared once, on the column, and carried by the whole chain: `RowOf`, `Insertable`,
`Repo.findById/update/delete` and `Table.update/delete`, whose id parameters are `IdOf<Row>` —
the type the entity's own `id` column declared. `IdOf` collapses to `string` for a row that
declared no brand and for a composite key, so an unbranded entity reads exactly as it always did.
Nothing is checked at runtime: a brand has no witness, `$parse` still validates the uuid, and
`type-pins.ts` is where the claim is enforced.

## Invariants run twice

One declaration, two enforcement points: the app checks it on every write, and the migration
emits it. A bulk import or a `psql` session hits the same rule.

```sql
ALTER TABLE "posts" ADD CONSTRAINT "posts_post_like_count_non_negative_check" CHECK (like_count >= 0);
CREATE UNIQUE INDEX "posts_post_slug_unique_per_org_key" ON "posts" ("org_id", "slug");
```

A rule written as a JS predicate — `c.slug.matches(isValidSlug)`, `c.satisfies(fn, [...])` —
still runs on write, reports `kind: 'assert'` and `sql: null`, and is what `x verify` warns
about: a rule the database does not know is a rule a migration script can violate.

## One typed handle

```ts
export const db = database({ orgs, posts });

db.posts.where({ orgId }).orderBy('createdAt').limit(50).page(); // { rows, nextCursor }
```

`db.posts` exists because `posts` was declared. Pagination is **cursor-only**: `OFFSET` is wrong
under concurrent writes, because an insert before the offset shifts every later page and the
client silently skips and repeats rows.

`nextCursor` is signed by `@ultimat3/core` and scoped to the plan that produced it — this entity,
these filters, this sort order. A tampered cursor, or one taken from another listing, is
`X_CURSOR_INVALID` rather than a silent page one. The page size is deliberately outside the scope:
asking for a bigger next page is the same query.

**A page is bounded whether or not the caller bounded it.** `DEFAULT_PAGE_SIZE` (50) covers the read
nobody sized; `MAX_PAGE_SIZE` (10,000) covers the one they did — `limit(input.pageSize)` on a number
that arrived over the wire is the same production incident with an argument in front of it. A page
size that is not a whole number of rows in `1..MAX_PAGE_SIZE` is `X_INVARIANT_VIOLATED` on the chain
and again inside the plan both drivers build, so `findMany({ limit })` straight at the repository
cannot route around it. `inBatches(size)` is the call that means "every row" — one page per
statement, never a table in memory.

`DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE` and `MAX_ASSERTED_ROWS` are exported, beside
`N_PLUS_ONE_THRESHOLD` and for the same reason: an action validating its own `pageSize` input
against a hardcoded `10_000` is a second declaration of one number, and the second one goes stale.

## Iterating every row

`As of 2026-08`. A page is bounded on purpose, so reading a whole table is a loop — and the loop is
the terminal, not something the caller writes around `page()`:

```ts
// One statement per batch, one page of rows in memory at a time.
for await (const batch of db.posts.where({ orgId }).preload('author').inBatches(500)) {
  await search.index(batch);
}

// Stopping early is cheap: the position survives, so the next run resumes where this one stopped.
await using batches = db.posts.where({ orgId }).after(checkpoint).inBatches(500);
for await (const batch of batches) {
  await search.index(batch);
  if (ctx.clock.now() > deadline) break;
}
await db.checkpoints.update(id, { cursor: batches.cursor });
```

Every batch is the page `page()` would have returned at that position — same filters, same tenancy,
same soft-delete visibility, same `select()`, same `preload()` — so there is no second read path to
learn or to drift.

| | |
|---|---|
| Statements | one per batch, each asking for one row past it, exactly as `page()` does. An empty batch is never yielded |
| Position | keyset, never OFFSET: a row written mid-iteration cannot make the loop skip or repeat one. `after(cursor)` starts it, `.cursor` is where it stopped, `null` once exhausted |
| Closing | `break`, `return` and a throw all stop the next statement; `await using` is the same guarantee for a handle kept in a variable, and `close()` is idempotent. One handle is one iteration — a second `for await` continues it rather than restarting the table |
| Refusals | on the chain, not one batch later: a size that is not a whole number of rows between 1 and `MAX_PAGE_SIZE` (10,000), a `limit()` on the same chain (one number, two meanings), and an ordering no cursor can carry — a nullable sort column, which a result that fits in one batch would otherwise hide until the table grew |
| Tenancy | the plan's, as everywhere else: an unscoped chain is `X_TENANCY_UNSCOPED` on its first batch |

## Counting by a column

`As of 2026-08`. `count()` answers one number, so a screen or a backfill that needs one per row
asks N times. `countBy(column)` is that whole loop as one statement, keyed by the value:

```ts
// One statement for every post in `ids`, not one `select count(*)` each.
const counts = await db.likes.where({ orgId }).andWhere('postId', 'in', ids).countBy('postId');
for (const id of ids) await db.posts.update(id, { likeCount: counts.get(id) ?? 0 });
```

`ReadonlyMap<Row[K], number>`, keyed by the column named — the chain knows the row, so
`counts.get(postId)` is a `number | undefined` and the `undefined` is load-bearing.

| | |
|---|---|
| Counts | the whole predicate, exactly as `count()` does: the chain's filters, its tenancy and its soft-delete visibility. `limit()` and `after()` bound the page, never the count |
| A value nothing matched | absent, never `0` — that is what `group by` returns, and it is what tells "none" apart from "never asked". The default is the caller's `?? 0` |
| NULL | one group, keyed `null`, in both drivers. `0`, `''` and `false` stay the values they are |
| Order | biggest group first, ties by the value (numbers and bigints numerically, everything else by its text), `null` last — applied after the rows are in, since a hash aggregate and a `Map` filled row by row have no order to inherit |
| Groupable columns | `uuid`, `text`, `char`, `boolean`, `integer`, `bigint`. A timestamp, a `jsonb` or `money` is `X_INVARIANT_VIOLATED` naming one of this entity's columns that is: a `Map` compares a non-primitive key by identity, so such a map could only ever answer `undefined` |
| More than 1000 groups | `X_INVARIANT_VIOLATED`, never a truncated map — the statement asks for one group past the bound, exactly as a page reads one row past its limit. The `fix` spells the `andWhere('<column>', 'in', <values>)` that bounds it |
| Statement | `select "post_id" as group_value, count(*) as group_count … group by "post_id"`. Both names are fixed aliases, so an entity may still declare a column called `count`, and the grouped value is re-parsed by the column that declared it |

## Writing by filter

`deleteWhere`/`updateWhere` are the bulk forms of `delete`/`update` — the same fix `insertAll` is
for a per-row insert loop, applied to the two write shapes a composite-key entity cannot address
one row at a time: a `for … of` deleting or patching one row per iteration is one statement here,
not `n`.

```ts
db.posts.delete(id);                                        // by a single primary key
db.posts.update(id, { title });                             // ditto

db.likes.deleteWhere({ postId, userId });                   // -> 1  · the only way to unlike
db.likes.deleteWhere({ postId });                           // -> n  · every like on that post
db.participants.updateWhere({ conversationId, userId }, { lastReadAt });   // -> 1 · mark read

db.likes.deleteWhere({});                                   // X_WRITE_UNFILTERED, never every row
db.participants.updateWhere({ conversationId }, {});        // X_PATCH_EMPTY, never a silent no-op
```

`delete(id)` and `update(id, patch)` both need a single-column primary key. A composite one —
`likes`, `blocks`, `participants`, any join table — has no single id, so the filtered pair is the
only write path there: without them such an entity is **create-only**, and a row could be written
and never unwritten.

| | |
|---|---|
| Returns | the **number of rows affected**, so "nothing matched" is distinguishable from "it worked" |
| Empty filter | `X_WRITE_UNFILTERED`. An `undefined` value is dropped before the count, so a forgotten variable is the error and not the whole table |
| Empty patch | `X_PATCH_EMPTY`. Counting rows for a statement that set nothing is the same silent no-op, one argument along |
| Tenancy | the plan a read builds, through `scopedPlan` — the actor's org predicate is in the statement, and the empty-filter guard runs before it, because one tenant's every row is still every row. The patch is judged too, through `assertRowTenant`: a filter bounds which rows are written, never what they become |
| Soft delete | the entity's `deletedAt` column is the same switch `delete(id)` uses. Stamped rows are not matched again by either call, so the original deletion time survives and a deleted row is never patched back into shape |
| `onUpdateNow()` | stamped by `touch()`, the same helper `update(id, patch)` uses — one place, so the two can never disagree about `updatedAt` |
| Rows read back | **only when something can still refuse them.** A `check` or a `unique` invariant is a constraint Postgres enforced on the statement, so the answer is a count and the statement carries no `returning *`. Only a JS-only rule (`kind: 'assert'`, `sql: null`) has to be judged on the result — and then the match is counted first and refused past `MAX_ASSERTED_ROWS` (50,000), naming `inBatches(1000)`, because a refusal issued after `returning *` is already holding what it is refusing |

## Writing many rows

```ts
await db.tags.insertAll(names.map((name) => ({ orgId, name })));   // one statement, n rows

await db.likes.upsertAll(rows, {                                  // insert, or leave what is there
  onConflict: ['orgId', 'postId', 'memberId'],
  onMatch: 'nothing',
});

await db.counters.upsertAll(rows, { onConflict: ['orgId', 'day'] });   // insert, or overwrite
```

`insertAll` is `insert` in bulk and nothing else: rows are `Insertable`, each one goes through
`$parse`, so declared defaults are filled here rather than by the caller. `upsertAll` adds the one
thing a per-row loop cannot do without a read first — resolve a collision — and stamps
`onUpdateNow()` columns through the same `touch()` `update(id, patch)` uses, because an upsert that
lands on a stored row *is* an update.

Both resolve with **the rows this call wrote**, in order. Under `onMatch: 'nothing'` a row already
stored is skipped and absent from the result, exactly as `returning *` reports it — which is how a
caller counts what it actually inserted.

| | |
|---|---|
| One builder | `insertStatement` compiles every insert in the framework, so `insertAll([row])` is the text `insert(row)` always produced. There is no second insert path to drift |
| What a collision overwrites | every column the batch writes, minus the conflict target (how the row was found), minus the primary key (where it lives) and minus the soft-delete stamp (whether the row is there at all). Moving either of the first two moves a row nobody asked to move, and every foreign key pointing at that id misses it |
| A soft-deleted row it lands on | stays deleted, and takes the batch's other columns. The stamped row still occupies its conflict target — that index is not partial — so `excluded."deleted_at"` would resurrect it; `$parse` fills `deletedAt: null` into every row before the plan is built, so the stamp is dropped from the set list rather than refused. `insertAll` still writes the stamp a new row carries |
| Conflict target | properties of a **declared** unique constraint — the primary key, a `unique()` column, an `indexes: [{ on, unique: true }]` entry, or an `invariant(name, c.unique([…]))`. Anything else is `X_INVARIANT_VIOLATED` here rather than `42P10` from the server |
| Tenancy | on a tenant-scoped entity `onMatch: 'update'` requires the tenant column *in the conflict target*, else `X_TENANCY_UNSCOPED`: a target that omits it matches another tenant's row and rewrites it. `'nothing'` is allowed — it writes nothing to a row it does not own |
| A batch that repeats itself | two rows with one conflict target under `'update'` is refused. Postgres answers that statement `ON CONFLICT DO UPDATE command cannot affect row a second time`, so it cannot pass in memory either |
| Uneven batches | under `'update'` every row must name the same columns: `excluded.<column>` for a row that omitted one is that column's *default*, not "leave it alone". Under `'nothing'` and under `insertAll`, an omitted column is `default` in its cell, which is what the same row means on its own |
| Nulls | a null in the conflict target collides with nothing, in both drivers — a Postgres unique index is `NULLS DISTINCT` |
| Size | past 65535 bind parameters the batch is several statements, never one the server refuses. Wrap the call in `withTransaction` when all-or-nothing matters |
| Filtered writes | `updateWhere` / `deleteWhere` above are the bulk forms of `update` and `delete` — one statement for a loop that would otherwise call either per row; there is no `updateAll` |

## Relations are the foreign keys, read twice

```ts
relationMap().posts;
// { org:     { kind: 'belongsTo', to: 'orgs',    localKey: 'orgId',    remoteKey: 'id' },
//   author:  { kind: 'belongsTo', to: 'members', localKey: 'authorId', remoteKey: 'id' },
//   likes:   { kind: 'hasMany',   to: 'likes',   localKey: 'id',       remoteKey: 'postId' } }

relationsFor('posts');              // one entity's relations, by name
relationNamed('posts', 'author');   // one relation, or X_PRELOAD_UNKNOWN_RELATION listing the rest
```

`.references(() => members.id)` already says a post has an author and a member has posts. There
is no second declaration syntax for associations and there will not be one: the map reads the keys
that exist. `belongsTo` comes from an entity's own foreign keys, `hasMany` from the inbound ones —
so the two sides can never disagree, and neither can drift from the constraint the migration emits.

| Rule | Detail |
|---|---|
| Names | `authorId` ⇒ `author`; a `hasMany` is named for the entity the rows come from |
| Collisions | two keys wanting one name ⇒ **both** take the long form (`author` / `authorId`, `postsByAuthor` / `postsByReviewer`), so a name never depends on declaration order |
| Ambiguity | two keys that differ only by an `Id` suffix ⇒ `X_INVARIANT_VIOLATED` naming both columns, never one relation silently swallowing the other |
| Unknown name | `X_PRELOAD_UNKNOWN_RELATION`, whose `fix` is a `relationNamed()` call on one that exists plus the rest by name — they are derived, so there is no schema file listing them to go and read |
| Keys | `local*` is always on `from`, `remote*` on `to`, whichever side the edge is read from |
| Money | no relation: one property, three physical columns, so none of them is the key |

**Where they come from.** `RegistryEntry.references()` — every `entity()` call leaves one behind, so
a consumer walks the whole domain without importing a schema module. A method rather than a field:
a `references()` thunk may point at an entity that two modules of an import cycle have not finished
evaluating. `relationMap()` derives the whole registry and memoises against its generation, so a
schema module imported late is rebuilt into the map instead of being missed by it, and a read that
changed nothing costs one integer compare. `relationsOf(entries)` is the same derivation over a
named subset — a `belongsTo` to an entity outside it is still reported, a `hasMany` needs both
sides. An entity holding its own keys reads `entity.$references()`: same closure, so a foreign key
is read once and not twice.

`preload()`, below, is what consumes it — exported because the derivation is a fact about the
schema, not an implementation detail of whoever traverses it first.

## Preloading a relation

`As of 2026-08`. A single `findById` batches itself, and a `for … of` loop over a page batches the
loop it causes — reach for `preload()` to carry the relation from the start, without waiting on
either pattern to trigger it:

```ts
export const db = database({ orgs, posts, members });

// Two statements: the page, then one `select … where "id" in (…)` over its authors.
const page = await db.posts.where({ orgId }).preload('author').page();
page.rows[0].author;        // the member row, or null — always present
```

| | |
|---|---|
| Vocabulary | one method, `preload('<relation>')` — no `include`, `join` or `with` |
| Unknown name | `X_PRELOAD_UNKNOWN_RELATION` at `preload()` itself, not a page later |
| Shape | `belongsTo` attaches the row or `null`; `hasMany` an array — always present |
| Statements | one extra per relation, resolved concurrently; naming one twice is one statement |
| Tenancy | carried onto the related read only when the other entity's tenant column shares the name; otherwise `X_TENANCY_UNSCOPED` refuses the related read rather than guess |
| Terminals | `page()`, `all()`, `one()` preload; `count()`, `countBy()` and `plan()` don't — none reads a row to attach one to |

## Two drivers, one meaning

```ts
database({ orgs, posts });                                 // memoryDriver() — the default
database({ orgs, posts }, { driver: postgresDriver() });   // production
```

| | `memoryDriver()` | `postgresDriver()` |
|---|---|---|
| Rows live | in a `Map` | in Postgres |
| For | tests, `x dev` before the first migration | production |
| Transaction | `memoryTransactor()` — undo closures | `postgresTransactor()` — real `BEGIN`/`COMMIT` |
| `reset()` | empties every repository it built | not implemented — the rows are the app's |

`database()` called with no driver takes the process default, and `defaultDriver()` is that same
object — the one seam a test harness needs, `As of 2026-08`:

```ts
import { defaultDriver } from '@ultimat3/entity';

defaultDriver().repo(posts).insert(row); // seeds what database({ posts }) reads
defaultDriver().reset?.();               // between tests; `?.` because Postgres has no reset
```

`Driver.reset?()` is optional on the interface and implemented by `memoryDriver()` alone, so a
harness asks rather than assumes. It empties the repositories in place: `database()` resolves each
table's repository once, so a driver that swapped in fresh ones would leave every handle the app
already holds reading the old rows. Application code never calls either — it names its driver in
`database(entities, { driver })`, or takes the default implicitly.

They are not two implementations of an idea. They share the plan (scope, sort order, page size),
the cursor codec and the `Repo<T>` contract, so a page taken in a test means the same thing as a
page taken in production. `postgresDriver()` takes no connection: `db()` from `@ultimat3/db`
returns the open transaction when there is one, so a repository call inside `withTransaction`
joins it without being told — which is how a job's outbox row lands atomically with the write
that enqueued it.

`postgresDriver({ client })` pins one instead, for a test harness or `x db branch` — and a pinned
repository used while a transaction is open is `X_REPO_CLIENT_PINNED`, `As of 2026-08`.
`withTransaction` reserved a connection and ran `BEGIN` on it; a pinned repository sends straight
to its own client, so the write would commit whatever the transaction decides and the read would
miss what the transaction has written, both silently. It is refused rather than resolved because a
`DbTx` does not name the client it was opened on: on a sharded app "the same connection" and "the
same database" are two different questions and this layer can answer neither. `setDbClient(client)`
plus an unpinned repository is the shape that joins.

Every value is bound to `$n` and every identifier is resolved through the entity, so a column
name can only be one the entity declared and a row value can never become SQL.

## Point lookups batch themselves

`As of 2026-08`:

```ts
const repo = postgresRepo(users);
// One statement, not one per post: the lookups issued in this microtask are one `in`.
const authors = await Promise.all(posts.map((post) => repo.findById(post.authorId, { orgId })));
```

`findById` keeps its signature and gets faster. There is no `dataloader()`, no `batch()` and
nothing to opt into: inside a request the point lookups issued in one microtask become one
`select … where "id" in ($1, $2, …)` carrying the scope each of them carried, and outside one — a
job, a script — it is the single statement it always was.

| | |
|---|---|
| Window | one microtask, closed before the statement is sent |
| Lifetime | the request; the batch is keyed by context identity and dies with it |
| Never shared with | another tenant, another soft-delete visibility, another projection, another entity, another client |
| Wider than 500 ids | several whole statements, never one Postgres refuses |
| An id with no row | `null`, exactly as the single statement answered |

## A page batches the loop it causes

`As of 2026-08`. A sequential loop shares no microtask — its `await` ends the window before the
next lookup exists. So a page leaves its foreign key values behind, and the first lookup for any
one of them resolves that key for every row of the page:

```ts
const page = await postgresRepo(posts).findMany({ orgId });
for (const post of page.rows) {
  // Two statements for the whole loop: the page, then one `in` over every author on it.
  const author = await postgresRepo(users).findById(post.authorId, { orgId });
}
```

Nothing new to write: the relation is the `references()` the column already declares.

| | |
|---|---|
| Served to | a lookup with the same scope key, the same client, and no write to that entity since — the preload statement *is* the statement it was widened from |
| Scope | the tenant predicate and `deleted_at is null` are in the preload statement, so a page's ids can never resolve rows outside the reader's own scope |
| A write | drops what was preloaded for that entity, before the statement goes out, so a changed row is re-read and never served from before it |
| Held | the ids, never the rows; keyed by context identity, so it dies with the request |
| Declines to the old statement | no request in scope, an id no page indexed, a key that resolved to nothing |
| Switched off | `postgresDriver({ jitPreload: false })`, where the driver is constructed — the one switch. Not an `app.config.ts` key: nothing reads config at the seam that builds a repository |

## A loop that got past all of that is reported, with the fix already written

`As of 2026-08`. The three batching paths above are what a loop *should* have taken; `nPlusOne()`
is what an author is handed when it did not. It takes a repeated statement — the verdict a ledger
reached, never a count this package keeps — and returns the error every surface renders:

```ts
nPlusOne({ kind: 'read', subject: 'members.findById', count: 50, entity: 'members', op: 'findById' });
// X_N_PLUS_ONE_QUERY: a read repeated once per row
//   cause: members.findById ran 50 times in one request — one read per row
//   fix:   db.posts.preload('author')   # one statement for the whole page
```

The relation in that `fix` is derived, never invented: `preloadsFor(entity, op)` reads the same
`relationMap()` `preload()` resolves against, so the line pastes into a chain that already
compiles. Which edge answers which loop follows from the operation — a point lookup per row is the
`belongsTo` side (`posts.preload('author')`), a filtered read per row the `hasMany` side
(`posts.preload('comments')`), and every other operation falls back to the batched form of the
statement that repeated.

| The loop | The `fix` |
|---|---|
| `findById` / `findMany` with a relation pointing at it | `db.<page>.preload('<relation>')`, the first candidate pasteable and the rest listed — the ledger saw the statement, never the `for … of` above it |
| a read with no such relation, or an operation no preload answers | `db.<entity>.andWhere('id', 'in', ids).all()` |
| `insert` / `update` / `delete` per row | `db.<entity>.insertAll(rows)` / `.updateWhere(filter, patch)` / `.deleteWhere(filter)` |
| hand-written SQL, attributed to no entity | the statement's own `any($1)` form, or `expectedQueryLoop('<why>', fn)` |

Nothing here counts or installs anything: `x dev` owns the ledger, `@ultimat3/testing`'s `statements`
fixture owns the strict one, `expectedQueryLoop` from `@ultimat3/db` is the one way to declare a loop
deliberate, and a production process pays the one branch the observer seam costs uninstalled. The
one number both detectors read *is* here — `N_PLUS_ONE_THRESHOLD` (5), next to the codes whose `fix`
it triggers, so a loop that fails a test and a loop that warns in dev are the same loop.

## Tenancy is a guard

`tenant: 'orgId'` on the entity names the column outright. Omit it and it is inferred — a
`.tenant()` column, else one named `orgId` — so an entity never becomes unscoped by forgetting the
key; name a column that does not exist and the declaration fails with `X_INVARIANT_VIOLATED`.

**A tenant column may not be nullable**, whichever of the three switches named it, and the
declaration fails the same way. `assertRowTenant` leaves a row that names no tenant alone and
delegates to the column's `NOT NULL`; on a nullable column that delegation has nothing behind it, so
the row lands with a null tenant, is matched by no `org_id = $1`, and belongs to nobody — never in
an export, never in an offboarding sweep, and there for as long as the table is.

**The tenant is the acting actor's, and never an argument.** Inside a request every plan for a
scoped entity is scoped to `ctx.actor.orgId`, whether the call named a tenant or not — so
`db.posts.where({ status })` reads one org's posts and a handler no longer threads a tenant
through its own signatures. Writes are reads: `update(id, patch)` and `delete(id)` build the same
plan, so an id alone never addresses a row, and another tenant's id is `X_NOT_FOUND` rather than
theirs.

An `orgId` argument is still legal and now means "I assert this is the tenant": equal to the
actor's it is a restatement, different from it — an `orgId` that arrived as action input, a query
string or a path parameter — it is `X_TENANCY_ACTOR_MISMATCH`, refused rather than silently
overridden, with both values in the cause. `in` on the tenant column is judged the same way: a set
containing the actor's org is still a set that is not it.

| Situation | Answer |
|---|---|
| actor carries an `orgId` | the plan is scoped to it, derived |
| a call names the same one | a restatement; one predicate, not two |
| a call names another one | `X_TENANCY_ACTOR_MISMATCH` |
| actor carries no `orgId` (anonymous, or a service actor minted without one) | `X_TENANCY_ACTOR_ORG_REQUIRED` — inside no org, every tenant-scoped row is somebody else's |
| no request context at all (a script, a seed, a test harness) | there is no actor to derive from, so the caller names the tenant and `X_TENANCY_UNSCOPED` refuses a plan that names none |
| a read that must span tenants | `crossTenant(reason, fn)` |

**A row is judged the same way as a predicate.** `insert`, `insertAll` and `upsertAll` build no
read plan at all, and a patch decides what a row *becomes*, so the tenant a write names is checked
against the actor too: `insert({ orgId: theirs, … })` and `update(id, { orgId: theirs })` are both
`X_TENANCY_ACTOR_MISMATCH`, refused before the statement is sent and before anything is stored. A
batch is all or nothing — one bad row refuses the rows beside it, in both drivers.

**Refused, never stamped.** A row that names no tenant is left exactly as it was written: the
column's own `NOT NULL` answers a missing one. Filling it in from the actor is the ergonomic half
and it is deliberately absent, because the column list an `upsertAll` writes is decided by which
properties a row names — a stamped column would change the statement, silence the uneven-batch
refusal, and let ambient state decide which stored row a collision lands on.

**A cross-tenant upsert is unrepresentable rather than documented.** Two halves, and both are now
enforced: the conflict target must contain the tenant column under `onMatch: 'update'`
(`X_TENANCY_UNSCOPED` — the target is what decides which stored row a collision lands on), and
every incoming row must name the acting actor's tenant. Together, the key a collision is judged by
can only hold a value that is this actor's.

```ts
// admin surfaces, background reconciliation, support tooling — greppable, and never a boolean
await crossTenant('nightly invite expiry runs for every org', async () => { … });
```

The scope needs the `tenancy:cross` capability on the actor (`scopes: ['tenancy:cross']`), proven
at the call and again at every plan built inside it, so an impersonated child context cannot
inherit it: `X_TENANCY_CROSS_DENIED` otherwise. A blank reason is refused — an escape with no
argument is a pragma. There is no build-time tenancy check in `x verify`, and there cannot
usefully be one: the tenant is a request-time value, so the seam every plan is built through is
the enforcement.

## Seeds

`defineSeed('dev', async ({ insert, id }) => …)`. `id('post:tenancy')` is a UUID v5 of the label,
so the same fixture graph gets the same ids on every machine. Rows go through the columns and
the invariants, which makes a seed a test of the schema as well.

## Errors

`X_ENTITY_DUPLICATE` · `X_INVARIANT_VIOLATED` · `X_TENANCY_UNSCOPED` ·
`X_TENANCY_ACTOR_MISMATCH` · `X_TENANCY_ACTOR_ORG_REQUIRED` · `X_TENANCY_CROSS_DENIED` ·
`X_DB_DRIFT` · `X_NOT_FOUND` · `X_WRITE_UNFILTERED` · `X_PATCH_EMPTY` ·
`X_PRELOAD_UNKNOWN_RELATION` · `X_N_PLUS_ONE_QUERY` · `X_N_PLUS_ONE_WRITE`

## Boundaries

Tier 2. Imports `@ultimat3/core`, `@ultimat3/schema` and `@ultimat3/db` only — `db` is tier 1
(it imports `core` and nothing else), which is what keeps `Driver` and its production
implementation in one package instead of two. No `drizzle-orm` dependency:
`types.ts` declares the narrow structural column vocabulary this package consumes, so the
generated SQL stays readable and an agent can self-correct against it. `@ultimat3/cache`
invalidates by the `entity:<name>` tag.
