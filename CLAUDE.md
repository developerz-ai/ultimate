# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Ultimate

A full-stack, **Bun-only**, opinionated web framework. Rails' philosophy on a Bun + Postgres + SolidJS stack, where **the primary user is an AI agent** and the secondary user is a tired senior engineer working through their own AI agent and AI reviewer.

Rails' actual promise, applied to agents: **reduce the number of problems the author has to worry about**, so the work goes into the app's features instead of the app's infrastructure. Every decision the framework makes is a decision an agent does not have to.

This repo is the framework itself: a monorepo of `@ultimat3/*` packages, the `x` CLI, the docs, the public site, and two reference apps.

CLI binary: `x`. npm scope: `@ultimat3`. Import paths: `@ultimat3/<pkg>`.

**Status:** 1.2.0, `As of 2026-08`. 28 `@ultimat3/*` packages plus the unscoped `create-ultimate` —
29 in all — on npm in lockstep: one version, one commit, one tag. 1.1.0 was the first
release published by [`.github/workflows/release.yml`](.github/workflows/release.yml) over OIDC
trusted publishing, no `NPM_TOKEN`, provenance attached; 1.0.0 was the manual bootstrap. Semver
applies — a breaking change to a documented API needs a major, and the eight primitive shapes, the
`x` CLI surface and the tier table are as stable as the `X_*` codes already were.

Realtime capacity is **measured once, on one node**: 50,000 real WebSocket clients against a single
`sync` node over `InProcessTransport`, `SIGKILL`ed with no drain. All 50,000 reconnected; **49,981**
received a channel patch inside the window. Time-to-consistent p50 54.0s / p90 105.5s / max 145.7s;
156,851 connect attempts shed by the `AcceptBudget` before any query or snapshot path. Per-node
recovery — the run never crossed NATS, so it is **not** a multi-node result and not a throughput
figure. [`scripts/bench/restart-bench.ts`](scripts/bench/restart-bench.ts), result committed under
[`scripts/bench/results/`](scripts/bench/results/).

Open: roadmap milestone 11's two-platform deploy proof — 1.1.0 gave a scaffolded app a real
deployable artifact (`packages/cli/src/serve.ts`; `x new` writes `apps/web/server.ts`,
`prerender.ts`, a Dockerfile and `docker-compose.prod.yml`; `ROLE=migrate` runs release-phase
migrations), but the demo app on Compose **and** K8s from one image with an invisible rolling
restart is still not demonstrated. Four known gaps ship with 1.1.0 and are named in
[`CHANGELOG.md`](CHANGELOG.md): `x build --target binary` compiled and crashed at import — **fixed**, the
version read is lazy and `x build` passes `--define ULTIMATE_FRAMEWORK_VERSION`, though the target
is still unproven end to end;
`docker-compose.prod.yml` pairs a published host port with `replicas: 3`; the shared cache tier's
Lua invalidation `DEL`s keys it never declares in `KEYS`, so it fails on Dragonfly and Redis
Cluster; `resolveEnvironment` exists in both `core` and `seo` with different return types. Milestone
detail: [`docs/idea/14-roadmap.md`](docs/idea/14-roadmap.md).

## Design axioms (override any instinct that conflicts)

1. **One way to do each thing.** Ambiguity is the tax agents pay. Never add a second path.
2. **Define once, project everywhere.** One `action` → HTTP + OpenAPI + typed client + job handle + MCP tool + tests.
3. **Enforced, not documented.** A convention that isn't a build error doesn't exist.
4. **Errors are instructions.** Stable code + cause + exact fix command + `--json`.
5. **One command means shippable.** `x verify` is the contract.
6. **Static path never pays for the app path.** Separate bundle graphs, hard boundaries.
7. **Deploy anywhere = containers only.** Zero platform primitives in the framework.

## Commands

| Task | Command |
|---|---|
| install | `bun install` |
| **the gate** | `bun run verify` — `x verify` at the repo root, 17 steps: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, manifest, roadmap. Green = shippable. |
| typecheck | `bun run typecheck` |
| lint | `bun run lint` · fix: `bun run lint:fix` |
| test (all) | `bun run test` — every framework suite, opt-in ones included. The reference app is gated separately: `cd examples/dummy && bun run ../../packages/cli/src/bin.ts verify` |
| **the app gate** | `bun run scripts/reference-app-gate.ts` — both tracked apps' own 17 steps (`examples/dummy`, `dummy/social-media-clone`), blocking on a ratchet: a step passing today must keep passing, a step pinned in that app's `expectedRed` (`scripts/lib/gated-apps.ts`) must still be failing, and a `typecheck` that goes green must join the root `tsconfig.json` references |
| test (one file) | `bun test packages/core/src/errors.test.ts` |
| test (one name) | `bun test -t 'formats the fix line'` |
| import boundaries | `bun run boundaries` |
| regenerate manifest | `bun run manifest` |
| list workspaces | `bun run workspaces:list` |
| new framework package | `bun run scripts/new-package.ts <name> --tier <n>` |
| the CLI, in-repo | `bun run x -- <args>` (e.g. `bun run x -- doctor --json`) |

