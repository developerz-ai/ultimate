---
name: add-primitive
description: Use when adding or changing an entity, policy, action, mutator, query, job, route, or task in this repo or in examples/dummy. Enforces the eight-primitive rule and the generation chain.
---

# Adding a primitive

## First: does it fit one of the eight?

`entity` · `policy` · `action` · `mutator` · `query` · `job` · `route` · `task`

If it doesn't fit, **stop**. The design is wrong. Don't invent a ninth primitive and don't smuggle the behavior into an unrelated one.

## The order (don't improvise a different one)

Generate each piece — `x g <kind> <name> --feature <slice>` (`x g --help` lists the kinds); the
generator decides the file, writes its test and its i18n keys, and registers it. A slice that does
not exist yet starts with `x g resource <slice>` (`--feature` never invents one: `X_FEATURE_UNKNOWN`).
In-repo, run it as `bun run x -- g … --cwd examples/dummy`.

| Step | Generator |
|---|---|
| 1. entity + invariants, then its migration | `x g entity` · `x db gen "<what changed>"` |
| 2. policy | `x g policy <slice>` writes the slice's `policy.ts`; a second permission set in it is `x g policy <name> --feature <slice>`, which **appends** `<name>:read`/`<name>:write` and its rules to that file (never `--force`: it holds every primitive's rules) |
| 3. action / mutator | `x g action` · `x g mutator` |
| 4. query (live?) | `x g query [--live]` |
| 5. job / task | `x g job` · `x g task` |
| 6. route + meta + offline | `x g route [--surface site\|app]` |
| 7. i18n keys, every shipped locale | `packages/i18n/catalogs/<locale>.json` (`x i18n check`) |
| 8. tests | next to each source file, `bun test ./<path>` |
| 9. the gate | `bun run verify` |

Full walkthrough with commands: `docs/architecture/15-adding-a-feature.md`.

## Rules that will fail the build

- An `action` without a `policy` fails at registration (`X_ACTION_POLICY_MISSING`; a query: `X_QUERY_POLICY_MISSING`). Add the policy first.
- A `job` without an `idempotencyKey` won't typecheck. It's required on purpose.
- A `route` without a coherent `offline` strategy is refused (`X_ROUTE_OFFLINE_MISSING`).
- A `task` without an explicit `tz` is a bug — a cron in an ambiguous zone drifts across DST.
- A route without `meta` is refused (`X_ROUTE_META_MISSING`); a `site/` page without a description fails the `seo` step (`X_SEO_META_MISSING`).
- Any new user-facing string needs a key in **every** shipped locale.

## Don't hand-write what's generated

One `action` already produces the HTTP route, the OpenAPI entry, the typed client method, the MCP tool, the job handle, and a contract test. If you're writing any of those by hand, you're duplicating the generator — check `packages/action/` first.
