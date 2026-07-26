---
title: Roadmap
nav: Roadmap
description: Twelve strictly ordered milestones, each ending in a working demo app and a green verify — plus the six risks, sized honestly and named before they bite.
lede: One demo app, twelve stages. Every milestone ends in a working demo and a green `x verify`. Ship 0–5 before touching realtime.
updated: 2026-07-26
---

## Status, As of 2026-07

<p class="pill-row">
<span class="pill pill--warn">pre-v1</span>
<span class="pill pill--danger">not production-ready</span>
<span class="pill pill--info">nothing published to npm</span>
</p>

The repository is a working skeleton: the contract, the package tiers, the error registry, and
the docs you are reading. No release has been cut, no package is on npm, and no API is stable.
Everything below marked *planned* is a plan, not a shipped feature.

## Twelve milestones

| # | Milestone | Contents | Done when |
|---|---|---|---|
| 0 | **Skeleton + error contract** | `core` (`UltimateError`, ALS context, config loader), `schema` (ArkType as `t`), root tooling, `scripts/boundaries.ts`, the `x verify` shell | a thrown `X_*` renders identically in terminal and `--json`; boundary violations fail the build |
| 1 | **HTTP + entity + policy** | `http` over `Bun.serve`, `entity` on Drizzle, `policy`, typed env validated at boot | demo: one entity, one protected route, one denial; a missing env key fails in milliseconds |
| 2 | **`action` + `query` + typed client** | generated HTTP routes, OpenAPI, the typed client, contract tests | demo: CRUD driven entirely by the typed client, no hand-written fetch; contract diff in `x verify` |
| 3 | **Rendering + router + site/app split** | Solid 2 integration, our router, five render modes, `stream` default, the hard `site/` → `app/` boundary | demo: a 0kb-JS landing page and a streaming dashboard; a deliberate cross-surface import fails the build |
| 4 | **SEO + images + budgets** | typed `meta`, `ld.*` helpers, sitemap/robots/RSS from the route table, image pipeline, per-route budgets | demo: CLS 0; deleting a description is a build error; a budget regression names the import chain |
| 5 | **Jobs + tasks + mail + storage + scheduler** | outbox enqueue, `step.run` / `sleep` / `waitForEvent`, `pg` driver, cron with leader election | demo: signup → onboarding job with a 3-day sleep, verified on the frozen clock; a failing step retries only that step |
| 6 | **Realtime tiers 1–2 + reconnect benchmark** | channels, live `query`, `replicator`, incremental matcher, NATS fanout, stateless `sync` | demo: a list updating live across two browsers, and the 50k-socket forced-restart benchmark measured **before topology is frozen** |
| 7 | **Caching — four tiers, one tag graph** | request memo, in-process LRU, Redis tier, CDN headers + purge, `invalidates` fanout, ISR regen | demo: one `invalidates: [tag.post]` evicts memo, LRU, Redis, page and CDN; an untagged cached query fails `x verify` |
| 8 | **PWA + offline + version skew** | generated `sw.js`, precache derivation, manifest/icons from one source icon, immutable build IDs, N-deploy retention | demo: installable, works offline, and six deploys with a tab left open never 404 a chunk |
| 9 | **AI-first surface** | MCP dev server, `x.manifest.json`, every action as a tool, `llm` gateway, versioned prompts + evals, pgvector hybrid search, branch environments | demo: an agent migrates, tests and publishes through MCP only, with authz identical to the UI |
| 10 | **Admin + generators + `x new`** | generated admin dashboard with its own MCP surface, every `x g` generator, `create-ultimate`, the `/_x` dev dashboard | `bunx create-ultimate myapp && cd myapp && x dev` with no Docker and no env editing; generated code passes `x verify` unmodified |
| 11 | **Deploy + docs + 1.0** | `x build --target docker\|binary\|static`, compose, Helm with per-role HPAs, graceful drain everywhere, error-code pages | the demo app runs on Compose **and** Kubernetes from one image; a rolling restart is invisible to connected clients |

Milestone 0 is in progress. Milestones 1–11 are planned.

## Sequencing rule

**Ship 0–5 before touching realtime.** A framework with excellent DX, durable jobs and enforced
SEO is already shippable. A half-built sync engine is worth nothing: it cannot be shipped
partially, cannot be demoed honestly, and consumes the attention everything else needs.

| Rule | Consequence |
|---|---|
| Milestones are strictly ordered; no parallel starts | one demo app grows through all twelve, so regressions surface immediately |
| Every milestone ends green | `x verify` never carries known failures forward |
| Realtime is gated on a measured benchmark (M6) | topology decisions wait for numbers, not intuition |
| Tier 3 local-first is out of v1 | it lands in v2 as `persist: true` on an existing query — a flag, not a rewrite |
| Scope cuts come off the back, never the middle | dropping M11's Helm chart is acceptable; dropping M4's budgets is not |
| A milestone that grows past its demo gets split | a milestone with no demo has no definition of done |

## The v1 boundary

| In v1 | Deferred |
|---|---|
| Milestones 0–11 | tier 3 local-first (`persist: true`) |
| Realtime tiers 1–2 | a plugin API |
| `pg` job driver, with redis/nats behind the interface | multi-region replication |
| Postgres + pgvector | mobile/desktop targets beyond placeholders |
| One admin dashboard | theming marketplace, template gallery |
| Docker / binary / static targets | vendor-specific deploy adapters — never, per axiom 7 |

## Risks, sized

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Sync engine is ~70% of total effort** | highest | tiers 1–2 only in v1, tier 3 as a later flag, ship 0–5 first, and wrap an existing protocol if the benchmark says our matcher is the bottleneck |
| 2 | **Scope is credibly 3–4 products** | highest | strict milestone order, no parallelism, eight primitives as a scope fence, permanent exclusions |
| 3 | **Live-query reconnect cost** | high | bounded per-query change buffers, snapshot fallback, server-directed jittered reconnect, benchmark gate at M6 |
| 4 | **Solid ecosystem thinness** | high | our own router and UI kit budgeted as framework work; pin Solid 2 exactly and ship codemods with `x upgrade` |
| 5 | **Bun-only constraints** | medium-high | no native addons by design; Bun natives cover image, hashing, Postgres, Redis, S3; explicit memory-profiling and soak tests at M6 and M11 |
| 6 | **Static path rot** | medium | 0kb default on `site/`, emitting JS without an explicit `hydrate` + `budget` is a build error, and the starter landing page lives in `site/` |

**Kill criterion, stated in advance:** if tier 2 is not correct and benchmarked by the end of
milestone 6, v1 ships with tier 1 only and live queries move to v1.1.

## What is deliberately never coming

GraphQL. A second runtime. A second ORM. A second CSS system. React Server Components. Vendor
edge/KV/queue primitives. A plugin API before v1. Each is a permanent no, not a "later" —
removing an alternative is a feature.

Follow releases in the [changelog](/changelog/) or its [RSS feed](/feed.xml).
