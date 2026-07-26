# Ultimate wiki

A full-stack, Bun-only, opinionated framework: Rails' philosophy applied to Bun + Postgres + SolidJS, where the primary user is an AI agent and the secondary user is a tired senior engineer.

**Pre-v1 `As of 2026-07`.** Nothing is published to npm, no API is stable, and no benchmark numbers exist yet. The marketing site is [ultimate.developerz.ai](https://ultimate.developerz.ai/); this wiki is the deeper reference.

```bash
bunx create-ultimate myapp && cd myapp && x dev
```

| If you are | Read, in order |
|---|---|
| Evaluating it | [Getting started](Getting-Started) → [The eight primitives](The-Eight-Primitives) → [FAQ](FAQ) |
| Building an app | [Installation](Installation) → [Project layout](Project-Layout) → [Actions](Actions) → [Testing](Testing) |
| An agent driving the framework | [CLI reference](CLI-Reference) → [Error codes](Error-Codes) → [MCP and AI](MCP-And-AI) |
| Operating it | [Configuration](Configuration) → [Deployment](Deployment) → [Troubleshooting](Troubleshooting) |
| Contributing | [Contributing](Contributing) → [Project layout](Project-Layout) → [Testing](Testing) |

## Start

| Page | What it covers |
|---|---|
| [Getting started](Getting-Started) | zero to a running app, one action, one green `x verify` |
| [Installation](Installation) | prerequisites, `x new`, typed env, editor and MCP client setup |
| [Project layout](Project-Layout) | the generated monorepo, the four surfaces, feature slices, the hard boundaries |

## The primitives

| Page | What it covers |
|---|---|
| [The eight primitives](The-Eight-Primitives) | `entity`, `policy`, `action`, `mutator`, `query`, `job`, `route`, `task` — the whole vocabulary |
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
| [PWA and offline](PWA-And-Offline) | generated `sw.js`, precache budgets, version skew |
| [MCP and AI](MCP-And-AI) | the dev MCP server, every action as a tool, the `llm()` gateway, evals |
| [Admin dashboard](Admin-Dashboard) | the generated admin app and its MCP surface |

## Cross-cutting

| Page | What it covers |
|---|---|
| [I18n](I18n) | flat catalogs, loud misses, locale routing, `hreflang` |
| [Theming](Theming) | semantic tokens as RGB channels, light + dark, no raw hex anywhere |
| [Timezones and dates](Timezones-And-Dates) | store UTC, format with an explicit IANA zone, frozen clocks in tests |
| [Money](Money) | `Money = { minor, currency }`, never a float |
| [Testing](Testing) | six test types, cloned databases, sealed network, `x verify` |

## Reference

| Page | What it covers |
|---|---|
| [CLI reference](CLI-Reference) | every `x` command and flag, with `--json` examples |
| [Error codes](Error-Codes) | every `X_*` code: meaning, cause, exact fix |
| [Configuration](Configuration) | every `app.config.ts` field and every env var |
| [Deployment](Deployment) | one image, six roles, drain, compose, Helm, targets |
| [Upgrading](Upgrading) | `x upgrade`, breaking-change detection, version skew |
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

Source docs live in the repo: [the idea](https://github.com/developerz-ai/ultimate/tree/main/docs/idea) (why) and [the architecture](https://github.com/developerz-ai/ultimate/tree/main/docs/architecture) (how). The machine-readable map for agents is [llms.txt](https://github.com/developerz-ai/ultimate/blob/main/llms.txt).
