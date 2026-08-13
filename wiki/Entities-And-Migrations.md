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

The table name is the first argument. Everything else is the init object:

| Field | Meaning |
|---|---|
| `columns` | types + defaults + FKs. Money is `bigint` minor units + `char(3)` currency, never a float; timestamps are `timestamptz`, stored UTC |
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
| `$migration()` | the CHECK and UNIQUE statements this entity contributes | `ALTER TABLE … ADD CONSTRAINT … CHECK` per `check`, `CREATE UNIQUE INDEX` per `unique`. A JS-only rule is `kind: 'assert'` and emits nothing — never a pretend CHECK |
| `$describe()` | the manifest row | name, table, primary key, physical columns, invariants, index names, tags, `cacheTag`, `softDelete`, `orgScoped` |
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
| Cache keys | framework-generated and include the actor's tenant + policy scope, so a hit can never cross tenants |
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
| Check | `x db drift --json` | schema vs migrations; exits non-zero on a difference |
| Inspect | `x db studio` | tables, columns, indexes, FKs, generated SQL — also the `/_x` **Schema** panel |
| Pre-deploy | `ROLE=migrate` container | run-once hook, same image; waits on the session-pinned advisory lock while another version's migration is in flight, then applies (`X_MIGRATE_CONCURRENT` is reserved, not thrown) |
| Test template | automatic | migrate + seed once into `myapp_test_tpl`, then clone per worker |

Prod ordering is fixed: `ROLE=migrate` completes, then `web` / `sync` / `worker` / `scheduler` roll. Migrations are forward-compatible with the previous release so a rolling restart never serves a request against a schema it cannot read. See [Deployment](Deployment).

## Drift is a `x verify` failure

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

| Direction | Meaning |
|---|---|
| Entity has what migrations lack | you edited an entity and did not generate — run the `fix` |
| DB has what migrations lack | someone changed the database by hand; generate a migration or revert the change |
| Migrations have what the entity lacks | a stale migration or a deleted column; reconcile before shipping |

There is no separate migration tool and no "regenerate types" step. `drift` is one of `x verify`'s seventeen steps — the list, in order, is in [Testing](Testing).

## Reversible or marked

| Rule | Detail |
|---|---|
| Every migration has a `down` | or an explicit `irreversible('<reason>')` marker |
| An unmarked non-reversible migration | fails `x verify` — the same check as drift |
| Destructive steps | column/table drops need the marker plus a rollout note; prefer expand → migrate → contract across two releases |
| `x db migrate` on a marked migration | proceeds, but the marker is printed and recorded in the manifest |

## Branch DBs for agents

```
x branch feat-new-billing
  ✓ database    myapp_feat_new_billing   (copy-on-write from dev template, 340ms)
  ✓ build       build id 8f2a1c…
  ✓ preview     http://feat-new-billing.localhost:3000
  ✓ mcp         ws://localhost:9229/feat-new-billing
```

| Property | Detail |
|---|---|
| Mechanism | `CREATE DATABASE … TEMPLATE` — Postgres file-copies, cheap, isolated, disposable |
| Writes | the MCP `db.migrate` tool applies **only** in a branch DB, never the shared dev DB |
| Preview | subdomain-routed, same image, `ROLE=web` |
| SW scope | the branch build id scopes the service worker and cache namespace, so a preview cannot poison prod cache |
| Teardown | `x branch rm feat-new-billing`, or automatic on branch delete |
| Agent loop | migrate, seed, test, browse a preview without risking anything shared |

The same clone mechanism powers test parallelism: `bun test --workers 8` gives each worker its own `myapp_test_N` from the template, typically 100–400ms. Never mock the database — clone it.

## Errors

| Code | Cause | Fix |
|---|---|---|
| `X_DB_DRIFT` | schema differs from migrations | `x db gen "<name>"` |
| `X_ENTITY_DUPLICATE` | two entities on the same table | rename one, or merge them |
| `X_INVARIANT_VIOLATED` | a write broke a named invariant | fix the caller, or change the invariant and generate a migration |
| `X_TENANCY_UNSCOPED` | a query without a tenant predicate | go through the repo |

Full list with `--json` shapes: [Error codes](Error-Codes). Source: [`docs/idea/02-primitives.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/02-primitives.md), [`docs/idea/10-testing.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/10-testing.md).
