# Roadmap

Twelve milestones. Each one ends in a **working demo app plus green `x verify`** — never a package that only compiles.

Status markers are load-bearing, not decoration: `x verify`'s `roadmap` step (`scripts/roadmap.ts`)
reads this table and fails the build if a row loses its marker, or if a milestone marked ✅ is
missing the packages/files its own **Ships** column names. `As of 2026-08`.

| Status | Meaning |
|---|---|
| ✅ | shipped — packages exist, tests pass, enforced by `x verify`'s `roadmap` step |
| 🚧 | in progress — some artifacts exist, the milestone is not yet closed |

| # | Status | Milestone | Ships | Done when |
|---|---|---|---|---|
| 0 | ✅ | **Skeleton + error contract** | `packages/core` (`UltimateError`, ALS context, config loader), `schema` (ArkType wrapper `t`), root tooling, `scripts/boundaries.ts`, `x verify` shell | `x verify` runs and passes on an empty repo; a thrown `X_*` error renders identically in terminal and `--json`; boundary violations fail the build |
| 1 | ✅ | **HTTP + entity + policy** | `http` over `Bun.serve`, `entity` on Drizzle, `policy`, typed env validated at boot | demo: a hello app with one entity, one protected route, one denial; `X_ENV_MISSING` fires in <100ms on a missing key |
| 2 | ✅ | **`action` + `query` + typed client** | `action`, `query`, generated HTTP routes, OpenAPI, typed client, contract tests | demo: CRUD app driven entirely by the typed client, no hand-written fetch; `x verify` includes contract diff |
| 3 | ✅ | **Rendering + router + `site`/`app` split** | Solid 2 integration, own router, five render modes, `stream` default, surfaces + hard `site/` → `app/` boundary | demo: landing page in `site/` at **0kb JS** and a streaming dashboard in `app/`; a deliberate cross-surface import fails the build |
| 4 | ✅ | **SEO + images + budgets** | typed `meta`, `ld.*` helpers, sitemap/robots/RSS from the route table, image pipeline, per-route budgets in `x verify` | demo landing page scores 100 SEO with **CLS 0**; deleting a description is a build error; a budget regression names the import chain |
| 5 | ✅ | **Jobs + tasks + mail + storage + scheduler** | outbox enqueue, `step.run` / `step.sleep` / `step.waitForEvent`, `pg` driver, `task` cron with leader election, mail, `Bun.s3` storage | demo: signup → onboarding job with a 3-day sleep, verified with the frozen clock; a failing step retries **only that step**; job tests in `x verify` |
| 6 | ✅ | **Realtime tier 1–2 (+ reconnect benchmark)** | channels, live `query`, `replicator` role, incremental matcher, NATS fanout, `sync` role | demo: collaborative list updating live across two browsers; **50k-socket forced-restart benchmark measured and published** before topology is frozen ([`03-realtime.md`](./03-realtime.md)) |
| 7 | ✅ | **Caching, four tiers, one tag graph** | request memo, in-process LRU, Redis tier, CDN headers + purge, `invalidates` fanout, ISR regeneration | demo: publish an ISR-backed post and observe memo/LRU/Redis/page/CDN all invalidate from one `invalidates: [tag.post]`; an untagged cached query fails `x verify` |
| 8 | ✅ | **PWA + offline + version skew** | generated `sw.js`, precache derivation, manifest/icons/splash from one source icon, required offline fallback, immutable build ID, N-deploy retention, `AppUpdateAvailable` | demo: installable app, works offline, and **six deploys with a tab left open never 404s a chunk**; `x status` reports the client build-ID spread |
| 9 | ✅ | **AI-first surface** | MCP dev server, `x.manifest.json`, every action as an MCP tool, `llm` gateway, versioned prompts + evals, pgvector hybrid search, branch environments | demo: an agent drives the demo app end-to-end through MCP only — migrate in a branch DB, run tests, publish a post — with **identical authz** to the UI; evals run in `x verify` |
| 10 | ✅ | **Admin + generators + `x new`** | generated admin dashboard (with its own MCP surface), all `x gen` generators, `create-ultimate`, `/_x` dev dashboard complete | `bunx create-ultimate myapp && cd myapp && x dev` is <60s with **no Docker and no env editing**; every generator produces code that passes `x verify` unmodified |
| 11 | 🚧 | **Deploy + docs + 1.0** | `x build --target docker\|binary\|static`, dev/prod compose, Helm with per-role HPAs, graceful drain everywhere, docs site, error-code pages | the demo app runs on Hetzner+Compose **and** a K8s cluster from one image; a rolling restart is invisible to connected clients; every `X_*` code has a docs page |

