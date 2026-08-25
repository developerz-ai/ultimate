# Ultimate wiki

A full-stack, Bun-only, opinionated framework: Rails' philosophy applied to Bun + Postgres + SolidJS, where the primary developer is an AI agent and the secondary developer is a tired senior engineer working through their own AI agent and AI reviewer.

**`As of 2026-08-23`.** 30 `@ultimat3/*` packages plus the unscoped `create-ultimate` — 31 in all — versioned in lockstep. **Every major so far has been a correctness sweep and none has shipped a codemod**, so each `BREAKING —` entry names its own manual edit ([Upgrading](Upgrading), one section per major, newest first). This page states no per-major counts: they are read from each major's own `CHANGELOG.md` section by `bun run changelog-check`, and a count hand-copied here goes stale on the next release. The **[footer](_Footer)** is the only page that stamps a version — one release bumps one line, and a stamp on a second page is 46 hand-copies of one fact.

## Is it for a project this size

**Yes at both ends, and that is the design.** A homework assignment or a weekend idea gets a running app in four commands with nothing to install and nothing to choose; a very large product gets the scale ladder, the tier boundaries and the same 19-step gate the beginner's app already ran. One framework, no lite mode — [axiom 1](#the-rules-everything-else-follows) forbids the second path a lite mode would be.

