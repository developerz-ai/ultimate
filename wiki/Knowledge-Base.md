# Knowledge base

The retrieval index for agents. Wiki pages are the **content**; this page is the **map**. Where `llms.txt` is a flat link dump and `Home.md` is a reading path by audience, this page answers the question a retrieval query actually asks: *"given what I'm looking for, which page do I retrieve?"*

`As of 2026-08`. A page is registered here the moment it lands in `wiki/`; the gate that maintains this index is `bun run scripts/wiki-index.ts --json`, and a wiki page that exists on disk but is missing from this map fails the `manifest` step until the index is updated.

## How to retrieve

Pages in this repo are retrieved with `code.recall` (the platform's recall tool, given a slug) or by reading the file at the path listed below. `code.recall` returns the body of the page; `Read` returns the same file plus line numbers. The two are interchangeable for retrieval — pick by budget, not by preference.

| You have | You want | Use |
|---|---|---|
| a slug from this page's table | the page body | `code.recall({ slugs: ['<slug>'] })` |
| a topic, not a slug | the slug, then the body | scan the table below, then `code.recall` |
| a file path | the page body | `Read` on the path |

The platform's `code.recall` is the right tool for the agent-internal knowledge base — review notes, decisions, past incident write-ups — that lives outside this repo. The slugs for those pages are listed in [The agent knowledge base](#the-agent-knowledge-base) below.

## By topic

Each wiki page is the canonical answer for exactly one topic. Where a topic lives in two pages (e.g. `Migrations` and `Migrations and backfills`), the more specific page wins and the broader page links to it.

### Framework concepts

| Topic | Page | What it covers |
|---|---|---|
| The eight primitives, canonical shapes | [The eight primitives](The-Eight-Primitives) | `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task` — the whole vocabulary, the rules each follows |
| Wrapping a primitive | [Building your own base](Building-Your-Own-Base) | `tenantEntity`, `auditedMutator`, the two caveats, why nothing downstream notices |
| One mutation, six projections | [Actions](Actions) | every field, the six generated artifacts, the mutator twin, contract tests |
| Tables and invariants | [Entities and migrations](Entities-And-Migrations) | tables, invariants, tenancy, `x db gen`, drift, branch databases |
| Authorization | [Policies and authz](Policies-And-Authz) | `can()`, where a policy is evaluated, denials, tenancy scoping |
| Reads, live or one-shot | [Queries and live queries](Queries-And-Live-Queries) | reads, `live: true`, per-row policy, bounded SQL |
| Background work | [Jobs and workflows](Jobs-And-Workflows) | transactional outbox, durable steps, idempotency, drivers |
| Cron and scheduling | [Scheduled tasks](Scheduled-Tasks) | cron with an explicit tz, leader election, next-run introspection |
| HTTP routes and rendering | [Routes and render modes](Routes-And-Render-Modes) | five render modes, hydration timing, budgets, enforced SEO |

### Capabilities

| Topic | Page | What it covers |
|---|---|---|
| Channels, live queries, sync | [Realtime](Realtime) | channels → live queries → local-first, the pipeline, the reconnect problem |
| Four-tier caching | [Caching and invalidation](Caching-And-Invalidation) | four tiers, one tag graph, one-hop fanout |
| Batching and preloading | [Batching and preloading](Batching-And-Preloading) | JIT preload, `.preload()`, `insertAll`/`upsertAll`/`updateWhere`, `inBatches`, the tenancy guarantee |
| Detecting N+1 | [N+1 detection](N-Plus-One-Detection) | the two codes, `expectedQueryLoop`, four surfaces, why prod pays nothing |
| Service worker and offline | [PWA and offline](PWA-And-Offline) | generated `sw.js`, precache budgets, version skew |
| MCP, llm(), evals | [MCP and AI](MCP-And-AI) | the dev MCP server, every action as a tool, the `llm()` gateway, evals |
| Agent loops and tools | [Agents](Agents) | `agent()` as an action factory, tools as real actions, `hive()`, `agentJob()`, and the at-least-once trap |
| The generated admin app | [Admin dashboard](Admin-Dashboard) | the generated admin app and its MCP surface |
| Browser automation | [Scraping](Scraping) | `scrape()` as a job factory, the driver-blind page vocabulary, robots and host gates, the yield alarm |

### Cross-cutting

| Topic | Page | What it covers |
|---|---|---|
| Translations | [I18n](I18n) | flat catalogs, loud misses, locale routing, `hreflang` |
| Design tokens | [Theming](Theming) | 24 semantic colour roles as RGB channels, every token scale, `defineTheme()`, what contrast is gated |
| UI components | [UI components](UI-Components) | the four page composites, and the generated 52-component catalog |
| Timezones | [Timezones and dates](Timezones-And-Dates) | store UTC, format with an explicit IANA zone, frozen clocks in tests |
| Money | [Money](Money) | `Money = { minor, currency }`, never a float |
| Disposable resources | [Resource management](Resource-Management) | `Disposable` db resources, `using`/`await using`, idempotent release, compile-time pins |
| Database migrations | [Migrations and backfills](Migrations-And-Backfills) | one migration engine and ledger, the destructive-migration rail, `backfill()` as a `job` factory |
| Tests | [Testing](Testing) | six test types, cloned databases, sealed network, `x verify` |

### Reference

| Topic | Page | What it covers |
|---|---|---|
| The `x` CLI | [CLI reference](CLI-Reference) | every `x` command and flag, with `--json` examples |
| Error codes | [Error codes](Error-Codes) | every `X_*` code: meaning, cause, exact fix command |
| Configuration | [Configuration](Configuration) | every `app.config.ts` field and every env var |
| Deploy | [Deployment](Deployment) | one image, six roles, `ROLE`/`PORT`, drain, compose, Helm, targets, `docs/ops/` |
| Metrics and logs | [Observability](Observability) | counters, gauges, histograms, `MetricExporter`, the Prometheus body, `/metrics` on its own port, and what the chart still cannot reach |
| Known gaps | [Known gaps](Known-Gaps) | every defect and unfinished seam in the published release, named |
| Upgrading | [Upgrading](Upgrading) | why the next release is a major, breaking-change detection, version skew — and that `x upgrade` is planned |
| Symptom → fix | [Troubleshooting](Troubleshooting) | symptom → cause → fix |
| Why decisions | [FAQ](FAQ) | why Bun only, why no GraphQL, is it production ready |
| Conventions | [Contributing](Contributing) | package layout, import tiers, conventions, PR expectations |
| Entry point | [Home](Home) | the reading-path index, with one row per audience |
| First run | [Getting started](Getting-Started) | zero to a running app, one action, one green `x verify` |
| Setup | [Installation](Installation) | prerequisites, `x new`, typed env, editor and MCP client setup |
| Layout | [Project layout](Project-Layout) | the generated monorepo, the four surfaces, feature slices, the hard boundaries |
| Migration | [Migrating an existing app](Migrating-An-Existing-App) | strangler fig off Rails/Node/Django, adopting a live schema, identity during cutover, and what does not work yet |
| Tutorial 1 | [1 · First app](Tutorial-01-First-App) | a scaffolded app running on `x dev`, green gate, no Docker |
| Tutorial 2 | [2 · First feature](Tutorial-02-First-Feature) | one `action` projected into five surfaces, with tests |
| Tutorial 3 | [3 · Auth and admin](Tutorial-03-Auth-And-Admin) | roles, policies and a real login flow |
| Tutorial 4 | [4 · Jobs and realtime](Tutorial-04-Jobs-And-Realtime) | a durable job, a cron task, a live query |
| Tutorial 5 | [5 · Deploy free](Tutorial-05-Deploy-Free) | the image running on a free PaaS tier, migrations on release |
| Tutorial 6 | [6 · Growing up](Tutorial-06-Growing-Up) | the rung you should be on, and the signal to climb |

## Every page, by path

Flat list for tools that walk files. The slug is the filename minus `.md`; `_Footer` and `_Sidebar` are partials rendered on every GitHub wiki page and are not retrieved on their own.

| Path | Slug | Topic |
|---|---|---|
| `wiki/Actions.md` | `Actions` | One mutation, six projections |
| `wiki/Admin-Dashboard.md` | `Admin-Dashboard` | The generated admin app |
| `wiki/Agents.md` | `Agents` | Agent loops and tools |
| `wiki/Batching-And-Preloading.md` | `Batching-And-Preloading` | Batching and preloading |
| `wiki/Building-Your-Own-Base.md` | `Building-Your-Own-Base` | Wrapping a primitive |
| `wiki/CLI-Reference.md` | `CLI-Reference` | The `x` CLI |
| `wiki/Caching-And-Invalidation.md` | `Caching-And-Invalidation` | Four-tier caching |
| `wiki/Configuration.md` | `Configuration` | Configuration |
| `wiki/Contributing.md` | `Contributing` | Conventions |
| `wiki/Deployment.md` | `Deployment` | Deploy |
| `wiki/Entities-And-Migrations.md` | `Entities-And-Migrations` | Tables and invariants |
| `wiki/Error-Codes.md` | `Error-Codes` | Error codes |
| `wiki/FAQ.md` | `FAQ` | Why decisions |
| `wiki/Getting-Started.md` | `Getting-Started` | First run |
| `wiki/Home.md` | `Home` | Entry point |
| `wiki/I18n.md` | `I18n` | Translations |
| `wiki/Installation.md` | `Installation` | Setup |
| `wiki/Jobs-And-Workflows.md` | `Jobs-And-Workflows` | Background work |
| `wiki/Known-Gaps.md` | `Known-Gaps` | Known gaps |
| `wiki/MCP-And-AI.md` | `MCP-And-AI` | MCP, llm(), evals |
| `wiki/Migrating-An-Existing-App.md` | `Migrating-An-Existing-App` | Migration |
| `wiki/Migrations-And-Backfills.md` | `Migrations-And-Backfills` | Database migrations |
| `wiki/Money.md` | `Money` | Money |
| `wiki/N-Plus-One-Detection.md` | `N-Plus-One-Detection` | Detecting N+1 |
| `wiki/Observability.md` | `Observability` | Metrics and logs |
| `wiki/PWA-And-Offline.md` | `PWA-And-Offline` | Service worker and offline |
| `wiki/Policies-And-Authz.md` | `Policies-And-Authz` | Authorization |
| `wiki/Project-Layout.md` | `Project-Layout` | Layout |
| `wiki/Queries-And-Live-Queries.md` | `Queries-And-Live-Queries` | Reads, live or one-shot |
| `wiki/Realtime.md` | `Realtime` | Channels, live queries, sync |
| `wiki/Resource-Management.md` | `Resource-Management` | Disposable resources |
| `wiki/Routes-And-Render-Modes.md` | `Routes-And-Render-Modes` | HTTP routes and rendering |
| `wiki/Scheduled-Tasks.md` | `Scheduled-Tasks` | Cron and scheduling |
| `wiki/Scraping.md` | `Scraping` | Browser automation |
| `wiki/Testing.md` | `Testing` | Tests |
| `wiki/The-Eight-Primitives.md` | `The-Eight-Primitives` | The eight primitives, canonical shapes |
| `wiki/Theming.md` | `Theming` | Design tokens |
| `wiki/Timezones-And-Dates.md` | `Timezones-And-Dates` | Timezones |
| `wiki/Troubleshooting.md` | `Troubleshooting` | Symptom → fix |
| `wiki/Tutorial-01-First-App.md` | `Tutorial-01-First-App` | Tutorial 1 |
| `wiki/Tutorial-02-First-Feature.md` | `Tutorial-02-First-Feature` | Tutorial 2 |
| `wiki/Tutorial-03-Auth-And-Admin.md` | `Tutorial-03-Auth-And-Admin` | Tutorial 3 |
| `wiki/Tutorial-04-Jobs-And-Realtime.md` | `Tutorial-04-Jobs-And-Realtime` | Tutorial 4 |
| `wiki/Tutorial-05-Deploy-Free.md` | `Tutorial-05-Deploy-Free` | Tutorial 5 |
| `wiki/Tutorial-06-Growing-Up.md` | `Tutorial-06-Growing-Up` | Tutorial 6 |
| `wiki/UI-Components.md` | `UI-Components` | UI components |
| `wiki/Upgrading.md` | `Upgrading` | Upgrading |

## The agent knowledge base

The platform maintains a separate knowledge base for agent-internal notes — past reviews, decisions, incident write-ups — that live outside this repo. They are retrieved with `code.recall`, given a slug. The slugs below are the ones the index surfaces; a slug not listed is not absent, only unindexed (add it by editing this section).

| Slug | Topic | Notes |
|---|---|---|
| `review-log` | Recent PR merges, open PRs, issue triage, known issues | the first stop when asked "what's open?" or "what shipped lately?" |
| `review/log` | Reverse-chronological review activity | PR → review thread correspondence |
| `review/pr-292-decisions` | Decisions made during PR #292 review | example; replace with the actual PR under review |
| `review/pr-298-decisions` | Decisions made during PR #298 review | example |
| `review/pr-301-decisions` | Decisions made during PR #301 review | example |
| `review/pr-303-decisions` | Decisions made during PR #303 review | example |
| `review/pr-307-decisions` | Decisions made during PR #307 review | example |
| `review/pr-309-decisions` | Decisions made during PR #309 review | example |
| `review/pr-364-decisions` | Decisions made during PR #364 review | example |
| `review/pr-381-decisions` | Decisions made during PR #381 review | example |

A page listed here that an agent has never retrieved is the **never-retrieved** failure mode. The fix is to call `code.recall` on it; the gate `bun run scripts/wiki-index.ts --json` reports a `X_KNOWLEDGE_BASE_UNRETRIEVED` finding for any slug whose last retrieval is older than the page itself.

## Maintenance

Two rules the index is built to enforce. Both run on the `manifest` step of `x verify`.

| Rule | Gate script | Failure code |
|---|---|---|
| every `wiki/*.md` (excluding `_Footer.md` and `_Sidebar.md`) is registered in the **By topic** section above | `scripts/wiki-index.ts` | `X_KNOWLEDGE_BASE_PAGE_MISSING` |
| every slug in the **Every page, by path** table resolves to a real file on disk | `scripts/wiki-index.ts` | `X_KNOWLEDGE_BASE_SLUG_STALE` |

The **The agent knowledge base** table is the place to add a slug. A slug not yet listed can still be retrieved — `code.recall` is the source of truth for what exists — but an unlisted slug is a slug no agent knows to ask for, which is the failure the gate is built to prevent.

The rule that built this page: a page exists in the wiki **and** an agent knows to retrieve it, or the page does not exist for agents. Adding a page to `wiki/` without registering it here is the second-most-frequent defect this index exists to prevent; the most-frequent is registering it without a topic row, which is why the **By topic** table is the section a maintainer reads first.