Run everything from the repo root. Prefer `bun run verify` before claiming work is done.

## Layout

```
packages/       the framework — one package per responsibility, tiered (see below)
examples/dummy/ the reference app: every primitive, once, idiomatically
dummy/social-media-clone/  the deployed demo app: production image built on every push to main
docs/idea/      what and why — the design spec
docs/architecture/  how it's built — internals
docs/ops/       running an app for real — PaaS → Compose → K8s, secrets, observability, runbooks
wiki/           the reference manual, and the only public documentation surface (synced to the
                GitHub wiki). There is no separate marketing site — decided 2026-08
scripts/        setup, verify, boundaries, manifest, release, bench
docker/         Dockerfile + compose + helm
llms.txt        the machine-readable repo map
framework.manifest.json  GENERATED by `bun run manifest`: packages, tiers, every X_* code with
                its owner and the file that declares it — scripts/ gate codes included. Never
                hand-edited — drift fails `bun run verify` (X_MANIFEST_DRIFT)
```

## Package tiers — imports may only go DOWN

A package may import from strictly lower tiers. Never sideways within a tier, never upward. Enforced by `bun run boundaries`; a violation is a build error. The table below is prose — [`scripts/lib/tiers.ts`](scripts/lib/tiers.ts) is the executable copy, and they must agree.

| Tier | Packages |
|---|---|
| 0 | `core`, `schema` |
| 1 | `i18n`, `money`, `time`, `cache`, `seo`, `db`, `storage`, `flags` |
| 2 | `entity`, `policy`, `http`, `auth` |
| 3 | `action`, `query`, `jobs`, `realtime` |
| 4 | `render`, `pwa`, `mcp`, `ai`, `manifest`, `mail` |
| 5 | `ui`, `admin`, `testing`, `cli` |

Declared sideways edges, each earning its line: `admin → ui`, `realtime → query`, `cli → admin`, `create-ultimate → cli`.

**`db` is tier 1, decided 2026-08.** It imports `core` and nothing else, so tier 1 is the lowest its real imports allow — and that is what lets `entity` (tier 2) hold its own Postgres driver (`postgresDriver()`) instead of exiling it to a tier-3 package. Two things would have been wrong: a second package owning `Driver`'s only production implementation (two places to look for "where rows live"), and `database()` callers importing the seam from one package and the driver from another. Same shape as `auth → db`.

Adding a package means picking its tier first. If it doesn't fit a tier, the design is wrong — fix the design, don't widen the table.

## The eight primitives

`entity` · `policy` · `action` · `mutator` · `query` · `job` · `route` · `task`

Everything in the framework is one of these. **If a feature doesn't fit one of them, it doesn't ship.** Don't invent a ninth. Canonical shapes: [`docs/idea/02-primitives.md`](docs/idea/02-primitives.md). The list is executable, not prose: `PRIMITIVE_KINDS` in [`packages/core/src/registrar.ts`](packages/core/src/registrar.ts) is the single source `PrimitiveKind` derives from, and `registrar.test.ts` pins it at these eight — a ninth entry is a failing test, per axiom 3.

**`llm()` is an action factory, not a ninth primitive — decided 2026-08.** A model call is a server-authoritative operation with an input schema, an output schema and a policy, which is the definition of an `action`; so `llm()` ([`packages/ai/src/llm.ts`](packages/ai/src/llm.ts)) *returns* one. That is what gives a model call `.tool()`, `.openapi()`, `.client()`, `.job()` and `.contract()` for free, one authz object across every surface, and a place in the manifest — none of which a ninth primitive would have inherited. The rule generalises: a new capability arrives as a **factory over an existing primitive**, never as a new kind of thing.

