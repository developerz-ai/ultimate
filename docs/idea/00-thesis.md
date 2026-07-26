# Thesis

Rails' philosophy — convention over configuration, generators, one blessed path, batteries included — applied to Bun + Postgres + SolidJS, where **the primary user is an AI agent**.

## Who it is for

| Audience | What they need | What that forces |
|---|---|---|
| **Primary: an AI agent** | one correct way, machine-readable errors, generated facts to read | no choice menus, `--json` everywhere, `x.manifest.json` emitted from code |
| **Secondary: a tired senior engineer** | no glue code, no 3am pager, no config archaeology | batteries in-box, typed env at boot, `x verify` as the only gate |

Agents fail on ambiguity, not on syntax. Every "you could use A or B here" is a branch point where an agent guesses, ships, and the guess is discovered in production. Ambiguity is the tax agents pay — Ultimate's job is to not levy it.

A framework optimized for agents is *also* the calmest framework for humans. The two audiences want the same thing: fewer decisions with consequences.

## Steal explicitly

Nothing here is novel in isolation. The bet is that no one has assembled it in one runtime with one authz system.

| Source | What we take | Why |
|---|---|---|
| **Rails** | convention over configuration, generators, one blessed path, batteries included | the only proven cure for decision fatigue at framework scale |
| **Meteor** | realtime as a default, not an add-on | realtime bolted on later never gets the authz story right |
| **Next.js** | per-route render modes, ISR, streaming shells | render mode is a route-level property, never a global one |
| **Laravel** | queues, mail, storage, scheduler in-box + genuinely good error pages | "batteries" means the boring 40% of every app, and errors that teach |
| **Phoenix LiveView** | server-authoritative realtime, channels, presence | the server owns truth; the client owns latency hiding |
| **Zero + Replicache** | optimistic mutators whose code is identical client and server | one function, two executions — the only local-first shape that stays honest |
| **Inngest** | durable step workflows | a step is the retry unit; the job is not |
| **Elixir/OTP** | supervision trees, graceful drain, role-based processes | one image, N roles, restart semantics you can reason about |
| **Django** | admin-grade introspection, migrations that don't lie | if the framework can't describe itself, neither can an agent |

## Design axioms

Non-negotiable. Every package, doc, and generated file honours these.

| # | Axiom | Consequence |
|---|---|---|
| 1 | **One way to do each thing.** | No adapter zoo, no `mode:` escape hatches. Removing an alternative is a feature. Ambiguity is the tax agents pay. |
| 2 | **Define once, project everywhere.** | One `action` → HTTP route + OpenAPI + typed client + job handle + MCP tool + tests. Adding a surface never means writing a mapping layer. |
| 3 | **Enforced, not documented.** | A convention that isn't a build error doesn't exist. Import boundaries, missing meta, drifted migrations, blown budgets all fail `x verify`. |
| 4 | **Errors are instructions.** | Stable `X_*` code + cause + exact fix command + `--json`. Same string in terminal, browser overlay, and MCP response. An agent that can read the fix does not need a human. |
| 5 | **One command means shippable.** | `x verify` green = deployable. No tribal checklist, no "also run the e2e suite on staging". |
| 6 | **Static path never pays for the app path.** | Separate bundle graphs; `site/` cannot import `app/`. 0kb JS baseline on marketing is structural, not aspirational. |
| 7 | **Deploy anywhere = containers only.** | Zero platform primitives. No edge functions, no vendor KV, no proprietary image loader. If it needs a specific host, it isn't in the framework. |

See [`02-primitives.md`](./02-primitives.md) for how axiom 2 is implemented and [`10-testing.md`](./10-testing.md) for axiom 5's contents.

## Explicit exclusions

Each one is a permanent no, not a "later".

| Excluded | Why |
|---|---|
| **GraphQL** | a second schema language, a second authz surface, and a resolver-shaped N+1 factory. Typed actions + live queries cover the need. |
| **Multi-runtime** (Node, Deno, workerd) | portability costs a lowest-common-denominator API. Bun-only buys `Bun.sql`, `Bun.redis`, `Bun.s3`, the bundler, and the test runner as *language features*. |
| **Multi-ORM** | two query builders means two migration stories and two sets of generated SQL for an agent to learn. Drizzle, because its SQL is legible enough to self-correct against. |
| **Multiple CSS solutions** | Tailwind + modules + CSS-in-JS in one repo is three token systems. SCSS modules + design tokens, one way to theme. |
| **React Server Components** | wrong runtime, and the mental model taxes the exact audience we optimize for. Solid streaming with `<Suspense>` gets the same payoff with no new component dialect. |
| **A plugin API before v1** | plugins freeze internals. Ship the blessed path first; extension points earn their existence from real forks. |
| **Vendor edge/KV primitives** | violates axiom 7. Cache tiers are ours (see [`05-caching.md`](./05-caching.md)); the CDN gets standard headers and a purge webhook, nothing more. |

## What "done" looks like

```
bunx create-ultimate myapp && cd myapp && x dev
```

No Docker install. No `.env` scavenger hunt. Embedded Postgres, in-process NATS, S3 → local dir. A landing page in `site/` at 0kb JS, an authed dashboard in `app/` streaming, an admin app that already speaks MCP, and `x verify` green — before the first line of user code.

Then `x build --target docker` and it runs anywhere that runs containers.
