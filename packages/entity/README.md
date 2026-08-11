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
| `uuid()` | `uuid`; `.primaryKey()` defaults to v7 | time-ordered keys keep the pk index append-friendly |
| `timestamp()` | `timestamptz` | UTC storage is not a per-table decision; there is no naive variant |
| `money()` | `<name>_minor bigint` + `<name>_currency char(3)` | never a float, never one implied currency |
| `enumerated(v)` | `text` + CHECK | a variant is a one-line migration, not `ALTER TYPE` |
| `tz(zones)`, `locale(tags)` | `text` + CHECK, `Intl`-validated at declaration | an offset is not a time zone |
| `text({ max })`, `integer()`, `boolean()`, `url()` | `text`/`integer`/`boolean` + CHECK | format is enforced by the database too |

Chain: `.primaryKey()` · `.nullable()` · `.unique()` · `.default(v)` · `.defaultNow()` ·
`.onUpdateNow()` · `.references(() => other.id, { onDelete })` · `.tenant()`. Physical names are
derived from the property key (`orgId` → `org_id`); a name is written once, or never.

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

## Writing by filter

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
| Tenancy | the plan a read builds, through `assertScoped` — the org predicate is in the statement, and the empty-filter guard runs before it, because one tenant's every row is still every row |
| Soft delete | the entity's `deletedAt` column is the same switch `delete(id)` uses. Stamped rows are not matched again by either call, so the original deletion time survives and a deleted row is never patched back into shape |
| `onUpdateNow()` | stamped by `touch()`, the same helper `update(id, patch)` uses — one place, so the two can never disagree about `updatedAt` |

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

They are not two implementations of an idea. They share the plan (scope, sort order, page size),
the cursor codec and the `Repo<T>` contract, so a page taken in a test means the same thing as a
page taken in production. `postgresDriver()` takes no connection: `db()` from `@ultimat3/db`
returns the open transaction when there is one, so a repository call inside `withTransaction`
joins it without being told — which is how a job's outbox row lands atomically with the write
that enqueued it.

Every value is bound to `$n` and every identifier is resolved through the entity, so a column
name can only be one the entity declared and a row value can never become SQL.

## Tenancy is a guard

`tenant: 'orgId'` on the entity names the column outright. Omit it and it is inferred — a
`.tenant()` column, else one named `orgId` — so an entity never becomes unscoped by forgetting the
key; name a column that does not exist and the declaration fails with `X_INVARIANT_VIOLATED`.

Either way, every read then needs an org predicate. Without one: `X_TENANCY_UNSCOPED`, at the
seam, every time. Writes are reads: `update(id, patch)` and `delete(id)` build the same plan, so
an id alone never addresses a row, and another tenant's id is `X_NOT_FOUND` rather than theirs.

## Seeds

`defineSeed('dev', async ({ insert, id }) => …)`. `id('post:tenancy')` is a UUID v5 of the label,
so the same fixture graph gets the same ids on every machine. Rows go through the columns and
the invariants, which makes a seed a test of the schema as well.

## Errors

`X_ENTITY_DUPLICATE` · `X_INVARIANT_VIOLATED` · `X_TENANCY_UNSCOPED` · `X_DB_DRIFT` ·
`X_NOT_FOUND` · `X_WRITE_UNFILTERED` · `X_PATCH_EMPTY`

## Boundaries

Tier 2. Imports `@ultimat3/core`, `@ultimat3/schema` and `@ultimat3/db` only — `db` is tier 1
(it imports `core` and nothing else), which is what keeps `Driver` and its production
implementation in one package instead of two. No `drizzle-orm` dependency:
`types.ts` declares the narrow structural column vocabulary this package consumes, so the
generated SQL stays readable and an agent can self-correct against it. `@ultimat3/cache`
invalidates by the `entity:<name>` tag.
