# 05 — Framework gaps, tiers 4–5: plan budget, concurrency test helpers, verbatim MCP text (conditional)

> Part of [`overview.md`](overview.md). Depends on: 04 (`decide`, `evaluateEach`). Tiers: 4 (`mcp`), 5 (`testing`). Downstream asks.

## Files to change

| Item | Files | Change |
|---|---|---|
| Plan budget for app tests | `packages/testing/src/plan-budget.ts` (new), `index.ts:~389` | `expectPlanWithin(fragment, { maxCost, maxSortRows }, { client? })` — both numbers required, no defaults (axiom 8). `explain (format json)` with real parameters in a read-only transaction, reusing the root reader in `plan-oracle.ts`; reads root `Total Cost` and the largest `Plan Rows` on any `Sort`. Never `EXPLAIN ANALYZE`. `judgePlan` (`plan-oracle.ts:165`) stays internal. |
| | error code | `X_QUERY_PLAN_OVER_BUDGET` (meta `{ totalCost, sortRows, node, table }`; fix names the index from `planFindings` when `judgePlan` has a verdict) via `bun run new-error-code … --package testing` |
| Concurrency helpers | `packages/testing/src/race-actions.ts` (new) | `raceActions(calls, { rounds })` runs calls concurrently, reports any `40P01` (mapped to `X_DB_SERIALIZATION_FAILURE`, `packages/db/src/sqlstate.ts:125`); `expectPartial(result, { allowed, denied })` for `decide()` answers |
| Verbatim MCP text | `packages/mcp/src/runtime-tool.ts:31` | `result?: 'text'` on `RuntimeToolDefinition`; `run` must return a string, else `X_MCP_TOOL_RESULT_NOT_TEXT` — a declared contract, never `typeof` sniffing |
| | `packages/mcp/src/remote-tools.ts:206` | `result?: 'text'` on `mcpTools()` definitions: the text block is the `delimit()` fence itself; `isError` lifted from the output |
| | `packages/mcp/src/from-action.ts:69,157` | internal `textOf?` on `ProjectablePrimitive`; `toolFrom` picks `textResult` (`registry.ts:414`) when present. Carrier for remote actions: package-private `WeakMap` set after `.named()`, like `BUILT` in `runtime-tool.ts`. `truncatedResult` (`query-page.ts:162`) still appends its page block. |

**Gate on verbatim text:** build only when the downstream app's measurement shows > 15% escaping
overhead; put the number in the PR. Without it, C1 idles and the row closes as "transport half only".
A text tool publishes no `outputSchema`/`structuredContent` (changes the tool list) — opt-in per
definition, never a default on `main`.

## Steps

1. Workers: C1 `packages/mcp/src/**` (conditional); C2 `packages/testing/src/{plan-budget*,race-actions*,index}.ts`.
2. Coordinator: codes, manifest, `wiki/Testing.md` ("analyze after seeding; one budget per engine" — PGlite and Postgres costs differ), `wiki/MCP-And-AI.md`, `packages/mcp/README.md`.
3. MCP surface budget (`surface-budget.ts`) re-measured if C1 runs; extend `security.test.ts` + `app-security.test.ts` per `packages/mcp/CLAUDE.md`.

## Tests

- `packages/testing/src/plan-budget.test.ts` (pure, JSON fixtures), `plan-budget-embedded.test.ts`.
- `packages/testing/src/race-actions.live.test.ts`.
- `packages/mcp/src/{from-action,runtime-tool,remote-tools}.test.ts` — the **decoded** text block equals the original fence byte for byte on HTTP and stdio (the JSON-RPC envelope still escapes; what is forbidden is a second serialization layer inside the text); fence red-team cases still hold; JSON tools byte-identical.

## Done when

- A downstream app can delete its own plan judge and use `expectPlanWithin` with its numbers.
- `bun run verify` green.
