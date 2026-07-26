# @ultimat3/entity 🗄️

An entity is **a table + its domain type + its invariants**. The first of the eight
primitives; repos, admin screens, cache tags and the manifest are all derived from
one `entity()` call.

```ts
const posts = entity({
  table: table('posts', { id: id(), orgId: orgId(), title: text(), ...money('price'),
                          ...timestamps(), ...softDelete() }),
  type: Post,
  invariants: [invariant('title_not_empty', {
    message: 'title must not be empty',
    sql: 'char_length(title) > 0',
    holds: (p) => p.title.length > 0,
  })],
});
```

## Blessed columns

| Helper | Emits | Why it is the only way |
|---|---|---|
| `id()` | `uuid` pk, v7 default | time-ordered keys keep the pk index append-friendly |
| `timestamps()` | `created_at`/`updated_at` `timestamptz` | UTC storage is not a per-table decision |
| `money('price')` | `price_minor bigint` + `price_currency char(3)` | never a float, never one implied currency |
| `tz()` | `text` + regex CHECK, `Intl`-validated | an offset is not a time zone |
| `locale()`, `slug()` | `text` + CHECK | format is enforced by the database too |
| `orgId()` | `uuid` + FK + index | its presence is what turns on tenancy |
| `softDelete()` | `deleted_at timestamptz null` | its presence is what turns on soft delete |
| `jsonb(parse)` | `jsonb` | a jsonb column without a parser is an untyped hole |

Physical names are derived from the property key (`orgId` → `org_id`); write a name
once or not at all.

## Invariants run twice

Written once, enforced in the app on every write **and** in Postgres as a CHECK or a
unique index (`toSql()`). The database can never disagree with the code — a bulk
import or a `psql` session hits the same rule.

```sql
ALTER TABLE "posts" ADD CONSTRAINT "posts_title_not_empty_check" CHECK (char_length(title) > 0);
```

## Repositories

`Repo<T>` takes an explicit `tx` on every write so the transactional outbox can join
the request's transaction. Pagination is **cursor-only**: `OFFSET` is wrong under
concurrent writes because an insert before the offset shifts every later page, so a
client silently skips and repeats rows. `memoryRepo()` is the default driver
(tests, `x dev` before the first migration); Drizzle + Postgres is production.

## Tenancy is a guard

An entity with an `orgId` column can only be queried through a plan carrying an org
predicate. Without one: `X_TENANCY_UNSCOPED`, at the seam, every time.

## Errors

`X_ENTITY_DUPLICATE` · `X_INVARIANT_VIOLATED` · `X_TENANCY_UNSCOPED` · `X_DB_DRIFT` ·
`X_NOT_FOUND`

## Boundaries

Tier 2. Imports `@ultimat3/core` and `@ultimat3/schema` only. There is deliberately no
`drizzle-orm` dependency: `ColumnDef`/`TableDef` are the narrow structural types this
package consumes, so generated SQL stays readable and an agent can self-correct
against it. `@ultimat3/cache` invalidates by the `entity:<name>` tag string.
