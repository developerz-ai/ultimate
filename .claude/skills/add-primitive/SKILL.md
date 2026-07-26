---
name: add-primitive
description: Use when adding or changing an entity, policy, action, mutator, query, job, route, or task in this repo or in examples/dummy. Enforces the eight-primitive rule and the generation chain.
---

# Adding a primitive

## First: does it fit one of the eight?

`entity` · `policy` · `action` · `mutator` · `query` · `job` · `route` · `task`

If it doesn't fit, **stop**. The design is wrong. Don't invent a ninth primitive and don't smuggle the behavior into an unrelated one.

## The order (don't improvise a different one)

| Step | Lands in |
|---|---|
| 1. entity + invariants | `<feature>/entity.ts` |
| 2. policy | `<feature>/policy.ts` |
| 3. action / mutator | `<feature>/actions.ts` |
| 4. query (live?) | `<feature>/live.ts` |
| 5. job / task | `<feature>/jobs.ts` |
| 6. route + meta + offline | the page file |
| 7. i18n keys, every shipped locale | `packages/i18n/<locale>.json` |
| 8. tests | next to each source file |
| 9. `bun run verify` | — |

Full walkthrough with commands: `docs/architecture/15-adding-a-feature.md`.

## Rules that will fail the build

- An `action` without a `policy` fails at registration. Add the policy first.
- A `job` without an `idempotencyKey` won't typecheck. It's required on purpose.
- A `route` without `offline` won't typecheck. Same reason.
- A `task` without an explicit `tz` is a bug — a cron in an ambiguous zone drifts across DST.
- A `site/` route without a `meta` description is a build error.
- Any new user-facing string needs a key in **every** shipped locale.

## Don't hand-write what's generated

One `action` already produces the HTTP route, the OpenAPI entry, the typed client method, the MCP tool, the job handle, and a contract test. If you're writing any of those by hand, you're duplicating the generator — check `packages/action/` first.