The measured version of that claim, with the command behind every number: [`docs/idea/21-the-range.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/21-the-range.md).

**Repository and registry agree, and there are no publication holes** `As of 2026-08-20`. `bunx create-ultimate myapp` installs whatever `latest` is; all 31 workspaces resolve at that one version, each published by [`release.yml`](https://github.com/developerz-ai/ultimate/blob/main/.github/workflows/release.yml) over OIDC with a provenance attestation, and [`registry-audit.yml`](https://github.com/developerz-ai/ultimate/blob/main/.github/workflows/registry-audit.yml) files an issue on the day that stops being true. Resolve it rather than believing this sentence:

| Fact | Read it yourself |
|---|---|
| what `latest` is | `npm view @ultimat3/core version` |
| that a tarball is attested | `npm view @ultimat3/core dist.attestations` |
| who published it | `npm view @ultimat3/core _npmUser` |

**A row that says "fixed in <version>" means fixed in a release you can install**; the "on 1.2.0, do X" column beside such a row is for readers still pinned to 1.x, not a current workaround. **No publication holes** — `@ultimat3/scraping` was the last never-published package, bootstrapped by hand at 2.0.0, so `bun add @ultimat3/scraping` resolves and browser automation no longer needs a checkout. **Every release from 3.0.0 on went out through the workflow**, each tarball attested; 2.0.0 went out by hand and is the one release whose tarballs carry no attestation at all, and 1.0.0 was the manual bootstrap. Milestones 0–10 are ✅; milestone 11 is 🚧, still open on the two-platform deploy proof — 1.1.0 gave a scaffolded app a real deployable artifact, which is progress toward it, not the proof.

The realtime restart numbers are **measured and committed**, in two halves that answer different questions ([`scripts/bench/results/`](https://github.com/developerz-ai/ultimate/tree/main/scripts/bench/results)). **Reachability:** 50,000 real WebSocket clients against a **single** `sync` node over `InProcessTransport`, `SIGKILL`ed with no drain — all 50,000 reconnected, 49,981 received a channel patch inside the window, p50 **54.0s** / p90 **105.5s** / max **145.7s**, and 156,851 connect attempts shed by the `AcceptBudget` before any query path. That times the first patch on the reconnected socket and nothing after it; it was published as "time-to-consistent" until 2026-08 and could not see a lost patch, so the name changed and the timings did not. **Delivery:** 10,000 clients, same forced restart, a probe every 200ms — **1,666,882 channel patches received, 0 observed sequence gaps**, `As of 2026-08` the only run with delivery accounting. That counts holes between frames a connection actually received, so it is a lower bound: no client observed a lost frame, which is not the same claim as none was lost. Both are **per-node recovery**: neither crossed NATS, so neither is a multi-node result and neither is a throughput figure → [Realtime](Realtime). This wiki is the only public documentation surface; there is no separate site.

Those facts are repeated on several pages because the wiki is plain markdown with no build step. Change them at the source first, then here: [`docs/idea/14-roadmap.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/14-roadmap.md) owns milestone status, [`CHANGELOG.md`](https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md) owns the version, `scripts/bench/results/` owns the benchmark, and `VERIFY_STEP_NAMES` in [`packages/cli/src/verify-step.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/verify-step.ts) owns the `x verify` step list.

```bash
bunx create-ultimate myapp && cd myapp && bin/setup && x dev
```

`bin/setup` is the scaffold's own script — `bun install`, `x db gen "initial"`, `x db migrate`, `x db seed`, idempotent. **`x dev` straight after `cd` does not work**: `x new` installs nothing, so the app has no `node_modules` and no `x` of its own, and the boot stops on `X_BUILD_FAILED` naming `bun install`. Measured `As of 2026-08-23`; this page said otherwise until then → [Getting started](Getting-Started).

| If you are | Read, in order |
|---|---|
| Evaluating it | [Getting started](Getting-Started) → [The eight primitives](The-Eight-Primitives) → [FAQ](FAQ) |
| Moving a production app off another stack | [Migrating an existing app](Migrating-An-Existing-App) → [Known gaps](Known-Gaps) → [Entities and migrations](Entities-And-Migrations) |
| Building an app | [Installation](Installation) → [Project layout](Project-Layout) → [Actions](Actions) → [Testing](Testing) |
| An agent driving the framework | [CLI reference](CLI-Reference) → [Error codes](Error-Codes) → [MCP and AI](MCP-And-AI) → [Agents](Agents) |
| Operating it | [Configuration](Configuration) → [Deployment](Deployment) → [Observability](Observability) → [Troubleshooting](Troubleshooting) |
| Deciding whether to trust it | [Known gaps](Known-Gaps) → [FAQ](FAQ) → [Upgrading](Upgrading) |
| Contributing | [Contributing](Contributing) → [Project layout](Project-Layout) → [Testing](Testing) |

## Start

| Page | What it covers |
|---|---|
| [Getting started](Getting-Started) | zero to a running app, one action, one green `x verify` |
| [Installation](Installation) | prerequisites, `x new`, typed env, editor and MCP client setup |
| [Project layout](Project-Layout) | the generated monorepo, the four surfaces, feature slices, the hard boundaries |
| [Migrating an existing app](Migrating-An-Existing-App) | strangler fig off Rails/Node/Django, adopting a live schema, identity during cutover, and what does not work yet |

## Tutorials

Follow in order. Each page states what it was executed against in its own first line — tutorial 1 is re-measured on `main`, the rest against published 1.1.0 packages — and names the gaps it hits with the workaround.

| Page | You end with |
|---|---|
| [1 · First app](Tutorial-01-First-App) | a scaffolded app running on `x dev`, green gate, no Docker |
| [2 · First feature](Tutorial-02-First-Feature) | one `action` projected into five surfaces, with tests |
| [3 · Auth and admin](Tutorial-03-Auth-And-Admin) | roles, policies and a real login flow |
| [4 · Jobs and realtime](Tutorial-04-Jobs-And-Realtime) | a durable job, a cron task, a live query |
| [5 · Deploy free](Tutorial-05-Deploy-Free) | the image running on a free PaaS tier, migrations on release |
| [6 · Growing up](Tutorial-06-Growing-Up) | the rung you should be on, and the signal to climb |

## The primitives

| Page | What it covers |
|---|---|
| [The eight primitives](The-Eight-Primitives) | `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task` — the whole vocabulary |
| [Building your own base](Building-Your-Own-Base) | wrap a primitive in your own factory: `tenantEntity`, `auditedMutator`, the two caveats, and why nothing downstream notices |
| [Actions](Actions) | every field, the six generated artifacts, the mutator twin, contract tests |
| [Entities and migrations](Entities-And-Migrations) | tables, invariants, tenancy, `x db gen`, drift, branch databases |
| [Policies and authz](Policies-And-Authz) | `can()`, where a policy is evaluated, denials, tenancy scoping |
| [Queries and live queries](Queries-And-Live-Queries) | reads, `live: true`, per-row policy, bounded SQL |
| [Jobs and workflows](Jobs-And-Workflows) | transactional outbox, durable steps, idempotency, drivers |
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
| [MCP and AI](MCP-And-AI) | the dev MCP server, every action as a tool, the `llm()` gateway, evals |
| [Agents](Agents) | `agent()` as an action factory, tools as real actions, `hive()`, `agentJob()`, and the at-least-once trap |
| [Admin dashboard](Admin-Dashboard) | the generated admin app and its MCP surface |
| [Scraping](Scraping) | `scrape()` as a job factory, the driver-blind page vocabulary, robots and host gates, the yield alarm |

## Cross-cutting

| Page | What it covers |
|---|---|
| [I18n](I18n) | flat catalogs, loud misses, locale routing, `hreflang` |
| [Theming](Theming) | 24 semantic colour roles as RGB channels, every token scale, `defineTheme()`, what contrast is gated |
| [UI components](UI-Components) | the four page composites, and the generated 52-component catalog |
| [Timezones and dates](Timezones-And-Dates) | store UTC, format with an explicit IANA zone, frozen clocks in tests |
| [Money](Money) | `Money = { minor, currency }`, never a float |
| [Resource management](Resource-Management) | `Disposable` db resources, `using`/`await using`, idempotent release, compile-time pins |
| [Migrations and backfills](Migrations-And-Backfills) | one migration engine and ledger, the destructive-migration rail, `backfill()` as a `job` factory |
| [Testing](Testing) | six test types, cloned databases, sealed network, `x verify` |

## Capabilities with no page here yet

Three shipped packages have no reference page on this wiki `As of 2026-08-23` — named rather than left to be discovered, because a capability nobody can find is a capability nobody uses. Their public API is in the package's own `README.md`, and every error they raise is in [Error codes](Error-Codes).

| Capability | Package | Read | Where it is mentioned here |
|---|---|---|---|
| Feature flags — permanent switches, and temporary ones that cannot be forgotten | `@ultimat3/flags` | [`packages/flags/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/flags/README.md) | [FAQ](FAQ), [Upgrading](Upgrading) |
| Named disks, safe keys, signed URLs, sniffed uploads | `@ultimat3/storage` | [`packages/storage/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/storage/README.md) · [`docs/architecture/17-uploads.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/architecture/17-uploads.md) | [Known gaps](Known-Gaps), [6 · Growing up](Tutorial-06-Growing-Up) |
| Transactional email as data — one template renders HTML and text, sent through a job | `@ultimat3/mail` | [`packages/mail/README.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/mail/README.md) | [The eight primitives](The-Eight-Primitives), [6 · Growing up](Tutorial-06-Growing-Up) |

## Reference

| Page | What it covers |
|---|---|
| [CLI reference](CLI-Reference) | every `x` command and flag, with `--json` examples |
| [Error codes](Error-Codes) | every `X_*` code: meaning, cause, exact fix |
| [Configuration](Configuration) | every `app.config.ts` field and every env var |
| [Deployment](Deployment) | one image, six roles, `ROLE`/`PORT`, drain, compose, Helm, targets, `docs/ops/` |
| [Observability](Observability) | counters, gauges, histograms, `MetricExporter`, the Prometheus body, `/metrics` on its own port, and what the chart still cannot reach |
| [Known gaps](Known-Gaps) | every defect and unfinished seam in the published release, named |
| [Upgrading](Upgrading) | why the next release is a major, breaking-change detection, version skew — and that `x upgrade` is planned |
| [Troubleshooting](Troubleshooting) | symptom → cause → fix |
| [FAQ](FAQ) | why Bun only, why no GraphQL, is it production ready |
| [Contributing](Contributing) | package layout, import tiers, conventions, PR expectations |

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

## Source docs in the repo

| Where | What it is |
|---|---|
| [`docs/idea/`](https://github.com/developerz-ai/ultimate/tree/main/docs/idea) | **why** — the design spec |
| [`docs/architecture/`](https://github.com/developerz-ai/ultimate/tree/main/docs/architecture) | **how** — the internals |
| [`docs/ops/`](https://github.com/developerz-ai/ultimate/tree/main/docs/ops) | running an app for real: the PaaS → Compose → Kubernetes ladder, secrets, observability, datastore sizing, disaster recovery, runbooks. **Recommendations only** — the framework depends on none of it |
| [`docs/idea/16-app-targets.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/16-app-targets.md) | three targets, one backend, two view layers — **design only, not shipped behaviour** |
| [`docs/idea/17-scale-ladder.md`](https://github.com/developerz-ai/ultimate/blob/main/docs/idea/17-scale-ladder.md) | why the app code is identical at rung 0 and rung 4 — **shipped, not design only**: 24 of its 26 seam rows are marked shipped, rungs 0–2 are real, and the places the invariant breaks today are named |
| [`packages/ui/CATALOG.md`](https://github.com/developerz-ai/ultimate/blob/main/packages/ui/CATALOG.md) | all 52 components with every prop, generated from source and drift-tested |
| [`framework.manifest.json`](https://github.com/developerz-ai/ultimate/blob/main/framework.manifest.json) | every package, tier, and `X_*` code with its owner — generated |
| [llms.txt](https://github.com/developerz-ai/ultimate/blob/main/llms.txt) | the machine-readable repo map for agents |
