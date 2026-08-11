# social-media-clone — the stress-test demo

A real social network built on Ultimate, to find out where the framework fails an agent.
Hosted at **`social-media.ultimate.demo.developerz.ai`**. `As of 2026-08-11`.

Not a toy. The point is to build something big enough that every gap shows up, then close the gaps
in the framework rather than working around them in the app.

## Who this is for

**The AI is in charge.** A person with zero experience and a person with twenty should both get a
good result, because the hard calls were made once, by the framework, instead of every time, by
whoever happens to be holding the keyboard. The framework is the thirty-year senior engineer who
already decided; the agent is the one typing. That is the whole product.

Two consequences the rest of this document keeps coming back to:

- **A decision an app author has to make is a decision the framework failed to make.** Boilerplate
  is the visible symptom; the disease is ambiguity.
- **Every project ships its own `scripts/` command surface.** An agent that has to write a
  throwaway script to check a queue, seed a user, or read a log is burning tokens on infrastructure
  the project should already own. Second time something is awkward, it becomes a command.

## The thesis, stated as a number

Two production codebases were measured — both AI-first, both well documented, names withheld. One
is a TypeScript monorepo behind an AI chat product; the other a Rails monolith behind a
finance/treasury product. The ceremony below is not sloppiness. It is what those architectures
*require*.

| Codebase | Feature | Cost to ship it |
|---|---|---|
| AI chat platform (TS monorepo) | one thumbs-up/down button | **11 new files + 5 line-edits** in two god-files (469 LOC and 610 LOC), across 4 workspaces |
| same | an achievements system | **~50 files**; the same entity redeclared 7× before a row moves |
| Finance monolith (Rails) | one CRUD resource + one MCP verb | **18 files + 2 frozen-array registry edits**; a 301-LOC controller, two 240-LOC handlers |
| same | one real domain entity | **81 files** |

Recurring taxes, both stacks: a service-interface file with no implementation; a DI/wiring adapter
whose own comment says "zero domain logic lives here"; a route file that only unwraps and re-wraps;
repo + sink + ports/store interfaces per domain; the same shape declared 3–7× (DB schema, query
type, shared contract, service interface, wiring adapter, route validator, client type);
hand-maintained registry arrays; hand-declared param types the ORM already knows.

The sharpest single number is **how many places one shape is declared**. A thumbs-up rating is
declared **9 times** in the TS monorepo (table, query row, branded id, enum, request schema, service
interface, wiring impl, route re-validation, client type) plus 4 registration edits that carry no
information at all. A finance entity is declared **8+ times** across two API planes. One composition
root in a third codebase is a **4,167-line file with 59 hand-written mount calls**.

**The counter-metric: one `entity()` declaration must project to ≥7 of those sites.** And the demo's
headline claim must be a measured file count for the same features, with **zero registry edits** —
Ultimate has no composition root to edit, because registration *is* the import scan. If a like
button costs more than ~3 files here, the framework has not earned its thesis.

Worth stealing from those codebases rather than only measuring them: **`scripts/lint/<rule>.ts`
guards as institutional memory that executes** (~40 of them, each with its own test, each born from
a real incident), a **per-app subagent fleet** in `.claude/agents/` so hive slices are disjoint by
construction, and **budget tests** that pin the agent's standing context. Ultimate is already ahead
on the capability catalog — what those repos hand-maintain and gate in CI, `x.manifest.json`
generates from the declarations.

## App scope

| Area | What ships |
|---|---|
| Auth | password login, seeded `user/user` and `admin/admin`, sessions, roles |
| Anti-bot | hCaptcha on signup + login, verified server-side, fail-closed |
| Social graph | profiles, friend requests, accept/decline, block |
| Feed | cursor-paginated, ranked, realtime-patched |
| Content | posts, comments, likes, media attachments |
| Realtime | chat (1:1 + group), notifications, presence |
| Uploads | images + video to R2 via signed URLs |
| Cron | digest mail, feed rebuild, orphan-media sweep, demo reset |
| Seeds | fake users, posts, comments, friendships; stock images/video |
| Admin | jobs, uploads, users, DB insights — `admin/admin` is **view-only**, enforced by policy |
| Surfaces | web (site + app), REST + OpenAPI, MCP server |

Build order: **web → mobile → desktop**. Mobile and desktop are roadmap milestones 12–14 and are
*design-only* today (`docs/idea/16-app-targets.md`) — they are a later phase, not this one.

## Framework gaps this build must close

Verdicts measured against the code, not the docs.

