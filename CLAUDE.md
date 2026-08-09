# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Ultimate

A full-stack, **Bun-only**, opinionated web framework. Rails' philosophy on a Bun + Postgres + SolidJS stack, where **the primary user is an AI agent** and the secondary user is a tired senior engineer working through their own AI agent and AI reviewer.

Rails' actual promise, applied to agents: **reduce the number of problems the author has to worry about**, so the work goes into the app's features instead of the app's infrastructure. Every decision the framework makes is a decision an agent does not have to.

This repo is the framework itself: a monorepo of `@ultimat3/*` packages, the `x` CLI, the docs, the public site, and one reference app.

CLI binary: `x`. npm scope: `@ultimat3`. Import paths: `@ultimat3/<pkg>`.

**Status:** pre-alpha. Architecture + docs + package skeletons landed; milestones 0–5 are the path to usable. See [`docs/idea/14-roadmap.md`](docs/idea/14-roadmap.md).

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
| **the gate** | `bun run verify` — `x verify` at the repo root: typecheck, lint, boundaries, sizes, shape, every test type, drift, contracts, budgets, manifest. Green = shippable. |
| typecheck | `bun run typecheck` |
| lint | `bun run lint` · fix: `bun run lint:fix` |
| test (all) | `bun run test` — every framework suite, opt-in ones included. The reference app is gated separately: `cd examples/dummy && bun run ../../packages/cli/src/bin.ts verify` |
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
docs/idea/      what and why — the design spec
docs/architecture/  how it's built — internals
wiki/           the reference manual (synced to the GitHub wiki)
site/           the public GitHub Pages site (0kb JS)
scripts/        setup, verify, boundaries, manifest, release
docker/         Dockerfile + compose + helm
llms.txt        the machine-readable repo map
```

## Package tiers — imports may only go DOWN

A package may import from strictly lower tiers. Never sideways within a tier, never upward. Enforced by `bun run boundaries`; a violation is a build error. The table below is prose — [`scripts/lib/tiers.ts`](scripts/lib/tiers.ts) is the executable copy, and they must agree.

| Tier | Packages |
|---|---|
| 0 | `core`, `schema` |
| 1 | `i18n`, `money`, `time`, `cache`, `seo`, `db`, `storage` |
| 2 | `entity`, `policy`, `http`, `auth` |
| 3 | `action`, `query`, `jobs`, `realtime` |
| 4 | `render`, `pwa`, `mcp`, `ai`, `manifest`, `mail` |
| 5 | `ui`, `admin`, `testing`, `cli` |

Declared sideways edges, each earning its line: `admin → ui`, `realtime → query`, `create-ultimate → cli`.

**`db` is tier 1, decided 2026-08.** It imports `core` and nothing else, so tier 1 is the lowest its real imports allow — and that is what lets `entity` (tier 2) hold its own Postgres driver (`postgresDriver()`) instead of exiling it to a tier-3 package. Two things would have been wrong: a second package owning `Driver`'s only production implementation (two places to look for "where rows live"), and `database()` callers importing the seam from one package and the driver from another. Same shape as `auth → db`.

Adding a package means picking its tier first. If it doesn't fit a tier, the design is wrong — fix the design, don't widen the table.

## The eight primitives

`entity` · `policy` · `action` · `mutator` · `query` · `job` · `route` · `task`

Everything in the framework is one of these. **If a feature doesn't fit one of them, it doesn't ship.** Don't invent a ninth. Canonical shapes: [`docs/idea/02-primitives.md`](docs/idea/02-primitives.md).

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
- **No float money.** `Money = { minor: number; currency: string }`, always both.

## Conventions

- File names `kebab-case.ts`. Single quotes, semicolons, 2-space indent, 100 cols, trailing commas — Biome owns this, don't argue with it.
- A 1–4 line header comment per file stating its single responsibility.
- Comments explain **why**, never what.
- Every package carries `README.md` (public API) + `CLAUDE.md` (boundary, deps, commands).
- Docs style: lead with the rule, fragments over sentences, tables for any ≥3-row structure, no meta-framing, no trailing summary. Date load-bearing claims `As of 2026-07`.

## Where things live

| Need | Go to |
|---|---|
| the design rationale | [`docs/idea/`](docs/idea/README.md) |
| how a subsystem actually works | [`docs/architecture/`](docs/architecture/README.md) |
| the coding contract in full | [`docs/architecture/00-conventions.md`](docs/architecture/00-conventions.md) |
| **adding a feature, step by step** | [`docs/architecture/15-adding-a-feature.md`](docs/architecture/15-adding-a-feature.md) |
| every error code | [`wiki/Error-Codes.md`](wiki/Error-Codes.md) |
| every CLI flag | [`wiki/CLI-Reference.md`](wiki/CLI-Reference.md) |
| what idiomatic usage looks like | [`examples/dummy/`](examples/dummy/README.md) |

## CI

Free GitHub Actions runners (`ubuntu-latest`) — never a paid runner. `ci.yml` runs lint, typecheck, boundaries, and tests; target under 5 minutes. Releases publish to npm via **OIDC trusted publishing**, no `NPM_TOKEN` — see [`PUBLISHING.md`](PUBLISHING.md).

## Note

Do not use git worktrees — work directly in this checkout. If a task is big enough to need subagents, run them as a team in this same checkout: split the work into disjoint pieces so no two agents touch the same files.
