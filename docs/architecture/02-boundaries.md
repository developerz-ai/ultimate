# Boundaries

Every boundary is a **build error**, never a lint warning, never a review convention. Axiom 3: a convention that isn't a build error doesn't exist ([`../idea/00-thesis.md`](../idea/00-thesis.md)).

One error code for the whole family: `X_BOUNDARY_VIOLATION`, plus a `rule` field naming which rule broke. One code keeps `errors.explain` and the docs URL stable while rules are added.

## Framework rules (tiers)

| Rule id | Forbids | Prevents |
|---|---|---|
| `tier-upward` | tier N importing tier > N | `core` depending on `render` — a cycle that makes every package a build-order problem |
| `tier-sideways` | tier N importing tier N (except `schema` → `core`) | `pwa` ↔ `manifest` cycles; two packages that must be released together |
| `tier-cycle` | any cycle at all, including through types | `tsc --build` deadlock, unresolvable publish order |
| `barrel-star` | `export *` from a non-type module | an accidental public API that cannot be removed without a major |
| `deep-import` | `@ultimat3/x/src/internal/y` | reaching past `src/index.ts`; every internal file becomes public surface |
| `no-any` | `any`, `as any`, `@ts-expect-error` without a code reference | the escape hatch that erases the whole type chain ([`05-type-chain.md`](./05-type-chain.md)) |
| `node-api` | `node:*` imports without an allowlist entry | silently breaking the Bun-only guarantee ([`../idea/01-stack.md`](../idea/01-stack.md)) |

## Generated-app rules

| Rule id | Forbids | Prevents concretely |
|---|---|---|
| `site-imports-app` | `site/` → `app/`, transitively | the marketing page that ships a charting library three hops away from any reviewed file ([`../idea/06-surfaces.md`](../idea/06-surfaces.md)) |
| `shared-imports-surface` | `shared/` → `site/` or `app/` | `shared/` stops being a leaf; the graph becomes bidirectional and unbudgetable |
| `app-imports-api-runtime` | `app/` → `api/` as a value import | bundling server handlers into the client. `import type` is allowed; call the typed client instead |
| `route-touches-db` | a route module importing `db` / a Drizzle table / `Bun.sql` | N+1 queries in a `<head>` computation, SQL that no policy guards, and a route that cannot be unit-tested |
| `component-holds-logic` | `ui/**` importing `repo.ts` / `service.ts` / `db` | business rules duplicated per component, and a rule that changes in one screen but not the other |
| `service-imports-http` | `service.ts` importing `Request`/`Response`/`@ultimat3/http` | a service that only works inside a request — so the identical logic gets re-implemented in a job |
| `cross-feature-repo` | `feature-a/**` → `feature-b/repo.ts` | "just add a join" turning a feature slice into a distributed monolith |
| `site-emits-js` | a `site/` route emitting JS without an explicit `hydrate` | the 0kb baseline decaying invisibly ([`09-rendering-internals.md`](./09-rendering-internals.md)) |
| `raw-img` | `<img>` in `site/` | CLS, no `srcset`, no AVIF — use `<Image>` |
| `raw-hex` | a colour literal in any component or `.scss` | breaking dark theme in one component ([`10-cross-cutting.md`](./10-cross-cutting.md)) |
| `hardcoded-string` | a user-facing literal outside `t()` | a string that ships untranslated to every locale |
| `date-no-tz` | `Intl.DateTimeFormat` / `toLocaleString` without `timeZone` | the bug that only appears for a user in Auckland |

## How `scripts/boundaries.ts` enforces them

```
scripts/boundaries.ts
  1. discover     workspaces from package.json, surfaces from app.config.ts
  2. parse        Bun.Transpiler().scanImports on every .ts/.tsx — no full typecheck needed
  3. resolve      specifier → owning package or surface (tsconfig paths + workspace map)
  4. build graph  module → module edges, kind: 'value' | 'type'
  5. evaluate     each rule over the graph; type-only edges skip value-only rules
  6. shortest     on violation, BFS the shortest path from the entry module to the offender
  7. report       UltimateError per violation, with the chain and a fix command
```

| Property | Detail |
|---|---|
| Runs in | the gate (`bun run verify` in this repo, `x verify` in an app) **and** the dev server, as you type |
| Cost | import scan only, no type resolution — whole-repo pass in tens of ms `As of 2026-07` |
| Transitive | yes. Direct-only checking misses the case that actually costs bytes |
| Type-aware | `import type` edges are erased at build, so they are exempt from bundle rules and from `app-imports-api-runtime` |
| Output | human + `--json`, identical content |

```
X_BOUNDARY_VIOLATION: site/ imported app/
  cause: site/pricing/page.tsx → shared/ui/button.tsx → app/charts/sparkline.tsx → chart.js
  fix:   x fix boundary site/pricing/page.tsx   (or move sparkline out of shared/ui)
```

`x fix boundary <file>` is not magic: it prints the minimal cut (which edge to delete) and, for the `shared/` fattening case, generates the split — `shared/ui/button.tsx` stays, `sparkline.tsx` moves to `app/charts/`.

## Why the chain matters

A direct-import checker passes the pricing-page case. The import that costs you is three hops from the file anyone reviewed, added by someone who was correct in their own file. Printing the chain converts "bundle too big" into a one-line instruction.

Same reasoning for budgets: a failure names the *transitive import that added the bytes*, never just the total ([`09-rendering-internals.md`](./09-rendering-internals.md)).

## Adding a framework package

| # | Step | Command / file |
|---|---|---|
| 1 | Pick the tier from what it must import — **not** from what it feels like | [`01-package-map.md`](./01-package-map.md) |
| 2 | Write the one-line responsibility. If it needs "and", stop and split | `packages/<name>/README.md` |
| 3 | Scaffold | `bun run scripts/new-package.ts <name> --tier <n>` |
| 4 | Declare deps explicitly in `package.json` — the graph is checked against declarations, not just imports | `packages/<name>/package.json` |
| 5 | If it needs a same-tier sibling: move the shared **type** to `core`, wire the concrete value in `cli` | `packages/core/src/contracts.ts` |
| 6 | Add the tier row and the graph edge | `docs/architecture/01-package-map.md` |
| 7 | Add its `X_*` codes | `packages/<name>/src/errors.ts` + [`04-error-contract.md`](./04-error-contract.md) |
| 8 | Prove the graph still holds | `bun run boundaries` then `bun run verify` |

Rules that keep the graph healthy:

- A new package at tier 0 or 1 needs justification in its README — low tiers are load-bearing for everything above.
- Never raise a package's tier to fix an import. Invert the dependency instead.
- An undeclared dependency that resolves via hoisting is a violation (`rule: undeclared-dep`), because it breaks on publish.
- Cycles are rejected before rules are evaluated; a cycle report names the smallest cycle, not the whole SCC.

## Escape hatches

There are two, both loud:

| Hatch | Syntax | Cost |
|---|---|---|
| Allowlist a `node:` import | `boundaries.allow` entry in `package.json` with a reason string | shows up in `x verify --json` output as a waiver |
| Waive a rule for one module | `// boundary-allow: <rule-id> — <reason> — <owner>` | expires: `x verify` fails on a waiver older than 90 days |

No global disable. No config flag that turns boundaries off.
