# 41 — Agents on the wire: tokens to the client, other servers' tools, recall under a filter

> Part of [`overview.md`](overview.md). Depends on: [`01-ai-tool-gate.md`](01-ai-tool-gate.md), [`18-ai-scripted-and-meter.md`](18-ai-scripted-and-meter.md) (`scriptedProvider`), [`11-core-outbound.md`](11-core-outbound.md), [`27-mcp-dual-era.md`](27-mcp-dual-era.md). Tier: 0 (`core`), 3 (`action`), 4 (`ai`, `mcp`), 5 (`cli`).

## Why
| Gap | Evidence |
|---|---|
| Streamed tokens stop at the server | `llm().stream()` is an `AsyncIterable` (`ai/src/llm-stream.ts:124`). No route projects it: `action/src/http.ts` answers JSON, `rpc` methods return one value (`action/src/client.ts:125`), and the transport rule forbids `new EventSource(` in the browser (`cli/src/browser-transport.ts:2`). Any chat page must relay tokens by hand, through a channel it invents |
| Agents are silent | "no `.stream()` on an agent" (`wiki/Agents.md:613`), turn events only. A 40 s loop shows a spinner |
| Agents only use the app's own tools | `agent({ tools })` takes actions (`ai/src/agent-def.ts:106`). `mcp` serves but cannot call (`mcp/src/` has no client). MCP is how third parties now publish tools |
| Vector recall under a filter | `searchSql` is `where <scope> order by distance limit k` (`ai/src/pg-vector-sql.ts:124`). No `ef_search` or iterative-scan setting exists (`grep` over `ai/src/pg-vector*`). An HNSW scan finds its nearest candidates and then filters: a small tenant in a big table can get fewer than `k` hits, silently. **Not reproduced**: the probe box's Postgres has no vector extension, so the live test below decides whether step 8 ships |

RAG itself stays: hybrid search, RRF, tenant envelope, reranker seam (`ai/src/vector.ts`, `rag.ts:226`). It is good enough apart from this row.

## Decisions
| Question | Answer |
|---|---|
| SSE or a channel | a channel is fan-out for many readers. A response stream is one answer to one caller, with that call's policy and budget. The rule at `wiki/Client-Data.md:42` keeps channels for events and gains one row for this. Two jobs, one way each |
| Browser API | `fetch` body through `clientTransport`, never `EventSource`: it cannot POST and skips the principal fence. The guard stays as is |
| Wire | `text/event-stream` framing on the action's own route, chosen by `accept`. So third parties get a standard, and OpenAPI documents it |
| Which actions | a stream-declaring action only. `llm()` declares it; `agent()` declares it; an app's `action` may too. No ninth primitive; no second route |
| A remote tool is | an `action()`, so it takes the app's `policy`, the confirmation gate (01), the budget and the manifest row. The model sees one tool list |
| Trust | a remote description is untrusted input. Tool names are pinned at definition, and a changed schema refuses. No auto-discovery at run time |

## Files to change
- `packages/action/src/action.ts` — `action({ stream?: chunkSchema })`; `handle` may be an async generator yielding chunks, returning the output.
- `packages/action/src/http-stream.ts` (new) — frames chunks, `done`, and `error` with the problem body; heartbeat comment; abort on disconnect through `ctx.signal`.
- `packages/action/src/http.ts` — dispatch on `accept`; idempotency and rate limit unchanged.
- `packages/action/src/client.ts:125` — `.stream(input)` on a stream-declaring method, an `AsyncIterable`.
- `packages/core/src/client-transport.ts` — a streaming read through the same credentials, fence and problem decode. Bytes in island budgets: measured, raised by `bun run budget-raises`, only pulled when imported.
- `packages/action/src/openapi*` — the `text/event-stream` response.
- `packages/ai/src/llm.ts:128` — projects through it, so `.stream()` on the server is unchanged.
- `packages/ai/src/agent.ts`, `agent-def.ts:166` — chunks `{ type: 'text' | 'tool_call' | 'tool_result' | 'turn' | 'done' }`. Budget and `maxTurns` unchanged.
- `packages/mcp/src/remote-client.ts` (new), `remote-tools.ts` (new) — `mcpTools()`.
- `packages/core/src/registrar.ts:83` — `mcpTools`, `kind: 'action'`.
- `packages/ai/src/pg-vector-sql.ts:124`, `pg-vector.ts:112,135` — a transaction with `SET LOCAL hnsw.iterative_scan`, if step 8 ships.
- `examples/dummy/apps/web/` — one island reading a streamed `llm()`; one `mcpTools` over the app's own MCP server in a contract test.
- `wiki/Agents.md:71,613,829`, `wiki/MCP-And-AI.md:350,370`, `wiki/Client-Data.md:42`, `wiki/Actions.md`, READMEs, `wiki/Error-Codes.md`.

