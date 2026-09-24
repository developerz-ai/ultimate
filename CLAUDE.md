# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Ultimate

A full-stack, **Bun-only**, opinionated web framework: Rails' philosophy on Bun + Postgres +
SolidJS, where **the primary developer is an AI agent**. The promise: **reduce the number of
problems the author has to worry about** — every decision the framework makes is one an agent does
not have to.

This repo is the framework: the `@ultimat3/*` packages, the `x` CLI, the docs, the wiki, and two
tracked apps — the reference app (`examples/dummy`) and the deployed demo
(`dummy/social-media-clone`), each gated on its own `expectedRed` table. CLI binary `x`, npm scope
`@ultimat3`, imports `@ultimat3/<pkg>`.

**Status:** released. 30 `@ultimat3/*` packages plus the unscoped `create-ultimate` — 31 in all —
versioned and published in lockstep: one version, one commit, one tag, 31 tarballs. Semver applies:
the eight primitive shapes, the `x` CLI surface and the tier table are as stable as the `X_*` codes.

**This page states no version number, deliberately.** Every fact below is a command:
**run the right-hand column — never quote the left.** How each of these came to be is
[`docs/history/publishing-and-provenance.md`](docs/history/publishing-and-provenance.md).

| Fact | Read it yourself |
|---|---|
| what this tree is stamped at, per workspace | `bun run scripts/list-workspaces.ts --json` — `.data[].version`; one value across every workspace, or the tree is out of lockstep |
| the whole repository is stamped at one version | `bun run scripts/release.ts --check <version>` — exits 1 and names every finding when it is not |
| the release workflow names every publishable workspace | `bun run scripts/release-workflow.ts --json` |
| every one of them is on npm at that version, attested | `bun run scripts/registry-audit.ts --json` — also names a new package owing its one bootstrap publish ([`PUBLISHING.md`](PUBLISHING.md) step 1) |
| what npm serves, and what `bunx create-ultimate myapp` installs | `npm view @ultimat3/core version` |
| provenance on a release | `npm view @ultimat3/core@<version> dist.attestations _npmUser` — `GitHub Actions` is the workflow; a person's name is a hand publish with no attestation |
| the tag is **annotated** and on the remote | `git ls-remote --tags origin 'refs/tags/v<version>*'` — the ref **and** its peeled `^{}` line. Not `git tag --list`, which reads the local repository. `git tag -a` only: `--follow-tags` never pushes a lightweight tag |
| the GitHub Release exists — the Release triggers the workflow | `gh release view v<version> --json tagName,isDraft,publishedAt` |
| the OIDC trusted publisher is attached, `Environment: npm-publish` | `NPM_CONFIG_OTP=<code> bun run scripts/trust-publishers.ts --check --json` — without a fresh OTP every package reads as missing |
| which majors have shipped, and what each one breaks | `grep -n '^## ' CHANGELOG.md` · [`wiki/Upgrading.md`](wiki/Upgrading.md), one section per major |

