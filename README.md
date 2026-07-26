<h1 align="center">Ultimate ⚡</h1>

<p align="center"><strong>The full-stack framework where the primary user is an AI agent.</strong></p>

<p align="center"><em>Rails' opinions. Bun's speed. One command that means shippable.</em></p>

<div align="center">

[![CI](https://github.com/developerz-ai/ultimate/actions/workflows/ci.yml/badge.svg)](https://github.com/developerz-ai/ultimate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-%E2%89%A5%201.3-black.svg?logo=bun)](https://bun.sh)
[![Status](https://img.shields.io/badge/status-pre--alpha-orange.svg)](docs/idea/14-roadmap.md)

</div>

> **Status: pre-alpha.** The architecture, the docs, and the package skeletons are in place. Milestones 0–5 are the path to usable — see the [roadmap](docs/idea/14-roadmap.md). Nothing here is production-ready yet, and this README will say so until it isn't.

---

## The thesis

Every framework built in the last fifteen years optimised for a human typing code. Ultimate assumes the code is written by an agent and reviewed by a tired senior engineer working through their own AI agent and AI reviewer.

The goal is the one Rails had: **shrink the set of problems the author has to hold in
their head, so they spend their attention on the app's features and not on the app's
infrastructure.** An agent that has to decide on a migration tool, a queue driver, a
cache key scheme and an authz model has spent its budget before writing a feature.

That single change of audience rewrites every default:

| Because the author is an agent… | Ultimate does this |
|---|---|
| ambiguity costs tokens and correctness | **one way to do each thing** — no second-best path to choose between |
| repeated definitions drift | **define once, project everywhere** — one `action` becomes six artifacts |
| documented conventions get ignored | **enforced, not documented** — a violated convention is a build error |
| errors are the feedback loop | **errors are instructions** — stable code + cause + the exact fix command |
| "is it done?" needs a machine answer | **`x verify`** — green means shippable, and it's the whole contract |
| output must be machine-readable | **`--json` on everything**, end to end |

## 60 seconds

```sh
bunx create-ultimate myapp && cd myapp && x dev
```

No Docker. No env scavenger hunt. Embedded Postgres, in-process NATS, S3 → a local directory. What you get is a running app with auth, a seeded database, a working example route, and a dev dashboard at `/_x`.

## One `action`, six artifacts

This is the load-bearing idea. You write one declaration:

```ts
export const publishPost = action({
  input:  t.object({ postId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },

  async handle({ input, ctx }) {
    const post = await ctx.posts.publish(input.postId);
    if (input.notify) await ctx.jobs.enqueue(notifySubscribers, { postId: post.id });
    return post;
  },
});
```

Ultimate generates all of this from it:

| # | Artifact | Detail |
|---|---|---|
| 1 | `POST /api/posts/publish` | the HTTP route, with validation and authz wired |
| 2 | OpenAPI entry | deterministic output, diffed by `x verify` against the committed spec |
| 3 | typed RPC client | `api.publishPost(...)` — a typo is a compile error *in the component* |
| 4 | an MCP tool | **identical authz.** One policy, two surfaces. |
| 5 | a job-callable handle | enqueue the same logic as durable work, no rewrite |
| 6 | a contract test + policy test stub | passing, not a TODO |

**Authz is defined once and enforced across HTTP, live queries, jobs, and MCP.** Two authz systems is how every Meteor-like framework died.

## The eight primitives

Everything in the framework is one of these. If a feature doesn't fit, it doesn't ship.

| Primitive | Is |
|---|---|
| `entity` | a table + its domain type + invariants |
| `policy` | an authz rule, evaluated in every surface |
| `action` | a mutation or command (server-authoritative) |
| `mutator` | an action with an optimistic local twin (offline/realtime) |
| `query` | a read; optionally live (subscribable) |
| `job` | durable background work, optionally multi-step |
| `route` | a URL + render mode + metadata + offline strategy |
| `task` | a scheduled trigger (cron) that enqueues jobs |

→ [The eight primitives, in full](docs/idea/02-primitives.md)

## What you get for free

Not "supported". Not "documented". **Enforced, and impossible to get wrong.**

| Concern | The default | The enforcement |
|---|---|---|
| **i18n** | flat catalogs, `Intl` for everything numeric | a missing key in a shipped locale fails `x verify`; misses render loudly as `⟦key⟧` |
| **Dark theme** | semantic tokens, OS-following with an explicit override that wins | a raw hex in a component is a lint failure; one token source of truth |
| **Timezones** | store UTC, format with an explicit IANA zone | no formatter has an ambient default; a cron without a `tz` won't compile |
| **Money** | integer minor units + currency, always attached | cross-currency arithmetic is refused; the exponent comes from the ISO table, never `/100` |
| **SEO** | typed metadata, JSON-LD, sitemap from the route table | a `site/` route with no description is a build error |
| **Offline** | `sw.js` generated from the route table | the offline fallback route is required *by the type* |
| **Admin** | Django-grade CRUD derived from the entity registry | `defineAdmin()` — 20 lines to a working dashboard |
| **MCP** | every action is a tool | and **your app's** dashboards expose their own MCP surface |

## Realtime — a ladder, not a cliff

Three tiers, the same mutator shape at every rung. Tier 2 → tier 3 is a config flag, not a rewrite.

| Tier | What | Covers |
|---|---|---|
| 1 · **Channels** | `ctx.publish(topic, msg)` over Bun's native WS pub/sub | presence, cursors, notifications |
| 2 · **Live queries** | declare server-side with a policy, receive a Solid signal | **90% of "realtime app"** |
| 3 · **Local-first** | optimistic mutators, OPFS SQLite, offline queue, rebase | offline writes that reconcile |

→ [Realtime design and its honest limits](docs/idea/03-realtime.md)

## Stack — locked, deliberately

| Layer | Decision | Why |
|---|---|---|
| Runtime | **Bun ≥ 1.3, only** | native SQL / Redis / S3 / WS / test / bundler / image — kills ~15 deps |
| HTTP | thin layer over `Bun.serve` | we own the lifecycle, so context/tracing/authz can't be skipped |
| DB | **Postgres + Drizzle** | SQL-transparent, so an agent reads the generated SQL and self-corrects |
| Validation | Standard Schema, **ArkType** default | swappable interface, one blessed default |
| Auth | **Better Auth**, wrapped | MIT, self-hosted, with our policy layer on top |
| Frontend | **SolidJS 2** + our own router | fine-grained reactivity; we vendor the router rather than track an alpha |
| Styling | **SCSS modules + design tokens** | no Tailwind (diff noise), no CSS-in-JS (runtime cost) |
| Jobs | Postgres queue default, Redis/NATS drivers | zero-infra start, a real scale path |
| Observability | **OpenTelemetry, always on** | one trace across HTTP → job → live query |

**Excluded on purpose:** GraphQL · multi-runtime · multi-ORM · a second CSS solution · React Server Components · a plugin API before v1 · vendor edge/KV primitives.

## Steal explicitly

| From | What we took |
|---|---|
| **Rails** | convention over configuration, generators, one blessed path, batteries included |
| **Meteor** | realtime as a default, not an add-on |
| **Next.js** | per-route rendering modes, ISR, streaming shells |
| **Laravel** | queues, mail, storage, scheduler in-box; great error pages |
| **Phoenix / LiveView** | server-authoritative realtime, channels, presence |
| **Zero / Replicache** | optimistic mutators that run identically client and server |
| **Inngest** | durable step workflows |
| **Elixir / OTP** | supervision, graceful drain, role-based processes |
| **Django** | admin-grade introspection, migrations that don't lie |

## Errors are instructions

Same three strings in the terminal, the browser overlay, and `--json`:

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

Every framework error carries a stable code, a cause, and a command that fixes it. → [The error contract](docs/architecture/04-error-contract.md)

## What your app looks like

A monorepo, so you can add mobile, desktop, or an extension later without restructuring — and so shared code stays shared.

```
myapp/
  apps/
    web/          site/ · app/ · api/ · shared/     ← the three surfaces
    admin/        the generated admin dashboard
    mobile/       native Swift/Kotlin, later
    desktop/      Tauri, later
  packages/
    domain/       pure types + constants, no I/O
    db/           Drizzle schema + migrations, no business logic
    core/         your business services — shared by web, admin, worker
    i18n/         your catalogs
    ui/           your components, on top of @ultimat3/ui
    mcp/          your app's own MCP tools
  app.config.ts   the one config file
```

`site/` **cannot** import from `app/` — a build error, not a lint warning. That one rule is what stops a marketing page from pulling in the charting library through a shared `<Button>` that grew a dependency.

You write features. The layout, the boundaries, the components, and the plumbing are already there. → [The generated app, explained](docs/architecture/12-generated-app.md)

## CLI

```sh
x new / dev / build / verify / deploy
x g resource|action|job|route|policy|entity|query|task   # complete, passing tests — no TODO stubs
x db gen|migrate|reset|studio|branch
x mcp serve
x doctor                                                 # env, versions, drift, ports
```

Every command takes `--json`. → [CLI reference](wiki/CLI-Reference.md)

## Documentation

| Where | What |
|---|---|
| [docs/idea/](docs/idea/README.md) | **what and why** — the design spec, primitive by primitive |
| [docs/architecture/](docs/architecture/README.md) | **how it's built** — internals, for changing the framework itself |
| [wiki/](wiki/Home.md) | the reference manual — every field, flag, and error code |
| [site/](site/README.md) | the public site (GitHub Pages) |
| [llms.txt](llms.txt) | the machine-readable map — start here if you're an agent |
| [examples/dummy/](examples/dummy/README.md) | the reference app: every primitive, once, idiomatically |

**Start here:** [the thesis](docs/idea/00-thesis.md) → [the primitives](docs/idea/02-primitives.md) → [adding a feature](docs/architecture/15-adding-a-feature.md).

## Contributing

```sh
bun install
bun run verify        # typecheck + lint + boundaries + tests. Green = shippable.
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture/00-conventions.md](docs/architecture/00-conventions.md) first. The tier boundaries in that second file are enforced by `bun run boundaries` — a sideways import fails the build, by design.

## Roadmap

Twelve milestones, each ending in a working demo app and a green `x verify`. **The sequencing rule: ship 0–5 before touching realtime.** A framework with great DX, jobs, and SEO is already shippable; a half-built sync engine is worthless.

→ [The full roadmap](docs/idea/14-roadmap.md) · [The risks, stated plainly](docs/idea/15-risks.md)

## License

MIT © [developerz.ai](https://developerz.ai)
