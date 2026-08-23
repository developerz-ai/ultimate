<h1 align="center">
  <img src="assets/logo.svg" alt="" width="88" height="88" /><br />
  Ultimate
</h1>

<p align="center"><strong>The full-stack framework where the primary developer is an AI agent.</strong></p>

<div align="center">

[![CI](https://github.com/developerz-ai/ultimate/actions/workflows/ci.yml/badge.svg)](https://github.com/developerz-ai/ultimate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-%E2%89%A5%201.3-black.svg?logo=bun)](https://bun.sh)
[![Version](https://img.shields.io/npm/v/%40ultimat3%2Fcore?label=version&color=blue)](https://www.npmjs.com/package/@ultimat3/core)

[Wiki — the reference manual](https://github.com/developerz-ai/ultimate/wiki) ·
[Error codes](wiki/Error-Codes.md) ·
[CLI reference](wiki/CLI-Reference.md) ·
[Adding a feature](docs/architecture/15-adding-a-feature.md) ·
[llms.txt](llms.txt)

</div>

> **If you are a coding agent, start with [`llms.txt`](llms.txt).** Every doc, wiki page and package README as one link map, generated from the on-disk indexes rather than hand-maintained — and carrying no version number at all, only the commands that resolve one.

## What it is

Rails' philosophy on a Bun + Postgres + SolidJS stack. Everything is one of **eight primitives**; one `action` declaration projects into an HTTP route, an OpenAPI operation, a typed client, a job handle, an MCP tool and a test — all on one `policy`, because two authz systems is how every framework of this shape has died.

`x verify` is the contract: green means shippable.

<p align="center">
  <img src="assets/never-send-a-human.webp" alt="Agent Smith: &quot;Never send a human to do a machine's job.&quot;" width="460" />
</p>

<p align="center"><sub><em>The Matrix</em> (1999)</sub></p>

## Who it is for, and the range

**A homework assignment through to a very large product, one framework, no lite mode.** The small end pays nothing for the large end — the large end is configuration the small end never types — and the large end is reachable because nothing the small end did has to be undone.

| End of the range | The claim | Measured `As of 2026-08-23` |
|---|---|---|
| **small** — a weekend idea, a first app | not overkill: nothing to install, nothing to choose | `x new` asks **0** questions (all five flags defaulted), writes **136** files you never edit, installs **104** packages, and reaches a running app in **4** commands with **0** env values supplied |
| **large** — many teams, real traffic | the ladder, the tier boundaries and the 19-step gate are already in the beginner's app | the same `x verify`, the same primitives, the same image; climbing is `ROLE`, env and replica counts ([scale ladder](docs/idea/17-scale-ladder.md)) |
| **the model you can afford** | enforced conventions and executable `fix:` lines are worth *more* the cheaper the model | a fresh scaffold's gate goes from red to **18 of 19** by running the `fix:` lines it printed, bounded at three rounds, on every push in CI |

→ [The range, in full, with every number's command](docs/idea/21-the-range.md)

## Run it

```sh
bunx create-ultimate myapp && cd myapp && bin/setup && x dev
```

`bin/setup` is `bun install`, `x db gen "initial"`, `x db migrate`, `x db seed` — idempotent, and the app's own README names it too. **Not `x dev` straight after `cd`:** `x new` installs nothing, so the app has no `node_modules` and no `x` of its own, and `x dev` stops on `X_BUILD_FAILED` — *"Could not resolve `@ultimat3/ui`. Maybe you need to `bun install`?"* (measured 2026-08-23; this file said otherwise until then).

No Docker, no env scavenger hunt. Embedded Postgres, in-process NATS, S3 → a local directory, a seeded database, a working route and a dev dashboard at `/_x`.

Working on the framework itself:

```sh
bun install
bun run verify            # the gate. Green = shippable
bun run x -- doctor --json   # the CLI, in-repo
```

## One `action`, six artifacts

**Define once, project everywhere** (axiom 2) — the load-bearing idea, and the reason an app here is small. You write one declaration:

```ts
export const publishPost = action({
  input:  t.object({ postId: t.uuid, orgId: t.uuid, notify: t.boolean.default(true) }),
  output: PostView,
  policy: can('post:publish', ({ input, actor }) => ownsPost(actor, input.postId)),
  cache:  { invalidates: [tag.post, tag.feed] },
  mcp:    { expose: true, description: 'Publish a draft post' },

  async handle({ input }) {
    const post = await publish(input.postId);
    if (input.notify) await notifySubscribers.enqueue({ postId: post.id, orgId: input.orgId });
    return post;
  },
});
```

| # | Artifact | Detail |
|---|---|---|
| 1 | `POST /api/posts/publish` | the HTTP route, validation and authz wired |
| 2 | an OpenAPI operation | deterministic, diffed by `x verify`'s `contract-diff` step against the committed spec |
| 3 | a typed RPC client | `api.publishPost(...)` — a typo is a compile error *in the component* |
| 4 | an MCP tool | **the same policy object.** One authz system, two surfaces |
| 5 | a job-callable handle | enqueue the same logic as durable work, no rewrite |
| 6 | a contract test + policy test stub | passing, not a TODO |

None of the six is hand-written and every one is drift-checked by `x verify`. Measured on the deployed demo: **~16 code lines per fully-projected endpoint**, and one 51-line action producing 179 lines of committed generated interface — [the counts and how to re-derive them](#how-much-code-you-do-not-write).

**Authz is defined once and enforced across HTTP, live queries, jobs and MCP.** Two authz systems is how every framework of this shape has died.

> **`As of 2026-08`, the handler's `ctx` is not the full `Ctx`.** Over HTTP it is a cast of the request context: it carries `actor`, `locale`, `tz`, `requestId` and `traceId`, and **not** `logger`, `now()`, `clock`, `signal` or `services`. So `ctx.posts` and `ctx.logger.info(...)` throw on the HTTP path, though both work under a job. Import your service and call the job handle directly, as above. Tracked with the fix in [Known gaps](wiki/Known-Gaps.md).

## The eight primitives

Everything in the framework is one of these. **A feature that fits none of them does not ship** — and there is no ninth: `PRIMITIVE_KINDS` in [`packages/core/src/registrar.ts`](packages/core/src/registrar.ts) is the single source, pinned by a test.

| Primitive | Is | Canonical shape |
|---|---|---|
| `entity` | a table + its domain type + invariants the database also enforces | [spec](docs/idea/02-primitives.md#entity) · [package](packages/entity/README.md) · [wiki](wiki/Entities-And-Migrations.md) |
| `policy` | one authz rule, evaluated identically in every surface | [spec](docs/idea/02-primitives.md#policy) · [package](packages/policy/README.md) · [wiki](wiki/Policies-And-Authz.md) |
| `action` | a server-authoritative mutation — the load-bearing one | [spec](docs/idea/02-primitives.md#action--the-load-bearing-one) · [package](packages/action/README.md) · [wiki](wiki/Actions.md) |
| `mutator` | an action with an optimistic local twin | [spec](docs/idea/02-primitives.md#mutator) · [package](packages/realtime/README.md) · [wiki](wiki/Realtime.md) |
| `query` | a read, optionally live | [spec](docs/idea/02-primitives.md#query) · [package](packages/query/README.md) · [wiki](wiki/Queries-And-Live-Queries.md) |
| `job` | durable background work, optionally multi-step | [spec](docs/idea/02-primitives.md#job) · [package](packages/jobs/README.md) · [wiki](wiki/Jobs-And-Workflows.md) |
| `route` | a URL + render mode + metadata + offline strategy | [spec](docs/idea/02-primitives.md#route) · [package](packages/render/README.md) · [wiki](wiki/Routes-And-Render-Modes.md) |
| `task` | a scheduled trigger that enqueues jobs | [spec](docs/idea/02-primitives.md#task) · [package](packages/jobs/README.md) · [wiki](wiki/Scheduled-Tasks.md) |

A new capability arrives as a **factory over an existing primitive**, never as a new kind of thing: `llm()` returns an action, `backfill()` returns a job. → [The eight primitives, in full](docs/idea/02-primitives.md)

## Errors are instructions

Not a mock-up. The three strings below are built in [`packages/db/src/errors.ts:249`](packages/db/src/errors.ts) and render identically in the terminal, in the browser overlay and under `--json`:

```
X_DB_DRIFT: schema differs from migrations
  cause: table "posts" has column "publish_at" not present in any migration
  fix:   x db gen "add publish_at"
```

**The `fix:` line is a command you run, never advice.** A stable code, the concrete cause, and the next thing to type — so a failure costs one round-trip instead of a search. Enforced, not hoped for: a `fix:` naming no command, no call and no file fails the gate's `errors` step, and every `x …` any page prints is resolved against the real command registry.

`x errors explain <CODE> --json` and the MCP `errors.explain` tool answer with the same three strings. A shipped code never changes meaning and is never reused. → [Every code](wiki/Error-Codes.md) · [The contract](docs/architecture/04-error-contract.md)

## The gate

```sh
bun run verify        # this repo. In an app: x verify
```

**Nineteen steps, in cost order**, and the same list runs in the framework repo and in a generated app — whole, or not at all. `x verify --only <step>` runs one step for an iteration loop and announces `NOT A GATE RUN`; the gate is this command with no flag, and there is no `--skip`.

`typecheck` · `lint` · `boundaries` · `filesize` · `package-shape` · `errors` · `unit` · `contract` · `live` · `job` · `e2e` · `eval` · `drift` · `contract-diff` · `budgets` · `seo` · `i18n` · `manifest` · `roadmap`

The list is data, not prose — `VERIFY_STEP_NAMES` in [`packages/cli/src/verify-step.ts`](packages/cli/src/verify-step.ts), and `bun run x -- verify --json` prints it with each step's verdict. **Green means shippable**; that is the whole contract.

| Also | Command |
|---|---|
| both tracked apps' own gates, on a ratchet | `bun run scripts/reference-app-gate.ts` |
| import boundaries alone | `bun run boundaries` |
| regenerate the framework manifest | `bun run manifest` |
| one test file · one test name | `bun test packages/core/src/errors.test.ts` · `bun test -t 'formats the fix line'` |

## Every number here has a command beside it

A version, a count or a status written into a file goes stale on the next commit; the command does not. **Run the right-hand column — never quote the left.**

| Fact | Read it yourself |
|---|---|
| what npm serves, and what `bunx create-ultimate` installs | `npm view @ultimat3/core version` |
| every package that moves together, with its tier | `bun run scripts/list-workspaces.ts --json` |
| the repository is stamped at one version | `bun run scripts/release.ts --check <version>` |
| every package is on the registry at that version, attested | `bun run scripts/registry-audit.ts --json` |
| the gate's steps, in order | `bun run x -- verify --json` |
| every command and flag this build ships | `bun run x -- help --json` |
| every `X_*` code, its owner and the file declaring it | `bun run manifest` → `framework.manifest.json` |
| the realtime capacity figures, audited against the committed run | [`CLAUDE.md`](CLAUDE.md)'s status section — [`scripts/bench-claims.ts`](scripts/bench-claims.ts) fails the gate when they drift |

`As of 2026-08-20`: 30 workspaces, 29 `@ultimat3/*` plus the unscoped `create-ultimate`, versioned and published in lockstep — one version, one commit, one tag, 30 tarballs. [`PUBLISHING.md`](PUBLISHING.md) owns the mechanics; [`CLAUDE.md`](CLAUDE.md) carries the full status table, one runnable check per row.

**Never claimed:** no adoption numbers, no production deployments, no testimonials. None exist yet, and this file will say so until they do.

## Navigate

One hop per question.

| You want | Go |
|---|---|
| to know whether it fits a project this size | [docs/idea/21-the-range.md](docs/idea/21-the-range.md) |
| the reference manual — every field, flag, error code | [wiki/](wiki/Home.md) · [browsable](https://github.com/developerz-ai/ultimate/wiki) |
| **what to do, step by step, to add a feature** | [docs/architecture/15-adding-a-feature.md](docs/architecture/15-adding-a-feature.md) |
| why a decision was made | [docs/idea/](docs/idea/README.md) |
| how a subsystem actually works | [docs/architecture/](docs/architecture/README.md) |
| running an app in production | [docs/ops/](docs/ops/README.md) |
| the coding contract in full | [docs/architecture/00-conventions.md](docs/architecture/00-conventions.md) |
| why an import failed | [docs/architecture/02-boundaries.md](docs/architecture/02-boundaries.md) |
| an `X_*` code | [wiki/Error-Codes.md](wiki/Error-Codes.md) · `bun run x -- errors explain <CODE> --json` |
| a CLI flag | [wiki/CLI-Reference.md](wiki/CLI-Reference.md) |
| upgrading across a major | [wiki/Upgrading.md](wiki/Upgrading.md) |
| what is broken and known | [wiki/Known-Gaps.md](wiki/Known-Gaps.md) · [wiki/Troubleshooting.md](wiki/Troubleshooting.md) |
| idiomatic usage, every primitive once | [examples/dummy/](examples/dummy/README.md) |
| a deployed app, warts included | [dummy/social-media-clone/](dummy/social-media-clone/) |
| the machine-readable repo map | [llms.txt](llms.txt) |
| conventions an agent cannot infer | [AGENTS.md](AGENTS.md) · [CLAUDE.md](CLAUDE.md) |
| what changed, and what breaks | [CHANGELOG.md](CHANGELOG.md) |
| the release process | [PUBLISHING.md](PUBLISHING.md) · [docs/architecture/19-cutting-a-major.md](docs/architecture/19-cutting-a-major.md) |

[`CLAUDE.md`](CLAUDE.md) carries the same table for an agent already inside the repo, plus the tier rules and the non-negotiables. This one is the entry point; that one is the working contract.

## The packages

One package, one responsibility. **Imports may only go DOWN a tier** — never sideways, never up; a violation is a build error (`bun run boundaries`). Each carries `README.md` (its public API) beside `CLAUDE.md` (its boundary, deps and commands).

Derived from `bun run scripts/list-workspaces.ts --json` and each package's own `description`. Re-run it rather than trusting this table.

| Tier | Package | Owns |
|---|---|---|
| 0 | [`@ultimat3/core`](packages/core/README.md) | Ultimate's foundation: errors, context, env, config, clock, ids, logging, telemetry, lifecycle |
| 0 | [`@ultimat3/schema`](packages/schema/README.md) | Ultimate's validation seam: Standard Schema interface, the `t` namespace, JSON Schema output |
| 1 | [`@ultimat3/cache`](packages/cache/README.md) | Tagged caching: request memo, LRU, Redis, CDN — one invalidation graph |
| 1 | [`@ultimat3/db`](packages/db/README.md) | Postgres access, transactions, migrations and drift detection |
| 1 | [`@ultimat3/flags`](packages/flags/README.md) | Feature flags: permanent switches, and temporary ones that cannot be forgotten |
| 1 | [`@ultimat3/i18n`](packages/i18n/README.md) | Dependency-free translator, catalog flattening, locale negotiation and loud missing-key rendering |
| 1 | [`@ultimat3/money`](packages/money/README.md) | Integer minor units with an attached currency: arithmetic, allocation, rounding, `Intl` formatting |
| 1 | [`@ultimat3/seo`](packages/seo/README.md) | Enforced SEO: typed meta, JSON-LD, sitemap, robots, feeds, responsive images, perf budgets |
| 1 | [`@ultimat3/storage`](packages/storage/README.md) | Named disks over `Bun.file` and `Bun.s3`: safe keys, signed URLs, sniffed uploads |
| 1 | [`@ultimat3/time`](packages/time/README.md) | UTC instants, DST-correct zone math, cron, durations and `Intl` formatting with an explicit timezone |
| 2 | [`@ultimat3/auth`](packages/auth/README.md) | Sessions, passwords, OAuth, MFA and api keys — resolved to one `Actor` |
| 2 | [`@ultimat3/entity`](packages/entity/README.md) | A table + its domain type + invariants the database also enforces |
| 2 | [`@ultimat3/http`](packages/http/README.md) | Owned request lifecycle over `Bun.serve`: router, ordered pipeline, problem+json errors |
| 2 | [`@ultimat3/policy`](packages/policy/README.md) | The one authz rule, evaluated identically in every surface |
| 3 | [`@ultimat3/action`](packages/action/README.md) | The action primitive: one declaration projected to route, OpenAPI, client, MCP tool, job handle, tests |
| 3 | [`@ultimat3/jobs`](packages/jobs/README.md) | Durable background work: steps, transactional outbox, cron tasks, one driver interface |
| 3 | [`@ultimat3/query`](packages/query/README.md) | The query primitive: a policy-checked read, optionally live, with cursor pagination and an incremental matcher |
| 3 | [`@ultimat3/realtime`](packages/realtime/README.md) | Three-tier realtime: channels, live queries, local-first sync — one protocol, one mutator shape |
| 4 | [`@ultimat3/ai`](packages/ai/README.md) | LLM gateway, versioned prompts, evals as tests, embeddings, hybrid vector search, RAG |
| 4 | [`@ultimat3/mail`](packages/mail/README.md) | Transactional email as data: one template renders HTML and text, sent through a job |
| 4 | [`@ultimat3/manifest`](packages/manifest/README.md) | `x.manifest.json`: deterministic generated facts, contract diff, `AGENTS.md` budget |
| 4 | [`@ultimat3/mcp`](packages/mcp/README.md) | MCP server, dev tools, and the action-to-tool projection — one authz system, two surfaces |
| 4 | [`@ultimat3/pwa`](packages/pwa/README.md) | Generated service worker, web manifest, icons, push and version-skew handling |
| 4 | [`@ultimat3/render`](packages/render/README.md) | The route primitive and the five render modes: `static`, `isr`, `ssr`, `stream`, `spa` |
| 4 | [`@ultimat3/ui`](packages/ui/README.md) | SolidJS design system: semantic design tokens, dark/RTL-ready SCSS modules, a11y primitives. Every component and prop: [`CATALOG.md`](packages/ui/CATALOG.md) |
| 5 | [`@ultimat3/admin`](packages/admin/README.md) | Two dashboards: the `/_x` framework dev panels and the generated, AI-first app admin |
| 5 | [`@ultimat3/cli`](packages/cli/README.md) | The `x` binary: new, dev, build, verify, generate, db, mcp, doctor, deploy |
| 5 | [`@ultimat3/scraping`](packages/scraping/README.md) | Browser automation as a job: `scrape()` returns a `JobHandle` |
| 5 | [`@ultimat3/testing`](packages/testing/README.md) | Test harness: cloned template DBs per worker, frozen clock, sealed network, 6 test types |
| 6 | [`create-ultimate`](packages/create-ultimate/README.md) | `bunx create-ultimate myapp` — scaffold an Ultimate monorepo |

Tier table, executable: [`scripts/lib/tiers.ts`](scripts/lib/tiers.ts). Declared sideways edges, each earning its line — five, `As of 2026-08-23`: `realtime → query`, `cli → admin`, `cli → scraping`, `cli → testing`, `create-ultimate → cli`. → [Package map](docs/architecture/01-package-map.md) · [Boundaries](docs/architecture/02-boundaries.md)

## What is enforced, not documented

A convention that is not a build error does not exist (axiom 3).

| Concern | The default | The enforcement |
|---|---|---|
| **i18n** | flat catalogs, `Intl` for everything numeric | a missing key in a shipped locale fails the gate; misses render loudly as `⟦key⟧` |
| **Dark theme** | semantic tokens, OS-following with an explicit override that wins | a raw hex in a component is a lint failure |
| **Timezones** | store UTC, format with an explicit IANA zone | no formatter has an ambient default; a cron without a `tz` will not compile |
| **Money** | integer minor units + currency, always attached | cross-currency arithmetic is refused; the exponent comes from the ISO table, never `/100` |
| **SEO** | typed metadata, JSON-LD, sitemap from the route table | its own gate step; a `site/` route with no description fails the build |
| **Offline** | `sw.js` generated from the route table | the offline fallback route is required *by the type* |
| **Errors** | `X_SCREAMING_SNAKE` code + cause + an executable `fix:` | a bare `Error` fails the `errors` step, in tests too |
| **Import tiers** | one package, one responsibility | a sideways or upward import fails `boundaries` |
| **Secrets** | `Secret` redacts **by value** — `toString`, `toJSON`, the logger, at any depth | frozen, so a spread cannot unwrap it; `.env.example` generated from the typed env declaration |
| **Generated facts** | `x.manifest.json` and `openapi.json` | stale or drifted fails `manifest` / `contract-diff` |

→ [Conventions in full](docs/architecture/00-conventions.md) · [The error contract](docs/architecture/04-error-contract.md)

## Surfaces and render modes

Render mode is a route-level property, never a global one. `site/` **cannot** import from `app/` — a build error, not a lint warning, so a marketing page can never grow the app's bundle through a shared component.

| Surface | Default mode | JS baseline |
|---|---|---|
| `site/` | `static` / `isr` | **0kb**, enforced |
| `app/` | `stream` | a per-route budget that fails the build when blown |
| `api/` | none | n/a |

→ [Surfaces](docs/idea/06-surfaces.md) · [Rendering and SEO](docs/idea/07-rendering-seo.md) · [Rendering internals](docs/architecture/09-rendering-internals.md)

## Realtime — a ladder, not a cliff

Three tiers, the same mutator shape at every rung. Tiers 1–2 ship; tier 3 is deferred behind the interfaces already here.

| Tier | What | Covers |
|---|---|---|
| 1 · **Channels** | `ctx.publish(topic, msg)` over Bun's native WS pub/sub | presence, cursors, notifications |
| 2 · **Live queries** | declared server-side with a policy, received as a Solid signal | most of what "realtime app" means |
| 3 · **Local-first** *(not shipped)* | optimistic mutators, OPFS SQLite, offline queue, rebase | offline writes that reconcile |

Capacity is measured **on one node** and published with its scope: per-node recovery from a forced restart, not a multi-node result and not a throughput figure. The audited figures live in [`CLAUDE.md`](CLAUDE.md) — [`scripts/bench-claims.ts`](scripts/bench-claims.ts) fails the gate when they disagree with the committed run. Reproduce:

```sh
bun run scripts/bench/restart-bench.ts --clients 10000 --probe-interval-ms 200
```

Committed reports and transcripts: [`scripts/bench/results/`](scripts/bench/results/). → [Realtime design and its limits](docs/idea/03-realtime.md) · [Internals](docs/architecture/07-realtime-internals.md)

## From a PaaS dyno to a cluster

The same app code at every rung. Climbing is a driver swap, an env var and someone else's infrastructure — the primitives, their authz, the manifest, the OpenAPI and the typed client never move.

| Rung | You run | App code change |
|---|---|---|
| 0 | one process on a PaaS, their managed Postgres | **none** |
| 1 | one service per `ROLE`, managed Postgres + a shared cache tier | none, plus config |
| 2 | one box, Compose, all six roles, NATS beside them | none, plus config |
| 3 | Kubernetes, per-role HPAs, logical replication for the change feed | none, plus config |
| 4 | distributed SQL, JetStream R3, metrics and traces end to end | none for the datastore swap — with named incompatibilities |

**This is the design, not a demonstration.** One rung is measured. [`17-scale-ladder.md`](docs/idea/17-scale-ladder.md) states rung by rung what is real and what is intent, and names where the "no app code change" invariant breaks today. Six roles, selected by `ROLE` from one image: `web` `sync` `worker` `scheduler` `migrate` `replicator` ([`packages/core/src/roles.ts`](packages/core/src/roles.ts)).

→ [Scale ladder](docs/idea/17-scale-ladder.md) · [Running it for real](docs/ops/README.md) · [Topology runtime](docs/architecture/13-topology-runtime.md)

## The CLI

```sh
x new / dev / build / test / verify / deploy / doctor
x g resource|action|mutator|backfill|job|route|policy|entity|query|task|island|admin:page|guard
#   generators emit code plus real, typed test files — never a TODO stub
x db gen|migrate|reset|seed|studio|branch|backfill
x jobs | tasks | routes | actions | queries | entities | policy   # introspection, all --json
x errors explain <CODE> | x docs "<question>" | x mcp serve
```

Every command and every error takes `--json`. Nine commands are registered and **planned** — they exit `X_NOT_IMPLEMENTED` with a `fix:` naming the closest shipped command, because "not built yet" and "not a command" are different facts. The shipped set, the planned set and every flag: `bun run x -- help --json`, and [the CLI reference](wiki/CLI-Reference.md).

## How much code you do not write

An agent's scarcest resource is context, and most of it goes on infrastructure that has nothing to do with the product. Measured on [`dummy/social-media-clone`](dummy/social-media-clone/) — the deployed demo, built to find out — with `git ls-files` + `tokei 14.0.0`, `As of 2026-08-20`. Every figure is **code** lines, never `wc -l`: comments are ~21% of this app's raw lines.

| Measured | Figure |
|---|---|
| everything the author owns, 218 files | **9,712** code lines |
| production only, tests excluded | **7,230** |
| a fully-projected endpoint — input schema, output schema, policy, OpenAPI operation, MCP tool, typed client | **~16 code lines**, from 4 actions in [`app/friends/actions.ts`](dummy/social-media-clone/apps/web/app/friends/actions.ts) |
| one action, 51 code lines | **179 lines** of committed generated interface — OpenAPI operation, two JSON Schemas, the manifest row — plus five handles it never declares |

Re-derive it — `node_modules`, `.x/`, `dist/` and `coverage/` are gitignored, so `git ls-files` never enters them:

```sh
# the app, author-owned
git ls-files dummy/social-media-clone \
  | grep -Ev '\.(md|png)$|x\.(manifest|verify)\.json$|openapi\.json$|\.(sql|hash)$|\.snapshot\.json$' \
  | xargs tokei

# all framework source — no tests, no .d.ts, no generated icon glyphs
git ls-files 'packages/*' | grep -E '\.(ts|tsx|scss|css)$' \
  | grep -Ev '\.test\.|\.d\.ts$|packages/ui/src/icons/glyphs/' | xargs tokei
```

The 1,767 generated Lucide glyph files are excluded on purpose — leaving them in inflates the framework side with code nobody wrote.

**Read it as *code you never own, never test and never fix*** — not as "a DIY build would be nine times bigger". It would not be; a DIY build reaches for libraries too. What it measures is how much of the surface is already decided, and where a bug gets fixed when one is found.

**What the number does not say.** Five things, none of them buried:

| Not claimed | Why |
|---|---|
| that the demo passes its own gate | it is **pinned red on 2 steps**, `As of 2026-08-23` — `boundaries` (`X_BOUNDARY_SITE_TO_APP` ×3, the static feed importing the authed post service) and `budgets` (`X_BUDGET_UNMEASURED`, no `.x/build-stats.json` has ever existed there). It was 3: `drift` came off when the migration reconciling its foreign keys landed. [`examples/dummy`](examples/dummy/README.md) is pinned on 4 steps — `typecheck`, `e2e`, `drift`, `budgets`. The pins and their reasons are [`scripts/lib/gated-apps.ts`](scripts/lib/gated-apps.ts); `bun run scripts/reference-app-gate.ts` re-derives them |
| that low lines means high leverage | partly it means **few features**. Roughly half of [`DOMAIN.md`](dummy/social-media-clone/DOMAIN.md) is a plan, not a build: `likes` and `comments` are entities with migrations and no write path |
| that the framework wrote the auth | it did not. 13 non-test files hand-write argon2id parameters, `__Host-` cookie prefixes, session token hashing and a captcha, and **`@ultimat3/auth` is imported nowhere in that app**. `@ultimat3/storage` likewise, despite a media feature. The largest thing the framework could have projected and did not |
| that live messaging works | the one live query is declared, unit-tested and **not wired**: nothing calls `installRealtimeTopics` at boot, and [`apps/web/api/realtime.ts`](dummy/social-media-clone/apps/web/api/realtime.ts) says so in its own header |
| that the typed client is proven | it is projected and unused. There is **no `.client()` call in either tracked app**; the demo's forms post HTML |

**The larger win is not the lines** — it is that a bug is found once, here, where the fix reaches every app at once. The sweeps in [`CHANGELOG.md`](CHANGELOG.md) closed defects of exactly that kind:

| Found once, here | What it would have cost an app |
|---|---|
| every authenticated websocket carried `actor: null`, because Bun runs `websocket.open` inside `server.upgrade()` | every channel subscribe on an authed client denied |
| an unreadable TOTP secret verified against a code that needs no secret | one shared code stream across every broken secret in the table |
| a `delete` bypassed the subscriber's own visibility rule | row ids leaking across tenants on the socket |
| an ISR route with a policy served the first actor's HTML to everybody | one actor's page cached under a bare pathname |
| a limiter shed vanished from `queue_depth` | the autoscaler going quiet exactly when the queue saturated |
| `t.date` resolved a zone-less string against the container's timezone | one wire value meaning two instants on two pods |

## Design axioms

Eight, and they override any instinct that conflicts: **one way to do each thing** · **define once, project everywhere** · **enforced, not documented** · **errors are instructions** · **one command means shippable** · **the static path never pays for the app path** · **deploy anywhere = containers only** · **Ultimate ships mechanism; your app ships convention**.

An app extends the framework by **wrapping**, never by forking, patching or petitioning — the primitives are plain functions returning values, so an app's own `tenantEntity` or `auditedMutator` yields primitives the registry, the manifest, admin and MCP treat identically. There is no plugin API.

→ [The thesis and the axioms in full](docs/idea/00-thesis.md) · [Mechanism, not convention](docs/idea/19-mechanism-not-convention.md) · [Build vs wrap](docs/idea/18-build-vs-wrap.md) · [The locked stack](docs/idea/01-stack.md)

## Roadmap

Twelve milestones, each ending in a working demo app and a green gate. **0–10 are shipped; 11 is open on one thing** — the demo app proven on Compose *and* Kubernetes from a single image, rolling restart invisible. Its artifacts all ship, including a Helm chart written by `x new`; the proof needs real infrastructure and has not been run. The status markers in that table are enforced by the gate's `roadmap` step, so they cannot quietly rot.

→ [The full roadmap](docs/idea/14-roadmap.md) · [The risks, stated plainly](docs/idea/15-risks.md) · [What is deliberately excluded](docs/idea/00-thesis.md)

## Contributing

```sh
bun install
bun run verify
```

Read [CONTRIBUTING.md](CONTRIBUTING.md), then [docs/architecture/00-conventions.md](docs/architecture/00-conventions.md) and [docs/architecture/15-adding-a-feature.md](docs/architecture/15-adding-a-feature.md). The tier boundaries are enforced by `bun run boundaries` — a sideways import fails the build, by design. A breaking change needs a section in [wiki/Upgrading.md](wiki/Upgrading.md) the moment it lands: [docs/architecture/19-cutting-a-major.md](docs/architecture/19-cutting-a-major.md).

## License

MIT © [developerz.ai](https://developerz.ai)
