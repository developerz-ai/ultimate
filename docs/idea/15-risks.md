# Risks

Six. Stated at full size, each with a mitigation that is already in the plan rather than a hope.

| # | Risk | Severity | Mitigation lives in |
|---|---|---|---|
| 1 | Sync engine is ~70% of total effort | **highest** | milestone sequencing + tiering |
| 2 | Solid ecosystem thinness | high | own router + own UI kit, budgeted as framework work |
| 3 | Bun-only constraints | medium-high | native-addon exclusion is explicit; memory profiling is scheduled |
| 4 | Scope is credibly 3–4 products | **highest** | strict milestone order, no parallelism |
| 5 | Static path rot | medium | hard 0kb default + starter landing page in `site/` |
| 6 | Live-query reconnect cost | high | benchmark gate at milestone 6 |

## 1. The sync engine is ~70% of the effort

Realistically: logical replication decoding, an incremental query matcher, a change-feed ring buffer, LSN-based resume, fanout subject design, a client store, a rebase log, conflict strategies, client-side schema migration, and reconnect behavior under load. Each is a project. Together they dwarf everything in milestones 0–5, and none of them can be shipped half-finished.

| Mitigation | Detail |
|---|---|
| **Tiers 1–2 only in v1** | channels and live queries deliver ~90% of what people mean by "realtime" with no client database and no conflict UX ([`03-realtime.md`](./03-realtime.md)) |
| **Tier 3 in v2, as a flag** | `persist: true` on an existing query; the mutator shape is designed for it now so it is never a rewrite |
| **Ship 0–5 first** | a framework with great DX, jobs, and SEO is already shippable ([`14-roadmap.md`](./14-roadmap.md)) |
| **Consider wrapping Zero's protocol** | if the milestone-6 benchmark shows our matcher or resume path is the bottleneck, adopting an existing, proven protocol beats inventing one. The mutator API is deliberately Zero-shaped so this substitution costs the internals, not the public API |
| Kill criterion | if tier 2 is not correct and benchmarked by the end of milestone 6, v1 ships with tier 1 only and live queries move to v1.1 |

## 2. Solid ecosystem thinness

`As of 2026-07`, **Solid 2 is still beta.** There is no mature router with the properties this framework needs, no component library at the level of the React ecosystem's, and far fewer battle-tested integrations. Practical consequence: **you will write your own UI kit and your own router**, and that is framework work, not a weekend.

| Cost | Reality |
|---|---|
| Router | must own render mode, hydration timing, offline strategy, and the route table that generates sitemap/`sw.js`/budgets. A third-party router could not carry those fields anyway — so this cost is partly unavoidable and partly a feature |
| UI kit | `@ultimat3/ui` needs the boring 30: button, input, select, combobox, dialog, popover, table, toast, tabs, date picker… each with a11y and both themes |
| Ecosystem gaps | charting, rich text, maps — mostly framework-agnostic libraries wrapped in a thin Solid shell |
| Beta churn | Solid 2 APIs may move. Pin exactly; treat upgrades as framework work with codemods (`x upgrade`) |
| Hiring/familiarity | fewer developers know Solid than React. Mitigated by the fact that agents write most of the code and Solid's model is smaller to learn |

Mitigation: budget the UI kit as a milestone deliverable (M10) rather than assuming it appears; keep component count deliberately small and token-driven so it stays maintainable; and accept that "we control the router" is what makes axioms 3 and 6 enforceable at all.

## 3. Bun-only constraints

The Bun bet buys `Bun.sql`, `Bun.redis`, `Bun.s3`, native WebSockets, the test runner, and the bundler as language features — roughly 1,150 fewer transitive packages ([`01-stack.md`](./01-stack.md)). The bill:

| Constraint | Impact | Mitigation |
|---|---|---|
| **Native addons (N-API) are blocked or unreliable** | no `sharp`, no `bcrypt` addon, no native ML bindings, some legacy DB drivers | Bun natives cover password hashing, Postgres, Redis, S3; `@ultimat3/core` carries its own pure-TS PNG/JPEG pipeline. Anything else: a subprocess or an HTTP service, never a hidden dependency |
| **Long-running-process maturity is less proven than Node's** | memory growth under sustained load and edge-case GC behaviour are less battle-tested, and `sync` nodes are *designed* to run for days holding many sockets | **budget explicit memory-profiling work**: soak tests at milestone 6 and 11 (24h+ at target socket count, RSS tracked), leak assertions in the live test type, and per-role memory ceilings with a graceful restart rather than an OOM kill |
| Some npm packages assume Node internals | occasional breakage | prefer web-standard libraries; the small dependency count makes this rare by construction |
| Single-runtime risk | a Bun regression is a framework outage | pin exact versions, keep an upgrade branch with the full `x verify` suite, and never depend on undocumented internals |
| Windows support is weaker | dev-machine friction | dev via WSL; CI and prod are Linux containers |

