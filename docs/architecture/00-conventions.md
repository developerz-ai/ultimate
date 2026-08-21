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

Imports go **down only**. Never sideways within a tier, never upward. Enforced by `bun run boundaries`; a violation names the importing file, the imported module and the allowed tiers.

**The table is not repeated here, on purpose.** [`scripts/lib/tiers.ts`](../../scripts/lib/tiers.ts) is the executable copy and exactly two prose copies are permitted — the root [`CLAUDE.md`](../../CLAUDE.md) and [`01-package-map.md`](01-package-map.md) — because `scripts/tier-table-drift.test.ts` reads those two and nothing else. A third copy on this page went stale in five rows before it was deleted: it still placed `ui` at 5, and had never heard of `db`, `storage`, `flags`, `auth`, `mail` or `scraping`.

**Adding a package:** pick the tier first. If it doesn't fit one, the design is wrong — fix the design, don't widen the table. `bun run scripts/new-package.ts <name> --tier <n>` scaffolds it correctly.

### One declaration, at the lowest tier that can hold it

A closed vocabulary two packages both name goes in the **lowest tier either can import** — not in whichever package "owns" the concept. Re-export it upward from any package whose own signatures take it; a re-export is not a declaration.

Imports only go down, so a sideways need becomes a copy, and a copy drifts **silently**: the route vocabulary (`RenderMode`, `OfflineStrategy`, `HydrateStrategy`) reached **14 declarations across six packages** before `'spa'` was deleted from one of them and five went on admitting it under a green project-wide typecheck — `@ultimat3/pwa`'s copy mapping it to `cache-first`, the one strategy that gives an `app/` route a shared cache entry. It now lives once, at tier 0, in `packages/core/src/route-vocabulary.ts`, with each union derived from its array so the pair cannot disagree.

| Rule | |
|---|---|
| Where | the lowest tier that can hold it — tier 0 for anything the whole graph names |
| Shape | `export const X = [...] as const` and `export type X = (typeof X)[number]`, never a hand-written union beside its array |
| Upward | re-export from each package whose API takes it, so a consumer needs one import |
| Never | restate the members. `bun run scripts/render-modes.ts --json` matches on the **literal set**, not the name — the copy that did the damage was called `PwaRenderMode` |

Two shared members is a copy; one is a coincidence and stays silent. The margin is measured, not guessed: the highest innocent overlap in this repo is **1** (`CacheTier` holds `isr`, `StrategyName` holds `network-only`, `ChangeFreq` holds `never`), `As of 2026-08`.

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
| **Money** | `{ readonly minor: number; readonly currency: string }` — `@ultimat3/schema`'s `MoneyValue`, aliased by `@ultimat3/money` and `@ultimat3/entity` | a float amount; a bare `/ 100`; cross-currency arithmetic; a second declaration of the shape; a `bigint` `minor` |

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