| # | Capability | Today | Work |
|---|---|---|---|
| 1 | **`database()` accepts a real entity** | ~~broken~~ **fixed** | `Invariant.holds` was a function-typed property, so contravariance made every `Entity<Row,C>` fail the `EntitySet` constraint; every table degraded to `Table<unknown>`. Now a method. 275 → 239 errors in the reference app |
| 2 | **Typed invariant columns** | broken | `InvariantColumns` is an index-signature type, so `c.title` is `ColumnExpr \| undefined` under `noUncheckedIndexedAccess` — **every generated entity fails typecheck**. Fix: callback form, `invariants: (c) => [...]`. Measured: it is the only shape TS can infer, and it makes a typo a compile error. **Breaking** |
| 3 | Feature flags | MISSING | permanent vs temporary; temporary flags auto-report to Glitchtip so they cannot be silently forgotten |
| 4 | DB insights (pghero-like) | thin | `pg_stat_statements`, index suggestions, bloat. Note the MCP read-only guard currently *denies* the functions such a panel needs |
| 5 | Error monitoring | seam only | `http`'s `onError` hook exists and **nothing ever supplies one**. Needs an `ErrorReporter` in `core`, a Glitchtip/Sentry-envelope transport, and wiring from `serve.ts` — plus jobs and realtime, which have no hook at all |
| 6 | Metrics | partly wired | `recordJob` is declared and never called, so `jobs_total` is always empty; Helm declares no metrics port and ships no `ServiceMonitor`, so HPAs read `<unknown>` |
| 7 | Loading skeletons | EXISTS | `<Skeleton>`, `<Spinner>`, `DataTable.skeletonRows`, streaming SSR by default. Caveat: the pinned `solid-js@2.0.0-experimental.16` does not export `Suspense` from its server build |
| 8 | **Asset pipeline** | MISSING | **zero `Bun.build` calls in the repo.** No client bundling, no code splitting, no minification (except `--target binary`), no chunk hashing. `renderSpaShell` consumes `input.chunks` that nothing produces; byte budgets are checked against a *declared* graph and `.x/build-stats.json` is never written, so the `budgets` gate passes vacuously |
| 9 | PWA service worker | EXISTS, unwired | `generateServiceWorker` is never called by `x build`; no `sw.js` is emitted. Cache namespacing by build id is already correct |
| 10 | Parallel tests | opt-in, unmeasured | `x test --workers` shards (LPT bin-packing, real). But `x verify` bypasses it, scaffolds get `"test": "bun test"`, and `--parallel` measured *slower* (isolate re-runs the preload). No published suite wall-clock |
| 11 | `.claude/` + `.mcp.json` scaffolding | MISSING | `x new` writes `AGENTS.md` + `CLAUDE.md` and nothing else. No agents, no commands, no MCP client config — although the app already *has* an MCP server to point at |
| 12 | `/idea` `/reset` `/feature` | MISSING for apps | four commands exist for framework maintainers; none is scaffolded into an app |
| 13 | SCSS system | EXISTS, strong | 46 components, ~25 mixins, `defineTheme()`, WCAG-tested token pairs. One live defect: scaffolded `shared/tokens.scss` `@use`s six variables that do not exist |
| 14 | hCaptcha | MISSING | verifier + widget + `captcha: true` on an action. A factory over `action`, so the eight-primitive rule holds |
| 15 | File uploads | half | signed URLs, magic-byte sniffing and drivers all exist; **nothing mounts `/_storage`**, there is no client `upload()`, and no UI component |
| 16 | Search | partial | FTS exists only inside `@ultimat3/ai` for RAG; a plain entity gets `LIKE` |
| 17 | Cron | EXISTS | `task()` with a required IANA `tz`, leader election, catch-up policy |

