# Contributing

Ultimate has **one blessed path per job**. A contribution that adds a second way to do something
that already works will be declined — that ambiguity is the tax agents pay.

## 🚀 Setup

```sh
bin/setup      # bun version check, install, .env.development.local, git hooks
bin/check      # the gate: typecheck, lint, boundaries, errors, tests, drift, budgets, manifest, roadmap
```

Requirements: **Bun >= 1.3**. Nothing else. No Node, no Docker, no database — `x dev` runs
embedded Postgres (PGlite), in-process events, and S3 to a local directory.

| Command | Does |
|---|---|
| `bin/setup` | fresh clone to running |
| `bin/dev <args>` | run the `x` CLI from source: `bin/dev verify --json` |
| `bin/check` | the CI gate, locally |
| `bun run test` | every package's tests, opt-in suites included; `examples/` is gated by its own `x verify` |
| `bun run scripts/help.ts` | the full script catalogue |

## ✅ The gate

**`bun run scripts/verify.ts` — green means shippable.** CI runs exactly this. There is no second
checklist and no CI-only step.

It **is** `x verify`, run at the repo root: one step list, defined once in
`packages/cli/src/cmd-verify.ts`, so a contributor and a user see the same steps. A step that has
nothing to check here is reported as skipped (`-`), never as passed.

| Step | Fails on |
|---|---|
| `typecheck` | any type error; `any` is banned, and a cast is not a fix |
| `lint` | Biome: formatting, `any`, unused, default exports |
| `boundaries` | a tier violation (see below) or an app surface violation |
| `filesize` | a file over 500 lines |
| `package-shape` | a package missing `README.md`, `CLAUDE.md`, `tsconfig.json`, `src/index.ts` |
| `errors` | an empty/advice-only `fix:`, a shipped code missing from `wiki/Error-Codes.md`, or a documented code no source declares |
| `unit` | any failing test that is not one of the typed suites below; a flake is a failure |
| `contract` `live` `job` `e2e` `eval` | any failing `*.<type>.test.ts` suite (or any test under `e2e/`) |
| `drift` | an app schema that no migration recorded |
| `contract-diff` | a breaking change to a published action without a version bump |
| `budgets` | per-route JS bytes or LCP over the declared limit |
| `manifest` | the manifest differs from what the code produces, or cannot be generated |
| `roadmap` | a milestone status marker out of sync, or a shipped milestone naming no verifiable artifact |

There is no `--only` and no `--skip`: "green" has to mean the same thing for everyone (axiom 5).

## 📦 Import tiers (a build error, not a preference)

A package may import from a **strictly lower** tier. Never sideways within its own tier unless the
edge is listed in `scripts/lib/tiers.ts`, never upward.

| Tier | Packages | May import |
|---|---|---|
| 0 | `core` `schema` | — |
| 1 | `i18n` `money` `time` `cache` `seo` `db` `storage` | 0 |
| 2 | `entity` `policy` `http` `auth` | 0–1 |
| 3 | `action` `query` `jobs` `realtime` | 0–2 |
| 4 | `render` `pwa` `mcp` `ai` `manifest` `mail` | 0–3 |
| 5 | `ui` `admin` `testing` `cli` | 0–4 |

```sh
bun run scripts/boundaries.ts --json
```

Declared sideways edges live in one table with a reason each. Adding one is a design decision that
needs a reviewer, not a convenience.

## 🧱 Code rules

| Rule | Detail |
|---|---|
| One file, one job | target < 200 lines, hard ceiling 500 |
| Public API | `src/index.ts`, explicit re-exports; no `export *` unless purely types |
| Errors | `src/errors.ts`, subclass `UltimateError`. **Never `throw new Error`** |
| Every error | stable `X_*` code + cause + **runnable fix command** + docs URL |
| No `any` | `unknown` plus a schema parse |
| Exports | named only, no defaults |
| Imports | `import type` / `export type` for types (`verbatimModuleSyntax`) |
| Files | `kebab-case.ts`; tests beside the source as `<file>.test.ts` |
| Comments | a 1–4 line header stating the module's single responsibility, explaining WHY |
| Strings | zero hardcoded user-facing text — everything through `t()` |
| Colour | semantic tokens only, never a raw hex, anywhere |
| Money | `{ minor: number; currency: string }`, never a float |
| Time | store UTC, format with an explicit IANA `timeZone` |
| `--json` | every command, every script, every error |

Style: single quotes, semicolons, 2-space indent, 100-column lines, trailing commas. Biome owns
all of it — do not argue with the formatter, run `bunx biome check --write .`.

## 🧪 Tests

Every package ships at least **two tests that would catch a real regression**. `expect(true)` is
not a test.

| Rule | Why |
|---|---|
| Never mock the database — clone it | a mocked query cannot catch a wrong query |
| Never read the wall clock — advance the frozen one | a test that depends on `Date.now()` fails at midnight |
| Never reach the network unmocked | the sealed network fails it by design, with the mock line |
| No `retry:` anywhere | a flake is fixed or deleted the day it flakes |
| Name tests through the type helpers | `unitTest`, `jobTest`, … so `x verify` can filter them |

```ts
import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';

unitTest('rejects a cross-org actor', async () => {
  await expect(canPostWrite).toDenyPolicy({ actor: outsider, input: { orgId: org } });
});
```

## ➕ Adding a framework package

```sh
bun run scripts/new-package.ts seo --tier 1 --description "Metadata, sitemaps, robots"
```

It scaffolds the seven contract files, an `UltimateError` subclass, and two passing tests. Then:

1. Add the package to the tier table in `scripts/lib/tiers.ts` (the generator places it, you
   confirm the tier is the lowest one its real imports allow).
2. Write `README.md` (what it owns, its public API, why it exists) and `CLAUDE.md` (boundary, deps,
   commands, under 40 lines).
3. Add it to the correct tier step in `.github/workflows/release.yml` and to the table in
   `PUBLISHING.md`. Lockstep versioning means it releases with everything else.
4. `bun run scripts/verify.ts`.

## ✍️ Commits and PRs

Conventional commits, imperative mood, lower case:

```
feat(query): live queries reject an unbounded select
fix(cli): x verify exits non-zero when a step throws
docs(jobs): step names are identifiers, not labels
chore(deps): bump biome to 2.4.16
```

Types: `feat` `fix` `perf` `refactor` `docs` `test` `chore` `ci`. A `!` after the scope marks a
breaking change, which for this repo means a minor bump before 1.0 and a note in the changelog.

Branch from `main`, keep the PR to one change, fill in the checklist in the PR template — including
the error-code table for any new `X_*` code.

## 🧭 Where things live

| Path | Holds |
|---|---|
| `packages/*/src` | the framework, one responsibility per file |
| `scripts/` | repo automation in Bun TS; `scripts/lib/` is the reusable half |
| `bin/` | 5–15 line shell shims over the scripts |
| `docker/` | one image, N roles, plus the Helm chart |
| `docs/idea/` | the design documents the code is accountable to |
| `.github/` | CI, the OIDC release workflow, issue and PR templates |
