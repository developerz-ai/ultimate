# Data layer

Postgres + Drizzle. SQL stays legible so an agent can read the generated statement and self-correct ([`../idea/01-stack.md`](../idea/01-stack.md)). `@ultimat3/entity` owns the schema→type→repo chain; nothing else touches SQL.

## Entity

A table + its domain type + invariants **the database also enforces**.

```ts
export const Post = entity(posts, {
  tenant: 'orgId',
  softDelete: 'deletedAt',
  invariants: [
    inv('title-not-blank', (p) => p.title.trim().length > 0, { db: "length(btrim(title)) > 0" }),
    inv('published-after-created', (p) => !p.publishedAt || p.publishedAt >= p.createdAt,
        { db: 'published_at IS NULL OR published_at >= created_at' }),
  ],
});
```

| Aspect | Rule |
|---|---|
| Projects to | Drizzle table, domain type, migration, repo, admin screen, seed factory, cache tag |
| `tenant` | required on any multi-tenant entity; names the column, not a value |
| `invariants` | checked in TS on write **and** emitted as a `CHECK` constraint when `db` is given |
| A TS-only invariant | allowed, but `x verify` warns: a rule the DB does not know is a rule a migration script can violate |
| Never | business logic, I/O, HTTP awareness, policy decisions |

Two enforcement points, one declaration. The TS check gives a typed error with a field path; the DB constraint means a bulk `UPDATE` from a migration, a psql session, or another service cannot write a row the app considers impossible.

## Repo

Generated per entity. The **only** place SQL lives.

| Method | Notes |
|---|---|
| `byId(id)` | tenant filter applied automatically; returns `null`, never throws on miss |
| `list(args)` | cursor-paginated only (below) |
| `insert(values)` / `update(id, patch)` / `softDelete(id)` | invariants run before the statement |
| `tx(fn)` | joins the ambient transaction if one exists, opens one otherwise |
| custom | added in the feature's `repo.ts`, returning schema-parsed rows |

Rules:

- Routes never touch the DB — build error (`route-touches-db`, [`02-boundaries.md`](./02-boundaries.md)). Routes call actions/queries; only `repo.ts` runs SQL.
- Services compose repos. A service that imports HTTP cannot be reused by a job — build error.
- Cross-feature access goes through the other feature's `service.ts`, never its `repo.ts`.

## Multi-tenancy

Defense in depth, because a single missed `WHERE` is a data breach.

| Layer | Mechanism | Failure |
|---|---|---|
| 1. Context | `ctx.tenantId` set once, at stage 7 of the pipeline ([`03-request-lifecycle.md`](./03-request-lifecycle.md)) | a repo call with no tenant in context throws `X_NO_CONTEXT` |
| 2. Repo | every generated statement injects `tenant_col = $ctx.tenantId` | a hand-written repo query without the filter fails a static check in `x verify` |
| 3. Write guard | insert/update stamps the tenant from context, refuses a mismatching literal | `X_TENANT_MISMATCH` |
| 4. Read guard | a returned row whose tenant ≠ context tenant is a bug, not a filter miss | `X_TENANT_MISMATCH`, logged with the query hash |
| 5. Postgres RLS | optional, opt-in per entity; policy uses a session variable set on checkout | last line of defense for raw SQL and admin sessions |
| 6. Cache keys | derived from actor scope, never hand-built | a cache hit cannot cross tenants ([`../idea/05-caching.md`](../idea/05-caching.md)) |
| 7. Live queries | subject includes the tenant; policy re-checked per delivered row | [`07-realtime-internals.md`](./07-realtime-internals.md) |

## Cursor pagination only

There is no `offset` in the repo API. Not discouraged — absent.

```ts
const page = await ctx.posts.list({
  where: { orgId },
  orderBy: [['createdAt', 'desc'], ['id', 'desc']],   // total order required
  limit: 20,
  after: cursor,                                       // opaque
});
// page.items, page.nextCursor (null when exhausted)
```

Generated SQL — a keyset predicate, index-friendly:

```sql
SELECT * FROM posts
WHERE org_id = $1
  AND (created_at, id) < ($2, $3)      -- decoded from `after`
ORDER BY created_at DESC, id DESC
LIMIT 21;                              -- 21 to detect "has more" without a count
```

### The offset failure case, spelled out

Feed ordered `createdAt DESC`, 20 per page.

| Time | Event | Consequence |
|---|---|---|
| T0 | client reads page 1: `LIMIT 20 OFFSET 0` → posts `#100 … #81` | fine |
| T1 | someone publishes post `#101` | the whole list shifts down by one |
| T2 | client reads page 2: `LIMIT 20 OFFSET 20` → rows 21–40 of the *new* ordering | rows 21–40 are now `#81 … #62` |
| result | `#81` appears **twice** (last of page 1, first of page 2); `#80` is **never returned** | duplicate + skipped row |

Under deletes it inverts: a delete between reads skips a row silently, and the user never learns there was one. Under concurrent writes at feed velocity, offset pagination is not "slightly off" — it is **lossy**, and the loss is invisible to every test that seeds a static fixture.

Keyset pagination is correct under concurrent writes because the cursor names a *position in the ordering*, not a count of rows that existed at some earlier instant. `(created_at, id) < ($2, $3)` returns exactly the rows after that position, whatever happened to the rows before it.

