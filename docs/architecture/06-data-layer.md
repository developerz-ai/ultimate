# Data layer

Postgres, no ORM. `postgresDriver()` (`packages/entity/src/pg-driver.ts`, `pg-sql.ts`) emits hand-written parameterised SQL, and it stays legible so an agent can read the statement and self-correct ([`../idea/01-stack.md`](../idea/01-stack.md)). `@ultimat3/entity` owns the schema→type→repo chain; nothing else touches SQL.

## Entity

A table + its domain type + invariants **the database also enforces**.

```ts
export const posts = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().references(() => orgs.id, { onDelete: 'cascade' }),
    title: text({ max: TITLE_MAX }),
    status: enumerated(POST_STATUSES).default('draft'),
    publishedAt: timestamp().nullable(),
    createdAt: timestamp().defaultNow(),
    deletedAt: timestamp().nullable(),   // presence alone makes the entity soft-deletable
  },
  tenant: 'orgId',
  invariants: (c) => [
    invariant('post_title_present', c.title.trimmed().minLength(1)),
    invariant(
      'post_publish_coherent',
      c.satisfies(hasCoherentPublishState, ['status', 'publishedAt']),
    ),
  ],
  indexes: [{ on: ['orgId', 'publishedAt'], order: 'desc' }],
});
```

| Aspect | Rule |
|---|---|
| Signature | `entity(name, init)` — name first, `init` is `{ columns, tenant?, primaryKey?, invariants?, indexes?, tags? }` |
| Projects to | SQL DDL, domain type (`typeof posts.$row`), migration, repo, admin screen, seed factory, cache tag |
| `tenant` | required on any multi-tenant entity; names the column, not a value. `.tenant()` on the column says the same thing, `init` wins when both appear, and with neither a column named `orgId` is inferred — silence never means unscoped |
| `invariants` | one callback `(c) => [...]`, each entry `invariant(name, expr)` written in the expression language, so one declaration yields the TS check **and** the `CHECK`/`UNIQUE` the migration emits. `c` is typed from `columns`, so a typo is a compile error that names the real column |
| A JS-predicate invariant | `c.satisfies(fn, [...columns])` and `c.matches(fn)` cannot be translated, so they report `kind: 'assert'` with `sql: null` — a rule the DB does not know is a rule a migration script can violate, and it is never faked as a CHECK |
| Soft delete | the presence of a `deletedAt` column, not a flag — there is no `softDelete:` option |
| Never | business logic, I/O, HTTP awareness, policy decisions |

Two enforcement points, one declaration. The TS check gives a typed error with a field path; the DB constraint means a bulk `UPDATE` from a migration, a psql session, or another service cannot write a row the app considers impossible.

## Repo

Generated per entity. The **only** place SQL lives.

`Repo<T>` in [`packages/entity/src/repo.ts`](../../packages/entity/src/repo.ts) is the contract both drivers implement — `memoryRepo()` and `postgresRepo()`, one meaning.

| Method | Notes |
|---|---|
| `findById(id)` | tenant filter applied automatically; returns `null`, never throws on miss. Inside a request, the calls issued in one microtask are **one** `where "id" in (…)` ([`coalesce.ts`](../../packages/entity/src/coalesce.ts)) — same scope, same soft-delete filter, one round trip. An id that is a foreign key on a page this request read resolves that key for the whole page instead ([`jit-preload.ts`](../../packages/entity/src/jit-preload.ts)), which is what batches a sequential `for … of` loop |
| `findMany(args)` | cursor-paginated only (below); leaves its page's foreign key values behind for the preload above |
| `inBatches(size)` | not on `Repo<T>` — a `ReadBuilder` terminal, `for await (const batch of db.<table>.where({ … }).inBatches(500))`. `findMany` in a loop over its own cursor ([`batch.ts`](../../packages/entity/src/batch.ts)), so a batch **is** the page `page()` would have returned at that position and there is no second read path. The handle is the iteration: `break`, a throw and `await using` all stop the next statement, and `.cursor` is where it stopped — `.after(cursor)` resumes it |
| `preload(name)` | not on `Repo<T>` — a `ReadBuilder` chain method, `db.<table>.preload('<relation>')`, resolved by `page()`/`all()`/`one()`. One more `where <key> in (…)` per named relation, over the page `findMany` already read ([`preload.ts`](../../packages/entity/src/preload.ts)); several relations resolve concurrently, and naming one twice is one statement |
| `insert(values)` / `update(id, patch)` | invariants run before the statement |
| `insertAll(rows)` | many rows, one `insert into … values (…), (…) returning *` ([`pg-sql.ts`](../../packages/entity/src/pg-sql.ts) builds *every* insert, so `insertAll([row])` is the text `insert(row)` produced). Resolves with the rows as stored; past 65535 bind parameters it is several statements, so all-or-nothing is `withTransaction`'s |
| `upsertAll(rows, args)` | `insertAll` that resolves a collision — `on conflict (…) do update set …`, or `do nothing`. Resolves with the rows this call **wrote**, so a skipped row is absent. What both drivers must agree on lives in [`bulk-write.ts`](../../packages/entity/src/bulk-write.ts) |
| `delete(id)` | soft-deletes when the entity declares `deletedAt`, hard-deletes when it does not |
| `deleteWhere(filter)` | delete by equality filter; resolves with the **number of rows removed** |
| `updateWhere(filter, patch)` | update by equality filter; resolves with the **number of rows written** |
| `count(args)` | the same plan as `findMany`, without the page |
| `countBy(column, args)` | the grouped count — one entry per distinct value of `column`, over exactly the rows `count(args)` counts, in one `group by` statement where a `count()` per row was N. What both drivers must agree on lives in [`count-by.ts`](../../packages/entity/src/count-by.ts) |
| `Transactor.run(fn)` | joins the ambient transaction if one exists, opens one otherwise |
| custom | added in the feature's `repo.ts`, returning schema-parsed rows |

