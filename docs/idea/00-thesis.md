# Thesis

Rails' philosophy — convention over configuration, generators, one blessed path, batteries included — applied to Bun + Postgres + SolidJS, where **the primary developer is an AI agent**.

## Who it is for

| Audience | What they need | What that forces |
|---|---|---|
| **Primary: an AI agent** | one correct way, machine-readable errors, generated facts to read | no choice menus, `--json` everywhere, `x.manifest.json` emitted from code |
| **Secondary: a tired senior engineer, via their own AI agent + AI reviewer** | no glue code, no 3am pager, no config archaeology | batteries in-box, typed env at boot, `x verify` as the only gate |

**Both ends of the project range, and the same framework at each.** A homework assignment is not
paying for a bank's infrastructure — the defaults *are* the small end — and a very large product is
not on a toy, because the ladder, the tier boundaries and the gate are already in the beginner's
app. The measured version of that claim, small end and large end, is [`21-the-range.md`](./21-the-range.md).

Agents fail on ambiguity, not on syntax. Every "you could use A or B here" is a branch point where an agent guesses, ships, and the guess is discovered in production. Ambiguity is the tax agents pay — Ultimate's job is to not levy it.

A framework optimized for agents is *also* the calmest framework for humans. The two audiences want the same thing: fewer decisions with consequences.

## Inspire explicitly

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
| **Spring** | a large capability surface behind swappable seams, and module boundaries verified by the build rather than by review | breadth is not the enemy of control — undeclared coupling is. Every capability here arrives as an interface with one shipped implementation, and `bun run boundaries` fails the build on an edge nobody declared. What we do **not** take: a DI container, runtime reflection, or configuration that surfaces its error three layers from the cause |
| **Play** | routes verified at compile time, and dev errors that name the line | a route that cannot drift from its handler is a class of bug deleted. We go one further — the directory **is** the URL, so there is no routes file to keep in sync in the first place |
| **Angular** | the CLI as the primary surface, and upgrades shipped as migrations rather than release notes | if `x g` emits it, nobody hand-writes it and nobody hand-edits it back. The upgrade half we take differently: an agent reads a machine-readable surface diff and edits with judgement, where a schematic guesses from syntax |
| **Ember Data** | an identity-mapped client store, one record per id — and its split between global records and per-view record arrays | two components holding two copies of one row is a bug the framework should make unrepresentable. Shipped `As of 2026-08`: rows are keyed `(entity, id)` and a subscription holds an ordered id list, so a patch on one live query is observed by every other holding that row. The split is load-bearing — without it, rolling back an optimistic insert would delete a row the server had since sent to another window |
| **Expo** | the updates protocol as a published spec, not a product | OTA that a vendor cannot revoke, because the client speaks a spec anyone can serve |

## Wrap, don't reinvent

**The framework wraps libraries so the user doesn't have to. The user wraps the framework so their agent doesn't have to.**

Two layers of wrapping, one goal: the least app code that can express the app. More code from an agent means more bugs, so the unit of progress is *lines not written*.

| Layer | Wraps | So that |
|---|---|---|
| Bun natives | Postgres, Redis, S3, the bundler, the test runner | ~40 dependencies never enter the lockfile ([`01-stack.md`](./01-stack.md)) |
| The framework | those natives, behind eight primitives | an agent writes `entity` / `action` / `job`, never a connection pool or a queue |
| The app | those primitives, behind its own domain vocabulary | a feature is a declaration, not an integration |