**The `npm-publish` environment has no required reviewers** (owner's decision, 2026-09-05). The
gate is `release.yml`'s `check` job — it waits for `ci.yml`'s verdict on the tagged commit and runs
`scripts/release.ts --check` — plus the environment's `v*` deployment tag rule; `publish` cannot
start without `check`.

## Design axioms (override any instinct that conflicts)

1. **One way to do each thing.** Ambiguity is the tax agents pay. Never add a second path.
2. **Define once, project everywhere.** One `action` → HTTP + OpenAPI + typed client + job handle + MCP tool + tests.
3. **Enforced, not documented.** A convention that isn't a build error doesn't exist.
4. **Errors are instructions.** Stable code + cause + exact fix command + `--json`.
5. **One command means shippable.** `x verify` is the contract.
6. **Static path never pays for the app path.** Separate bundle graphs, hard boundaries.
7. **Deploy anywhere = containers only.** Zero platform primitives in the framework.
8. **Ultimate ships mechanism; your app ships convention.** Mechanisms and *structural* conventions
   ship — the same for a bank and a blog. *Business* conventions never do. Primitives are functions
   returning values, so an app encodes its own by wrapping one: no fork, no patch, no plugin API.
   [`docs/idea/19-mechanism-not-convention.md`](docs/idea/19-mechanism-not-convention.md).
9. **Useful, then efficient.** Working function first; bytes and milliseconds second. A route or
   island budget is a measurement, not a ceiling to game: when real function costs bytes, raise the
   budget by the measured amount, with the number and the reason in the same diff
   (`bun run budget-raises`, `X_BUDGET_RAISE_UNSTATED`). Never cut or stub a feature, or leave it
   `X_NOT_IMPLEMENTED`, to hold a figure. Bytes that buy no function are still a defect. Axiom 6 is
   not traded.

## Commands

Run everything from the repo root.

| Task | Command |
|---|---|
| install | `bun install` |
| fresh clone to running | `bun run setup` — idempotent; safe to re-run after every pull |
| **the gate** | `bun run verify` — `x verify` at the repo root, 20 steps: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, seo, i18n, policy, manifest, roadmap. Green = shippable. The list is `VERIFY_STEP_NAMES` in `packages/cli/src/verify-step.ts` |
| typecheck | `bun run typecheck` · start over: `bun run typecheck:clean` |
| lint | `bun run lint` · fix: `bun run lint:fix` |
| test (all) | `bun run test` — every framework suite, opt-in ones included |
| test (one file) | `bun test packages/core/src/errors.test.ts` |
| test (one name) | `bun test packages/core/src/errors.test.ts -t '<name>'` — **always with a path**: a bare `-t` loads every test file into one process |
| coverage, per package | `bun run coverage` · `bun run coverage:package <pkg>` |
| **the app gate** | `bun run scripts/reference-app-gate.ts` — both tracked apps built (`x build --target static`) then verified, blocking on a ratchet: a passing step must keep passing, a step pinned in `expectedRed` (`scripts/lib/gated-apps.ts`) must still fail |
| shrink the ratchet | `bun run scripts/reference-app-gate.ts --unpin <app>:<step>[,<step>]` |
| a new error code | `bun run new-error-code <CODE> --package <pkg> --title '…' --fix '…'` — writes the registration and its `wiki/Error-Codes.md` row together |
| new framework package | `bun run scripts/new-package.ts <name> --tier <n>` |
| regenerate manifest | `bun run manifest` |
| stale `@ultimat3/*` ranges in `bun.lock` | `bun run lockfile` reports, `bun run lockfile:fix` performs the edit |
| the CLI, in-repo | `bun run x -- <args>` (e.g. `bun run x -- doctor --json`) |
| **every guard** | [`docs/architecture/guards.md`](docs/architecture/guards.md) — generated from each guard's header by `bun run scripts/guards-doc.ts --write`, drift refused by `--check` |

## Layout

```
packages/       the framework — one package per responsibility, tiered (see below)
examples/dummy/ the reference app: every primitive, once, idiomatically
dummy/social-media-clone/  the deployed demo app: production image built on every push to main
docs/idea/      what and why — the design spec
docs/architecture/  how it's built — internals
docs/ops/       running an app for real — PaaS → Compose → K8s, secrets, observability, runbooks
docs/history/   why things are the way they are — decision records moved out of this file
wiki/           the reference manual, the only public documentation surface (synced to the GitHub wiki)
scripts/        setup, verify, guards, manifest, release, bench
docker/         Dockerfile + compose + helm
llms.txt        the machine-readable repo map
framework.manifest.json  GENERATED by `bun run manifest` — never hand-edited (X_MANIFEST_DRIFT)
```

## Package tiers — imports may only go DOWN

A package may import from strictly lower tiers. Never sideways within a tier, never upward.
Enforced by `bun run boundaries`. [`scripts/lib/tiers.ts`](scripts/lib/tiers.ts) is the executable
copy of this table, and they must agree.

| Tier | Packages |
|---|---|
| 0 | `core`, `schema` |
| 1 | `i18n`, `money`, `time`, `cache`, `seo`, `db`, `storage`, `flags` |
| 2 | `entity`, `policy`, `http`, `auth` |
| 3 | `action`, `query`, `jobs`, `realtime` |
| 4 | `render`, `pwa`, `mcp`, `ai`, `manifest`, `mail`, `ui`, `notify` |
| 5 | `admin`, `testing`, `cli`, `scraping` |

Declared sideways edges, one line each — the full record per edge is
[`docs/history/tier-decisions.md`](docs/history/tier-decisions.md):

- `core → schema` — the reverse stays forbidden: `t` is in every bundle graph.
- `realtime → query` — a live query is a query.
- `cli → admin` — the dev dashboard is the admin package's.
- `cli → testing` — already a runtime dependency of the CLI.
- `create-ultimate → cli` — tier 6, and its only permitted import.

The FLOOR is enforced too: a package above the tier its imports allow needs a `FLOOR_ABOVE` row
saying what moving it down would legalise (`X_TIER_FLOOR_UNDECLARED` / `X_TIER_FLOOR_STALE`).
Adding a package means picking its tier first. If it doesn't fit a tier, the design is wrong — fix
the design, don't widen the table.

## The eight primitives

`entity` · `policy` · `action` · `mutator` · `query` · `job` · `route` · `task`

Everything in the framework is one of these. **If a feature doesn't fit one of them, it doesn't
ship.** Don't invent a ninth. Canonical shapes: [`docs/idea/02-primitives.md`](docs/idea/02-primitives.md).
`PRIMITIVE_KINDS` in [`packages/core/src/registrar.ts`](packages/core/src/registrar.ts) is the
executable list, pinned at eight by `registrar.test.ts`.

A new capability arrives as a **factory over an existing primitive**, never a new kind of thing:
`llm()` returns an `action`, `backfill()` returns a `job`
([`docs/history/primitive-factories.md`](docs/history/primitive-factories.md)). The factories are
a list, never a count or an ordinal: `PRIMITIVE_FACTORIES` in the same file, held complete by
`scripts/primitive-factories.test.ts`.

## Non-negotiables

- **Bun only.** No Node-specific APIs unless via `node:` and unavoidable, with a `why:` comment (`bun run node-imports`).
- **No new dependencies** without a strong reason stated in the PR — the bar is [`docs/idea/18-build-vs-wrap.md`](docs/idea/18-build-vs-wrap.md).
- **No `any`.** Biome fails the build. Use `unknown` + a schema parse.
- **Never throw a bare `Error`.** Subclass `UltimateError` with a code, a cause, and an executable `fix:`. Codes are `X_SCREAMING_SNAKE` and stable forever once shipped. In tests too: `expect.unreachable` states a test's verdict (`scripts/test-bare-error.ts`); a `new Error` handed to the code under test is input, not a verdict.
- **SRP.** One file, one job. Target < 200 LOC, hard ceiling ~500. Split before you exceed it.
- **Named exports only.** No default exports. `src/index.ts` re-exports the public API explicitly — no blind `export *`.
- **`import type` / `export type`** for type-only imports (`verbatimModuleSyntax` is on).
- **Tests next to source** as `<file>.test.ts`. A test that can't fail isn't a test.
- **`--json` on every CLI command and every error.**
- **No hardcoded user-facing strings.** Everything through `t()`.
- **No raw colours.** Semantic tokens only, in every component and stylesheet.
- **No date formatted without an explicit IANA `timeZone`.** No ambient default, anywhere.
- **No float money.** `Money = { readonly minor: number; readonly currency: string }`, always both — one declaration in `@ultimat3/schema`, never restated and never a `bigint`.

## Conventions

- File names `kebab-case.ts`. Single quotes, semicolons, 2-space indent, 100 cols, trailing commas — Biome owns this.
- A 1–4 line header comment per file stating its single responsibility. Comments explain **why**, never what.
- Every package carries `README.md` (public API) + `CLAUDE.md` (boundary, deps, commands). This file stays ≤ 16 KB and a package's ≤ 24 KB or its pin (`bun run scripts/claude-md-size.ts`): history goes to `docs/history/`.
- Route files: `page.tsx` on `site/`/`app/`, `route.ts` on `api/` — the directory is the URL. `registerRoute()` enforces it (`X_ROUTE_FILE_INVALID`).
- i18n catalogs: one flat file per locale. An **app's** live at `packages/i18n/catalogs/<locale>.json` (`x i18n check` audits them); the **framework's own** is `packages/i18n/src/catalogs/en.json` (the `boundaries` step audits it, `X_CATALOG_KEY_UNREACHABLE`).
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
| realtime capacity, as measured | [`scripts/bench/results/README.md`](scripts/bench/results/README.md) |
| the deploy-proof milestone | [`docs/history/milestone-11.md`](docs/history/milestone-11.md) · [`docs/idea/14-roadmap.md`](docs/idea/14-roadmap.md) |

## CI

Free runners (`ubuntu-latest`), never a paid one. Target under 5 minutes.
`awk '/^jobs:/{j=1;next} j && /^  [a-z-]+:$/{print $1}' .github/workflows/ci.yml` re-derives the jobs:

| Job | The question only it answers |
|---|---|
| `verify` | the gate, `x verify` verbatim — lint, typecheck, boundaries and every suite are its **steps**, never a second job |
| `reference-app-verify` | both tracked apps, built then gated, on their ratchet |
| `scaffold-smoke` | `x new` → `bun install` → the documented first run → the scaffolded app's own `x verify`, outside the checkout |
| `container` | `docker/` as a built artifact, ending in the runtime stage's own `/app/x --version`, plus `helm template` assertions |
| `deploy-proof` | a kind cluster, the scaffolded chart installed and then upgraded under load, failing on a single non-2xx (`docker/deploy-proof/run.sh`). `main` pushes and manual dispatch only |
| `packages` | each package tested and covered **alone** (`bun run scripts/coverage-gate.ts --all`) |

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push to `main`, every PR | the jobs above |
| `release.yml` | a **published** GitHub Release | every publishable workspace to npm via OIDC trusted publishing, after the `check` job; the list is derived by `scripts/release-workflow.ts` |
| `registry-audit.yml` | daily cron | `scripts/registry-audit.ts`; files a `registry-drift` issue when the tree and the registry disagree |
| `deploy-social-demo.yml` | push to `main` | builds and publishes the demo app's production image |
| `wiki.yml` | push to `main` | mirrors `wiki/` into the GitHub wiki |

## Note

Do not use git worktrees — work directly in this checkout. If a task is big enough to need
subagents, run them as a team in this same checkout: split the work into disjoint pieces so no two
agents touch the same files.

**Only the top-level agent spawns subagents.** A subagent does the work it was given and reports
back — it never delegates further. Nested fan-out is why a 4-agent sweep becomes 17 running agents:
the count stops being knowable, the disjoint-files split stops holding, and two grandchildren edit
the same file. A subagent that finds its scope too large says so in its report and returns; widening
the split is the top-level agent's call.
