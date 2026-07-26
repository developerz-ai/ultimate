# Entities and migrations

An `entity` is a table + its domain type + its invariants. The single source of the DB schema, the TS type, and the parse boundary.

| Aspect | Rule |
|---|---|
| Projects to | Drizzle table, domain type, migration, repo type, admin screen, seed factory |
| Owns | column types, defaults, invariants, tenant column |
| Never | business logic, I/O, HTTP awareness, policy decisions |

Declared in `<feature>/entity.ts`; the Drizzle schema and migrations live in `packages/db` and hold **no business logic**.

## Six projections

| Projection | Where it lands | Consumed by |
|---|---|---|
| Drizzle table | `packages/db/schema.ts` | `repo.ts` — the only file that touches SQL |
| Domain type | `packages/domain` | actions, queries, Solid component props |
| Migration | `packages/db/migrations/` | `x db apply`, `ROLE=migrate` |
| Repo type | the feature's `repo.ts` signature | `ctx.<service>` inside `handle` |
| Admin screen | `apps/admin/` | operators, and the admin app's MCP surface |
| Seed factory | `seed(name)` fixtures | all six test types |

One inferred chain, no hand-typed link:

```
Drizzle table  →  entity type + invariants  →  action input/output  →  typed client + MCP tool  →  component props
```

Rename a column and the entity type changes, the action's output stops matching, and the component prop errors — all at typecheck, before a test runs.

## Shape

`As of 2026-07` (`entity` lands in milestone 1):

```ts
export const post = entity({
  table: 'posts',
  tenant: 'orgId',
  columns: {
    id:          c.uuid.primary,
    orgId:       c.uuid.references(org),
    title:       c.text,
    body:        c.text,
    publishedAt: c.timestamptz.nullable,
  },
  invariants: [
    inv('published-post-has-title', (p) => p.publishedAt === null || p.title.length > 0),
  ],
  embed: { field: 'body', model: 'text-embedding-3-large' },
});
```

| Field | Meaning |
|---|---|
| `table` | physical table name; snake_case, plural |
| `tenant` | the tenant column. Required on any multi-tenant table |
| `columns` | types + defaults + FKs. Money is `{ minor, currency }`, never a float; timestamps are `timestamptz`, stored UTC |
| `invariants` | named predicates enforced on write, projected to a CHECK constraint where expressible |
| `embed` | opt-in vector column + HNSW index + backfill job |

## Tenant column rule

Every multi-tenant entity declares `tenant`. Every query against it is tenant-scoped or it fails:

```
X_TENANCY_UNSCOPED: query is not scoped to a tenant
  cause: select on "posts" has no predicate on tenant column "orgId"
  fix:   query through posts repo (ctx.posts.*) — it applies the tenant scope from ctx.actor
```

| Consequence | Detail |
|---|---|
| Repo methods | inject the tenant predicate from `ctx.actor.orgId`; a raw `db.*` call in a service is a boundary error |
| Cache keys | framework-generated and include the actor's tenant + policy scope, so a hit can never cross tenants |
| Live queries | the tenant predicate is part of the matcher, not a post-filter |
| Vector search | tenant + policy filters applied **in SQL**, so similarity search cannot leak across tenants |

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
| Apply (dev) | `x db apply` | runs pending migrations against the dev DB; live queries resubscribe |
| Check | `x db drift --json` | schema vs migrations; exits non-zero on a difference |
| Inspect | `x db studio` | tables, columns, indexes, FKs, generated SQL — also the `/_x` **Schema** panel |
| Pre-deploy | `ROLE=migrate` container | run-once hook, same image; refuses to run while another version's migration is in flight (`X_MIGRATE_CONCURRENT`) |
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

There is no separate migration tool and no "regenerate types" step. Drift is check 5 of nine in `x verify` ([Testing](Testing)).

## Reversible or marked

| Rule | Detail |
|---|---|
| Every migration has a `down` | or an explicit `irreversible('<reason>')` marker |
| An unmarked non-reversible migration | fails `x verify` — the same check as drift |
| Destructive steps | column/table drops need the marker plus a rollout note; prefer expand → migrate → contract across two releases |
| `x db apply` on a marked migration | proceeds, but the marker is printed and recorded in the manifest |

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
| `X_MIGRATE_CONCURRENT` | another version's migration is in flight | wait for the running `ROLE=migrate` to finish, then redeploy |
| `X_ENTITY_DUPLICATE` | two entities on the same table | rename one, or merge them |
| `X_INVARIANT_VIOLATED` | a write broke a named invariant | fix the caller, or change the invariant and generate a migration |
| `X_TENANCY_UNSCOPED` | a query without a tenant predicate | go through the repo |

Full list with `--json` shapes: [Error codes](Error-Codes). Source: [`docs/idea/02-primitives.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/02-primitives.md), [`docs/idea/10-testing.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/10-testing.md).
