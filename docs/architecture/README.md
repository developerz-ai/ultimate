# 🏗️ Ultimate — architecture

How Ultimate is built. [`../idea/`](../idea/README.md) answers *what and why*; these docs answer *how*, at the level a contributor or an agent needs to change the framework itself.

| Doc | Hook |
|---|---|
| [`00-conventions.md`](./00-conventions.md) | File layout, naming, export surface, LOC ceilings — the rules Biome and `x verify` enforce. |
| [`01-package-map.md`](./01-package-map.md) | 22 packages, 6 tiers, one reason to change each. What every package owns and must never do. |
| [`02-boundaries.md`](./02-boundaries.md) | Tier violations are build errors. `scripts/boundaries.ts` resolves the transitive chain and prints it. |
| [`03-request-lifecycle.md`](./03-request-lifecycle.md) | 17 ordered stages and why each sits where it does. ALS context, so no layer threads `actor`. |
| [`04-error-contract.md`](./04-error-contract.md) | `UltimateError`: one object, three renderings. Every error carries an executable `fix:`. |
| [`05-type-chain.md`](./05-type-chain.md) | DB column → entity → action → OpenAPI → client → component. Rename a field, count the compile errors. |
| [`06-data-layer.md`](./06-data-layer.md) | Entities, repos, tenancy. Cursor pagination only. Migrations that cannot lie. |
| [`07-realtime-internals.md`](./07-realtime-internals.md) | WAL → change feed → matcher → fanout → patch. Per-subscriber policy, reconnect cost model. |
| [`08-jobs-internals.md`](./08-jobs-internals.md) | Memoized step replay, the real `SKIP LOCKED` claim SQL, advisory-lock leader election. |
| [`09-rendering-internals.md`](./09-rendering-internals.md) | Two bundle graphs, the streaming envelope, four hydration strategies, ISR single-flight. |
| [`10-cross-cutting.md`](./10-cross-cutting.md) | i18n, theming, timezones, money — four concerns, enforced rather than documented. |
| [`11-ai-surface.md`](./11-ai-surface.md) | One `evaluate`, two adapters. Hidden tools answer `ToolNotFound`, never `Forbidden`. |
| [`12-generated-app.md`](./12-generated-app.md) | What `x new` emits, why each directory exists, and how it grows to mobile without restructuring. |
| [`13-topology-runtime.md`](./13-topology-runtime.md) | One image, six roles. Drain sequencing, `/healthz` vs `/readyz`, version skew. |
| [`14-testing-internals.md`](./14-testing-internals.md) | Template-DB cloning, frozen clock, sealed network, and the exact order of `x verify`. |
| [`15-adding-a-feature.md`](./15-adding-a-feature.md) | The end-to-end walkthrough with the exact command per step. Read this one most. |

## Start here

| # | Read | Because |
|---|---|---|
| 1 | [`15-adding-a-feature.md`](./15-adding-a-feature.md) | the loop you will actually run |
| 2 | [`01-package-map.md`](./01-package-map.md) | where code is allowed to live |
| 3 | [`02-boundaries.md`](./02-boundaries.md) | why your import failed |
| 4 | [`04-error-contract.md`](./04-error-contract.md) | how to fail correctly |
| 5 | [`03-request-lifecycle.md`](./03-request-lifecycle.md) | what runs before your handler |
| 6 | [`05-type-chain.md`](./05-type-chain.md) | why a typo is a compile error |
| 7 | the doc for your subsystem | `06`–`09`, `11`, `13` |
| 8 | [`14-testing-internals.md`](./14-testing-internals.md) | what green means |

## Reading paths

| You are | Read |
|---|---|
| Adding a feature to an app | `15` → `12` → `10` |
| Writing a framework package | `01` → `02` → `00` → `04` → `14` |
| Debugging a request | `03` → `04` → `06` |
| Debugging realtime | `07` → `13` → [`../idea/15-risks.md`](../idea/15-risks.md) |
| Debugging a deploy | `13` → `09` |
| Building agent tooling | `11` → `05` → `04` |

## Subsystem → doc → packages

| Subsystem | Doc | Packages |
|---|---|---|
| Request handling, ALS, tracing | [`03`](./03-request-lifecycle.md) | `http`, `core`, `policy` |
| Errors | [`04`](./04-error-contract.md) | `core` + every package's `src/errors.ts` |
| Types, schemas, env | [`05`](./05-type-chain.md) | `schema`, `entity`, `action` |
| Entities, repos, migrations, outbox | [`06`](./06-data-layer.md) | `entity`, `jobs` |
| Live queries, sync, offline | [`07`](./07-realtime-internals.md) | `realtime`, `policy` |
| Queues, steps, cron | [`08`](./08-jobs-internals.md) | `jobs`, `time` |
| Render modes, islands, ISR, cache fanout | [`09`](./09-rendering-internals.md) | `render`, `cache`, `seo`, `pwa` |
| i18n, theming, timezones, money | [`10`](./10-cross-cutting.md) | `i18n`, `ui`, `time`, `money` |
| MCP, prompts, manifest | [`11`](./11-ai-surface.md) | `mcp`, `ai`, `manifest` |
| Roles, drain, skew | [`13`](./13-topology-runtime.md) | `cli`, `http`, `jobs`, `realtime` |
| Runners, fixtures, the gate | [`14`](./14-testing-internals.md) | `testing`, `cli` |

## Every gate

A convention that isn't a build error doesn't exist. What actually fails, and where it is specified:

| Gate | Fails on | Doc |
|---|---|---|
| `tsc` | any error; `any` is banned outright | [`05`](./05-type-chain.md) |
| Biome | bare `Error`, default exports, raw hex, hardcoded strings, dates without a zone | [`00`](./00-conventions.md), [`10`](./10-cross-cutting.md) |
| boundaries | tier violations, `site/` → `app/`, routes → DB, services → HTTP | [`02`](./02-boundaries.md) |
| six test types | any failure; a flake **is** a failure | [`14`](./14-testing-internals.md) |
| migration drift | schema ≠ migrations ≠ catalog | [`06`](./06-data-layer.md) |
| contract diff | a breaking action/query change without a version bump | [`11`](./11-ai-surface.md) |
| budgets | per-route bytes, LCP, precache size | [`09`](./09-rendering-internals.md) |
| SEO + i18n | missing meta, duplicate meta, missing key in any locale | [`09`](./09-rendering-internals.md), [`10`](./10-cross-cutting.md) |
| manifest freshness | `x.manifest.json` / `openapi.json` differ from the code | [`11`](./11-ai-surface.md) |

One command runs all of them, from one step list: `bun run verify` in this repo *is* `x verify` run at the repo root — same steps, same report, same exit code. There is no `--only` and no `--skip`.
