# Batching and preloading

The entity layer never sends one statement per row. A relation is a foreign key read a second way, not a second declaration, and every batching path — automatic or named — reads the same `references()` columns [Entities and migrations](Entities-And-Migrations) already derives relations from.

`As of 2026-08`. Source: [`packages/entity/src/relations.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/entity/src/relations.ts), [`query.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/entity/src/query.ts), [`pg-driver.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/entity/src/pg-driver.ts).

## Relations are derived, never declared twice

`belongsTo`/`hasMany` come out of the `.references(() => orgs.id)` calls an entity's columns already make — there is no `hasMany: […]` init key, and adding one would put two declarations of one fact in the schema. A `belongsTo` reads the FK's own column (`authorId` → `author`); a `hasMany` reads it from the other side (`posts` inbound to `orgs`). When two foreign keys would collide on one name, **every** member of that colliding group takes its long form together — never just the newcomer — so a second FK declared later cannot silently rename the first relation. What the two tiers still cannot separate is refused as `X_INVARIANT_VIOLATED`, naming both columns, never collapsed into one relation.

There is exactly one flat namespace of relation names per entity, `belongsTo` and `hasMany` mixed, resolved through `relationNamed(entity, name)` — a name no foreign key produces is `X_PRELOAD_UNKNOWN_RELATION`, listing the relations that do exist.

## Three ways the same batching shows up

| Form | Trigger | Statements |
|---|---|---|
| Point-lookup coalescing | several `findById` calls in one microtask | one `where id in (…)` |
| JIT (sibling-aware) preload | a `findById` whose id is a FK value on a page already read | one `where <key> in (…)` for the whole loop |
| `.preload('name')` | named on the chain | one extra statement per relation, resolved concurrently |

The first two are automatic — nothing to opt into, no `dataloader()`, no `batch()` call. `.preload()` is the explicit, declarative third: name the relation once and every row of the page carries it, resolved *before* the caller sees a row.

### Same-microtask coalescing

`findById` called several times inside one microtask of one request is one `select … where "id" in (…)`. The store is a per-request `WeakMap<Ctx, …>`, so a batch dies with the request and never crosses one; a sequential `for … of` loop shares no microtask — its `await` ends the window — which is what the sibling preload below exists for.

### JIT preload — the sibling-aware case

`findMany` tags the rows it returns with their own foreign key **values** (never the rows) under a per-request store. The first `findById` whose id matches one of those values then resolves that key for **every** row of the page in one statement, and the rest of a `for … of` loop is served from memory:

```ts
const page = await db.posts.findMany({ orgId });
for (const post of page.rows) {
  // Two statements for the whole loop: the page, then one `where "id" in (…)` over every
  // author on it. Every lookup after the first is memory.
  const author = await db.users.findById(post.authorId, { orgId });
}
```

Controlled by the `jitPreload` option, default `true`, on `postgresDriver({ jitPreload })` / `postgresRepo(entity, { jitPreload })`. **Not** an `app.config.ts` key — nothing reads config at the seam that builds a repository, so a `database.jitPreload` field would be a switch the framework cannot read. Set it where the driver is built.

### `.preload('relation')` — named on the chain

```ts
export const db = database({ orgs, posts, members });

// Two statements: the page, then one `select … where "id" in (…)` over its authors.
const page = await db.posts.where({ orgId }).preload('author').page();
page.rows[0].author;   // the member row, or null — always present
```

A `belongsTo` attaches the row or `null`; a `hasMany` attaches an array, always present so "no author" and "nobody preloaded the author" cannot read the same. `preload()` is resolved on the chain (`relationNamed`), so an unknown relation fails there and not a page later. Attachment happens after the projection — `select()` is widened internally with every preloaded relation's own key, so a projection can never drop what a preload needs; `plan().select` reports the widened list that actually ran. Only the terminals that read a row resolve it: `page()`, `all()`, `one()` — never `count()`, `countBy()` or `plan()`, since none of those has a row to attach one to.

Reach for `.preload()` when the relation is part of what the page *is* — a list rendered with its authors, rows handed somewhere that will not call back into the repo, or a read a reviewer should see stated rather than inferred from a loop. The other two forms ask for nothing.

## The tenancy guarantee — a security boundary, not a perf detail

**A coalesced or JIT-preloaded statement carries exactly the scope every single lookup it replaces would have carried — same tenant predicate, same soft-delete visibility, same projection, same entity, same client.** This is enforced, not incidental:

- The coalescer's scope key (`scopeKey` in `batch-read.ts`) is built from the entity, the table, `includeDeleted`, the projection and every `where` predicate — two lookups share a statement only when all of that matches. A predicate whose value cannot be rendered to a string declines the batch rather than guess.
- The JIT preload's bucket is keyed the same way, and a bucket is only reused when its client and its write-generation still match; a write to that entity drops the bucket before the statement goes out (`forgetPreloaded`), so a row a request just changed is re-read, never served stale.
- `.preload()`'s tenancy is *carried*, never inferred: the page's own tenant predicate reaches the related read only when **both** entities are scoped by a column of the same name. A source scoped by `workspaceId` may still carry an ordinary `orgId` predicate of its own — a filter, not its tenancy — and matching on the target's column name alone would lift that filter into the target's tenant scope. Carrying nothing is not a failure of this rule: the related read builds its own plan, and `assertScoped` refuses it as `X_TENANCY_UNSCOPED` rather than answer with a guess.

`pg-driver.test.ts`, `jit-preload.test.ts` and `preload.test.ts` each pin this against a real cross-tenant fixture — another tenant's row is unreachable from every one of the three paths, never served by whichever tenant asks.

## Bulk writes — the same idea on the write side

A loop of `insert()` calls is the same defect a per-row read loop is, on the other side of the statement:

```ts
await db.tags.insertAll(names.map((name) => ({ orgId, name })));         // one statement, n rows

await db.likes.upsertAll(rows, {                                         // insert, or leave what's there
  onConflict: ['postId', 'memberId'],   // the declared unique index, verbatim — `likes` keys on the pair
  onMatch: 'nothing',                   // …so the tenant column is not in the target: see below
});

const n = await db.posts.updateWhere({ orgId, status: 'draft' }, { status: 'archived' });
const removed = await db.likes.deleteWhere({ orgId, postId, memberId });
```

| Call | Shape |
|---|---|
| `insertAll(rows)` | one multi-row `insert`, every row parsed through `$parse` exactly as `insert(row)` parses one |
| `upsertAll(rows, { onConflict, onMatch })` | `on conflict (…) do update` / `do nothing`; a collision overwrites every column the batch names except the conflict target, the primary key, and the soft-delete stamp |
| `updateWhere(filter, patch)` | the bulk form of `update(id, patch)` — and the only write path for a composite-key entity (`likes`, `blocks`, any join table) with no single-column id to address |
| `deleteWhere(filter)` | the bulk form of `delete(id)`, same reason |
| `countBy(column)` | one grouped count, the aggregate a `count()` per row is the N+1 of — see [Entities and migrations → A count per row is one grouped count](Entities-And-Migrations#a-count-per-row-is-one-grouped-count) |

`onConflict` names the columns of a **declared unique index**, never a convenient superset: `likes` is `primaryKey: ['postId', 'memberId']` with `orgId` as its tenant column, so `['orgId', 'postId', 'memberId']` matches no index and is refused. The tenant column belongs in the conflict target only under `onMatch: 'update'`, where a collision writes — a target without it would match and overwrite another tenant's row, which is `X_TENANCY_UNSCOPED` and not an N+1 code. Under `onMatch: 'nothing'` no write happens to a row you do not own, so the pair alone is right. Every other call still passes its tenant filter: `deleteWhere({ orgId, postId, memberId })`, not `deleteWhere({ postId, memberId })`.

`deleteWhere({})` and `updateWhere({}, patch)` are `X_WRITE_UNFILTERED`, never every row; an empty patch is `X_PATCH_EMPTY`. Both are covered in full, including the tenancy rule on `onMatch: 'update'`, in [Entities and migrations → Writing many rows is one statement](Entities-And-Migrations#writing-many-rows-is-one-statement).

## `inBatches(size)` — sweeping a whole table

The chain's own terminal for "every row, not one page":

```ts
await using batches = db.posts.where({ orgId }).preload('author').inBatches(500);
for await (const batch of batches) {
  await search.index(batch);
}
```

`inBatches` returns a disposable async iterator (`AsyncIterable & AsyncDisposable`) — `break`, `return`, a throw, and `await using` all stop the *next* statement rather than the one in flight, and `close()` is idempotent by construction. Its `.cursor` is where the next batch starts, advanced before the yield, so a consumer that stops early can persist it and resume later with `.after(cursor).inBatches(size)`. Every batch is exactly the page `page()` would have sent at that position — same filters, tenancy, soft delete, projection and every `.preload()` — so this is not a second read path.

Keyset only, the same reason there is no `offset()` anywhere in this package: an insert before an OFFSET shifts every later page, silently skipping or repeating rows under concurrent writes. Two refusals happen at `inBatches()` itself rather than one batch later: a size that is not a whole number of rows ≥ 1, and a chain that also called `limit()` — one number would then carry two meanings, and neither reading is safe to guess. An ordering that cannot carry a cursor (a nullable sort column) is refused there too.

This is also the mechanism `backfill()` runs on — see [Migrations and backfills](Migrations-And-Backfills).

## The jobs `PgExecutor` carve-out

`@ultimat3/jobs`' Postgres driver (`driver-pg.ts`) does **not** go through any of the above. It speaks a two-method `PgExecutor` interface (`query(sql, params)`) it declares itself, and has no `@ultimat3/db` or `@ultimat3/entity` dependency at all — a claim, an ack, a nack, an enqueue or a heartbeat is compiled straight to SQL against that executor, never through a repository. This is a documented exception, not a gap: **queue traffic is invisible to this batching machinery by design**, because there is no repository call for the coalescer, the JIT preload or `.preload()` to attach to. It follows that a job driver statement carries no statement attribution either (see `packages/jobs/CLAUDE.md`), which is a separate, narrower observability note and not something this page's tenancy guarantee needs to answer for.

## Errors

Each code carries its own `fix:` line, computed from the call that raised it — the entity's real name, its real columns, the relations it really has. The table below shows the *shape* that line takes; the authority is the error itself, and `x errors explain <CODE> --json` prints it.

| Code | Owner | Cause | `fix:` shape |
|---|---|---|---|
| `X_PRELOAD_UNKNOWN_RELATION` | `entity` | `<entity>` has no relation named `"<name>"` | `relationNamed('<entity>', '<known>')   # or: <the other names>` — and `x entities list --json` when the entity declares none |
| `X_TENANCY_UNSCOPED` | `entity` | `<entity>.<op>()` was built without an org predicate but the entity has an `orgId` column | `pass { orgId } to <entity>.<op>(), or wrap the plan with orgScoped(entity, orgId, plan)` |
| `X_TENANCY_UNSCOPED` (upsert) | `entity` | the collision is judged on columns that exclude the tenant column, so another tenant's row would match | `<entity>.upsertAll(rows, { onConflict: ['orgId', …] })   # or onMatch: 'nothing'` |
| `X_N_PLUS_ONE_QUERY` | `entity` | `<subject>` ran `<n>` times in one request — one read per row | `db.<entity>.preload('<relation>')`, or `db.<entity>.andWhere('id', 'in', ids).all()` |
| `X_N_PLUS_ONE_WRITE` | `entity` | `<subject>` ran `<n>` times in one request — one write per row | `db.<entity>.insertAll(rows)` (or `upsertAll`/`updateWhere`/`deleteWhere`), or `expectedQueryLoop('<why one per row is optimal>', fn)` |
| `X_WRITE_UNFILTERED` | `entity` | `<entity>.<op>()` named no filter columns — an empty filter would reach every row | `<entity>.<op>({ <primary key columns> }, …)`; a deliberate whole-table write is `x db gen "<name>"` |
| `X_PATCH_EMPTY` | `entity` | `<entity>.<op>()` named no columns to write | `<entity>.<op>(filter, { <column>: <value> })   # pick a column from: <the entity's columns>` |

```bash
x errors explain X_N_PLUS_ONE_QUERY --json    # the canonical cause + fix for any code above
```

Full list with `--json` shapes: [Error codes](Error-Codes). Resource lifetimes referenced above — the `using pinned` client and the advisory-lock RAII shape — are covered once in [Resource management](Resource-Management).
