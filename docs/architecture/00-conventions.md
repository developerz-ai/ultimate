# The coding contract

The rules every file in this repo obeys. Most are mechanically enforced — `bun run verify` is the arbiter, not review.

Rationale lives in [`../idea/00-thesis.md`](../idea/00-thesis.md). This file is the rules.

## Axioms, applied to code

| Axiom | What it means when you're typing |
|---|---|
| One way to do each thing | Adding a second path to an existing capability is a rejected PR, not a feature. |
| Define once, project everywhere | If you're writing the same shape twice, one of them should be generated. |
| Enforced, not documented | Shipping a convention means shipping its check. No check, no convention. |
| Errors are instructions | Every throw carries a code, a cause, and a command that fixes it. |
| One command means shippable | If `x verify` passes and the thing is broken, `x verify` has a bug. |
| Static never pays for app | A byte added to `site/` needs a justification in the PR. |
| Containers only | No cloud-vendor primitive enters the framework. Ever. |

## Package tiers

Imports go **down only**. Never sideways within a tier, never upward.

| Tier | Packages | May import |
|---|---|---|
| 0 | `core`, `schema` | nothing (`@ultimat3/*`) |
| 1 | `i18n`, `money`, `time`, `cache`, `seo` | tier 0 |
| 2 | `entity`, `policy`, `http` | tier 0–1 |
| 3 | `action`, `query`, `jobs`, `realtime` | tier 0–2 |
| 4 | `render`, `pwa`, `mcp`, `ai`, `manifest` | tier 0–3 |
| 5 | `ui`, `admin`, `testing`, `cli` | tier 0–4 |

Enforced by `bun run boundaries`. A violation reports the importing file, the imported module, and the allowed tiers.

**Adding a package:** pick the tier first. If it doesn't fit one, the design is wrong — fix the design, don't widen the table. `bun run scripts/new-package.ts <name> --tier <n>` scaffolds it correctly.

Details: [`02-boundaries.md`](02-boundaries.md).

## Package layout

Every framework package, without exception:

```
packages/<name>/
  package.json         # @ultimat3/<name>, exports ./src/index.ts, publishConfig
  tsconfig.json        # extends ../../tsconfig.base.json, composite
  README.md            # what it owns, its public API, why it exists
  CLAUDE.md            # boundary + deps + commands, < 40 lines
  src/index.ts         # explicit named re-exports of the public API
  src/errors.ts        # this package's X_* codes
  src/<concern>.ts     # one responsibility each
  src/<concern>.test.ts
```

`src/index.ts` is the package's **only** public surface. Reaching into another package's internals is a boundary violation even when the tier allows the import.

## Files and modules

| Rule | Detail |
|---|---|
| One file, one job | Target < 200 LOC. Hard ceiling ~500. Split before you exceed it. |
| Header comment | 1–4 lines naming the module's single responsibility. |
| File names | `kebab-case.ts`. Solid components are `PascalCase.tsx` + `PascalCase.module.scss`. |
| Named exports only | No default exports, anywhere. |
| Barrels | Explicit re-exports. `export *` only from a pure-types module. |
| Type imports | `import type` / `export type` — `verbatimModuleSyntax` is on. |
| Tests | `<file>.test.ts`, next to the source. |
| Comments | Explain **why**. Never what. |

## Types

- **No `any`.** Biome fails the build. Use `unknown` plus a schema parse at the boundary.
- Strict everything: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. All on. Don't disable one to unblock yourself.
- Discriminated unions + `assertNever()` for exhaustive switches. Handle every case or fail loudly.
- Make illegal states unrepresentable. A required field in the type beats a runtime check in a handler — that's how `job.idempotencyKey` and `route.offline` work.
- Branded types for ids (`Brand<string, 'PostId'>`) so a post id can't be passed where an org id belongs.

## Errors

**Never throw a bare `Error`.** Every throw is an `UltimateError` subclass:

```ts
throw new UltimateError({
  code: 'X_DB_DRIFT',
  cause: 'table "posts" has column "publish_at" not present in any migration',
  fix: 'x db gen "add publish_at"',
  docs: 'https://ultimate.dev/errors/X_DB_DRIFT',
});
```

| Rule | Detail |
|---|---|
| Code format | `X_` + `SCREAMING_SNAKE`. Registered in the package's `src/errors.ts`. |
| Stability | A shipped code is stable **forever**. Agents pattern-match on it. |
| `cause` | The specific fact, with the actual identifier. Not a restatement of the code. |
| `fix` | An **executable command** where one exists. Not advice. |
| Renderings | One source → three outputs: terminal, browser overlay, `--json`. |

Full anatomy: [`04-error-contract.md`](04-error-contract.md).

## Cross-cutting concerns

These four are the framework's promise. Violating one is a build failure, not a code smell.

| Concern | Rule | Fails on |
|---|---|---|
| **i18n** | no hardcoded user-facing strings; everything through `t()` | a key missing from a shipped locale |
| **Theming** | semantic tokens only, both schemes | a raw hex or a named colour in any component or stylesheet |
| **Timezones** | store UTC; format with an explicit IANA zone | a formatter call with no `timeZone`; a cron with no `tz` |
| **Money** | `{ minor: number; currency: string }` | a float amount; a bare `/ 100`; cross-currency arithmetic |

Details and the enforcement mechanisms: [`10-cross-cutting.md`](10-cross-cutting.md).

## Tests

- Every package: at least two tests that would **actually catch a regression**. `expect(true).toBe(true)` is worse than nothing.
- Deterministic: seeded RNG, frozen clock, sealed network. Any unmocked egress fails the test.
- Parallel: each worker owns a Postgres DB cloned via `CREATE DATABASE ... TEMPLATE`. No transaction-rollback hacks, no shared-state flakes.
- Six first-class types: `unit`, `contract`, `live`, `job`, `e2e`, `eval`. Pick the right one.

Details: [`14-testing-internals.md`](14-testing-internals.md).

## Implementation honesty

A skeleton is fine. A lie is not.

| Situation | Do |
|---|---|
| Interface known, backend not built | ship the interface + a working in-memory/PGlite default driver |
| Remote driver not implemented | throw `X_NOT_IMPLEMENTED` with a `fix:` naming the doc or env var |
| Unsupported input shape | throw a specific code — an honest fallback beats a silent wrong answer |
| Tempted to write `// TODO` | don't. A typed throw with a real code is the acceptable form. |

## Dependencies

Default answer: **no**. Bun's natives (`Bun.sql`, `Bun.redis`, `Bun.s3`, WS, test runner, bundler, image) replace most of what you'd reach for. A new dependency needs a justification in the PR body naming what it replaces and why a native won't do.

## Formatting

Biome owns it. Single quotes, semicolons, 2-space indent, 100 columns, trailing commas, organized imports. `bun run lint:fix` before committing; the pre-commit hook does it anyway. Don't hand-format and don't argue with the formatter.

## Docs you write

- Lead with the rule, not the reason. Fragments over sentences.
- Tables for any ≥3-row structure.
- Commands, paths, and code verbatim. Compress the prose around them.
- No meta-framing ("this section covers"), no rhetoric ("critically important"), no trailing summary.
- Date load-bearing claims: `As of 2026-07`.
- A stale doc is worse than a missing one. Delete it.

## The gate

```sh
bun run verify
```

typecheck · lint · import boundaries · tests · migration drift · contract diff · budgets.

Green means shippable. That's the whole contract — with a human reviewer and with an agent alike.
