# Contributing

Bun-only monorepo. One gate: `x verify`. `As of 2026-08` — semver covers the documented surface, so read the tier table before adding an import and assume a rename is a major ([Upgrading](Upgrading)).

```
bun install
bun run verify        # or: bun run x verify
```

## Repo layout

```
packages/<name>/
  package.json         # name @ultimat3/<name>, exports ./src/index.ts, publishConfig
  tsconfig.json        # extends ../../tsconfig.base.json, composite
  README.md            # what it owns, its public API, why it exists
  CLAUDE.md            # boundary + deps + commands, compressed style
  src/index.ts         # explicit public exports
  src/errors.ts        # this package's X_* codes
  src/<concern>.ts     # one responsibility each
  src/<concern>.test.ts
```

Root also holds `scripts/` (verify, boundaries, manifest, setup), `docs/idea/` (design), `docs/architecture/` (internals), `wiki/` (this reference), `examples/dummy/` (the reference app CI runs `x verify` against).

### `package.json` template

```json
{
  "name": "@ultimat3/<name>",
  "version": "1.0.0",
  "description": "<one line>",
  "license": "MIT",
  "type": "module",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/developerz-ai/ultimate.git",
    "directory": "packages/<name>"
  },
  "publishConfig": { "access": "public", "provenance": true },
  "exports": { ".": "./src/index.ts" },
  "files": ["src", "README.md", "LICENSE"],
  "engines": { "bun": ">=1.3.0" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "bun test"
  },
  "dependencies": {}
}
```

### `tsconfig.json` template

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

## Import tiers

A package may import from **strictly lower** tiers only — never sideways within its own tier, never upward.

| Tier | Packages | May import |
|---|---|---|
| 0 | `core`, `schema` | nothing internal |
| 1 | `i18n`, `money`, `time`, `cache`, `seo`, `db`, `storage` | tier 0 |
| 2 | `entity`, `policy`, `http`, `auth` | tier 0–1 |
| 3 | `action`, `query`, `jobs`, `realtime` | tier 0–2 |
| 4 | `render`, `pwa`, `mcp`, `ai`, `manifest`, `mail` | tier 0–3 |
| 5 | `ui`, `admin`, `testing`, `cli` | tier 0–4 |

