# FAQ

Honest answers. Where something is not built yet, it says so.

## Status

### Is it production ready?

No. Pre-v1, `As of 2026-07`. No packages are published to npm and there is no stability promise. Milestones 0–5 (skeleton, HTTP + entity + policy, actions + queries, rendering + surfaces, SEO + budgets, jobs + tasks) ship before realtime is touched. Remote drivers — Redis, NATS, real S3, Postgres logical replication — are interface-complete and throw `X_NOT_IMPLEMENTED` with a `fix:` line rather than pretending to work.

### What is actually finished?

Package skeletons with complete public types, implemented happy paths, and typed throws for every named error. The 12-milestone roadmap is the honest picture: each milestone ends in a **working demo app plus green `x verify`**, and the same demo app grows through all twelve. See [`docs/idea/14-roadmap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md).

### When is v1?

When milestones 0–11 are done, not on a date. Publishing a release date for pre-alpha work is how roadmaps become fiction. Scope cuts come off the back (M11's Helm chart), never the middle (M4's budgets).

## The stack

### Why Bun only?

Portability costs a lowest-common-denominator API. Bun-only makes `Bun.sql`, `Bun.redis`, `Bun.s3`, `Bun.serve` WebSockets, `Bun.build`, and `bun test` **language features** instead of dependencies — roughly a thousand transitive packages that never enter the lockfile. Target: under 40 direct dependencies for the whole framework.

### Why no Node or Deno support?

Multi-runtime means every native gets an adapter, every adapter gets a second behavior, and the second behavior is where bugs live. It would also make the WebSocket cost model — the thing `sync`'s economics depend on — a per-runtime variable. Stated cost: no native-addon packages, and long-running Bun processes are less battle-proven than Node's.

### Why no GraphQL?

A second schema language, a second authz surface, and a resolver-shaped N+1 factory. Typed `action` + `query` cover the need, and `openapi.json` is generated from them. One authz system is the whole point ([Policies and authz](Policies-And-Authz)).

### Why no Tailwind?

Tailwind plus modules plus CSS-in-JS in one repo is three token systems and three ways to theme. SCSS modules + design tokens is build-time only, zero runtime, and dark theme is a token flip. See [Theming](Theming).

### Why no React, and no RSC?

Wrong runtime for RSC, and the mental model taxes exactly the audience being optimized for. Solid's fine-grained reactivity makes streaming shells cost ~0 hydration, and `stream` + `<Suspense>` gets the same payoff with no new component dialect.

### Why SolidJS 2 and your own router?

The router must own render mode, offline strategy, and metadata — those are framework concerns, so it cannot be a third-party dependency that disagrees with the build. `As of 2026-07` SolidJS 2 is in beta and the ecosystem around it is thin, which is also why the UI kit is ours.

### Why ArkType?

One schema drives runtime parse, TS type, OpenAPI, and the MCP tool's JSON Schema. It is exposed as `t` and sits behind the Standard Schema interface, so the blessed default is swappable at the framework level — not per app.

## Design decisions people push back on

### Why is `idempotencyKey` required on every job?

At-least-once is the only honest guarantee any queue provides, so every handler must be replay-safe. "Remember to add a key" is exactly the instruction that gets dropped under pressure — by a human at 2am and by an agent always. Making it a required field converts a duplicate-charge incident into a red squiggle. Keys derive from `input` only: no timestamps, no random, no `ctx`.

### Why is every action an MCP tool?

Because the alternative is two authorization systems. An MCP call and an HTTP call reach the same `policy` with the same actor resolution — no MCP permission table, no "trusted tool" mode, no broad-rights service account. Actions still opt in per-action with `mcp: { expose: true }`; what is not optional is that exposure reuses the existing authz.

### Why does `x verify` block on budgets and SEO?

A convention that isn't a build error doesn't exist. A missing `description`, a blown JS budget, or a drifted migration is discovered in production otherwise — usually by someone who did not write the change. `x verify --json` names the route, the metric, the actual value, and the import chain that caused it.

### Is `x verify` really the only gate?

Yes. CI runs exactly `x verify` — no bespoke pipeline steps, because a check that lives only in CI is a check you cannot run locally. It covers typecheck, lint, import boundaries, all six test types, migration drift, contract diff, budgets, SEO + i18n, and manifest freshness. See [Testing](Testing).

### Why are there only eight primitives?

`entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task`. If a feature doesn't fit one of them, it doesn't ship. A push notification is a `job`; a share target is a `route` with a policy; an admin screen is a `query` plus actions. No PWA-specific or realtime-specific concept escapes into your mental model.

## Running it

### Do I need Docker to develop?

No. `x dev` uses embedded Postgres, in-process NATS, and a local directory in place of S3. `bunx create-ultimate myapp && cd myapp && x dev` — no Docker install, no `.env` scavenger hunt. The compose files exist for parity debugging and CI jobs that want real services ([Deployment](Deployment)).

### Do I need Redis or NATS?

No. Postgres covers the job queue (`SELECT ... FOR UPDATE SKIP LOCKED`) and pubsub, and a local volume covers files. Redis is a cache tier you opt into; NATS is fanout you need once `sync` runs on more than one node. Both are drivers behind one interface — job code and query code never change.

### Can I deploy serverless or to the edge?

No, by design. Containers only. Edge runtimes, function-per-route, and vendor KV/queue/cron primitives would each need a second implementation of a framework primitive, and the second implementation is where behavior diverges. Requirement: something that runs containers, plus Postgres.

### How much infrastructure does a small app need?

One container running `ROLE=all` and one Postgres. Split roles when a signal tells you to: RPS for `web`, connection count for `sync`, queue depth for `worker`. `scheduler` and `replicator` are fixed at one replica — a second is a warm standby, not throughput.

### Can I use it without the realtime tiers?

Yes. `realtime.tier: 1` with `transport: 'memory'` is the default, and a tier-1 app needs no `sync` role, no `replicator`, and no NATS. Milestones 0–5 are a complete product without any realtime at all: entities, actions, a typed client, five render modes, a 0kb static path, and durable jobs.

## Risk

### What happens if the sync engine doesn't work out?

It is roughly **70% of total effort** and the single largest risk. Milestone 6 is a reconnect benchmark — 50k sockets, a forced `sync` restart, measured time-to-consistent and DB load — and **topology is not frozen until that number exists**. If the incremental matcher is the bottleneck, wrapping an existing protocol (Zero's) is an accepted fallback. Tiers 1–2 target v1; tier 3 local-first is v2.

### Why ship realtime last if it's the differentiator?

A half-built sync engine is worth nothing: it cannot be shipped partially, demoed honestly, or tested against a real app, and it consumes the attention everything else needs. Starting there is how this project would die with 40 packages and no users.

### What if Bun has a problem under sustained load?

Stated risk, not a hidden one. `As of 2026-07` long-running Bun processes are less proven than Node's, so memory profiling under sustained socket load is explicit roadmap work. See [`docs/idea/15-risks.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/15-risks.md).

