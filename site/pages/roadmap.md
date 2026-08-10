---
title: Roadmap
nav: Roadmap
description: Twelve strictly ordered milestones, each ending in a working demo app and a green verify — plus the six risks, sized honestly and named before they bite.
lede: One demo app, twelve stages. Milestones 0–10 shipped in `1.0.0`; milestone 11 is in progress, with the two-platform deploy proof still outstanding.
updated: 2026-08-10
---

## Status, As of 2026-08

<p class="pill-row">
<span class="pill pill--ok">v1.0.0</span>
<span class="pill pill--info">28 packages, one version</span>
<span class="pill pill--warn">milestone 11 in progress</span>
</p>

1.0.0 shipped on 2026-08-10 — 27 `@ultimat3/*` packages plus `create-ultimate`, released in
lockstep to npm. Semver applies from here. Milestones 0–10 are shipped and enforced: `x verify`'s
`roadmap` step reads the milestone table in the repo and fails the build if a milestone claims a
status the files on disk do not support.

## Twelve milestones

| # | Status | Milestone | Contents | Done when |
|---|---|---|---|---|
| 0 | shipped | **Skeleton + error contract** | `core` (`UltimateError`, ALS context, config loader), `schema` (Standard Schema over a dependency-free builtin provider, exposed as `t`), root tooling, `scripts/boundaries.ts`, the `x verify` shell | a thrown `X_*` renders identically in terminal and `--json`; boundary violations fail the build |
| 1 | shipped | **HTTP + entity + policy** | `http` over `Bun.serve`, `entity` over a hand-written `postgresDriver()`, `policy`, typed env validated at boot | demo: one entity, one protected route, one denial; a missing env key fails in milliseconds |
| 2 | shipped | **`action` + `query` + typed client** | generated HTTP routes, OpenAPI, the typed client, contract tests | demo: CRUD driven entirely by the typed client, no hand-written fetch; contract diff in `x verify` |
| 3 | shipped | **Rendering + router + site/app split** | Solid 2 integration, our router, five render modes, `stream` default, the hard `site/` → `app/` boundary | demo: a 0kb-JS landing page and a streaming dashboard; a deliberate cross-surface import fails the build |
| 4 | shipped | **SEO + images + budgets** | typed `meta`, `ld.*` helpers, sitemap/robots/RSS from the route table, image pipeline, per-route budgets | demo: CLS 0; deleting a description is a build error; a budget regression names the import chain |
| 5 | shipped | **Jobs + tasks + mail + storage + scheduler** | outbox enqueue, `step.run` / `sleep` / `waitForEvent`, `pg` driver, cron with leader election | demo: signup → onboarding job with a 3-day sleep, verified on the frozen clock; a failing step retries only that step |
| 6 | shipped | **Realtime tiers 1–2** | channels, live `query`, `replicator`, incremental matcher, NATS fanout, stateless `sync` | demo: a list updating live across two browsers. The 50k-socket forced-restart benchmark is **still unrun** — see [Realtime](/realtime/) |
| 7 | shipped | **Caching — four tiers, one tag graph** | request memo, in-process LRU, Redis tier, CDN headers + purge, `invalidates` fanout, ISR regen | demo: one `invalidates: [tag.post]` evicts memo, LRU, Redis, page and CDN; an untagged cached query fails `x verify` |
| 8 | shipped | **PWA + offline + version skew** | generated `sw.js`, precache derivation, manifest/icons from one source icon, immutable build IDs, N-deploy retention | demo: installable, works offline, and six deploys with a tab left open never 404 a chunk |
| 9 | shipped | **AI-first surface** | MCP dev server, `x.manifest.json`, every action as a tool, `llm` gateway, versioned prompts + evals, pgvector hybrid search, branch environments | demo: an agent migrates, tests and publishes through MCP only, with authz identical to the UI |
| 10 | shipped | **Admin + generators + `x new`** | generated admin dashboard with its own MCP surface, every `x g` generator, `create-ultimate`, the `/_x` dev dashboard | `bunx create-ultimate myapp && cd myapp && x dev` with no Docker and no env editing; generated code passes `x verify` unmodified |
| 11 | in progress | **Deploy + docs + 1.0** | the `docker`, `binary` and `static` build targets, dev/prod compose, Helm with per-role HPAs, graceful drain everywhere, error-code pages | the demo app runs on Compose **and** Kubernetes from one image; a rolling restart is invisible to connected clients |