**`backfill()` is a job factory — the rule's second instance, decided 2026-08.** A one-pass sweep over a table is durable background work with an input schema, a retry policy, an idempotency key and a queue, which is the definition of a `job`; so `backfill()` ([`packages/jobs/src/backfill.ts`](packages/jobs/src/backfill.ts)) *returns* one, and inherits `.enqueue()`, the worker's cancellation, the dead-letter path, `x jobs show` and its manifest row. The pass is `inBatches()` — one statement per page — with every page in its own `step.run`, so a killed attempt resumes on the page it stopped at. What a step persists is a cursor, never the page. **`handle` is at least once**: it runs before its checkpoint lands, so an attempt cancelled between the two replays that page — the handler must be idempotent (`upsertAll`, `updateWhere`, a statement whose second run changes nothing), never `count + 1`.

## Non-negotiables

- **Bun only.** No Node-specific APIs unless via `node:` and unavoidable, and then with a comment saying why.
- **No new dependencies** without a strong reason stated in the PR. Bun's natives replace most of them.
- **No `any`.** Biome fails the build. Use `unknown` + a schema parse.
- **Never throw a bare `Error`.** Subclass `UltimateError` with a code, a cause, and an executable `fix:`. Codes are `X_SCREAMING_SNAKE` and stable forever once shipped.
- **SRP.** One file, one job. Target < 200 LOC, hard ceiling ~500. Split before you exceed it.
- **Named exports only.** No default exports. `src/index.ts` re-exports the public API explicitly — no blind `export *`.
- **`import type` / `export type`** for type-only imports (`verbatimModuleSyntax` is on).
- **Tests next to source** as `<file>.test.ts`. A test that can't fail isn't a test.
- **`--json` on every CLI command and every error.**
- **No hardcoded user-facing strings.** Everything through `t()`.
- **No raw colours.** Semantic tokens only, in every component and stylesheet.
- **No date formatted without an explicit IANA `timeZone`.** No ambient default, anywhere.
- **No float money.** `Money = { readonly minor: number; readonly currency: string }`, always both — one
  declaration in `@ultimat3/schema`, aliased by `money` and `entity`, never restated and never a `bigint`.

## Conventions

- File names `kebab-case.ts`. Single quotes, semicolons, 2-space indent, 100 cols, trailing commas — Biome owns this, don't argue with it.
- A 1–4 line header comment per file stating its single responsibility.
- Comments explain **why**, never what.
- Every package carries `README.md` (public API) + `CLAUDE.md` (boundary, deps, commands).
- Route files: `page.tsx` on `site/`/`app/`, `route.ts` on `api/` — the directory is the URL, never the filename. `index.tsx` is not a page and `<name>.tsx` is not a route; `registerRoute()` enforces it (`X_ROUTE_FILE_INVALID`).
- i18n catalogs: one flat file per locale, `packages/i18n/catalogs/<locale>.json` — never a directory per locale or a file per feature. `x g route` / `x g resource` merge keys into it.
- Docs style: lead with the rule, fragments over sentences, tables for any ≥3-row structure, no meta-framing, no trailing summary. Date load-bearing claims `As of 2026-07`.

## Where things live

| Need | Go to |
|---|---|
| the design rationale | [`docs/idea/`](docs/idea/README.md) |
| how a subsystem actually works | [`docs/architecture/`](docs/architecture/README.md) |
| the coding contract in full | [`docs/architecture/00-conventions.md`](docs/architecture/00-conventions.md) |
| **adding a feature, step by step** | [`docs/architecture/15-adding-a-feature.md`](docs/architecture/15-adding-a-feature.md) |
| running an app in production | [`docs/ops/`](docs/ops/README.md) |
| which rung of the scale ladder a claim belongs to | [`docs/idea/17-scale-ladder.md`](docs/idea/17-scale-ladder.md) |
| every error code | [`wiki/Error-Codes.md`](wiki/Error-Codes.md) |
| every CLI flag | [`wiki/CLI-Reference.md`](wiki/CLI-Reference.md) |
| what idiomatic usage looks like | [`examples/dummy/`](examples/dummy/README.md) |

## CI

Free GitHub Actions runners (`ubuntu-latest`) — never a paid runner. `ci.yml` runs three jobs, each answering a question no other job answers: `verify` (the gate, `x verify` verbatim — lint, typecheck, boundaries and every suite are its steps, never a second job), `reference-app-verify` (the app gate, on its ratchet) and `scaffold-smoke` (`x new` → `bun install` → `x verify` outside the checkout). Target under 5 minutes. Every job starts with `./.github/actions/setup` — bun, the install cache, a frozen install. Releases publish to npm via **OIDC trusted publishing**, no `NPM_TOKEN` — see [`PUBLISHING.md`](PUBLISHING.md).

## Note

Do not use git worktrees — work directly in this checkout. If a task is big enough to need subagents, run them as a team in this same checkout: split the work into disjoint pieces so no two agents touch the same files.