## Scope

### Where do plugins fit?

Nowhere, before v1. Plugins freeze internals, and internals are still moving. Fork the blessed path if you need something else; extension points earn their existence from real forks, not from speculation.

### Will you add an adapter for my host or my ORM?

No. Multi-ORM means two migration stories and two sets of generated SQL for an agent to learn. Vendor deploy adapters violate the containers-only axiom. Removing an alternative is treated as a feature.

### Who is it for?

Primary user: **an AI agent** — one correct way per task, machine-readable errors, generated facts to read. Secondary: **a tired senior engineer, working through their own AI agent and AI reviewer** — no glue code, no config archaeology, no 3am pager. Both want the same thing: fewer decisions with consequences.

### How is this different from Rails, Next.js, Meteor, or Phoenix?

| Compared to | Difference |
|---|---|
| **Rails** | same philosophy — conventions, generators, one blessed path — on Bun + Postgres + Solid, with types end to end and an agent as the primary reader |
| **Next.js** | render modes are borrowed; jobs, realtime, authz, mail, storage, admin, and MCP are in-box, and there are no platform primitives |
| **Meteor** | realtime by default is borrowed; **one** authz system that live queries reuse per delivered row is the part Meteor's generation got wrong |
| **Phoenix** | server-authoritative realtime is borrowed; different runtime, and durable step workflows are a first-class primitive rather than a library choice |
| **Inngest / Zero** | their shapes appear as `job` steps and `mutator`s — assembled into one runtime with one authz system, which is the actual bet |

Nothing here is novel in isolation. See [Home](Home) for the full "steal explicitly" table.

## Getting unstuck

### Where do I report a bug?

Run `x verify --json` and `x status --json`, attach both, and open an issue. The JSON is the report. Security issues go through [`SECURITY.md`](https://github.com/developerz-ai/ultimate/blob/main/SECURITY.md), never a public issue.

### An error code is unclear — where do I look?

`x errors explain <CODE> --json`, then [Error codes](Error-Codes). Every `X_*` code carries a cause, an exact fix command, and a docs URL, rendered identically in the terminal, the browser overlay, and `--json`. Symptom-first: [Troubleshooting](Troubleshooting).
