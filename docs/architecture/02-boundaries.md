# Boundaries

Every boundary is a **build error**, never a lint warning, never a review convention. Axiom 3: a convention that isn't a build error doesn't exist ([`../idea/00-thesis.md`](../idea/00-thesis.md)).

**One code per condition, not one code for the family.** `X_BOUNDARY_VIOLATION` is this repo's own
tier finding; a generated app's surface rules each carry their own `X_BOUNDARY_*` code, so
`x errors explain` answers the specific mistake instead of a category.

## Framework rules — this repo, `scripts/boundaries.ts`

The script imports no workspace package and reads source through Bun's own transpiler, so the CI job
that runs it needs no `bun install`. Three rules, `As of 2026-08`:

| Rule | Code | Forbids | Prevents |
|---|---|---|---|
| the tier table over `packages/*/src` | `X_BOUNDARY_VIOLATION` | importing anything but a strictly lower tier — sideways and upward both fail, unless the edge is in `SIDEWAYS_ALLOW` | `core` depending on `render`; two packages that must be released together |
| the leaf rule over a tracked app's `shared/` | `X_BOUNDARY_SHARED_LEAF` | `shared/` loading an `app/` or `site/` **module**. Naming its type is allowed | `shared/` stops being a leaf; the graph becomes bidirectional and unbudgetable |
| the admin one-flattener rule | `X_ADMIN_FLATTENER_VIOLATION` | a second flattener beside `entity-columns.ts` | two answers to "how does a row become columns" |

`X_CATALOG_KEY_UNREACHABLE` rides on the same step — the framework catalog defining a key no
framework source can reach. It is a boundary in the same sense: a rule this repo makes about itself
that the framework cannot know.

The **executable** tier table is [`scripts/lib/tiers.ts`](../../scripts/lib/tiers.ts), and the prose
copy in the root `CLAUDE.md` must agree with it — `tier-table-drift.test.ts` asserts them row for
row. The four declared sideways edges are `realtime → query`, `cli → admin`,
`cli → testing` and `create-ultimate → cli`. **`schema → core` is not one of them and never was**:
`packages/schema/src/errors.ts` states outright that schema may not import `@ultimat3/core`, because
core's error machinery would make tier 0 a cycle.

## Generated-app rules — `packages/cli/src/app-boundaries.ts`

Five, each with its own code. `x verify` reports them as findings and `x fix boundary` re-reports the
same violation as a cut, off one rule → code table.

| Rule id | Code | Forbids | Prevents concretely |
|---|---|---|---|
| `site-imports-app` | `X_BOUNDARY_SITE_TO_APP` | `site/` → `app/`, transitively | the marketing page that ships a charting library three hops away from any reviewed file ([`../idea/06-surfaces.md`](../idea/06-surfaces.md)) |
| `shared-is-a-leaf` | `X_BOUNDARY_SHARED_LEAF` | `shared/` → `site/` or `app/` at runtime | `shared/` stops being a leaf |
| `app-imports-api-at-runtime` | `X_BOUNDARY_APP_TO_API` | `app/` → `api/` as a **value** import | bundling server handlers into the client. `import type` is allowed; call the typed client instead |
| route → db | `X_BOUNDARY_ROUTE_TO_DB` | `page.tsx` / `layout.tsx` / `route.ts` importing `@ultimat3/db`, a `*/db` specifier or `drizzle-orm` | N+1 queries in a `<head>` computation, SQL no policy guards, a route that cannot be unit-tested |
| service → http | `X_BOUNDARY_SERVICE_TO_HTTP` | `service.ts` importing `@ultimat3/http` or a `*/http` specifier | a service that only works inside a request — so the identical logic gets re-implemented in a job |

**Seven rules this page claimed and no checker implements**, `As of 2026-08`: `component-holds-logic`,
`cross-feature-repo`, `site-emits-js`, `raw-img`, `raw-hex`, `hardcoded-string`, `date-no-tz`. Nor do
the framework-side `tier-cycle`, `barrel-star`, `deep-import`, `no-any` or `node-api` rule ids exist
as rules — `no-any` is Biome's `noExplicitAny`, and the rest are conventions in
[`00-conventions.md`](./00-conventions.md) that no build error enforces. Per axiom 3 an unenforced
convention does not exist; each is a check somebody has to write before this table can claim it.
The two that *are* separately mechanised have their own steps, not boundary rules: JS bytes are
`X_BUDGET_EXCEEDED` on the `budgets` step, and a surface crossing inside `@ultimat3/render` is
`X_SURFACE_BOUNDARY`.

## How it runs

```
  1. read         every .ts/.tsx under the scanned root
  2. parse        Bun.Transpiler().scanImports — no full typecheck needed
  3. resolve      specifier → owning package (framework) or surface (app)
  4. evaluate     each rule over the edges; type-only edges skip value-only rules
  5. report       one Finding per violation, with the chain and a fix command
```