The rule that keeps this from becoming an abstraction tower: **a wrapper must delete a decision, not rename one.** A wrapper that only renames its subject adds a layer to learn and removes nothing to worry about — that is the failure mode, and it is the reason [axiom 1](#design-axioms) forbids a second path rather than encouraging a nicer one.

Reinventing is reserved for where the wrap would leak the thing being avoided: there is no ORM, because an ORM's abstraction is exactly the thing that has to be understood to debug it.

Which layer owns a given decision is [axiom 8](#design-axioms): Ultimate ships mechanism, your app ships convention. The mechanism / structural-convention / business-convention split, the worked decisions, and why the third row of that table needs no plugin API are in [`19-mechanism-not-convention.md`](./19-mechanism-not-convention.md).

## Pre-MVP to planet-scale, without a rewrite

The same app code runs on one PaaS dyno and on a distributed cluster. Climbing is a driver swap and configuration — never a re-architecture. That is the promise the whole design is arranged around, and the rungs, seams and honest incompatibilities are in [`17-scale-ladder.md`](./17-scale-ladder.md).

| Stage | What changes | What does not |
|---|---|---|
| pre-MVP → production | a managed Postgres URL, a cache driver | entities, actions, policies, queries, jobs, routes, tasks |
| production → scale-out | replicas, a NATS transport, a change feed | the same, plus every test that covered them |

`As of 2026-08` this is the *design*, proven at one measured point — 50,000 sockets **reachable again** after a forced restart of one node, which is reachability and not consistency ([`14-roadmap.md`](./14-roadmap.md) carries both halves) — and not yet at the top of the ladder. [`17-scale-ladder.md`](./17-scale-ladder.md) states which rungs are real today and which are intent, including the incompatibilities that would currently break the climb.

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
| 8 | **Ultimate ships mechanism; your app ships convention.** | Mechanisms ship, and so do *structural* conventions — file naming, the four surfaces, the tier order, one catalog per locale — because they are the same for a bank and a blog. *Business* conventions never ship: tenancy is a mechanism, an org model is somebody's business. Primitives are functions returning values, so an app encodes its own by wrapping one — no fork, no monkey-patch, no plugin API. |

See [`02-primitives.md`](./02-primitives.md) for how axiom 2 is implemented, [`10-testing.md`](./10-testing.md) for axiom 5's contents, and [`19-mechanism-not-convention.md`](./19-mechanism-not-convention.md) for axiom 8's test and its worked decisions.

## Explicit exclusions

Each one is a permanent no, not a "later".

| Excluded | Why |
|---|---|
| **GraphQL** | a second schema language, a second authz surface, and a resolver-shaped N+1 factory. Typed actions + live queries cover the need. |
| **Multi-runtime** (Node, Deno, workerd) | portability costs a lowest-common-denominator API. Bun-only buys `Bun.sql`, `Bun.redis`, `Bun.s3`, the bundler, and the test runner as *language features*. |
| **Multi-ORM** | two query builders means two migration stories and two sets of generated SQL for an agent to learn. No ORM at all, in fact: `entity()` is the one table declaration and `postgresDriver()` emits hand-written parameterised SQL, legible enough to self-correct against. |
| **Multiple CSS solutions** | Tailwind + modules + CSS-in-JS in one repo is three token systems. SCSS modules + design tokens, one way to theme. |
| **React Server Components** | wrong runtime, and the mental model taxes the exact audience we optimize for. Solid streaming with `<Suspense>` gets the same payoff with no new component dialect. |
| **A plugin API before v1** | plugins freeze internals. Ship the blessed path first; extension points earn their existence from real forks. |
| **Vendor edge/KV primitives** | violates axiom 7. Cache tiers are ours (see [`05-caching.md`](./05-caching.md)); the CDN gets standard headers and a purge webhook, nothing more. |

## What "done" looks like

```
bunx create-ultimate myapp && cd myapp && bin/setup && x dev
```

`bin/setup` is `bun install`, `x db gen "initial"`, `x db migrate`, `x db seed` — the scaffold's own
script, and not optional ([`13-dx.md`](./13-dx.md)). No Docker install. No `.env` scavenger hunt. Embedded Postgres, in-process NATS, S3 → local dir. A landing page in `site/` at 0kb JS, an authed dashboard in `app/` streaming, an admin app that already speaks MCP, and `x verify` green — before the first line of user code.

Then `x build --target docker` and it runs anywhere that runs containers.