| 18 | **Per-project `scripts/`** | MISSING | An agent should never write a throwaway script. Every scaffolded app gets `scripts/<resource>/<verb>.ts` + a `scripts/help.ts` catalog, so "check the queue", "seed a user", "tail a log" are commands, not improvised code. `bin/setup`, `bin/dev`, `bin/check` already scaffold; the script layer under them does not |
| 19 | **N+1 detection (Bullet-style)** | PARTIAL — counted, never enforced | `packages/admin/src/dev/panel-timeline.ts:25` already counts "same SQL text more than once in one request", fed by `packages/cli/src/dev-traces.ts:92`. That is a *panel row*. Bullet's value is that it **fails**. Work: promote it to an assertion — an N+1 over a declared threshold fails the request in dev, fails a test via a `testing` matcher, and fails `x verify`. Stable code + the exact query + the fix |
| 20 | **Encrypted secrets in the repo (Rails credentials)** | MISSING | Today: `defineEnv` typed env, `.env.development` committed, `.env.development.local` wins locally, and `renderEnvExample()`/`assertEnvExample()` project `.env.example` from the declaration so it can never drift — that half is **good and already better than dotenv**. What is missing is the other half: a committed **encrypted** secrets file plus one master key (`ULTIMATE_MASTER_KEY`, or a gitignored `config/master.key`), so a real secret travels with the repo and there is no "ask a teammate for the keys" step. Wants `x secrets edit` (decrypt → `$EDITOR` → re-encrypt), `x secrets show`, key rotation, and resolution order **env var → encrypted file → `.env.*.local` → `.env.*`**. Deploy stays unchanged: the platform injects one key, not twenty variables |
| 21 | **Production data debugging (`rails console` equivalent)** | EXISTS — outside the framework, unreferenced | Solved by the in-house **DB MCP gateway** (stable, in production, deployed in-cluster): `list_databases`, `describe_schema`, `sample_table`, `run_query`, `explain`, `get_query_history`; read-only by default, writes opt-in per grant, SSO identity end-to-end, synchronous audit, row caps and statement timeouts at both the gateway and the DB. **The credential never reaches the agent.** No framework code needed — the gap is that `x new` does not write a `.mcp.json` pointing at it (gap 11). That is the fix: reference it, do not rebuild it. A `console` command in the framework would be a second, unaudited door |

### One tension, named

Our own engineering standards reject feature flags outright — "N flags = 2^N untested states", use
a tenant config record instead. The goal asks for them anyway. The requested design is what answers
the objection: a **temporary** flag that reports itself to the error monitor until it is deleted
cannot become one of the 2^N forgotten states, and a **permanent** flag is just the config record
the doctrine already allows, under one API. Building it, with the distinction enforced rather than
documented.

## What `x new` must hand the agent — the access matrix

An agent maintaining and extending an app needs **full context and full access**. Safety belongs in
the tool, not in withholding the tool: a capability the agent lacks becomes a worse thing it invents.
Every scaffolded app therefore ships, on day one:

| Need | How it is met | Why not the obvious alternative |
|---|---|---|
| Read the codebase structurally | CodeGraph index + its MCP server | grep answers text questions, not "who calls this" |
| Query production data | the DB MCP gateway — read-only by default, SSO identity, synchronous audit, row caps | a `DATABASE_URL` on a laptop; or a framework `console` command, which would be a second unaudited door |
| See what is actually broken in prod | the error monitor's MCP — errors are a **work queue**, not a dashboard | reading logs by hand |
| Drive its own app | the app's own MCP server, already scaffolded (`ai.mcp.expose`), with **the same policy objects** as HTTP | a second authz path |
| Run anything operational | `scripts/<resource>/<verb>.ts` + `scripts/help.ts` | improvising a throwaway script every session |
| Know the house rules | `CLAUDE.md` + `AGENTS.md` (already scaffolded) + `.claude/agents` + `.claude/commands` | prose nobody loads |
| Ship safely | `x verify` — one command, 17 steps, green means shippable | a checklist |

The `.mcp.json` is committed, secrets referenced as `${VAR}` and never inlined, and every `${VAR}`
lands in `.env.example` in the same commit.

## Architecture

A well-structured monolith. One image, `ROLE` selects `web | sync | worker | scheduler | migrate`.
The eight primitives only — no ninth. New capability arrives as a **factory over an existing
primitive** (`llm()` is the precedent), never as a new kind of thing.

## Deployment

GitOps, pull-based. CI holds no cluster credentials.

| Piece | Value |
|---|---|
| Host | `social-media.ultimate.demo.developerz.ai` |
| Slug / namespace | `ultimate-social` |
| Postgres | `ultimate_social` on the shared CNPG cluster via pgcat |
| Registry | `registry.digitalocean.com/developerz-ai/ultimate-social`, tag `sha-<7>` |
| Rollout | ArgoCD Image Updater, `newest-build`, `allow-tags: regexp:^sha-[0-9a-f]{7}$` |
| Ingress | Traefik `IngressRoute`, `websecure`, cert-manager `letsencrypt-prod` |
| DNS | ClouDNS A record → `15.204.255.75` (worker-1), **created before the cert can issue** |
| Cache | dedicated in-namespace Dragonfly — a public untrusted demo must not share prod's cache |
| Secrets | Bitnami sealed-secrets, sealed offline against the committed cert, strict-scoped to `{ns,name}` |
| Errors | Glitchtip project via `scripts/glitchtip/ensure-projects.ts --apply` |
| Metrics | `ServiceMonitor`; no `release` label needed |

The framework stays platform-agnostic (axiom 7: containers only). Everything above lives in
`docs/ops/` and in the `infrastructure` repo — never in a `@ultimat3/*` package.
