---
title: FAQ
menu: true
nav: FAQ
description: Straight answers about Bun-only, no GraphQL, no Tailwind, no serverless, production readiness, and how Ultimate differs from Rails, Next and Meteor.
lede: Short answers, including the unflattering ones.
updated: 2026-07-26
---

## Status

**Is it production-ready?** No. `As of 2026-07` Ultimate is pre-v1: milestones 0–5 come first,
nothing is published to npm, and no API is stable. Treat it as a design under construction.

**Are the benchmarks on this page real?** There are none. The reconnect benchmark is milestone
6 and has not been run; no throughput, latency or adoption number appears anywhere on this site
until it exists.

**Can I use it today?** You can read it, clone it, and argue with it. Building a business on it
is premature.

## Stack choices

**Why Bun only?** Portability costs a lowest-common-denominator API. Bun-only buys `Bun.sql`,
`Bun.redis`, `Bun.s3`, native WebSockets, the bundler and the test runner as language features —
roughly 1,200 transitive packages of a conventional stack collapse into under 40 direct
dependencies.

**Will you support Node or Deno?** No. Multi-runtime is a permanent exclusion, not a backlog
item.

**Why no GraphQL?** A second schema language, a second authz surface, and a resolver-shaped
N+1 factory. Typed actions plus live queries cover the need, and OpenAPI is generated for free.

**Why no Tailwind or CSS-in-JS?** Three token systems in one repo is how theming rots. SCSS
modules plus design tokens: build-time only, zero runtime, dark theme is a token flip.

**Why no React or RSC?** Wrong runtime for RSC, and the mental model taxes the exact audience
we optimise for. Solid's `stream` mode with `<Suspense>` gets the same payoff with no new
component dialect and no hydration pass over the shell.

**Why your own router?** The router must own render mode, hydration timing and offline strategy
to make those route-level properties enforceable. That cannot be a third-party dependency.

**Why Drizzle and not Prisma?** Its generated SQL is legible, so an agent can read the statement
it produced and self-correct. That is the whole selection criterion.

## Design rules

**Why is `idempotencyKey` required by the type?** At-least-once is the only honest delivery
guarantee, so every handler must be replay-safe. "Remember to add a key" is exactly the
instruction an agent drops under pressure; a required field converts a duplicate-charge
incident into a red squiggle.

**Why is every action an MCP tool?** Because the alternative is a second authorization system.
The MCP call reaches the same `policy` with the same actor resolution as the HTTP call. No
trusted-tool mode, no service account with broad rights.

**Why is a missing meta description a build error?** A convention that isn't a build error
doesn't exist. Every SEO regression in history was a documented convention someone forgot.

**Why can't `site/` import `app/`?** Because that import is how a marketing page ships a
charting library — three hops away from any file a human reviewed. It is enforced
transitively, at build time.

## Operations

**Do I need Docker to develop?** No. `x dev` uses embedded Postgres, in-process NATS and a local
directory for S3. Docker is for parity checks and for building the production image.

**Do I need Redis or NATS?** No. Postgres covers the queue and pubsub; both are optional in
small deployments. They exist as drivers behind one interface, not as prerequisites.

**Can I deploy to the edge or to serverless functions?** No, by design. Deploy target means
"runs containers, plus Postgres". Vendor edge/KV/cron primitives would each need a second
implementation of a framework primitive, and the second implementation is where behavior
diverges.

**How do I scale?** Per role: `web` on RPS, `sync` on connection count, `worker` on queue depth,
`scheduler` and `replicator` pinned at one. Same image everywhere.

## Comparisons

| Compared to | What is the same | What is different |
|---|---|---|
| **Rails** | convention over configuration, generators, batteries, one blessed path | typed end to end, realtime and MCP as primitives, containers-only deploy story |
| **Next.js** | per-route render modes, ISR, streaming shells | one runtime, one authz system, no vendor platform primitives, 0kb static path enforced by the build |
| **Meteor** | realtime as a default | one authz system instead of `allow`/`deny` rules alongside method bodies — the drift that killed that model |
| **Phoenix** | server-authoritative realtime, channels, presence, supervision-shaped roles | TypeScript, Postgres-native queue, agent-first tooling |
| **Inngest / Zero** | durable steps; optimistic mutators with identical client/server code | they are libraries you assemble; here they are two of eight primitives sharing one policy layer |

## Extending it

**Where do plugins fit?** Nowhere before v1. Plugins freeze internals; extension points earn
their existence from real forks. Fork the blessed path in the meantime.

**Can I use tier 2 realtime but not tier 3?** Yes — that is the expected shape. Tier 3 is a
per-query `persist: true`, planned for v2.

**Is `x verify` really the only gate?** Yes. CI runs exactly `x verify` — a check that lives
only in CI is a check developers cannot run.

**Who is this for?** Primarily an AI agent, secondarily a tired senior engineer. Both want the
same thing: fewer decisions with consequences.