## Steps
1. An ordinary call on a stream-declaring action runs the generator to its end and answers JSON. So MCP, jobs and `.as()` keep one contract.
2. Each chunk is parsed with `stream` before it leaves. A failure mid-stream is one `error` frame, then close: no second answer. `llm`'s `X_LLM_STREAM_INVALID` keeps its rule.
3. Disconnect aborts `ctx.signal`. Agent run settles through its normal path, and usage is recorded as `unsettled` where it applies (`wiki/Agents.md:448`).
4. Proxies: `x-accel-buffering: no`, and no compression on this type ([`28-assets-compression.md`](28-assets-compression.md) excludes it; add the row).
5. `mcpTools({ name, url, auth, allow: ['search', 'fetchDoc'], policy, confirm? })`. `allow` required. Each name is resolved against a committed `tools.lock.json`, written by `x mcp lock <name>`. Drift: `X_MCP_REMOTE_TOOL_CHANGED`, at boot and in `verify`, which is the convention's build error.
6. Transport through `outbound({ dial: 'public' })`, deadline from `ctx`, sizes capped. Both protocol eras, using [`27-mcp-dual-era.md`](27-mcp-dual-era.md)'s wire. A remote error surfaces as a tool result to the model, per the loop's existing rule.
7. A remote tool's output is delimited as untrusted before it reaches the prompt, and is a mutating action unless the lock marks it read-only, so 01's gate binds by default.
8. Recall: if the live test reproduces the underfill, set `hnsw.iterative_scan = strict_order` and `ef_search` from `max(k, 40)` per search, on an extension version that has it; older versions answer `X_VECTOR_EXTENSION_OLD` naming the upgrade. If it does not reproduce, delete this step and the row above.

## Error codes
`bun run new-error-code` for each new row.

| Code | When | Fix |
|---|---|---|
| `X_ACTION_STREAM_INVALID` (new, off-socket) | `stream` beside a non-generator, or a chunk failing its schema | yield what `stream` declares |
| `X_MCP_REMOTE_TOOL_CHANGED` (new, off-socket) | a schema differs from the lock | review it, then `x mcp lock <name>` |
| `X_MCP_REMOTE_REFUSED` (new, 502) | the remote server failed or refused | check `url` and `auth`; the cause names its status |
| `X_VECTOR_EXTENSION_OLD` (new, off-socket) | the extension has no iterative scan | upgrade the extension |

## Tests
- `packages/action/src/http-stream.test.ts`: frames in order; a denied caller gets a plain 403, no stream; disconnect aborts `ctx.signal`; a bad chunk gives one `error` frame then close.
- `packages/action/src/client-stream.test.ts`: chunks arrive before the end, tested with a held body. Fails if buffered.
- `packages/ai/src/agent-stream.test.ts` with `scriptedProvider` (18): chunks across two turns and a tool; budget still refuses.
- `packages/mcp/src/remote-tools.contract.test.ts`: agent calls a remote tool over HTTP from a second app instance; changed schema refused; gate binds.
- `packages/ai/src/pg-vector.live.test.ts`: 100,000 rows, one tenant of 50, `k: 10` answers 10. Skips with a named reason where the extension is absent.
- `bun test packages/action/src/http-stream.test.ts`

## Semver
minor. `wiki/Agents.md`'s "no `.stream()`" statement is reversed, with a CHANGELOG line.

## Done when
- An island in `examples/dummy` e2e shows tokens arriving before the final answer.
- `bun run verify`, `bun run scripts/reference-app-gate.ts` green.
