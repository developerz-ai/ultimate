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
    db/                   # entity re-exports + plain-SQL migrations, no business logic
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
| `db` | the schema registry, plain-SQL migrations, entity re-exports | business logic, HTTP, policy | `core`, jobs, admin |
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
apps/web/app/<feature>/
  entity.ts  repo.ts  service.ts  policy.ts  errors.ts  ui.tsx  ui.module.scss
  actions/<verb>-<feature>.ts    one action or mutator per file
  live/<name>.ts                 one subscribable query per file (`x g query --live`)
  queries/<name>.ts              one plain query per file (`x g query`)
  jobs/<verb>-<feature>.ts       one job per file
  tasks/<name>.ts                one cron trigger per file (`x g task`)
  ui/<feature>-card.tsx          the feature's components
  admin/resource.ts              --admin only
apps/web/app/<features>/page.tsx the route, at the plural URL
```

| Path | Owns | Never |
|---|---|---|
| `entity.ts` | table + domain type + invariants + the view an action returns | I/O, policy |
| `repo.ts` | SQL for this feature | business rules, HTTP |
| `service.ts` | business logic composed from repos | HTTP, rendering, direct SQL |
| `policy.ts` | `policy` rules, the permission set, the feature's cache tag | data shaping |
| `errors.ts` | the feature's `X_*` codes | a bare `Error` |
| `actions/` | one `action` / `mutator` per file | logic — delegate to `service.ts` |
| `live/` | one `query` per file, `live: true` | writes |
| `queries/` | one `query` per file, not subscribable | writes |
| `jobs/` | one `job` per file | inline slow work in an action |
| `tasks/` | one `task` per file — a cron trigger that enqueues a job | doing the work itself |
| `ui.tsx`, `ui/` | Solid components | fetching, business logic, its own authz |
| `admin/resource.ts` | list columns, title key, page size | a second authz path |

One primitive per file, not one file per role: `actions/publish-post.ts` is the only place `publishPost` is declared, so a slice with nine actions is nine reviewable diffs instead of one 600-line module. The flat files are the ones there is exactly one of per feature.

The folder is the name passed to `x g resource`; the route is its plural, because a collection URL is plural — `x g resource post` writes the slice to `apps/web/app/post/` and the page to `apps/web/app/posts/page.tsx`.

A feature imports another feature only through its `service.ts` or its published types — never its `repo.ts`. Cross-feature `repo` access is a build error, and is the reason "just add a join" turns into a distributed monolith.

Why feature slices beat layer directories here: a change request is almost always feature-shaped ("posts need scheduling"), so a feature-sliced tree makes the change a single directory read. A layer-sliced tree makes it eight directory reads and one forgotten file.

## Route files

The directory is the URL; the filename names the kind of file, never a URL segment:

| File | URL |
|---|---|
| `apps/web/site/page.tsx` | `/` |
| `apps/web/site/pricing/page.tsx` | `/pricing` |
| `apps/web/site/(marketing)/about/page.tsx` | `/about` |
| `apps/web/site/blog/[slug]/page.tsx` | `/blog/:slug` |
| `apps/web/site/docs/[...path]/page.tsx` | `/docs/*path` |
| `apps/web/app/dashboard/page.tsx` | `/dashboard` |

`page.tsx` on `site/` and `app/`. `index.tsx` is not a page filename and `<name>.tsx` is not a
route — `registerRoute()` refuses any other filename, enforced with `X_ROUTE_FILE_INVALID`. One
directory per route is what lets `page.tsx`, `page.module.scss` and `page.test.ts` co-locate,
gives a dynamic segment (`blog/[slug]/`) its own directory for its own stylesheet, and makes "is
this file a route?" mechanically decidable from the filename alone.

`api/` carries two separate rules, and conflating them is the mistake to avoid.

**Rule one — a `route` primitive on `api/` is named `route.ts`.** `ROUTE_FILENAME['api']` is
`'route.ts'` in [`packages/render/src/registry.ts`](../../packages/render/src/registry.ts), so
`registerRoute()` accepts `api/**/route.ts` and refuses every other filename under `api/` with the
same `X_ROUTE_FILE_INVALID` it uses on `site/`/`app/`. This is the hand-written raw HTTP route: you
own the `Request` → `Response`, and you get no OpenAPI row, no typed client and no job handle.

**Rule two — an action, mutator, query, job or task reaches HTTP through `defineApi()`, not
through a filename.** Those modules keep whatever name their feature gives them
(`app/posts/actions.ts`, `app/digest/jobs.ts`, …) and `apps/web/api/index.ts` collects them into
one `defineApi()` call, which is what projects the HTTP routes, `openapi.json`, the typed client
and the job handles. No scaffolded or reference app writes a `route.ts`; every generated surface
arrives on rule two.

`x g route` generates only under `site/` and `app/` — there is no generator for rule one.

## What `x g resource` generates

```
x g resource post --admin --locales en,es
```

The entity is the one declaration — `entity()` from `@ultimat3/entity` owns the table, the tenant
column and the invariants together, so there is no ORM table definition to keep in sync
with it. MCP exposure is the same story: an action that sets `mcp: { expose: true }` already reaches
the app's MCP server through `defineAppMcp({ include: 'exposed' })`, so the generator does not write
a second, parallel tool declaration — that would be the two-authz-paths mistake the framework
refuses to allow.

| # | File | Contents |
|---|---|---|
| 1 | `apps/web/app/post/entity.ts` | `entity('posts', { tenant, columns, invariants, indexes })`, the row type, `PostView` |
| 2 | `apps/web/app/post/repo.ts` | the table's only SQL: `byId`, ordered-and-bounded `listByOrg`, `insert` |
| 3 | `apps/web/app/post/service.ts` | one method per use case, over the repo, no HTTP |
| 4 | `apps/web/app/post/policy.ts` | `post:read` / `post:write` both ways (module augmentation + `definePermissions`) and the feature's cache tag |
| 5 | `apps/web/app/post/errors.ts` | `PostNotFoundError` — code, cause, executable fix |
| 6 | `apps/web/app/post/actions/{create,archive}-post.ts` | one `action` each: `input`, `output`, `policy`, `cache.invalidates`, `mcp: { expose: true }` |
| 7 | `apps/web/app/post/live/post-list.ts` | `query({ live: true })`, ordered and bounded |
| 8 | `apps/web/app/post/jobs/reindex-post.ts` | one job with the `idempotencyKey` the type requires |
| 9 | `apps/web/app/post/ui.tsx` + `ui.module.scss` + `ui/post-{card,form}.tsx` | components, tokens only, `t()` only |
| 10 | `apps/web/app/posts/page.tsx` + `page.module.scss` | `defineRoute`: `render`, `hydrate`, `offline`, `budget`, `meta` |
| 11 | `packages/i18n/catalogs/<locale>.json` (`--locales`, default `en`), merged into the existing file | every key the components and the route use — so the build is green |
| 12 | `apps/web/app/post/admin/resource.ts` (`--admin`) | the `AdminResourceOptions` override — title key, list columns, page size |
| 13 | `*.test.ts` beside each declaration — entity, policy, both actions, the query, the job, the service, the route, the admin override | unit, contract, live and job tests that pass on the first run |
| 14 | `x.manifest.json` | rescanned and rewritten after any `x g` run that wrote a file |

Nothing is a stub, and nothing is a `TODO`. The generated tests assert the invariants a slice can
lose quietly: a cross-org actor is denied before the handler runs, garbage input is rejected, the
live query's SQL carries `order by` and `limit`, the job dedupes a replayed enqueue, the route stays
inside its byte budget. The CLI's own gate writes the whole scaffold to a sandbox and compiles it
with the real `tsc` against the real workspace packages — `packages/cli/src/scaffold-typecheck.ts` —
and the only diagnostics it tolerates are pinned one occurrence at a time in `KNOWN_GAPS`, each
owned by a framework package, never by a template, and each spendable only by the variant that
pinned it.

One compile per *file set*, listed in `scaffold-fixture.ts`: `x new` with every generator run on
top of it (`--admin` included, since that override is a template no other invocation emits), and
`x new --no-example` on its own. `--no-example` writes a different `packages/db` — no entity, so
nothing for `schema.ts` or `seed.ts` to name (no invocation writes a migration at all, `As of
2026-08`: `x db gen` is that directory's only writer) — and compiling only the
example app is exactly what let it ship a `schema.ts` importing a slice that invocation never
wrote. A flag that changes which files are emitted earns a variant; one that changes their
contents does not.

`x g` never clobbers: a path that already exists is `X_GENERATE_CONFLICT` with the path and the
`--force` that overrides it, so running the generator twice grows a slice instead of flattening it.

## A narrower generator plants what it imports

The five generators that write *into* a slice import its shared modules — `../repo`, `../policy`,
`../errors` — and wrote none of them until 2026-08, so each emitted `TS2307` in any slice
`x g resource` had not been run in first. Each now composes exactly the modules its own source
imports, through `sliceFoundation(target, needs)`
([`templates/slice-foundation.ts`](../../packages/cli/src/templates/slice-foundation.ts)).

| Generator | Files into a bare slice | Its own | `needs` |
|---|---|---|---|
| `x g action`, `x g mutator` | 8 | 2 | `entity`, `policy`, `errors` |
| `x g query`, `x g query --live` | 7 | 2 | `entity`, `policy` |
| `x g job` | 5 | 2 | `entity` |
| `x g backfill` | 5 | 2 | `entity` |
| `x g task` | 7 | 4 — the task and the job it enqueues | `entity` |

**Named per generator, never one fixed set.** A job has no request behind it and evaluates no
policy, so a `policy.ts` it never reads would be a file an author has to read before deleting.
`'entity'` is the **pair** — `repo.ts` imports `./entity` for its row type, so emitting one without
the other moves the unresolved import rather than closing it.

`x g resource` composes the same sub-generators and therefore writes `errors.ts` through the action's
`needs`, not through a template of its own; `dedupe` collapses the five copies of `entity.ts` that
composition produces, first occurrence winning.

A planted module is tagged `merge: 'if-absent'`, and `planFile`
([`cmd-generate.ts`](../../packages/cli/src/cmd-generate.ts)) gives it a **third** answer beside
write and conflict: an existing one is a `skip` — never a conflict, and never overwritten,
**`--force` included**. A foundation module belongs to the slice rather than to the generator that
needed it, and `--force` is about the primitive the author named: clobbering `policy.ts` to
regenerate one action would delete every rule they wrote. Regenerating a slice module is its own
generator, `x g entity` or `x g policy`.

Measured `As of 2026-08` on a slice holding an authored `policy.ts`: `x g action` writes **7 of 8** —
everything the slice lacked, including `policy.test.ts`, and not the `policy.ts` — and a second
`x g action` into the finished slice writes exactly its own **2**. `--force` leaves the authored file
byte-for-byte.

### The two hand-wired lines

| File | Why the generator leaves it alone | What a new resource costs |
|---|---|---|
| `packages/db/src/schema.ts` | registration, not declaration — the migration generator reads what this file re-exports, and the drift hash covers `packages/db/src/**`, which the feature slice is deliberately outside of | one `export { post } from '@myapp/web/app/post/entity';` |
| `apps/admin/src/index.ts` | composition — `defineAdmin({ entities, resources })` is the app deciding which tables get an operator door and which stay shut | one entry in `entities`, plus the `--admin` override in `resources` |

Neither is a second declaration of anything, and neither is a generator's file to overwrite.
`packages/db/src/schema.ts` ships with `x new`, already re-exporting the example resource, so the
second entity is a copy of the line in front of you. The `defineAdmin` call is not scaffolded at
all: as of 2026-08 `x new` emits the admin app as a route shell (`apps/admin/app/page.tsx`), and the
app writes its own composition — the reference app keeps it at `apps/admin/src/index.ts`.

Of the two, only the admin list is arguably still a registry rather than a decision. MCP solved the
same problem on the declaration side — `mcp: { expose: true }`, collected by
`defineAppMcp({ include: 'exposed' })` — and admin exposure has no equivalent: as of 2026-08
`defineAdmin` takes an explicit `entities` array and nothing else.

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