| Also true | Detail |
|---|---|
| Cost | offset scans and discards `OFFSET` rows; page 500 costs 500× page 1. Keyset is an index seek — page 500 costs the same as page 1 |
| Total order required | `orderBy` must end in a unique column (usually `id`), or `x verify` fails the query: a non-total order makes the cursor ambiguous |
| Cursor contents | base64url of the ordering tuple + the query shape hash, HMAC-signed. A tampered or cross-query cursor is `X_CURSOR_INVALID`, not a silent wrong page |
| Live queries | the same total-order requirement, because the matcher needs a deterministic window ([`07-realtime-internals.md`](./07-realtime-internals.md)) |
| UI need for page numbers | answered with an approximate count (`reltuples` or a windowed count), never by offsetting |

## Transactional outbox

`ctx.jobs.enqueue` writes the job row **in the same transaction as the business write**.

```ts
async handle({ input, ctx }) {
  const post = await ctx.posts.publish(input.postId);              // INSERT/UPDATE
  if (input.notify) await ctx.jobs.enqueue(notifySubscribers, { postId: post.id });  // same tx
  return post;
}
```

How `enqueue` finds the transaction: the pipeline's `handler` stage opens the transaction and puts the handle in the ALS store. `ctx.jobs.enqueue` reads it. There is no `tx` parameter to pass, therefore none to forget.

```
stage 13 handler
  BEGIN
    repo write            → uses ctx.tx
    jobs.enqueue          → INSERT INTO x_jobs (...) using ctx.tx
    cache.invalidate(tag) → INSERT INTO x_outbox (kind='cache', ...) using ctx.tx
  COMMIT                                  ← the commit *is* the enqueue
stage 14 post-commit
  notify the worker pool (LISTEN/NOTIFY), release outbox rows to the relay
```

| Bug class removed | Without an outbox |
|---|---|
| Ghost job | enqueue succeeded, transaction rolled back → worker processes a post that does not exist |
| Lost job | transaction committed, broker publish failed → the email is never sent and nothing logs |
| Double side effect | handler retry re-enqueues → two welcome emails |
| Ordering inversion | worker reads the row before the writer's commit is visible → "not found", then a retry storm |

`redis` and `nats` drivers are not exempt: the outbox table stays the transactional record and a relay moves committed rows onto the broker. Atomicity is not negotiable ([`08-jobs-internals.md`](./08-jobs-internals.md)).

## Migrations that cannot lie

| Rule | Enforcement |
|---|---|
| Schema is the source; migrations are the ledger | `x db gen "<name>"` diffs schema vs. applied migrations and writes SQL |
| Applied set is recorded in-DB | `x_migrations` table: name, checksum, applied_at, build id |
| Editing an applied migration | checksum mismatch → `X_MIGRATION_TAMPERED`, `fix: x db gen "<followup>"` |
| Drift in either direction | `X_DB_DRIFT` in `x verify`, naming the table and column |
| Irreversible migrations | allowed only with `-- irreversible: <reason>`; otherwise `X_MIGRATION_NOT_REVERSIBLE` |
| Concurrent versions | `ROLE=migrate` takes an advisory lock; a second version in flight is `X_MIGRATE_CONCURRENT` |
| Destructive statements | `DROP COLUMN` / `DROP TABLE` require `--allow-destructive`, and are refused outright against a production-tagged URL |

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

Drift detection compares three things — the Drizzle schema, the migration ledger, and the live catalog — so it catches both "you edited the schema and forgot to generate" and "someone ran DDL by hand".

## Template-DB parallel testing

```
bun test --workers 8
  once:        migrate + seed → myapp_test_tpl
  per worker:  CREATE DATABASE myapp_test_N TEMPLATE myapp_test_tpl   (~100-400ms)
  per file:    truncate the tables that file touched
  teardown:    drop on exit (--keep-db to inspect)
```

Real Postgres, truly parallel. Rejected alternatives and why, plus worker→DB assignment mechanics: [`14-testing-internals.md`](./14-testing-internals.md).

The short version of why not transaction-rollback isolation: the outbox commits, `LISTEN/NOTIFY` commits, logical replication reads committed data. A test wrapped in a rollback tests a code path production never runs.

## Codes

| Code | Meaning | Fix |
|---|---|---|
| `X_DB_DRIFT` | schema ≠ migrations ≠ catalog | `x db gen "<name>"` |
| `X_MIGRATION_TAMPERED` | an applied migration's checksum changed | `x db gen "<followup>"` |
| `X_MIGRATION_NOT_REVERSIBLE` | no down path and no `irreversible:` marker | add the marker or a down migration |
| `X_MIGRATE_CONCURRENT` | another version's migration is in flight | wait, then `x db status --json` |
| `X_TENANT_MISMATCH` | row tenant ≠ request tenant | scope the query to `ctx.tenantId` |
| `X_CURSOR_INVALID` | signature or query-shape mismatch | restart pagination from `after: null` |
| `X_INVARIANT_VIOLATED` | a write broke a declared invariant; `data.invariant` names it | fix the value, or relax the invariant |
| `X_QUERY_UNBOUNDED` | `list`/live query without `limit` + total order | add `limit` and a unique tiebreak column |