[`scripts/lib/tiers.ts`](https://github.com/developerz-ai/ultimate/blob/main/scripts/lib/tiers.ts) is the executable copy of that table — change it there first. **Five** sideways edges are declared and no others, `As of 2026-08-23`: `realtime → query`, `cli → admin`, `cli → scraping`, `cli → testing`, `create-ultimate → cli` — `SIDEWAYS_ALLOW` is the list, and `bun run boundaries --json` re-derives it. `admin → ui` was deleted 2026-08-19 by moving `ui` to tier 4.

Enforced by [`scripts/boundaries.ts`](https://github.com/developerz-ai/ultimate/blob/main/scripts/boundaries.ts): `bun run boundaries`. A violation is `X_BOUNDARY_VIOLATION` with the **transitive chain**, not just the offending line. It runs on pre-push and inside `x verify` — a lint warning would not count as enforcement.

In a generated app the same mechanism enforces `site/` cannot import `app/`, routes never touch the DB, components hold no business logic, services never import HTTP.

## Code conventions

| Rule | Detail | Enforced by |
|---|---|---|
| One file, one job | target <200 LOC, hard ceiling ~500 | review |
| One export surface per package | `src/index.ts` re-exports explicitly. No `export *` unless the module is purely types | review |
| Custom typed errors | `src/errors.ts` per package, subclassing `UltimateError`. **Never a bare `Error`** | `x verify` lint stage |
| No `any` | prefer `unknown` + a schema parse | Biome `suspicious.noExplicitAny: error` |
| Named exports only | no default exports anywhere | `x verify` lint stage |
| Single quotes, semicolons, 2-space indent, 100 cols, trailing commas | | `biome.json` formatter |
| `import type` / `export type` | `verbatimModuleSyntax` is on | Biome `useImportType` / `useExportType`, both `error` |
| No unused variables or imports | | Biome `correctness.noUnusedVariables` / `noUnusedImports`, both `error` |
| `kebab-case.ts` filenames | | review |
| Tests next to the source as `<file>.test.ts` | never a `__tests__/` directory | review |
| Comments explain WHY | plus a 1–4 line header stating the module's single responsibility | review |
| i18n-ready | zero hardcoded user-facing strings — everything through `t()` | `x verify` (i18n check) |
| Dark-theme-ready | every colour a semantic token, never a raw hex | **review — a convention, not a rule.** `As of 2026-08` no Biome rule and no `x verify` step reads a stylesheet for a hex literal. What *is* enforced is the token name: `t.role('<name>')` with a role that does not exist throws `X_TOKEN_UNKNOWN` |
| tz-ready | never format a date without an explicit IANA `timeZone` | **the type signature.** Every `@ultimat3/time` formatter takes a required `zone` and rejects a non-IANA value with `X_TIMEZONE_INVALID`, so a formatted date with no zone does not compile. A bare `Date.prototype.toLocaleString()` is caught by **nothing** — no lint rule, no gate step. `X_TIME_NO_ZONE` is not a code: it exists nowhere in the source or the manifest |
| Money as minor units | `Money = { readonly minor: number; readonly currency: string }` — one declaration in `@ultimat3/schema`, aliased by `money` and `entity`, never restated. Never a float, never a `bigint` on a row | types + `type-pins.ts` + `X_MONEY_NOT_INTEGER` |

TypeScript strictness comes from [`tsconfig.base.json`](https://github.com/developerz-ai/ultimate/blob/main/tsconfig.base.json) and is not negotiable per package: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`, `isolatedModules`, `verbatimModuleSyntax`, `composite`. `noNonNullAssertion` is a Biome **warning** — treat it as an error in review; a `!` is almost always a missing narrow.

## Commands

| Task | Command |
|---|---|
| all tests | `bun run test` (bare `bun test` also scans `examples/`, which has its own gate) |
| one file | `bun test packages/core/src/errors.test.ts` |
| typecheck the framework graph | `bun run typecheck` (`tsc -b --pretty`) |
| clean the build info | `bun run typecheck:clean` |
| lint + format check | `bun run lint` (`biome check .`) |
| autofix | `bun run lint:fix` / `bun run format` |
| import boundaries | `bun run boundaries` |
| regenerate manifest | `bun run manifest` |
| the gate | `bun run verify`, or `bun run x verify` |
| the CLI from source | `bun run x <command>` → `packages/cli/src/bin.ts` |

Git hooks via [`lefthook.yml`](https://github.com/developerz-ai/ultimate/blob/main/lefthook.yml):

| Hook | Runs |
|---|---|
| pre-commit | `bunx biome check --no-errors-on-unmatched --staged`, with `stage_fixed: true` — fixes are added to the commit |
| pre-push | `bun run typecheck`, then `bun run boundaries` |

Both skip on `merge` and `rebase`. Hooks are a fast subset; CI runs exactly `x verify` — a check that lives only in CI is a check contributors cannot run.

## Adding a new error code

| # | Step |
|---|---|
| 1 | Add the code to the package's `src/errors.ts` as a subclass of `UltimateError` — never a bare `Error` |
| 2 | Give it a `cause`, an exact `fix` command, and a `docs` URL. The same string must render in terminal, browser overlay, and `--json` |
| 3 | Register it in the code registry. Duplicates across packages fail with `X_ERROR_CODE_DUPLICATE` |
| 4 | Add a row to [Error codes](Error-Codes) with cause and fix |
| 5 | Add a test asserting the code, the `fix` string, and the JSON shape |

```ts
throw new UltimateError({
  code: 'X_DB_DRIFT',
  cause: 'table "posts" has column "publish_at" not present in any migration',
  fix: 'x db gen "add publish_at"',
});
```

A code with no `fix` command is not mergeable. "Errors are instructions" is axiom 4, and an agent that cannot read the fix needs a human.

## Tests

| Requirement | Detail |
|---|---|
| >=2 meaningful tests per package | tests that would catch a real regression. `expect(true).toBe(true)` is a rejected PR |
| Never mock the database | clone it. One real Postgres per test worker |
| Never assert on wall-clock time | advance the frozen clock |
| Never reach the network unmocked | it fails by design with `X_TEST_NETWORK_SEALED` |
| A flaky test is fixed or deleted **the day it flakes** | there is no `retry: 3` |

Six test types, each a first-class runner: `unit`, `contract`, `live`, `job`, `e2e`, `eval`. See [Testing](Testing).

## Docs style

Everything in `wiki/`, `docs/`, and every `README.md` / `CLAUDE.md` uses compressed-config style:

| Rule | Detail |
|---|---|
| Lead with the rule, not the reason | fragments over sentences |
| Tables for any >=3-row structured data | |
| Code, paths, and commands verbatim | compress the prose around them, never the command |
| No meta-framing, no rhetoric, no trailing summary | "This section covers…" is deleted in review |
| Date load-bearing claims | `As of 2026-08` |
| No fabricated numbers | no benchmarks that were not run, no adoption counts, no invented dates |
| `README.md` + `CLAUDE.md` per package | both required — `x verify`'s `package-shape` step refuses a package missing either (`PACKAGE_FILES` in `packages/cli/src/workspace-checks.ts`). Neither has a length cap: this page stated `<40 lines` for a `CLAUDE.md` until 2026-08-21 and 28 of 30 packages were over it (`packages/cli/CLAUDE.md` is 843), and `30-80 lines` for a `README.md`, which **no** package met. An unenforced number that the tree contradicts is deleted rather than renumbered |

Never generate prose documentation at runtime. Facts come from code (`x.manifest.json`, regenerated every build); conventions come from a human (`AGENTS.md`, short, hand-written).

## PR expectations

| Expectation | Detail |
|---|---|
| Green `x verify` | all 19 steps, in this order: typecheck, lint, boundaries, filesize, package-shape, errors, unit, contract, live, job, e2e, eval, drift, contract-diff, budgets, seo, i18n, manifest, roadmap |
| No new dependency without justification in the PR body | target is **under 40 direct dependencies for the whole framework**. A Bun native beats a package |
| No new alternative for something already locked | a second CSS system, a second ORM, a second validator, a second runtime is a closed PR ([Home](Home)) |
| Feature fits one of the eight primitives | if it doesn't fit, it doesn't ship ([The eight primitives](The-Eight-Primitives)) |
| New failure modes have `X_*` codes with `fix:` lines | |
| Deep infra may ship interface-only | an in-memory or PGlite-shaped default driver plus a clearly-labelled `X_NOT_IMPLEMENTED` throw carrying a `fix:`. Never a bare `// TODO` |
| Milestone discipline | each of the 12 milestones ends in a working demo app plus green `x verify`. A package that only compiles is not a milestone |

The step list has one source of truth: `VERIFY_STEP_NAMES` in [`packages/cli/src/verify-step.ts`](https://github.com/developerz-ai/ultimate/blob/main/packages/cli/src/verify-step.ts). Adding, removing or reordering a step means editing that constant first; the wiki is plain markdown with no build step, so the copies on this page, [Getting started](Getting-Started), [Testing](Testing) and [FAQ](FAQ) are hand-synced in the same PR.

Security issues go through [`SECURITY.md`](https://github.com/developerz-ai/ultimate/blob/main/SECURITY.md), never a public issue.
