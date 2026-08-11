# @postly/db

Six entities, their migrations, the cache-tag graph, and the deterministic dev seed.

**Schema only.** No business logic, no policy decisions, no HTTP. An entity declares columns,
indexes, and invariants; anything that decides *whether* something may happen lives in
`policy.ts`, anything that decides *what* happens lives in `packages/core` or a feature's
`service.ts`.

## Entities

| Entity | Tenant column | Notable |
|---|---|---|
| `orgs` | is the tenant | `planCode` + `billingCurrency`; slug is globally unique |
| `members` | `orgId()` | `tz()` and `locale()` per member — the digest and every timestamp read them |
| `posts` | `orgId()` | `(orgId, slug)` unique; `likeCount` is a denormalised counter the mutator maintains |
| `comments` | `orgId()` | cascades with its post |
| `likes` | `orgId()` | composite key `(postId, memberId)` — the uniqueness *is* the idempotency of `likePost` |
| `plans` | none (catalog) | `money()` price, one row per `(code, currency)` |

## Public API

| Export | Purpose |
|---|---|
| `db` | the typed handle a `repo.ts` or a `query`'s `sql` uses |
| `orgs` `members` `posts` `comments` `likes` `plans` | entity declarations |
| `tag` | the cache-tag graph: `tag.post`, `tag.post.id(x)`, `tag.feed` |
| `type Org` `Member` `Post` `Comment` `Like` `PlanRow` | inferred row types |
| `dev` (from `@postly/db/seeds/dev`) | the deterministic dev fixture graph |

## Invariants are one declaration

```ts
invariants: [
  invariant('slug_shape', (c) => c.slug.matches(SLUG_PATTERN)),
  invariant('publish_coherent', (c) => c.status.eq('published').iff(c.publishedAt.isNotNull())),
]
```

Each one projects to a Postgres `CHECK` constraint **and** to the runtime parse boundary. The
predicate is written once, so the database and the app can never disagree — the classic failure
where validation lives in the app and the table happily stores the broken row.

## Migrations

```bash
x db gen "add publish_at"     # diffs entities against migrations, writes the SQL
x db migrate                  # forward-only in prod; branch DBs in dev
```

Never hand-write or edit a migration. A schema that differs from the migrations is `X_DB_DRIFT`
in `x verify`, with the exact `x db gen` command to fix it.

## Seeds

```bash
x db seed dev
```

Deterministic: same UUIDs, same rows, every run. Two orgs, five members spread across four
timezones and both locales, posts in both statuses, likes, comments, and the plan catalog in USD
and EUR. Tests build the test template database from this same graph, so a bug reproduced in dev
reproduces in CI.

## Rules

- Columns are `NOT NULL` by default; `.nullable()` is an explicit choice, and reviewers see it.
- Every tenant-scoped table carries `orgId()` and an index leading with it. There is no
  "we'll add tenancy later".
- Money is a `money()` column — an integer minor-unit column plus its currency. A `numeric`
  price does not compile.
- Timestamps are `timestamptz`, stored UTC. Formatting happens at the edge with an explicit zone.
