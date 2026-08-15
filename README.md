<p align="center">
  <img src="assets/logo.svg" alt="" width="88" height="88" />
</p>

<h1 align="center">Ultimate</h1>

<p align="center"><strong>The full-stack framework where the primary user is an AI agent.</strong></p>

<p align="center"><em>Rails' opinions. Bun's speed. One command that means shippable.</em></p>


<div align="center">

[![CI](https://github.com/developerz-ai/ultimate/actions/workflows/ci.yml/badge.svg)](https://github.com/developerz-ai/ultimate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-%E2%89%A5%201.3-black.svg?logo=bun)](https://bun.sh)
[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](CHANGELOG.md)

</div>

> **Status: 1.2.0**, `As of 2026-08`. 28 `@ultimat3/*` packages plus the unscoped `create-ultimate` — 29 in all — versioned in lockstep: one version, one commit, one tag. **`@ultimat3/flags` has never reached npm** and the rest sit at 1.2.0, so the registry is not yet in lockstep with the repo ([#84](https://github.com/developerz-ai/ultimate/issues/84)); it needs the one-time manual bootstrap every package gets before a trusted publisher can attach. 1.1.0 was the **first release published by the workflow**, over OIDC trusted publishing with provenance attached; 1.0.0 was the manual bootstrap. Semver applies — a breaking change to a documented API needs a major. That is what the version number means: a stable API under semver, not a promise about your infrastructure.

## Built by agents, for agents, maintained by agents

Nobody writes this code by hand any more, and the framework is designed for that rather than
retrofitted to it. A coding agent works 24/7/365, and — the part that actually matters — it writes
the tenth feature the way it wrote the first. No Friday-afternoon shortcut, no "I'll clean this up
later", no second way of doing a thing because someone new joined. Consistency at volume is the
thing humans are worst at and agents are best at.

That only pays off if the framework agrees. One way to do each thing, so there is nothing to choose
between. Conventions that are build errors, so the compiler corrects the agent instead of a
reviewer. Errors carrying a stable code, a cause and a command that fixes it, so a failure costs one
round-trip. Docs local in `node_modules`, so nothing reaches for a wiki. `--json` on every command,
so output is parsed rather than re-read. Each of those is worth a little on its own; together they
are the difference between an agent that ships and one that thrashes.

<p align="center">
  <img src="assets/never-send-a-human.webp" alt="Agent Smith: &quot;Never send a human to do a machine's job.&quot;" width="460" />
</p>

<p align="center"><sub><em>The Matrix</em> (1999)</sub></p>

**Measured, and only this much:**

| What was measured | The result |
|---|---|
| **Realtime restart recovery** | 50,000 real WebSocket clients against **one** `sync` node, `SIGKILL`ed with no drain — no `reconnect` frame sent, so every client recovers on its own backoff. All 50,000 reconnected; **49,981** received a channel patch inside the window. Time-to-consistent p50 **54.0s**, p90 **105.5s**, max 145.7s |
| **The DB-load half** | **156,851** connect attempts shed by the shipped `AcceptBudget` (500/s, burst 2000) before reaching any query or snapshot path. Recovery is bounded by admission control, not by the matcher |
| **What it is not** | one node, in-process transport — the run never crossed NATS. Per-node recovery, **not** a multi-node result, and not a throughput or latency-under-load figure |

Reproduce it: `bun run scripts/bench/restart-bench.ts --clients 50000` — the committed report and the run's own transcript are in [`scripts/bench/results/`](scripts/bench/results/).

**Not claimed at 1.1.0:**

| Open | Where it stands |
|---|---|
| **Two-platform deploy proof** | 1.1.0 gave a scaffolded app a real deployable artifact — `x new` writes `apps/web/server.ts`, `prerender.ts`, a Dockerfile and `docker-compose.prod.yml`, and `ROLE=migrate` runs release-phase migrations. The **proof** is still open: the demo app on Compose **and** K8s from one image, with an invisible rolling restart, is [milestone 11](docs/idea/14-roadmap.md) and has not been demonstrated |
| **Known gaps shipped in 1.1.0** | `x build --target binary` compiled and then crashed at import — **fixed since**: the version read is lazy and `x build` compiles it in as a define, so the executable boots, though the target is still unproven end to end · `docker-compose.prod.yml` pairs a published host port with `replicas: 3`, which cannot work · the shared cache tier's Lua invalidation `DEL`s keys it never declares in `KEYS`, so it fails on Dragonfly and Redis Cluster · `resolveEnvironment` now exists in both `core` and `seo` with different return types. All four are in [CHANGELOG.md](CHANGELOG.md) |
| **Deferred to v2** | realtime tier 3 local-first (`persist: true`), the plugin API, multi-region replication, the Redis/NATS **job** drivers — each behind the interface that ships today. The job drivers throw `X_NOT_IMPLEMENTED` with a runnable `fix:` rather than pretending to work |

**Never claimed:** no adoption numbers, no production deployments, no testimonials. None exist yet, and this file will say so until they do.

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

## Wrap, don't reinvent

The framework wraps libraries so you don't have to. Your app wraps the framework so your agent doesn't have to. Two layers, one goal: **the least app code that can express the app** — more generated code is more bugs, so the unit of progress is lines *not* written.

| Layer | Wraps | So that |
|---|---|---|
| Bun natives | Postgres, Redis, S3, WS, the bundler, the test runner | a whole class of dependency never enters the lockfile — see the stack table below |
| **Ultimate** | those natives, behind eight primitives | an agent writes `entity` / `action` / `job` — never a connection pool, a queue, or a cache-key scheme |
| **Your app** | those primitives, behind your own domain vocabulary | a feature is a declaration, not an integration |

The rule that stops this becoming an abstraction tower: **a wrapper must delete a decision, not rename one.** Reinvention is reserved for the places where wrapping would leak the thing being avoided — which is why there is no ORM, and why the router is ours.

The framework makes the big decisions so the agent spends its budget on your product. Breadth is not the enemy of control; undeclared coupling is. Every capability arrives as an interface with one shipped implementation — assemble like Lego, and drop to the seam when Lego runs out.

→ [The thesis, in full](docs/idea/00-thesis.md)

## 60 seconds

```sh
bunx create-ultimate myapp && cd myapp && x dev
```

No Docker. No env scavenger hunt. Embedded Postgres, in-process NATS, S3 → a local directory. What you get is a running app with auth, a seeded database, a working example route, and a dev dashboard at `/_x`.

Every `@ultimat3/*` dependency it writes is pinned to one exact version. They move together — never mix versions across the scope.

## One `action`, six artifacts

This is the load-bearing idea. You write one declaration:

```ts
export const publishPost = action({
  input:  t.object({ postId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },

  async handle({ input }) {
    const post = await publish(input.postId);
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id });
    return post;
  },
});
```

> **`As of 2026-08`, the handler's `ctx` is not the full `Ctx`.** Over HTTP it is a cast of the
> request context: it carries `actor`, `locale`, `tz`, `requestId` and `traceId`, and it does **not**
> carry `logger`, `now()`, `clock`, `signal` or `services`. So `ctx.posts` and `ctx.logger.info(...)`
> throw on the HTTP path, though both work under a job. Import your service and call the job handle
> directly, as above. Tracked, with the fix, in [Known gaps](wiki/Known-Gaps.md).

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
| **Metrics** | counters, gauges and histograms on the OpenTelemetry data model; `/metrics` in Prometheus text | no dependency, and the Helm chart's HPA metrics are the ones the framework already emits |
| **Secrets** | `Secret` redacts **by value** — `toString`, `toJSON`, the logger, at any depth, under any key | frozen, so a spread cannot unwrap it; `.env.example` is generated from the typed env declaration |

## Rendering — SSR only where it pays

Render mode is a route-level property, not a global one. A landing page is static or ISR at a 0kb JS baseline; a dashboard streams. The `site/` surface **cannot** import from `app/` — a build error, not a lint warning — so the marketing path can never grow the app's bundle through a shared component.

| Surface | Default mode | JS baseline |
|---|---|---|
| `site/` | `static` / `isr` | **0kb**, enforced |
| `app/` | `stream` | a per-route budget that fails the build when blown |
| `api/` | none | n/a |

→ [Surfaces](docs/idea/06-surfaces.md) · [Rendering and SEO](docs/idea/07-rendering-seo.md)

## Realtime — a ladder, not a cliff

Three tiers, the same mutator shape at every rung. Tier 2 → tier 3 is a config flag, not a rewrite. Tiers 1–2 ship today; tier 3 lands in v2, behind the interfaces that are already here.

| Tier | What | Covers |
|---|---|---|
| 1 · **Channels** | `ctx.publish(topic, msg)` over Bun's native WS pub/sub | presence, cursors, notifications |
| 2 · **Live queries** | declare server-side with a policy, receive a Solid signal | **90% of "realtime app"** |
| 3 · **Local-first** *(v2)* | optimistic mutators, OPFS SQLite, offline queue, rebase | offline writes that reconcile |

→ [Realtime design and its honest limits](docs/idea/03-realtime.md)

## From pre-MVP to planet-scale

The same app code on one PaaS dyno and on a replicated cluster. Climbing is a driver swap, an env var, and someone else's infrastructure — the eight primitives, their shapes, their authz, the manifest, the OpenAPI and the typed client never move.

| Rung | You run | App code change |
|---|---|---|
| 0 | one process on a PaaS, their managed Postgres | **none** |
| 1 | one service per `ROLE`, managed Postgres + a shared cache tier | none, plus config |
| 2 | one box, Compose, all six roles, NATS beside them | none, plus config |
| 3 | Kubernetes, per-role HPAs, logical replication for the change feed | none, plus config |
| 4 | distributed SQL (YugabyteDB), JetStream R3, metrics and traces wired end to end | none for the datastore swap — with named incompatibilities |

**This is the design, not a demonstration.** `As of 2026-08` exactly one point on it is measured — the 50k restart above, at one node. Rung 4 has never been run. [`17-scale-ladder.md`](docs/idea/17-scale-ladder.md) states rung by rung what is real today and what is intent, and names the places the invariant currently breaks. Fintech, agent platforms, multi-tenant dashboards: that is what the architecture is *for*, and nobody's production traffic has tested the claim yet.

→ [The scale ladder](docs/idea/17-scale-ladder.md) · [Running it for real](docs/ops/README.md) · [Mobile and desktop targets](docs/idea/16-app-targets.md)

## Stack — locked, deliberately

| Layer | Decision | Why |
|---|---|---|
| Runtime | **Bun ≥ 1.3, only** | native SQL / Redis / S3 / WS / test / bundler / image — kills ~15 deps |
| HTTP | thin layer over `Bun.serve` | we own the lifecycle, so context/tracing/authz can't be skipped |
| DB | **Postgres**, no ORM | `entity()` is the one table declaration; `postgresDriver()` emits hand-written parameterised SQL, so an agent reads the statement and self-corrects |
| Validation | **Standard Schema**, builtin provider default | dependency-free and shipped; ArkType/Zod/Valibot swap in behind `configureSchemaProvider()` with a ~40-line adapter you write |
| Auth | **Better Auth**, wrapped | MIT, self-hosted, with our policy layer on top |
| Frontend | **SolidJS 2** + our own router | fine-grained reactivity; we vendor the router rather than track an alpha |
| Styling | **SCSS modules + design tokens** | no Tailwind (diff noise), no CSS-in-JS (runtime cost) |
| Jobs | Postgres queue default; Redis/NATS drivers in v2 | zero-infra start, a real scale path behind one interface |
| Observability | **OpenTelemetry, always on** | one trace across HTTP → job → live query |

**Excluded on purpose:** GraphQL · multi-runtime · multi-ORM · a second CSS solution · React Server Components · a plugin API in 1.x · vendor edge/KV primitives.

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

## How much does a feature actually cost?

Measured, not asserted — from the social-network demo in [`dummy/social-media-clone`](dummy/social-media-clone), which was built to find out.

**Adding "block a user" end to end: 3 files.** One entity, one rule, one action.

```ts
// packages/db/src/schema/blocks.ts — the whole table
export const blocks = entity('blocks', {
  columns: {
    blockerId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp().defaultNow(),
  },
  // The composite key IS the idempotency mechanism: blocking twice is a no-op at the storage
  // layer, not because a caller remembered to check first.
  primaryKey: ['blockerId', 'blockedId'],
  indexes: [{ on: ['blockedId'] }],
});
```

```ts
// apps/web/shared/visibility.ts — one rule, every surface
export const canSeePost = (actor: Actor | null, post: PostRow): boolean => {
  if (post.deletedAt !== null) return false;
  // Blocks come FIRST and both ways. Check the audience ladder first and a `public` post stays
  // visible to someone who blocked its author — the specific rule has to beat the general one.
  if (isBlocked(actor, post.authorId)) return false;
  if (isSelf(actor, post.authorId)) return true;
  return isVisibleAudience(post.audience, isFriend(actor, post.authorId));
};
```

That rule is enforced on the public feed, the profile page, the signed-in feed, the API and the MCP
tool — because each of them asks the same function. **There is no `WHERE audience = 'public'`
anywhere in the app.** A `where` clause would be a second, weaker copy that drifts the first time
either changes.

**No registry to edit.** Registration is the import scan: `defineApi` takes whole modules, so the
export name *is* the primitive's name. There is no composition root, no DI container, no
`app.route(...)` list. For comparison, two production codebases were measured while designing this:

| Codebase | Feature | Cost |
|---|---|---|
| a TypeScript monorepo | one thumbs-up button | **11 files + 5 edits** in two god-files (469 and 610 LOC) across 4 workspaces |
| the same | an achievements system | **~50 files**; the entity redeclared **7×** |
| a Rails monolith | one CRUD resource + one MCP verb | **18 files + 2 frozen-array registry edits** |
| the same | one real domain entity | **81 files** |

The number that matters is not file count, it is **how many places one shape is declared**. A
thumbs-up rating was declared **9 times** in that TS monorepo — table, query row, branded id, enum,
request schema, service interface, wiring impl, route validation, client type — plus 4 registration
edits carrying no information at all. Here, `entity()` is declared once and the row type, the
migration, the insert shape, the admin screen, the OpenAPI schema and the client type are all
projections of it. Rename a column and every one of them fails to compile, which is the point.

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
    db/           entity declarations + SQL migrations, no business logic
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

## New in 1.1.0

| Landed | What it is |
|---|---|
| **`x` serves in production** | `serve.ts` boots a role with no dev watcher and no `/_x`; `ROLE=migrate` applies migrations and exits — the release phase a PaaS asks for. `x new` writes `apps/web/server.ts`, `prerender.ts`, a Dockerfile and `docker-compose.prod.yml` |
| **Metrics** | counter / gauge / histogram on the OTel data model, a `MetricExporter` seam, and `/metrics` in Prometheus text with no dependency |
| **`Secret`** | redaction by value, at any depth, under any key, frozen against a spread |
| **`resolveEnvironment()`** | `development \| test \| staging \| production` from `ULTIMATE_ENV`, plus `renderEnvExample()` so `.env.example` cannot drift from the typed declaration |
| **Page-level UI** | `AppShell` (with a working skip link), `PageHeader`, `Section`, `Toolbar`, `defineTheme()` as the one brand-override seam, and a generated [`CATALOG.md`](packages/ui/CATALOG.md) |
| **Test harness** | factory traits, associations and `create()`, plus `sharedExamples` / `behavesLike` |
| **[`docs/ops/`](docs/ops/README.md)** | the operations manual — rungs, secrets, observability, datastore sizing, disaster recovery, runbooks |
| **Design, not code** | [`16-app-targets.md`](docs/idea/16-app-targets.md) (mobile + desktop) and [`17-scale-ladder.md`](docs/idea/17-scale-ladder.md) are specs, with nothing shipped behind them yet |

Full detail, including the four known gaps: [CHANGELOG.md](CHANGELOG.md).

## Documentation

| Where | What |
|---|---|
| [docs/idea/](docs/idea/README.md) | **what and why** — the design spec, primitive by primitive |
| [docs/architecture/](docs/architecture/README.md) | **how it's built** — internals, for changing the framework itself |
| [docs/ops/](docs/ops/README.md) | **how to run it** — PaaS → Compose → Kubernetes, secrets, observability, datastore sizing, runbooks. Recommendations; the framework depends on none of it |
| [the wiki](https://github.com/developerz-ai/ultimate/wiki) | the reference manual and the one public documentation surface — every field, flag, and error code. Source in [`wiki/`](wiki/Home.md) |
| [llms.txt](llms.txt) | the machine-readable map — start here if you're an agent |
| [packages/ui/CATALOG.md](packages/ui/CATALOG.md) | 46 components with every prop and the token vocabulary, generated from source and drift-tested |
| [examples/dummy/](examples/dummy/README.md) | the reference app: every primitive, once, idiomatically |

**Start here:** [the thesis](docs/idea/00-thesis.md) → [the primitives](docs/idea/02-primitives.md) → [adding a feature](docs/architecture/15-adding-a-feature.md).

## Contributing

```sh
bun install
bun run verify        # the 17-step gate: typecheck → lint → boundaries → tests → drift → budgets → manifest → roadmap. Green = shippable.
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture/00-conventions.md](docs/architecture/00-conventions.md) first. The tier boundaries in that second file are enforced by `bun run boundaries` — a sideways import fails the build, by design.

## Roadmap

Twelve milestones, each ending in a working demo app and a green `x verify`. **Milestones 0–10 are shipped.** Milestone 11 — deploy and docs — is open on one thing: the demo app proven on Compose **and** K8s from a single image, rolling restart invisible. Its artifacts all ship, and 1.1.0 closed the gap that made the proof impossible to attempt — a scaffolded app now produces a deployable image — but the proof itself needs real infrastructure and has not been run. The status markers in that table are enforced by `x verify`'s `roadmap` step, so they cannot quietly rot.

The realtime kill criterion that 1.0.0 **waived** is now met: milestone 6 gated tier-2 realtime on a measured 50k-socket forced-restart benchmark, and that number is measured and committed — at one node, which is the scope stated above.

→ [The full roadmap](docs/idea/14-roadmap.md) · [The risks, stated plainly](docs/idea/15-risks.md)

## License

MIT © [developerz.ai](https://developerz.ai)
