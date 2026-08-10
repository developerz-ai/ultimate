# Surfaces

Four directories, two bundle graphs, one hard boundary.

```
apps/web/
  site/      # static/isr, 0kb JS baseline, SEO-critical
  app/       # auth'd, stream/spa, realtime, heavy
  api/       # actions only, no rendering
  shared/    # tokens, primitives, entity types, policies
```

| Surface | Audience | Default render | JS baseline | Auth | May import |
|---|---|---|---|---|---|
| `site/` | anonymous, crawlers | `static` / `isr` | **0kb** | none | `shared/` |
| `app/` | signed-in users | `stream` (or `spa`) | whatever the budget allows | required | `shared/`, `api/` types |
| `api/` | programs, agents, the typed client | none | n/a | policy per action | `shared/` |
| `shared/` | both | n/a | must stay 0-dep-heavy | n/a | nothing app-local |

## `site/` cannot import `app/`

A build error. `X_BOUNDARY_VIOLATION`, with the offending import chain printed:

```
X_BOUNDARY_VIOLATION: site/ imported app/
  cause: site/pricing/page.tsx → shared/ui/button.tsx → app/charts/sparkline.tsx → chart.js
  fix:   x fix boundary site/pricing/page.tsx   (or move sparkline out of shared/ui)
```

### The exact failure this prevents

1. Someone builds `<Button>` in `shared/ui/`. Correct — both surfaces need buttons.
2. A dashboard needs a button with a tiny inline trend line. They add `<Sparkline>` to the same file, importing the charting library.
3. `site/pricing` imports `<Button>`.
4. The marketing page's bundle now contains the charting library. Nothing broke, nothing warned. LCP on the highest-intent page in the product regresses by 900ms, discovered a quarter later by a Lighthouse audit nobody scheduled.

This is not hypothetical: it is the default outcome in every framework where both audiences share one module graph. The transitive nature is the whole problem — the import that costs you is three hops away from the file anyone reviewed.

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

`scripts/boundaries.ts` runs in `x verify` and in the dev server, so the failure arrives while you are typing, not in CI.

## 0kb JS on `site/`

Default for every `site/` route: `render: 'static' | 'isr'`, `hydrate: 'never'`. The HTML ships with inlined critical CSS and no script tag at all.

| Need | Solution — no framework JS |
|---|---|
| Mobile nav toggle | `<details>` / CSS `:has()` / checkbox hack |
| Newsletter form | native `<form method="post">` to an `api/` action |
| Carousel | CSS scroll-snap |
| Theme toggle | one inlined `<script>` under a documented byte cap, tokens flip via `data-theme` |
| Anything genuinely interactive | `hydrate: 'visible'` on **that one island**, with a per-route `budget.js` |

Opting a `site/` route into hydration is allowed, explicit, and budgeted. It is never silent.

## The starter landing page lives in `site/`

`x new` generates the marketing landing page — hero, features, pricing table, docs links — in `site/`, and the generated `app/` dashboard is a separate surface.

Reason: **the framework eats its own static path.** Every Ultimate developer's first file, and every framework maintainer's smoke test, is a real static page with real SEO metadata, real images through the image pipeline, and a real 0kb budget. If the static path regresses, the starter template breaks on day one — visibly, for everyone — instead of decaying quietly while all attention goes to the app path.

This is a deliberate guardrail against the failure mode named in [`15-risks.md`](./15-risks.md): frameworks serving both audiences drift app-side, and the static path rots.

## Feature slicing inside a surface

Feature-sliced, not layer-sliced. One folder per feature; each file has one job.

```
apps/web/app/<feature>/{entity,repo,service,actions,live,jobs,policy,ui}.ts
```

| File | Owns | Never |
|---|---|---|
| `entity.ts` | table + domain type + invariants | I/O, policy |
| `repo.ts` | SQL for this feature | business rules, HTTP |
| `service.ts` | business logic, composed from repos | HTTP, rendering, direct SQL |
| `actions.ts` | `action` / `mutator` declarations | logic (delegate to `service.ts`) |
| `live.ts` | `query` declarations, `live: true` | writes |
| `jobs.ts` | `job` declarations | inline slow work in an action |
| `policy.ts` | `policy` rules for this feature | data shaping |
| `ui/` | Solid components | fetching, business logic, its own authz |

A feature imports another feature only through that feature's `service.ts` or its published types — never its `repo.ts`. Cross-feature `repo` access is a build error and the reason "just add a join" turns into a distributed monolith.

## Monorepo shape

The generated app is a monorepo so mobile/desktop/extension can be added without restructuring.

```
myapp/
  apps/web/{site,app,api,shared}/
  apps/admin/                     # generated admin dashboard, exposes MCP
  apps/mobile/  apps/desktop/     # placeholders + README
  packages/{domain,db,i18n,ui,mcp}/
  app.config.ts                   # the one config file
  x.manifest.json                 # GENERATED
  AGENTS.md  CLAUDE.md
```

| Package | Rule |
|---|---|
| `packages/domain` | pure types + constants, **no I/O** |
| `packages/db` | `entity()` declarations + plain-SQL migrations, **no business logic** |
| `packages/i18n` | flat catalogs; a missing key renders `⟦key⟧` and fails `x verify` |
| `packages/ui` | app components on `@ultimat3/ui`; subject to the same byte budgets as `shared/` |
| `packages/mcp` | the app's own MCP tools ([`09-ai-first.md`](./09-ai-first.md)) |

Cross-links: render modes per surface in [`07-rendering-seo.md`](./07-rendering-seo.md); how `sw.js` derives its precache set from the route table in [`08-pwa-offline.md`](./08-pwa-offline.md).
