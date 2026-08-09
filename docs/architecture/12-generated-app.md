# Generated app

What `x new myapp` emits, and why each directory exists. Surface rationale: [`../idea/06-surfaces.md`](../idea/06-surfaces.md).

## The shape

```
myapp/
  apps/
    web/                  # the Ultimate app — the three surfaces live here
      site/               # static/isr, 0kb JS baseline, SEO-critical
      app/                # auth'd, stream/spa, realtime, heavy
      api/                # actions only, no rendering
      shared/             # tokens, primitives, entity types, policies
    admin/                # generated admin dashboard (Ultimate app, role=web)
    mobile/               # placeholder + README (native Swift/Kotlin later)
    desktop/              # placeholder + README (Tauri/Electron later)
  packages/
    domain/               # pure types + constants, no I/O
    db/                   # Drizzle schema + migrations, no business logic
    i18n/                 # app catalogs (en, es, ...)
    ui/                   # app-specific Solid components on top of @ultimat3/ui
    mcp/                  # the app's own MCP tools (its dashboards are AI-first too)
  bin/                    # setup, dev, check — thin wrappers over `x`
  docker/                 # compose (dev) + per-role compose (prod) + Dockerfile
  app.config.ts           # the one config file
  x.manifest.json         # GENERATED: routes, entities, actions, jobs, policies
  AGENTS.md               # short, human-authored
  CLAUDE.md
```

## Why each directory

| Path | Exists because | Would break without it |
|---|---|---|
| `apps/web/site/` | anonymous + crawler traffic has different economics from app traffic; it gets its own bundle graph | the marketing page ships the dashboard's dependencies ([`09-rendering-internals.md`](./09-rendering-internals.md)) |
| `apps/web/app/` | authed, stateful, realtime, budgeted | app code leaks into the static path and LCP rots quietly |
| `apps/web/api/` | actions are a surface, not an afterthought of a page | handlers scattered across route files, unreviewable authz |
| `apps/web/shared/` | tokens, primitives, entity types, policies are needed by both surfaces, and must stay a **leaf** | a bidirectional graph, unbudgetable, uncuttable |
| `apps/admin/` | operations are a product, and the admin surface is where an agent does real work | a hand-built admin with its own authz — a second door |
| `apps/mobile/`, `apps/desktop/` | a README-only placeholder makes the growth path obvious on day one | adding mobile in year two becomes a repo restructure |
| `packages/domain/` | pure types + constants, importable by anything including native clients | types entangled with I/O, so no second client can reuse them |
| `packages/db/` | schema + migrations only | business logic in the schema package, so a job importing "the DB" pulls services |
| `packages/i18n/` | catalogs are data, versioned separately from code, extracted against | strings scattered per surface, locales drifting |
| `packages/ui/` | app components on `@ultimat3/ui`, budgeted like `shared/` | components with fetching inside them, duplicated per surface |
| `packages/mcp/` | the app's own tools, declared in one place next to their policies | MCP exposure defined far from the authz it depends on |
| `bin/` | `bin/setup`, `bin/dev`, `bin/check` — thin wrappers over `x` | onboarding by README archaeology |
| `docker/` | dev compose + per-role prod compose + one Dockerfile | drift between what you tested and what runs ([`13-topology-runtime.md`](./13-topology-runtime.md)) |
| `app.config.ts` | one config file, typed, validated at boot | five config files and an env scavenger hunt |
| `x.manifest.json` | generated facts, drift-checked | prose docs an agent trusts and shouldn't ([`11-ai-surface.md`](./11-ai-surface.md)) |
| `AGENTS.md` / `CLAUDE.md` | short, human-authored conventions | LLM-generated context that reduces task success |

## The `packages/` model

The rule that keeps a growing app scalable: **a package is defined by what it may not import.**

| Package | Owns | Must never | Importable by |
|---|---|---|---|
| `domain` | types, constants, enums, pure predicates, branded ids | any I/O, any framework import beyond `@ultimat3/schema` | everything, including a future native client |
| `db` | Drizzle schema, migrations, entity declarations | business logic, HTTP, policy | `core`, jobs, admin |
| `core` | business services composed from repos | HTTP, rendering, direct SQL outside a repo | actions, jobs, admin, MCP tools |
| `ui` | Solid components + app tokens | fetching, business logic, its own authz | `apps/*` surfaces |
| `mcp` | the app's MCP tool declarations | a second authz path | the MCP role |
| `i18n` | flat catalogs per locale | logic | everything |

Why *that* boundary is the one that matters:

| Boundary | What it buys as the app grows |
|---|---|
| `domain` has no I/O | a mobile client, a CLI, a Lambda, or a test can import the types without a database |
| `db` has no logic | a job, an action, and an admin screen all read the same schema without dragging services along |
| `core` has no HTTP | the identical business rule runs in a request, a job, a cron task, and an MCP tool — one implementation, four surfaces |
| `ui` has no fetching | components are testable and reusable, and a screen's data requirements stay visible at the route |
| `mcp` is declarative | the agent-facing surface is auditable in one file, and exposure lives next to the policy |

The failure this prevents is specific: a service that imports `Request` cannot be called from a job, so someone re-implements it there, and six months later the two copies disagree about refund eligibility. `service-imports-http` is a build error for that reason ([`02-boundaries.md`](./02-boundaries.md)).

## Adding a surface later, without restructuring

The monorepo shape is the whole point: new clients are **new `apps/*` entries**, not a migration.