Milestone 11 ships its artifacts — the three build targets, both compose files, the Helm chart —
but not yet its proof. Running the demo app on Compose **and** on Kubernetes from one image,
with a rolling restart invisible to connected clients, has not been demonstrated.

## Sequencing rule

**Ship 0–5 before touching realtime.** The rule 1.0.0 was built under, kept to the letter. A
framework with excellent DX, durable jobs and enforced SEO is already shippable. A half-built
sync engine is worth nothing: it cannot be shipped partially, cannot be demoed honestly, and
consumes the attention everything else needs.

| Rule | Consequence |
|---|---|
| Milestones are strictly ordered; no parallel starts | one demo app grows through all twelve, so regressions surface immediately |
| Every milestone ends green | `x verify` never carries known failures forward |
| Realtime is gated on a measured benchmark (M6) | the one rule 1.0.0 **waived**: tiers 1–2 shipped, the benchmark did not run |
| Tier 3 local-first is out of v1 | it lands in v2 as `persist: true` on an existing query — a flag, not a rewrite |
| Scope cuts come off the back, never the middle | dropping M11's Helm chart is acceptable; dropping M4's budgets is not |
| A milestone that grows past its demo gets split | a milestone with no demo has no definition of done |

## The 1.0.0 boundary

| In 1.0.0 | Deferred to v2 |
|---|---|
| Milestones 0–10, plus milestone 11's build targets, compose files and Helm chart | tier 3 local-first (`persist: true`) |
| Realtime tiers 1–2 | a plugin API |
| `pg` job driver; `redis` and `nats` are interface-complete stubs that throw `X_NOT_IMPLEMENTED` with a runnable `fix:` | the `redis` and `nats` job drivers |
| Postgres + pgvector | multi-region replication |
| One admin dashboard | mobile/desktop targets beyond placeholders |
| Docker / binary / static targets | theming marketplace, template gallery |
| Mail, OAuth, storage, caching, PWA, MCP, `llm()`, evals | vendor-specific deploy adapters — never, per axiom 7 |

## Risks, sized

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Sync engine is ~70% of total effort** | highest | tiers 1–2 only in v1, tier 3 as a later flag, ship 0–5 first, and wrap an existing protocol if the benchmark says our matcher is the bottleneck |
| 2 | **Scope is credibly 3–4 products** | highest | strict milestone order, no parallelism, eight primitives as a scope fence, permanent exclusions |
| 3 | **Live-query reconnect cost** | high | bounded per-query change buffers, snapshot fallback, server-directed jittered reconnect, benchmark gate at M6 |
| 4 | **Solid ecosystem thinness** | high | our own router and UI kit budgeted as framework work; pin Solid 2 exactly and ship codemods with `x upgrade` |
| 5 | **Bun-only constraints** | medium-high | no native addons by design; Bun natives cover image, hashing, Postgres, Redis, S3; explicit memory-profiling and soak tests at M6 and M11 |
| 6 | **Static path rot** | medium | 0kb default on `site/`, emitting JS without an explicit `hydrate` + `budget` is a build error, and the starter landing page lives in `site/` |

**Kill criterion, waived — not resolved.** Tier 2 shipped in 1.0.0 by exception: the 50k-socket
forced-restart benchmark it was gated on has never been run, and an unmeasured criterion cannot be
called met.

| Waiver | Terms |
|---|---|
| What was gated | tier 2 realtime ships only on a measured 50k-socket forced-restart benchmark |
| Why it shipped anyway | tiers 1–2 are complete and under semver; the benchmark needs infrastructure the release did not have |
| Replacement condition | the criterion is resolved when the benchmark runs and its throughput, latency and socket-count numbers are published — not before |
| Held meanwhile | no throughput, latency or socket-count figure appears anywhere on this site; every capacity number is a target, not a result |

## What is deliberately never coming

GraphQL. A second runtime. A second ORM. A second CSS system. React Server Components. Vendor
edge/KV/queue primitives. Each is a permanent no, not a "later" — removing an alternative is a
feature.

Follow releases in the [changelog](/changelog/) or its [RSS feed](/feed.xml).