## 4. Scope is credibly 3–4 products

Honestly counted, this is: a web framework, a job/workflow engine, a sync engine, and an AI/MCP platform — plus a UI kit and a CLI. Each has funded companies working on it alone. The failure mode is not building the wrong thing; it is building all of them to 60%.

| Mitigation | Detail |
|---|---|
| **The milestone sequence is the mitigation** | twelve strictly ordered milestones, each ending in a working demo app plus green `x verify`. Order is the plan |
| **Resist parallelism** | no two milestones in flight. Parallel work here produces four 60%-done subsystems and no product |
| Eight primitives as a scope fence | if a feature is not one of `entity policy action mutator query job route task`, it does not ship ([`02-primitives.md`](./02-primitives.md)) |
| Explicit exclusions | GraphQL, multi-runtime, multi-ORM, multiple CSS systems, RSC, plugin API, vendor primitives — each is a permanent no, not a later ([`00-thesis.md`](./00-thesis.md)) |
| Cuts come off the back | drop M11's Helm chart before dropping M4's budgets |
| Default to deletion | a removed alternative is a shipped feature |

## 5. Static rot

**Frameworks that serve both audiences drift app-side, and the static path decays.** Next.js did exactly this: it began as a static/SSR tool, the interesting work moved to the app-side rendering model, and static export became the path with the caveats, the missing features, and the worse docs. The gravity is structural, not a mistake anyone made — the app path is where the hard problems and the paying users are, so attention goes there, and one shared module graph lets app-side weight leak into marketing bundles unnoticed.

| Guardrail | Mechanism |
|---|---|
| **Hard 0kb default on `site/`** | `hydrate: 'never'`, and emitting JS without an explicit `hydrate` + `budget` is a build error ([`06-surfaces.md`](./06-surfaces.md)) |
| **`site/` cannot import `app/`** | transitive check, build error, prints the offending chain — the `<Button>` that grew a charting dep cannot reach marketing |
| **The starter landing page lives in `site/`** | every new app and every maintainer smoke test exercises the static path on day one. Static regressions break the template *visibly*, for everyone |
| Independent static deploy | `x build --target static` ships without the app image, so the static path has its own lifecycle and cannot be an afterthought of an app deploy ([`12-build-deploy.md`](./12-build-deploy.md)) |
| Budgets in `x verify` | Lighthouse + per-route bytes on `site/` routes, ratcheting |

Residual risk: guardrails prevent silent decay, not deliberate neglect. If `site/` features stop being added while `app/` grows, the framework is still drifting — worth watching as a maintainer-attention metric, not just a CI metric.

## 6. Live-query reconnect cost

The dangerous case is not steady state; it is **N thousand sockets reconnecting at once**, each asking "what changed since my LSN?", during a deploy when capacity is already reduced. A naive implementation turns every rolling restart into a self-inflicted load spike that can outlast the deploy and re-form on the surviving nodes.

| Mitigation | Detail |
|---|---|
| **Prototype at milestone 6, before topology is locked** | 50k sockets, forced `sync` restart, measure time-to-consistent, DB queries issued, and peak CPU on the replicator. Published numbers, not estimates |
| Bounded per-query change buffer | reconnect inside the window is a delta replay with **zero DB work** |
| Snapshot fallback, never WAL replay | outside the window: one bounded query at a current LSN |
| Server-directed jittered reconnect | draining nodes send `{ type: 'reconnect', afterMs, resumeFrom }` so clients spread out and redistribute ([`11-topology.md`](./11-topology.md)) |
| Per-tenant subscription caps | a subscription explosion is a typed load-shedding decision, not a fall-over |
| Escape hatch | if the numbers are bad, wrap an existing protocol (risk 1) or ship v1 with tier 1 only |

## What is explicitly accepted

| Accepted | Why |
|---|---|
| Smaller ecosystem than React/Next | the axioms require owning the router and the boundaries |
| Opinionated to the point of exclusion | one way to do each thing is the product |
| No serverless / edge story | axiom 7; containers only |
| A tier-3 story that lands in v2 | shipping tiers 1–2 well beats shipping three tiers badly |
| Bun-only | the dependency reduction is the reason the framework is small enough to be coherent |