| Want | Do | Reuses |
|---|---|---|
| Native mobile | replace `apps/mobile/README.md` with a Swift/Kotlin project | `packages/domain` types, the OpenAPI client, the same actions and policies |
| Desktop | `apps/desktop/` with Tauri | the `app/` surface build output, `packages/ui` |
| Browser extension | `apps/extension/` | `packages/domain`, the typed client |
| A second web product | `apps/marketing/` as its own Ultimate app | `packages/{domain,ui,i18n}` |
| A public SDK | `sdks/js/` generated from `openapi.json` | the same contract `x verify` diffs |

Nothing above requires moving a file that already exists. That is what the placeholders are for: the empty directory is a decision already made.

## Feature slicing inside a surface

Feature-sliced, not layer-sliced. One folder per feature; each file one job.

```
apps/web/app/<feature>/{entity,repo,service,actions,live,jobs,policy,ui}.ts
```

| File | Owns | Never |
|---|---|---|
| `entity.ts` | table + domain type + invariants | I/O, policy |
| `repo.ts` | SQL for this feature | business rules, HTTP |
| `service.ts` | business logic composed from repos | HTTP, rendering, direct SQL |
| `actions.ts` | `action` / `mutator` declarations | logic — delegate to `service.ts` |
| `live.ts` | `query` declarations, `live: true` | writes |
| `jobs.ts` | `job` declarations | inline slow work in an action |
| `policy.ts` | `policy` rules for this feature | data shaping |
| `ui/` | Solid components | fetching, business logic, its own authz |

A feature imports another feature only through its `service.ts` or its published types — never its `repo.ts`. Cross-feature `repo` access is a build error, and is the reason "just add a join" turns into a distributed monolith.

Why feature slices beat layer directories here: a change request is almost always feature-shaped ("posts need scheduling"), so a feature-sliced tree makes the change a single directory read. A layer-sliced tree makes it eight directory reads and one forgotten file.

## What `x g resource` generates

```
$ x g resource post --admin --locales en,es
```

The entity is the one declaration — `entity()` from `@ultimat3/entity` owns the table, the tenant
column and the invariants together, so there is no second Drizzle schema file to keep in sync with
it. MCP exposure is the same story: an action that sets `mcp: { expose: true }` already reaches the
app's MCP server through `defineAppMcp({ include: 'exposed' })`, so the generator does not write a
second, parallel tool declaration — that would be the two-authz-paths mistake the framework refuses
to allow.

| # | File | Contents |
|---|---|---|
| 1 | `apps/web/app/posts/entity.ts` | `entity(posts, { tenant, invariants })` + `PostView` |
| 2 | `apps/web/app/posts/repo.ts` | cursor-paginated `listByOrg`, `byId`, `insert` |
| 3 | `apps/web/app/posts/service.ts` | one method per use case, no HTTP |
| 4 | `apps/web/app/posts/policy.ts` | `post:read` / `post:write` with denial reasons, both ways (type + runtime) |
| 5 | `apps/web/app/posts/actions/{create,archive}-post.ts` | `action`s with `input`, `output`, `policy`, `cache.invalidates`, `mcp: { expose: true }` |
| 6 | `apps/web/app/posts/live/post-list.ts` | `query({ live: true })` with total order + limit |
| 7 | `apps/web/app/posts/jobs/reindex-post.ts` | one stub job with a required `idempotencyKey` |
| 8 | `apps/web/app/posts/ui.tsx` + `ui/{post-card,post-form}.tsx` | components, tokens only, `t()` only |
| 9 | `apps/web/app/posts/page.tsx` + `defineRoute` | `render`, `hydrate`, `offline`, `budget`, `meta` |
| 10 | `packages/i18n/catalogs/<locale>/{posts,post}.json` (`--locales`, default `en`) | every key the route and the components use — so the build is green |
| 11 | `apps/web/app/posts/admin/resource.ts` (`--admin`) | the `AdminResourceOptions` override — title, list columns, page size |
| 12 | `*.test.ts` next to each | unit, contract, live, and job scaffolds that **fail until filled in** |
| 13 | `x.manifest.json` | regenerated by the same `x manifest` scan, after every write |

Every generated file is real, typed, and passes `x verify` except the test scaffolds, which fail on
purpose: an untested resource is a red build, not a backlog item.

Two files stay hand-wired, once, the same "define once, register once" shape as everything else
that touches a repo-wide file: `packages/db/src/schema.ts` re-exports the new entity so `x db gen`
sees it, and `apps/admin/src/index.ts` adds the entity (and, with `--admin`, its resource override)
to `defineAdmin({ entities, resources })`. Neither is a generator's file to overwrite — both already
exist by the time a second resource is generated.

## The promise

Reusable packages + an opinionated layout = you write **features, not boilerplate**.

| You do not write | Because |
|---|---|
| a router, a fetch layer, a client SDK | the typed client is inferred ([`05-type-chain.md`](./05-type-chain.md)) |
| pagination logic | cursor pagination is the only API ([`06-data-layer.md`](./06-data-layer.md)) |
| an outbox, a retry loop, a scheduler | `job` and `task` ([`08-jobs-internals.md`](./08-jobs-internals.md)) |
| cache invalidation glue | `invalidates: [tag.post]` ([`09-rendering-internals.md`](./09-rendering-internals.md)) |
| a service worker, an icon set, a sitemap | generated from the route table |
| i18n plumbing, theme plumbing, tz plumbing, money math | [`10-cross-cutting.md`](./10-cross-cutting.md) |
| an MCP server | `mcp: { expose: true }` ([`11-ai-surface.md`](./11-ai-surface.md)) |
| a test harness, a Dockerfile, per-role compose | `x new` emits them |

What is left is the entity, the invariant, the policy, and the handler — the part that is actually your product. The walkthrough: [`15-adding-a-feature.md`](./15-adding-a-feature.md).
