# 10 — One guard pipeline for action and query

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 2 (`policy`), 0 (`core`, gate shapes). [`11`](11-action-query.md) adopts it.

## Why
`action` and `query` are tier-3 siblings and cannot import each other, so 18 same-named file pairs implement one pipeline twice: `policy-gate`, `rate-limit-gate`, `audit-gate`, `declared-errors*`, `exercise*`, `openapi-errors`, `stable`, `facade`, `registry`. They have drifted: the policy gates differ by 65 lines, the declared-errors contracts by 34 after normalising names. Symptom: the query MCP `admit` uses surface `'server'` while `run` uses `'mcp'` (`mcp/src/projectable.ts`). Axiom 1.

## Files to change
- `packages/policy/src/guard-primitive.ts` (new): `guardPrimitive(kind, policy, subject, surface)` — the actor check, row check, surface rules, the decision event. Exported from `policy/src/index.ts`.
- `packages/core/src/gate-shapes.ts` (new): the rate-limit and audit gate *shapes* both packages use (types + pure helpers, no I/O).
- `packages/policy/README.md`, `packages/policy/CLAUDE.md`.
- `packages/mcp/src/projectable.ts` — one surface for admit and run (`'mcp'`).

## Steps
1. Diff each twin pair (`diff -u packages/action/src/policy-gate.ts packages/query/src/policy-gate.ts`, …). For every behavioural difference, decide which is right; record each in the PR body. A difference with no reason is a bug: pick the stricter.
2. Move the common half into `guardPrimitive`; [`11`](11-action-query.md) turns both `policy-gate.ts` files into thin adapters.
3. Fix the MCP surface split.

## Tests
- `policy/src/guard-primitive.test.ts`: the union of both packages' current policy-gate tests, run once.
- `mcp/src/projectable.test.ts`: admit and run see `'mcp'`.
- `bun test packages/policy packages/mcp/src/projectable.test.ts`

## Done when
- After [`11`](11-action-query.md): `action/src/policy-gate.ts` and `query/src/policy-gate.ts` are each < 60 lines and import `guardPrimitive`.
