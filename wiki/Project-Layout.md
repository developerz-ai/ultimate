# Project layout

`x new` generates a monorepo, so mobile/desktop/extension can be added later without restructuring.

```
myapp/
  apps/
    web/                  # the Ultimate app — the three surfaces live here
      site/               # static/isr, 0kb JS baseline, SEO-critical
      app/                # auth'd, stream/ssr, realtime, heavy
      api/                # actions only, no rendering
      shared/             # tokens, primitives, entity types, policies
    admin/                # generated admin dashboard (Ultimate app, role=web)
    mobile/               # placeholder + README (native Swift/Kotlin later)
    desktop/              # placeholder + README (Tauri/Electron later)
  packages/
    domain/               # pure types + constants, no I/O
    db/                   # entity() declarations + plain-SQL migrations, no business logic
    i18n/                 # app catalogs (en, es, ...)
    ui/                   # app-specific Solid components on top of @ultimat3/ui
    mcp/                  # the app's own MCP tools (its dashboards are AI-first too)
  bin/                    # setup, dev, check — thin wrappers over `x`
  guards/                 # one rule per file, DISCOVERED not registered — `x verify` runs
                          #   each inside its `boundaries` step. `x new` writes every
                          #   name in SHIPPED_GUARD_NAMES (packages/cli/src/templates/
                          #   scaffold-guards.ts); `x doctor` lists the ones missing
  docker/                 # Dockerfile, Dockerfile.dockerignore, both compose files, and
                          #   helm/ — the chart, 8 files. All written by `x new`
  app.config.ts           # the one config file
  x.manifest.json         # GENERATED: routes, entities, actions, jobs, policies
  AGENTS.md               # short, human-authored
  CLAUDE.md
```

## Surfaces

Four directories, two bundle graphs, one hard boundary.

| Surface | Audience | Default render | JS baseline | Auth | May import |
|---|---|---|---|---|---|
| `site/` | anonymous, crawlers | `static` / `isr` | **0kb** | none | `shared/` |
| `app/` | signed-in users | `stream` (or `ssr`) | whatever the budget allows | required | `shared/`, `api/` types |
| `api/` | programs, agents, the typed client | none | n/a | policy per action | `shared/` |
| `shared/` | both | n/a | must stay 0-dep-heavy | n/a | nothing app-local |

## `site/` cannot import `app/`

A build error. `X_BOUNDARY_VIOLATION`, with the offending import chain printed:

```
X_BOUNDARY_VIOLATION: site/ imported app/
  cause: site/pricing/page.tsx → shared/ui/button.tsx → app/charts/sparkline.tsx → chart.js
  fix:   x fix boundary site/pricing/page.tsx   (or move sparkline out of shared/ui)
```

The failure it prevents: `<Button>` lives in `shared/ui/`; someone adds `<Sparkline>` to the same file, importing a charting library; `site/pricing` imports `<Button>`; the highest-intent page in the product now ships the chart library. Nothing broke, nothing warned, LCP regressed 900ms, found a quarter later. **The import that costs you is three hops from the file anyone reviewed** — which is why the check resolves transitively.

Enforcement, not vigilance:

| Rule | Check |
|---|---|
| `site/` → `app/` import | build error, transitive chain resolved (not just direct imports) |
| `shared/` → `app/` or `site/` import | build error — `shared/` is a leaf |
| A `shared/` module exceeding its own byte budget | build error, so `shared/ui` cannot silently fatten |
| `site/` route emitting >0kb JS without an explicit `hydrate` | build error |
| `app/` → `api/` | **types only** (`import type`); a runtime import is a build error, call the typed client instead |
| routes → DB | build error. Routes call actions/queries; only `repo.ts` touches the DB |
| components → business logic | build error via the feature-slice rule below |
| services → HTTP | build error. A service that knows about requests cannot be reused by a job |

`scripts/boundaries.ts` runs in `x verify` **and** in the dev server, so the failure arrives while you are typing. `/_x` → **Boundaries** renders the same graph with violations highlighted.

## 0kb JS on `site/`

Default for every `site/` route: `render: 'static' | 'isr'`, `hydrate: 'never'`. Inlined critical CSS, no script tag.

| Need | Solution — no framework JS |
|---|---|
| Mobile nav toggle | `<details>` / CSS `:has()` / checkbox hack |
| Newsletter form | native `<form method="post">` to an `api/` action |
| Carousel | CSS scroll-snap |
| Theme toggle | one inlined `<script>` under a documented byte cap, tokens flip via `data-theme` |
| Anything genuinely interactive | `hydrate: 'visible'` on **that one island**, with a per-route `budget.js` |

Opting a `site/` route into hydration is allowed, explicit, and budgeted — never silent. The starter landing page lives in `site/` on purpose: the framework eats its own static path, so a regression there breaks the template on day one instead of rotting quietly.

## Feature slicing inside a surface

Feature-sliced, not layer-sliced. One folder per feature, one job per file.