One family, three members:

| Path | Trigger | Cost |
|---|---|---|
| Microtask coalescing ([`coalesce.ts`](../../packages/entity/src/coalesce.ts)) | several `findById` calls land in one microtask | one `where id in (…)` — nothing to opt into |
| Sibling JIT preload ([`jit-preload.ts`](../../packages/entity/src/jit-preload.ts)) | the first `findById` whose id is a foreign key on a page this request read | one `where <key> in (…)` for the whole page; every later lookup in the loop is memory — nothing to opt into, and `postgresDriver({ jitPreload: false })` is the one switch that turns it off |
| Eager preload ([`preload.ts`](../../packages/entity/src/preload.ts)) | `.preload('<relation>')` named on the chain | one `where <key> in (…)` per relation, resolved before the caller sees a row |

Reach for `preload()` when the relation is part of what the page *is* — a list rendered with its authors, rows handed to something that will not call back into the repo, or a read a reviewer should see stated rather than inferred from a loop. The other two ask for nothing: a same-microtask fan-out and a sequential `for … of` loop already get them for free. All three read their keys through one file ([`batch-read.ts`](../../packages/entity/src/batch-read.ts)) — one spelling of a key, one 500-id bind cap — so a bound and a key's identity cannot disagree between them. What each may widen is its own: the two implicit paths share a scope key and refuse to widen across a tenant, a soft-delete visibility, a projection or an entity, because they answer a statement the caller already sent; `preload()` sends its own, so it carries the chain's tenant predicate onto it and refuses when it cannot.

That family collapses one *lookup* repeated per row. The other repeated statement is an aggregate — one `count()` per row, the shape `recountLikes` had — and no batch reaches it, because each of those statements asks a different question. `countBy(column)` asks all of them at once:

```ts
// One statement for every post in `ids`, not one `select count(*)` each.
const counts = await db.likes.where({ orgId }).andWhere('postId', 'in', ids).countBy('postId');
for (const id of ids) await db.posts.update(id, { likeCount: counts.get(id) ?? 0 });
```

| Rule | Mechanism |
|---|---|
| Counts the predicate, never the page | the plan `count(args)` builds, so the filters, the tenant predicate and `deleted_at is null` are in the statement Postgres runs and `limit`/`after` bound nothing |
| A value nothing matched is absent, never `0` | what `group by` returns, and the only way a caller can tell "none" from "never asked". The `?? 0` is the caller's |
| NULL is one group, keyed `null` | the memory driver reads the property as `?? null`, so it lands where Postgres puts its NULL rows. `0`, `''` and `false` stay the values they are |
| Ordered biggest group first | ties by the value, `null` last — applied in [`count-by.ts`](../../packages/entity/src/count-by.ts) *after* the rows are in, because a hash aggregate returns groups in whatever order it built them and a `Map` filled row by row returns insertion order, so an `order by` in the statement would let the two drivers disagree about a result they agree on |
| Groupable columns are a closed set | `uuid`, `text`, `char`, `boolean`, `integer`, `bigint`. A `timestamptz` is a `Date`, a `jsonb` is an object, `money` is two columns — a `Map` compares those by identity, so the map could only ever answer `undefined`. `X_INVARIANT_VIOLATED` naming a column of that entity that is groupable |
| The group count is bounded, and the bound is a refusal | `MAX_GROUPS` (1000). The statement asks for one group past it, exactly as a page reads one row past its limit; the extra group is `X_INVARIANT_VIOLATED` spelling `andWhere('<column>', 'in', <values>)`. A truncated map reads exactly like a complete one, and a caller recounting from it writes the wrong number to every row it missed |
| One statement, fixed output names | `select "post_id" as group_value, count(*) as group_count … group by "post_id" limit $n` ([`pg-sql.ts`](../../packages/entity/src/pg-sql.ts)) — aliased so an entity may still declare a column called `count`, and the grouped value is re-parsed by the column that declared it, since `int8` arrives as a string |