## One demo app, twelve stages

The same application grows through every milestone. A regression in M3 surfaces while building M9, because it is the same app.

| After | The demo app is |
|---|---|
| 0–1 | one entity, one protected route, a typed error, a validated env |
| 2 | full CRUD over the typed client; OpenAPI published |
| 3–4 | a blog: 0kb-JS marketing pages + streaming authed dashboard, 100 SEO, CLS 0 |
| 5 | signup triggers a durable onboarding flow with a 3-day sleep and a nightly digest task |
| 6 | the post list updates live across two browsers; presence indicators on the editor |
| 7 | published posts invalidate memo/LRU/Redis/ISR/CDN from one declaration |
| 8 | installable, works offline, survives six deploys with a tab left open |
| 9 | an agent publishes a post through MCP with the same authz as the UI |
| 10 | reproducible from `bunx create-ultimate` in under 60 seconds |
| 11 | running on Compose and on K8s from one image, rolling restarts invisible |

## Milestone anatomy

Every milestone, without exception:

| Element | Requirement |
|---|---|
| Packages | complete public types, implemented happy path, typed throws for named errors |
| Tests | >=2 regression-catching tests per package, plus the milestone's own test type |
| Demo | the shared demo app advanced visibly; a screenshot or a terminal transcript |
| `x verify` | green, with the milestone's new checks added to the gate |
| Errors | every new failure mode has an `X_*` code, a `fix:`, and a docs stub |
| Docs | the relevant `docs/idea/` doc updated where reality diverged from the plan |

A milestone is not done because the code exists. It is done when the gate covers it.

## Sequencing rule

**Ship 0–5 before touching realtime.**

A framework with excellent DX, durable jobs, and enforced SEO is already shippable and already better than the alternatives for most apps. Milestones 0–5 are a product: entities, actions, a typed client, five render modes, a 0kb static path, and a job system with durable steps. Someone can build and sell a real application on that.

A half-built sync engine is worth nothing. It cannot be shipped partially, it cannot be demoed honestly, and it consumes the attention that everything else needs — and it is ~70% of total effort ([`15-risks.md`](./15-risks.md)). Starting there is how this project would die with 40 packages and no users.

| Rule | Consequence |
|---|---|
| Milestones are strictly ordered; no parallel starts | one demo app grows through all twelve, so regressions surface immediately |
| Every milestone ends green | `x verify` never carries known failures forward |
| Realtime is gated on a measured benchmark (M6) | topology decisions wait for numbers, not intuition |
| Tier 3 local-first is **out of v1** | it lands in v2 as `persist: true` on an existing query — a flag, not a rewrite |
| Scope cuts come off the back, never the middle | dropping M11's Helm chart is acceptable; dropping M4's budgets is not |
| A milestone that grows past its demo gets split | a milestone with no demo is a milestone with no definition of done |

## v1 boundary

| In v1 | Deferred |
|---|---|
| Milestones 0–11 | tier 3 local-first (`persist: true`) |
| Realtime tiers 1–2 | plugin API |
| `pg` job driver (redis/nats behind the interface) | multi-region replication |
| Postgres + pgvector | mobile/desktop app targets beyond placeholders |
| One admin dashboard | theming marketplace, template gallery |
| Docker / binary / static targets | vendor-specific deploy adapters (never, per [axiom 7](./00-thesis.md)) |