| Property | Detail |
|---|---|
| Runs in | the `boundaries` step of the gate — `bun run verify` in this repo, `x verify` in an app. **Not** in `x dev`: nothing in `cmd-dev.ts` runs a boundary check, so a violation is found at the gate, not as you type |
| Cost | import scan only, no type resolution |
| Transitive | app rules, yes — `appImportGraph` walks module → module edges. The framework tier rule is per-specifier, which is enough: a package's own imports are what the tier table constrains |
| Type-aware | the app's runtime rules read `scanRuntimeImports`, so an `import type` edge is exempt from `app-imports-api-at-runtime`. The **tier** rule reads `allImportsOf` and applies to type-only imports too — a type edge is still a build-order edge |
| Output | human + `--json`, identical content |

```
X_BOUNDARY_SITE_TO_APP: site/ imported app/
  cause: site/pricing/page.tsx → shared/ui/button.tsx → app/charts/sparkline.tsx → chart.js
  fix:   x fix boundary site/pricing/page.tsx   (or move sparkline out of shared/ui)
```

`x fix boundary <file>` is **analysis and a plan only — it never rewrites a file, and there is no
`--write` flag.** It prints the minimal cut (which edge to delete) and, for the `shared/` fattening
case, the split: the `git mv` plus every import specifier the move invalidates, each named with its
file. `--json` carries the same plan structured, so an agent applies it without re-parsing the
sentence.

## Why the chain matters

A direct-import checker passes the pricing-page case. The import that costs you is three hops from the file anyone reviewed, added by someone who was correct in their own file. Printing the chain converts "bundle too big" into a one-line instruction.

Same reasoning for budgets: a failure names the *transitive import that added the bytes*, never just the total ([`09-rendering-internals.md`](./09-rendering-internals.md)).

## Adding a framework package

| # | Step | Command / file |
|---|---|---|
| 1 | Pick the tier from what it must import — **not** from what it feels like | [`01-package-map.md`](./01-package-map.md) |
| 2 | Write the one-line responsibility. If it needs "and", stop and split | `packages/<name>/README.md` |
| 3 | Scaffold | `bun run scripts/new-package.ts <name> --tier <n>` |
| 4 | Declare deps explicitly in `package.json`, pinned at the lockstep version | `packages/<name>/package.json` |
| 5 | If it needs a same-tier sibling: move the shared **type** down to `core`, and wire the concrete value where both are already visible — or declare the edge, with its reason | `packages/core/src/` · [`scripts/lib/tiers.ts`](../../scripts/lib/tiers.ts) |
| 6 | Add its tier row to **both** copies of the table — the executable one and the prose one | [`scripts/lib/tiers.ts`](../../scripts/lib/tiers.ts) + root `CLAUDE.md` |
| 7 | Add its `X_*` codes, and a row per code in the error reference | `packages/<name>/src/errors.ts` + [`wiki/Error-Codes.md`](../../wiki/Error-Codes.md) |
| 8 | Add it to the root `tsconfig.json` `references` — `tsc -b` builds referenced projects and nothing else | root `tsconfig.json` (`X_PACKAGE_UNREFERENCED`) |
| 9 | Prove the graph still holds | `bun run boundaries` then `bun run verify` |

Rules that keep the graph healthy:

- A new package at tier 0 or 1 needs justification in its README — low tiers are load-bearing for everything above.
- Never raise a package's tier to fix an import. Invert the dependency instead.
- A sibling pinned at a version that is not the lockstep one is `X_RELEASE_VERSION_SKEW` on the `package-shape` step. An **undeclared** dependency that resolves through hoisting is not caught by any step `As of 2026-08` — a convention, not a rule, and the check that should exist would compare each package's imports against its own `dependencies`.
- Cycles are not detected as cycles: the tier rule makes most of them unreachable, and `tsc -b` refuses the rest at build time with its own message rather than an `X_*` code.

## There is no escape hatch

No waiver comment, no `boundaries.allow` key, no global disable, no config flag. This page
documented both of the first two until 2026-08 and **neither has ever existed** — a grep of
`scripts/` and `packages/cli/src/` finds no reader for either, so an agent that wrote one got a
build error with no explanation. They are removed rather than built: a second way to make a rule
not apply is axiom 1 broken, and the framework already has one way.

**Widening the table is the only way to add an edge**, and it is a deliberate act:
`SIDEWAYS_ALLOW` in [`scripts/lib/tiers.ts`](../../scripts/lib/tiers.ts), with a doc-block row
saying why the edge is not a lower-tier extraction. `cli → testing` is the worked example — it was
already live as a relative specifier the checker could not see, and declaring it made the rule
enforce what shipping already assumed.

**Adding a rule of your own is `guards/`.** A file in an app's `guards/` directory
([`packages/cli/src/guards.ts`](../../packages/cli/src/guards.ts)) returns `Finding[]` and rides on
the `boundaries` step, so "green" keeps meaning what it meant. Discovered, never registered — no
`defineGuard`, no index, no manifest row. `x g guard <name>` writes one and its test. What it
returns is held to the error contract: an `X_SCREAMING_SNAKE` code, a non-empty cause and a `fix:`
that passes the same rule every shipped `fix:` passes, or `X_GUARD_FINDING_INVALID`.
