# AGENTS.md

Hand-written, deliberately short. The *facts* about this codebase are generated into `x.manifest.json` — read that for routes, entities, actions, jobs, and policies. This file carries only the conventions a generator can't infer.

## What this repo is

The **Ultimate** web framework. Bun-only, Postgres + Drizzle, SolidJS, SCSS tokens. A monorepo of 27 `@ultimat3/*` packages — the `x` CLI among them — plus the unscoped `create-ultimate`. All 28 publish to npm at **1.0.0** in lockstep, `As of 2026-08`.

Semver applies from 1.0.0: breaking the eight primitive shapes, the `x` CLI surface, the tier table, or an `X_*` code needs a major.

## Before you start

```sh
bun install
bun run verify     # the gate. Green = shippable. Run it before you claim done.
```

## The rules that will fail your build

- Imports may only go **down** the tier table in `CLAUDE.md`. Never sideways, never up.
- No `any`. No bare `Error` — subclass `UltimateError` with a code, a cause, and a `fix:`.
- No raw colours. No hardcoded user-facing strings. No date formatted without an explicit IANA timezone. No float money.
- `site/` cannot import from `app/`.
- One file, one job. Split past ~200 LOC.

## The eight primitives

`entity` · `policy` · `action` · `mutator` · `query` · `job` · `route` · `task`

Everything is one of these. If your feature doesn't fit one, the design is wrong — don't invent a ninth.

## Adding a feature

Follow [`docs/architecture/15-adding-a-feature.md`](docs/architecture/15-adding-a-feature.md). It is a checklist with the exact command per step. Don't improvise a different order.

## When you hit an error

Every framework error carries a stable code and an executable fix. Run the `fix:` command. If you don't recognise the code, look it up in [`wiki/Error-Codes.md`](wiki/Error-Codes.md) before guessing.

## Reading the code

Start with `packages/action/` — it's the load-bearing abstraction, and understanding it explains most of the framework. Then `examples/dummy/` for what idiomatic usage looks like.

`bun run x -- mcp serve` gives you the dev MCP server: route introspection, schema, policies, test runs, log tails, read-only queries. Use it instead of grepping.
