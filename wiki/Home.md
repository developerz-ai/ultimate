# Ultimate wiki

**The full-stack framework where the primary developer is an AI agent.** Rails' philosophy on Bun + Postgres + SolidJS: everything is one of [eight primitives](The-Eight-Primitives), and one `action` declaration projects into an HTTP route, an OpenAPI operation, a typed client, a job handle, an MCP tool and a test, all behind one `policy`. `x verify` is the contract: green means shippable.

```bash
bunx create-ultimate myapp && cd myapp && bun run setup && bun run dev
```

No Docker and no service: embedded Postgres, in-process NATS, local storage, a seeded database and a dev dashboard at `/_x`. `bun run setup` is not optional: `x new` installs nothing, so `x dev` straight after `cd` stops on `X_BUILD_FAILED` naming `bun install` → [Getting started](Getting-Started) · [Bare VM](Bare-VM).

**Look first: [the live demo](https://social-media.ultimate.demo.developerz.ai)**, a social network deployed from `main` on every green push. Fabricated data, every row decided by a policy. Source: [`dummy/social-media-clone/`](https://github.com/developerz-ai/ultimate/tree/main/dummy/social-media-clone).

## Why pick it, and when not to

| Pick it when | Do not pick it when |
|---|---|
| an agent writes most of your code: one way per task, `--json` everywhere, every error a code, a cause and a `fix:` command | you need Node.js or Deno: Bun only |
| you want authz written once: one `policy` guards HTTP, live queries, jobs, MCP and admin | your database is not Postgres, or your UI is not SolidJS |
| you want jobs, realtime, auth, mail, storage, i18n, SEO, admin and MCP decided and gated | you deploy to Vercel functions, Lambda or Workers: containers only |
| the app may grow: the same code from one PaaS process to Kubernetes | you want a plugin API (an app wraps a primitive instead), or multi-node realtime proven today ([Known gaps](Known-Gaps)) |

## Is it for a project this size

**Yes at both ends, and that is the design.** A homework assignment or a weekend idea gets a running app in four commands with nothing to install and nothing to choose; a very large product gets the scale ladder, the tier boundaries and the same 21-step gate the beginner's app already ran — the list is `VERIFY_STEP_NAMES` in [`packages/cli/src/verify-step.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/verify-step.ts), whole or not at all. One framework, no lite mode — [axiom 1](#the-rules-everything-else-follows) forbids the second path a lite mode would be.

The measured version of that claim, with the command behind every number: [`docs/idea/21-the-range.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/21-the-range.md).

**Proof, each with a command:** what npm serves is `npm view @ultimat3/core version`; that every package is published and attested, `bun run scripts/registry-audit.ts --json` in the repository; the rolling-restart proof is `ci.yml`'s `deploy-proof` job; realtime recovery on one node is measured in [`scripts/bench/results/`](https://github.com/developerz-ai/ultimate/tree/main/scripts/bench/results) → [Realtime](Realtime). How each release was published, attestations included: [`PUBLISHING.md`](https://github.com/developerz-ai/ultimate/blob/main/PUBLISHING.md#publication-history). This wiki is the only public documentation surface.

Those facts are repeated on several pages because the wiki is plain markdown with no build step. Change them at the source first, then here: [`docs/idea/14-roadmap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md) owns milestone status, [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) owns the version, `scripts/bench/results/` owns the benchmark, and `VERIFY_STEP_NAMES` in [`packages/cli/src/verify-step.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/verify-step.ts) owns the `x verify` step list.

| If you are | Read, in order |
|---|---|
| Evaluating it | [Getting started](Getting-Started) → [Bare VM](Bare-VM) → [The eight primitives](The-Eight-Primitives) → [FAQ](FAQ) |
| Moving a production app off another stack | [Migrating an existing app](Migrating-An-Existing-App) → [Known gaps](Known-Gaps) → [Entities and migrations](Entities-And-Migrations) |
| Building an app | [Installation](Installation) → [Project layout](Project-Layout) → [Actions](Actions) → [Testing](Testing) |
| An agent driving the framework | `x docs "<question>"` first, offline from the install → [CLI reference](CLI-Reference) → [Error codes](Error-Codes) → [MCP and AI](MCP-And-AI) → [Agents](Agents) |
| Operating it | [Configuration](Configuration) → [Deployment](Deployment) → [Observability](Observability) → [Troubleshooting](Troubleshooting) |
| Deciding whether to trust it | [Known gaps](Known-Gaps) → [FAQ](FAQ) → [Stability](Stability) → [Upgrading](Upgrading) |
| Contributing | [Contributing](Contributing) → [Project layout](Project-Layout) → [Testing](Testing) |

## Start

| Page | What it covers |
|---|---|
| [Getting started](Getting-Started) | zero to a running app, one action, one green `x verify` |
| [Installation](Installation) | prerequisites, `x new`, typed env, editor and MCP client setup |
| [Bare VM](Bare-VM) | the four commands a fresh Ubuntu box with bun and git runs, and why no Docker and no service is needed |
| [Project layout](Project-Layout) | the generated monorepo, the four surfaces, feature slices, the hard boundaries |
| [Migrating an existing app](Migrating-An-Existing-App) | strangler fig off Rails/Node/Django, adopting a live schema, identity during cutover, and what does not work yet |
| [Compared](Compared) | each stack this gets compared to: when to pick it instead, what you give up here, and the measured figures with the commands that reproduce them |
| [Shapes](Shapes) | `x new --shape api`, `blog` and `dashboard`: what each writes and what it leaves out |

## Tutorials

Follow in order. Each page states what it was executed against in its own first line — tutorial 1 its own measurement. `As of 2026-11-03`, 2–4 were re-run by hand, whole, in the app tutorial 1 leaves, and 5 with Docker up to the point a real host is needed. `scripts/tutorial-run.ts` (workflow `tutorial-run.yml`, on `main`) runs 1–4 in order and never 5; it has not yet run green. A workaround for a gap fixed since has been removed rather than left to mislead.

| Page | You end with |
|---|---|
| [1 · First app](Tutorial-01-First-App) | a scaffolded app running on `x dev`, green gate, no Docker |
| [2 · First feature](Tutorial-02-First-Feature) | one `action` projected into five surfaces, with tests |
| [3 · Auth and admin](Tutorial-03-Auth-And-Admin) | roles, policies, a real login flow, and the admin's detail pages, actions and batches |
| [4 · Jobs and realtime](Tutorial-04-Jobs-And-Realtime) | a durable job, a cron task, a live query |
| [5 · Deploy free](Tutorial-05-Deploy-Free) | the image running on a free PaaS tier, migrations on release |
| [6 · Growing up](Tutorial-06-Growing-Up) | the rung you should be on, and the signal to climb |

## The primitives

| Page | What it covers |
|---|---|
| [The eight primitives](The-Eight-Primitives) | `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task` — the whole vocabulary |
| [Building your own base](Building-Your-Own-Base) | wrap a primitive in your own factory: `tenantEntity`, `auditedMutator`, the two caveats, and why nothing downstream notices |
| [Actions](Actions) | every field, the six generated artifacts, the mutator twin, contract tests |
| [Entities and migrations](Entities-And-Migrations) | tables, invariants, tenancy, the typed-handle repo, `.sealed()` columns, `x db gen`, the schema dump, drift, branch databases |
| [Policies and authz](Policies-And-Authz) | `can()`, where a policy is evaluated, denials, tenancy scoping |
| [Queries and live queries](Queries-And-Live-Queries) | reads, `live: true`, per-row policy, bounded SQL |
| [Jobs and workflows](Jobs-And-Workflows) | transactional outbox, durable steps, idempotency, keyed concurrency, `onSettled`, operating a queue, `webhook()`, drivers |
| [Scheduled tasks](Scheduled-Tasks) | cron with an explicit tz, leader election, next-run introspection |
| [Routes and render modes](Routes-And-Render-Modes) | five render modes, hydration timing, budgets, enforced SEO |

## Capabilities

| Page | What it covers |
|---|---|
| [Realtime](Realtime) | channels → live queries → local-first, the pipeline, the reconnect problem |
| [Caching and invalidation](Caching-And-Invalidation) | four tiers, one tag graph, one-hop fanout |
| [Batching and preloading](Batching-And-Preloading) | JIT preload, `.preload()`, `insertAll`/`upsertAll`/`updateWhere`, `inBatches`, the tenancy guarantee |
| [N+1 detection](N-Plus-One-Detection) | the two codes, `expectedQueryLoop`, four surfaces, why prod pays nothing |
| [PWA and offline](PWA-And-Offline) | generated `sw.js`, precache budgets, version skew |
| [Client data](Client-Data) | the one browser transport (`browserClient`, `useQuery`), the record store, and the gate that refuses a raw `fetch(` |
| [Client navigation](Client-Navigation) | soft navigation over server-rendered pages: one config line per surface, swap, prefetch, history, focus |
| [MCP and AI](MCP-And-AI) | the dev MCP server, every action as a tool, the `llm()` gateway, evals |
| [Agents](Agents) | `agent()` as an action factory, tools as real actions, `hive()`, `agentJob()`, and the at-least-once trap |
| [Admin dashboard](Admin-Dashboard) | `defineAdmin()` serving list, detail and form per entity with no host code; filters, scopes, sections, related rows, actions with `when` and `batch`, the audit log, the jobs dashboard; zero JavaScript; its MCP surface |
| [Scraping](Scraping) | `scrape()` as a job factory, the driver-blind page vocabulary, robots and host gates, per-run egress, a rented CDP browser, usage, sealed sessions, mid-run prompts |
| [Auth](Auth) | sessions, OAuth, MFA, API keys and service tokens — the output is an `Actor` |
| [Mail](Mail) | one template renders HTML and text, every string a key, sending is a job |
| [Notify](Notify) | `notifier()` as a job factory: fan-out, preference gate, digest window, ledger, inbox |
| [Storage and uploads](Storage-And-Uploads) | named disks, safe keys, the three-call signed upload, upload scanning, orphans |
| [Feature flags](Feature-Flags) | permanent switches and temporary ones that cannot be forgotten |
| [SEO](SEO) | enforced meta, typed JSON-LD, sitemaps, fail-closed robots, feeds, responsive images |

## Cross-cutting

| Page | What it covers |
|---|---|
| [I18n](I18n) | flat catalogs, loud misses, locale routing, `hreflang` |
| [Theming](Theming) | 24 semantic colour roles as RGB channels, every token scale, breakpoint and layout mixins, `defineTheme()`, what contrast is gated |
| [Interface rules](Interface-Rules) | how a screen must behave, and which of the app's `guards/` refuses each rule |
| [UI components](UI-Components) | the four page composites, and the generated catalog of 99 source-derived UI components |
| [Timezones and dates](Timezones-And-Dates) | store UTC, format with an explicit IANA zone, frozen clocks in tests |
| [Money](Money) | `Money = { minor, currency }`, never a float |
| [Outbound HTTP](Outbound-HTTP) | `outbound()`: one vendor call with a whole-call deadline, the caller's signal, safe-only retry, idle and byte bounds, `dial: 'public'` pinning, and `breaker()` |
| [Resource management](Resource-Management) | `Disposable` db resources, `using`/`await using`, idempotent release, compile-time pins |
| [Migrations and backfills](Migrations-And-Backfills) | one migration engine and ledger, concurrent index builds and drops outside a transaction, the destructive-migration rail, `backfill()` as a `job` factory |
| [Testing](Testing) | six test types, cloned databases, sealed network, the coverage floor, silent runs, `x verify` |

## Reference

| Page | What it covers |
|---|---|
| [CLI reference](CLI-Reference) | every `x` command and flag, with `--json` examples |
| [Error codes](Error-Codes) | every `X_*` code: meaning, cause, exact fix |
| [Configuration](Configuration) | every `app.config.ts` field and every env var |
| [Adapters](Adapters) | every swappable backend — one `runtime.ts` field each: the interface, the reference to copy, the conformance suite, the default |
| [Deployment](Deployment) | one image, six roles, `ROLE`/`PORT`, drain, compose, Helm, targets, the prebuilt island store, `docs/ops/` |
| [Deploy recipes](Deploy-Recipes) | per host — Compose, the chart, Fly.io, Render, Railway, Heroku, bare VM — the build source, port, health path, release command and services, each marked executed or not |
| [Observability](Observability) | counters, gauges, histograms, process and pool gauges, `MetricExporter`, the Prometheus body, `/metrics` on its own port, and what the chart still cannot reach |
| [Known gaps](Known-Gaps) | every defect and unfinished seam in the published release, named |
| [Upgrading](Upgrading) | one section per major with every manual edit, the newest first, each as a checklist, version skew — and how `x upgrade` walks them, one major per run |
| [Stability](Stability) | what semver covers and what it does not, one major per 90 days from v30, the support window, deprecation, the security exception |
| [Troubleshooting](Troubleshooting) | symptom → cause → fix |
| [FAQ](FAQ) | why Bun only, why no GraphQL, is it production ready |
| [Contributing](Contributing) | a pointer: `CONTRIBUTING.md` is the one contributor guide |

## The rules everything else follows

| Axiom | Consequence |
|---|---|
| One way to do each thing | no adapter zoo, no `mode:` escape hatches. Removing an alternative is a feature |
| Define once, project everywhere | one `action` → HTTP route + OpenAPI + typed client + job handle + MCP tool + tests |
| Enforced, not documented | a convention that isn't a build error doesn't exist |
| Errors are instructions | stable `X_*` code + cause + exact fix command + `--json` |
| One command means shippable | `x verify` green = deployable |
| The static path never pays for the app path | `site/` cannot import `app/`; 0kb JS is structural |
| Deploy anywhere = containers only | zero platform primitives |
| Ultimate ships mechanism; your app ships convention | mechanisms and structural conventions ship; business conventions never do. Tenancy ships, an org model does not — primitives are functions returning values, so an app wraps one → [Building your own base](Building-Your-Own-Base) |
| Useful, then efficient | working function first, bytes second. A budget is a measurement, not a ceiling to game: raise it by the measured amount, with the reason, rather than cut a feature. The static path still pays nothing for the app path |

## Source docs in the repo

| Where | What it is |
|---|---|
| [`docs/idea/`](https://github.com/developerz-ai/ultimate/tree/main/docs/idea) | **why** — the design spec |
| [`docs/architecture/`](https://github.com/developerz-ai/ultimate/tree/main/docs/architecture) | **how** — the internals |
| [`docs/ops/`](https://github.com/developerz-ai/ultimate/tree/main/docs/ops) | running an app for real: the PaaS → Compose → Kubernetes ladder, secrets, observability, datastore sizing, disaster recovery, runbooks. **Recommendations only** — the framework depends on none of it |
| [`docs/idea/16-app-targets.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/16-app-targets.md) | three targets, one backend, two view layers — **design only, not shipped behaviour** |
| [`docs/idea/17-scale-ladder.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/17-scale-ladder.md) | why the app code is identical at rung 0 and rung 4 — **shipped, not design only**: all 26 seam rows are marked shipped, rungs 0–2 are real, and the places the invariant breaks today are named |
| [`packages/ui/CATALOG.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/ui/CATALOG.md) | the full catalog of 99 source-derived UI components with every prop, generated from source and drift-tested |
| [`framework.manifest.json`](https://github.com/developerz-ai/ultimate/blob/main/framework.manifest.json) | every package, tier, and `X_*` code with its owner — generated |
| [llms.txt](https://github.com/developerz-ai/ultimate/blob/main/llms.txt) | the machine-readable repo map for agents |
