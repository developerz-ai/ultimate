# 01 — The confirmation gate reaches in-app agents

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 3 (`action`), 4 (`mcp`, `ai`), 5 (`cli`). **First sweep. Security.**

## Why
Reproduced. One action, gated by `mcpConfirmations({ tools: ['refundOrder'] })`. Same actor kind, same arguments:
- over `mcp.server.handle` → `X_MCP_CONFIRMATION_PENDING`, `refunded []`
- through `asProjectableAction` + `runLlmToolCall` → `{"ok":true}`, `refunded ["B"]`

The gate wraps MCP tools only (`packages/mcp/src/app-tools.ts:242`). The in-app adapter calls `invoke` directly (`packages/ai/src/tools.ts:130-132`). A prompt-injected in-app agent runs what an external agent needs a person to approve, and it is the agent with the less trusted input.

## Files to change
- `packages/action/src/tool-gate.ts` (new) — `registerToolGate(names, gate)`, `toolGateFor(name)`, `gatedToolNames()`. Tier 3, the lowest both `mcp` and `ai` can reach.
- `packages/action/src/registry.ts:157` — `resetActions` also clears the gates, so a reload that re-evaluates modules starts clean.
- `packages/mcp/src/confirmation-gate.ts:59-100` — split `gate()`'s body into a function of `{ tool, args, actor }` and a continuation. `gate()` calls it; so does the registered `ToolGate`.
- `packages/mcp/src/confirmations.ts:115-137` — `mcpConfirmations` registers its gate when called.
- `packages/ai/src/tools.ts:124-132` — `run` passes through `toolGateFor(name)`, read at call time. Hand-built `ProjectableAction`s too, in `asProjectableAction`.
- `packages/cli/src/verify-role-load.ts:43-68` — `registrations()` gains `of('tool gate', gatedToolNames())`.
- `packages/ai/README.md`, `packages/ai/CLAUDE.md`, `packages/mcp/README.md`, `wiki/Agents.md`, `wiki/MCP-And-AI.md`, `wiki/Upgrading.md`.
- `examples/dummy/apps/web/app/posts/actions/review-draft.ts` — the agent lists a gated tool.

## Steps
1. `ToolGate = (call: { tool: string; args: unknown; inputSchema: JsonSchema | undefined; actor: Actor }, run: () => Promise<unknown>) => Promise<unknown>`. Keyed by name because tools are named across both surfaces. One list, `mcpConfirmations({ tools })`, so no `agent({ confirmations })` option an author can forget.
2. **The worker.** A worker imports the API index and every module reaching no document (`packages/cli/src/role-load.ts:100-108`), so a decision action in a module that reaches one is absent there, and its agent would be ungated. `verify-role-load.ts` exists for exactly this: "the build error for everything else a job reads by name". Adding the gate to `registrations()` makes that layout `X_ROLE_LOAD_INCOMPLETE` at the `manifest` step, whose fix already names the import to add. Registration stays in `mcpConfirmations`, with nothing new at boot.
3. **The digest.** The registered gate lives in `mcp`, so it runs `validateArgs(call.inputSchema, call.args)` (`packages/mcp/src/validate-args.ts:26`) and then `inputDigest` (`confirmation-gate.ts:53`): the same validated, defaulted arguments the MCP path digests. A repeat that spells a default differently consumes the approval. Arguments that fail validation open no row: the gate calls `run()`, and `invoke`'s `input:` parse refuses with `X_INPUT_INVALID`.
4. An approval binds actor, tool and digest, not surface. An in-app agent's actor is the user (`packages/ai/src/agent.ts:14`) and an MCP agent's is its own, so they do not meet in practice; the same actor on both shares one row, which is correct.
5. **Several gates on one name.** Two `mcpConfirmations` on one tool stay legal, since the gate is per server (`confirmation-gate.ts:22`). `registerToolGate` keeps the first registered; a later one for that name is a no-op, not an error. MCP servers keep their own gate as today. Any gated tool still waits for a person in-app, which is the property owed. Document which decider answers. No duplicate code: identity would trip on a fresh closure under re-evaluation (`packages/action/src/registry.ts:49-53`).
6. Order in the adapter: the actor half of the policy, then gate, then `invoke`. The first is the call `packages/mcp/src/projectable.ts:68-70` makes (`guardActionBeforeInput`, exported by `action`), inside `withChildContext({ actor })`, so a caller the tool refuses outright opens no row. Replaces the comment at `tools.ts:125`, which holds only while nothing sits before `invoke`.
7. No new run outcome. `X_MCP_CONFIRMATION_PENDING` is 409 (`packages/http/src/error-map-tier-4.ts:95`), so `discloseFailure` shows the model its code, cause and `callerFix`. The model reports through `output`; the user approves through the decision action; a new user turn repeats the call and consumes the approval. `docs/history/ai.md:766` already chose this: no deferred tool.
8. `decide`'s `kind === 'agent'` refusal (`confirmations.ts:122`) does not stop an in-app agent, whose actor is the user. It is held elsewhere: the decision action has no `mcp.expose`, so `agent({ tools: [decide] })` is `X_AGENT_TOOL_UNEXPOSED`. Pin that with a test, and state in the README that exposing the decision action hands an in-app agent its own approval.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_MCP_CONFIRMATION_PENDING` (existing) | now also from an in-app agent's tool call | existing `callerFix` |
| `X_ROLE_LOAD_INCOMPLETE` (existing) | a gate registered only in a module a worker does not load | existing fix |

## Tests
- `packages/ai/src/tools-confirmation.test.ts` (unit): the reproduction, failing today. After approval the repeat runs once, and a second repeat opens a new row. A repeat omitting a defaulted argument consumes the same approval. A policy-refused actor opens no row.
- `packages/action/src/tool-gate.test.ts` (unit): first gate wins; `resetActions` clears.
- `packages/mcp/src/confirmations-projected.test.ts` (unit): MCP order unchanged; two servers with two deciders each keep their own.
- `packages/cli/src/verify-role-load.test.ts` (unit): a gate declared in a module reaching a document is a finding; in a document-free one it is none.
- `bun test packages/ai/src/tools-confirmation.test.ts`

## Semver
Breaking in behaviour, narrowly. An in-app agent calling a tool already in `mcpConfirmations` is refused until approved. An app whose decision action reaches a document goes red on the `manifest` step. `wiki/Upgrading.md`: "a tool in `mcpConfirmations({ tools })` now waits for a person from `agent({ tools })` too. Have the agent's `output` report the pending confirmation id. To keep the old behaviour, remove the tool from one list. With two deciders on one tool, the first registered answers in-app."

## Done when
- The reproduction prints `X_MCP_CONFIRMATION_PENDING` on both paths with `refunded []`.
- `bun run verify` green; `bun run scripts/reference-app-gate.ts` green.