```
apps/web/app/<feature>/{entity,repo,service,policy,errors}.ts
apps/web/app/<feature>/{actions,live,queries,jobs,tasks}/<name>.ts   # one per file, as generated
apps/web/app/<feature>/ui/                                           # components
```

**A primitive is registered by `defineApi()` and found by the module scan, never by its filename**, so a feature may keep one declaration per file (`actions/<verb>-<name>.ts` — what `x g` writes) or several in one (`actions.ts` — what `examples/dummy` keeps); nothing enforces either, `As of 2026-10`. The filenames that ARE enforced:

| File | Owns | Never — and the error |
|---|---|---|
| `entity.ts` | table + domain type + invariants | I/O, policy |
| `repo.ts` | the feature's reads and writes, through the typed handle | a raw SQL literal the handle can express — `guards/repo-raw-sql.ts` |
| `service.ts` | business logic, composed from repos | an HTTP import — `X_BOUNDARY_SERVICE_TO_HTTP` |
| `page.tsx` · `layout.tsx` | a URL | a database import — `X_BOUNDARY_ROUTE_TO_DB` |
| `actions/` · `actions.ts` | `action` / `mutator` declarations | logic (delegate to `service.ts`) |
| `live/` · `queries/` · `live.ts` | `query` declarations | writes |
| `jobs/` · `tasks/` · `jobs.ts` | `job` / `task` declarations | inline slow work in an action |
| `policy.ts` | `policy` rules for this feature | data shaping |
| `ui/` | Solid components | fetching, business logic, its own authz |

A feature imports another feature through that feature's `service.ts` or its published types, never its `repo.ts` — a convention, **not a build error** (`As of 2026-10-06`: no boundary rule reads it from a `service.ts`). A **route** importing any `repo.ts` is a build error, `X_BOUNDARY_ROUTE_TO_DB`; `x new`'s own dashboard reads through the `postList` query (`../post/live/post-list`).

## App packages

| Package | Rule |
|---|---|
| `packages/domain` | pure types + constants, **no I/O** |
| `packages/db` | `entity()` declarations + plain-SQL migrations, **no business logic**; no ORM in the request path ([Entities and migrations](Entities-And-Migrations)) |
| `packages/i18n` | flat catalogs; a missing key renders `⟦key⟧` and fails `x verify` ([I18n](I18n)) |
| `packages/ui` | app components on `@ultimat3/ui`; same byte budgets as `shared/` ([Theming](Theming)) |
| `packages/mcp` | the app's own MCP tools ([MCP and AI](MCP-And-AI)) |

## Framework package tiers

Inside the framework repo, a package may import from **strictly lower** tiers only — never sideways within its tier unless listed, never upward. `scripts/boundaries.ts` makes a violation a build error.

| Tier | Packages | May import |
|---|---|---|
| 0 | `core`, `schema` | nothing internal |
| 1 | `i18n`, `money`, `time`, `cache`, `seo`, `db`, `storage`, `flags` | tier 0 |
| 2 | `entity`, `policy`, `http`, `auth` | tier 0–1 |
| 3 | `action`, `query`, `jobs`, `realtime` | tier 0–2 |
| 4 | `render`, `pwa`, `mcp`, `ai`, `manifest`, `mail`, `ui`, `notify` | tier 0–3 |
| 5 | `admin`, `testing`, `cli`, `scraping` | tier 0–4 |

The declared sideways edges are `SIDEWAYS_ALLOW` in [`scripts/lib/tiers.ts`](https://github.com/developerz-ai/ultimate/blob/main/scripts/lib/tiers.ts), the executable copy of both tables; [`llms.txt`](https://github.com/developerz-ai/ultimate/blob/main/llms.txt) carries a generated copy of the list. `admin → ui` was deleted 2026-08-19 by moving `ui` from tier 5 to 4 — the edge existed only to undo a placement two tiers above what `ui` actually imports.

Per-package layout is fixed: `package.json`, `tsconfig.json`, `README.md`, `CLAUDE.md`, `src/index.ts` (explicit exports, no `export *` outside pure-type modules), `src/errors.ts` (this package's `X_*` codes), one `src/<concern>.ts` per responsibility with `<concern>.test.ts` beside it. Target < 200 LOC per file, hard ceiling ~500. See [Contributing](Contributing).

## Generated vs authored

| Path | Author | Drift behavior |
|---|---|---|
| `x.manifest.json` | generated every build | `x verify` fails on staleness |
| `openapi.json` | generated | contract diff fails on a breaking change without a version bump (`X_CONTRACT_DRIFT`) |
| `packages/db/migrations/` | `x db gen "<name>"` | schema mismatch is `X_DB_DRIFT` |
| `apps/web/**/sw.js` | derived from the route table | regenerated on `route` config change ([PWA and offline](PWA-And-Offline)) |
| `app.config.ts`, `AGENTS.md`, `CLAUDE.md` | you | never auto-appended; LLM-written context files reduce task success |

Repo files: [`docs/idea/06-surfaces.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/06-surfaces.md), [`docs/architecture/00-conventions.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/00-conventions.md).