`upsertAll` refuses four things before a statement exists, each of them otherwise a `42P10`, a cross-tenant write, a `21000` or a silent surprise:

| Refusal | Why it is not the server's job |
|---|---|
| A conflict target no declared unique constraint matches | Postgres answers `42P10`, which arrives as `X_DB_UNAVAILABLE` and names nothing to edit. The entity already holds `$primaryKey`, `$indexes` and `$invariants`, so the target is checkable at the seam. All three spellings of one constraint count — the key, `unique()`/`indexes:`, and `invariant(name, c.unique([…]))` — or the refusal would ask for a second declaration of a constraint that exists. A partial unique index is not a target on any of them, since `on conflict` would have to repeat its predicate |
| A target omitting the tenant column under `onMatch: 'update'` | `X_TENANCY_UNSCOPED`. `upsertAll` builds no read plan, so nothing else puts an org predicate in the statement: a target that omits the tenant column matches a row stored by another tenant and rewrites it, tenant column included. `'nothing'` stays legal — it writes nothing to a row it does not own |
| A batch repeating one conflict target under `'update'` | `ON CONFLICT DO UPDATE command cannot affect row a second time` (`21000`) on the server, and a silent last-one-wins in memory. The two drivers have to mean one thing |
| An uneven batch under `'update'` | `excluded.<column>` for a row that omitted the column is that column's *default*, not the stored value, so "leave the others alone" is not what runs. `insertAll` and `'nothing'` accept one and render `default` in the missing cell, which is what the same row means on its own |

A collision overwrites every column the batch writes minus three closed sets — the conflict target, which is how the row was found, the primary key, which is where it lives, and the soft-delete stamp, which is whether the row is there at all. A soft-deleted row still occupies its conflict target, so `excluded."deleted_at"` would clear a delete the app made; excluded from the set list rather than refused, since `$parse` fills that `deletedAt: null` in before the plan is built. A null anywhere in the target collides with nothing, in both drivers, because a Postgres unique index is `NULLS DISTINCT`.

The two filtered writes are not conveniences. `delete(id)` and `update(id, patch)` both need a single-column primary key — `singleKeyOf` throws `X_INVARIANT_VIOLATED` on a composite one — so on a join table (`likes`, `blocks`, `participants`) they are the only write paths there are. Without them a composite-key row is create-only: `likes` could be liked and never unliked, and `participants.lastReadAt` could never be marked read. They double as the bulk forms of `delete`/`update` in the ordinary case, too — one statement for a loop that would otherwise delete or patch a row at a time, the same role `insertAll`/`upsertAll` play for a per-row insert loop. Four properties make them safe to be the only filtered writes:

| Property | Mechanism |
|---|---|
| Bounded by construction | an empty filter is `X_WRITE_UNFILTERED`, never every row; an empty patch is `X_PATCH_EMPTY`, never a counted no-op. An `undefined` value is dropped before either count, so `updateWhere({ id }, { lastReadAt })` on a forgotten variable lands on the error rather than on the table |
| Tenancy applies | `deletePlan`/`updatePlan` build the plan a read builds and run `assertScoped`, so the org predicate is in the statement Postgres executes. The empty-filter guard runs **first**: an org predicate bounds the blast radius to one tenant, which is still all of that tenant's rows |
| Soft delete respected | the entity's `deletedAt` column is the same switch `delete(id)` uses. Soft entities delete via `update … set deleted_at = $1 … where deleted_at is null`, so a second delete matches nothing and the original stamp survives; `updateWhere` carries the same `deleted_at is null` clause `update(id, patch)` does, so a deleted row is not silently patched back into shape |
| Stamps are the framework's | `touch()` in `query.ts` is the one place `onUpdateNow()` columns are written, for `update(id, patch)` and `updateWhere` alike. It leaves an empty patch empty, so whether `X_PATCH_EMPTY` fires depends on the call and not on whether the entity happens to declare `updatedAt` |

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
| 6. Cache keys | query name + parsed-input fingerprint + tags, never hand-built. `As of 2026-08` the actor is **not** a part, so the tenant must be in the read's input | a `cache:` read scoped by actor rather than by input is a cross-tenant hit ([`../idea/05-caching.md`](../idea/05-caching.md)) |
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
| Cursor contents | `base64url([scope, id, key])` + a truncated HMAC-SHA256 of that body. A tampered or cross-query cursor is `X_CURSOR_INVALID`, not a silent wrong page — [below](#cursor-contents) |
| Live queries | the same total-order requirement, because the matcher needs a deterministic window ([`07-realtime-internals.md`](./07-realtime-internals.md)) |
| UI need for page numbers | answered with an approximate count (`reltuples` or a windowed count), never by offsetting |

### Cursor contents

One codec for the whole framework — `encodeCursor` / `decodeCursor` in `@ultimat3/core`. The repo, the read primitive's `paginate()` and the admin's tables sign and verify the same string, so a cursor cannot mean three things with three trust levels.

```text
base64url(JSON [scope, id, key]) "." hmac-sha256(body, secret)[0:32]
```

| Part | Contents | Buys |
|---|---|---|
| `scope` | the read plus its arguments: entity, filters, sort order | a cursor from another query, another filter or a flipped sort is `X_CURSOR_INVALID`, never a wrong page |
| `key` | the ordering tuple of the last row of the page, in `orderBy` order | the keyset predicate is rebuilt from the cursor — no server-side page state to expire |
| `id` | that row's primary key | the tiebreak that makes the order total. A read that returns rows without one is `X_QUERY_NOT_PAGEABLE`, never a cursor signed over `"undefined"` |
| signature | truncated HMAC-SHA256 over the body, compared in constant time | a client can replay a position it was handed, never invent one |

| Rule | Detail |
|---|---|
| Secret | `ULTIMATE_CURSOR_SECRET`, with a dev default so `x dev` pages unconfigured. `configureCursorSigning(secret)` overrides it in-process; `usesDevCursorSecret()` reports the dev key is still in use, and `x doctor` turns that into `X_CURSOR_SECRET_DEV` when the process is running in production — the shipped key is published, so there it is a forgeable position |
| Rotation | rotating the secret invalidates every open cursor — clients restart from `after: null` |
| Signed, not encrypted | the client already holds the rows the cursor points at. Tamper-evidence, not authorization: policy still runs per page |
| Opaque | never parsed, extended or built by hand on either side of the wire |
| Admin tables | `@ultimat3/admin` catches `X_CURSOR_INVALID` and renders page one — a stale bookmark should not be an error page for an operator |

## Transactional outbox

`<job>.enqueue` writes the job row **in the same transaction as the business write**.

```ts
async handle({ input, ctx }) {
  const post = await ctx.posts.publish(input.postId);              // INSERT/UPDATE
  if (input.notify) await notifySubscribers.enqueue({ postId: post.id, orgId: input.orgId });  // same tx
  return post;
}
```

How `enqueue` finds the transaction: the pipeline's `handler` stage opens the transaction and puts the handle in the ALS store. The job handle's `enqueue` resolves the ambient jobs facade — what `ctx.jobs` names — and that facade reads it. There is no `tx` parameter to pass, therefore none to forget.

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
| Drift in the source | `X_DB_DRIFT` from `checkSourceDrift`, naming the schema and migration hashes that moved — `x verify`, no database needed |
| Drift in the database | `X_DB_DRIFT` from `checkDrift`, naming the table, column or index the live catalog disagrees on — `x db migrate` and `ROLE=migrate` |
| Irreversible migrations | allowed only with `-- irreversible: <reason>`; otherwise `X_MIGRATION_NOT_REVERSIBLE` |
| Concurrent versions | `ROLE=migrate` takes an advisory lock; a second version in flight is `X_MIGRATE_CONCURRENT` |
| Destructive statements | `DROP COLUMN` / `DROP TABLE` require `--allow-destructive`, and are refused outright against a production-tagged URL |

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

Drift detection compares three things — the declared entities, the migration ledger, and the live catalog — so it catches both "you edited an entity and forgot to generate" and "someone ran DDL by hand". Two checks, because one cannot be both: `x verify`'s `drift` step hashes the entity source against what `x db gen` recorded and opens no database, which is what lets the gate run in CI; `x db migrate` diffs the live catalog against `x_migrations` on the connection it just migrated over, which is the only place hand-run DDL is visible. Framework tables (the `x_` namespace) are declared by no migration and are never drift.

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
| `X_CURSOR_INVALID` | signature mismatch, or a cursor from another query, filter or sort order | restart pagination from `after: null` |
| `X_INVARIANT_VIOLATED` | a write broke a declared invariant; `data.invariant` names it | fix the value, or relax the invariant |
| `X_QUERY_UNBOUNDED` | `list`/live query without `limit` + total order | add `limit` and a unique tiebreak column |
| `X_WRITE_UNFILTERED` | `deleteWhere({})` / `updateWhere({}, patch)` — no filter, so every row | name the columns that bound it; a whole-table write is a migration, `x db gen "<name>"` |
| `X_PATCH_EMPTY` | `updateWhere(filter, {})` — nothing to write | name the columns to write |
