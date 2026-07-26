# @ultimat3/entity 🗄️

An entity is **columns + the invariants that hold for every row**. The row type is derived from
the columns: `type Post = typeof posts.$row`. Declare the shape once — repos, migrations, the
admin screen, cache tags and the manifest are all projections of that one call.

```ts
export const posts = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    slug: text({ max: 80 }),
    title: text({ max: 120 }),
    coverUrl: url().nullable(),
    status: enumerated(POST_STATUSES).default('draft'),
    likeCount: integer().default(0),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  invariants: [
    invariant('post_title_present', (c) => c.title.trimmed().minLength(1)),
    invariant('post_slug_unique_per_org', (c) => c.unique(['orgId', 'slug'])),
    invariant('post_like_count_non_negative', (c) => c.likeCount.atLeast(0)),
  ],
  indexes: [{ on: ['orgId', 'createdAt'], order: 'desc', where: (c) => c.status.eq('published') }],
});

export type Post = typeof posts.$row;
```

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
client silently skips and repeats rows. `memoryDriver()` is the default (tests, `x dev` before
the first migration); Postgres is production and implements the same `Repo<T>`.

## Tenancy is a guard

A `.tenant()` column (or one named `orgId`) means every read needs an org predicate. Without
one: `X_TENANCY_UNSCOPED`, at the seam, every time.

## Seeds

`defineSeed('dev', async ({ insert, id }) => …)`. `id('post:tenancy')` is a UUID v5 of the label,
so the same fixture graph gets the same ids on every machine. Rows go through the columns and
the invariants, which makes a seed a test of the schema as well.

## Errors

`X_ENTITY_DUPLICATE` · `X_INVARIANT_VIOLATED` · `X_TENANCY_UNSCOPED` · `X_DB_DRIFT` ·
`X_NOT_FOUND`

## Boundaries

Tier 2. Imports `@ultimat3/core` and `@ultimat3/schema` only. No `drizzle-orm` dependency:
`types.ts` declares the narrow structural column vocabulary this package consumes, so the
generated SQL stays readable and an agent can self-correct against it. `@ultimat3/cache`
invalidates by the `entity:<name>` tag.
