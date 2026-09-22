# 07 — MCP: surfaces, request-aware tokens, audit hook, human confirmation

> Part of [`overview.md`](overview.md). Depends on: 06 (query audit), 01. Tiers: 3 (declaration fields on `action`/`query`), 4 (`mcp`).

Rules:
- An app may serve several MCP **surfaces**. A primitive names the surfaces it is exposed on, and
  `include: 'exposed'` projects only primitives exposed on that surface. The default surface is
  `'default'`, so today's apps are unchanged.
- A mutating tool can require a human: the agent's call becomes a durable pending call, and
  nothing runs until an approving action does.

## Files to change
- `packages/action/src/action.ts:50-64`, and the query twin in `packages/query/src/query.ts` — `mcp.surfaces?: readonly string[]`, defaulting to `['default']`.
  - A catalog fact, like `visibleTo`: static and serialisable.
  - `mcp.confirm?: 'human'`, allowed only on an action whose policy is not `public`. The refusal is at definition time, with the new `X_MCP_CONFIRM_UNSAFE`.
- `packages/mcp/src/app-tools.ts:33-100,140-185` — `DefineAppMcpInput.surface?: string`, default `'default'`. `include: 'exposed'` filters `exposedPrimitives()` by `mcp.surfaces.includes(surface)`. An explicitly listed primitive not exposed on the surface is `X_MCP_TOOL_UNDECLARED`, like today.
  - `AppMcp` gains `surface` and `path`, taken from `input.path`, which is read by the mounter in slice 11. That fixes the ignored `path` (`app-tools.ts:79-80` vs `cli/src/app-mcp.ts:120`).
- `packages/mcp/src/transport-http.ts:62,136` — `resolveToken(token, request: McpRequestFacts)`, where `McpRequestFacts = { headers: Headers; peer: string | null }` and the peer comes from http's `peer-identity.ts` rules. Passed by the route. Additive, so existing one-argument resolvers compile. The allowlist lives in the app's resolver, never as a framework config key.
- `packages/mcp/src/audit.ts:118-155` — `DefineAppMcpInput.onAudit?(entry: McpAuditEntry): void | Promise<void>`, called after the log line for every outcome (`hidden`, `scope-denied`, `invalid-args`, `policy-denied`, `failed`, `ok`).
  - Fields carry the decision, never arguments (the `audit.ts:121-123` rule).
  - A throwing hook is logged as `mcp.audit.hook-failed` and never changes the answer, because an agent must not learn about the sink.
  - The log line stays the one mandatory sink.
- `packages/mcp/src/confirm.ts` (new, < 200 LOC) — `mcpConfirmations({ ttl })`, a factory over existing primitives. It returns:
  - `pendingMcpCalls`, a query (`audit: true`);
  - `approveMcpCall` and `rejectMcpCall`, both actions.

  Each defaults to `mcp.expose: false`, because approval happens in the app's UI, never over MCP.
  - On the MCP surface, calling a `confirm: 'human'` tool:
    - validates the arguments and evaluates the policy first, so a caller who could never run it is refused as today;
    - then writes `x_mcp_pending_calls(id, tool, input_json, actor_json, surface, created_at, expires_at, state)`;
    - then answers a tool result `{ status: 'confirmation_required', pendingId, expiresAt }` with `isError: false`, and the code `X_MCP_CONFIRMATION_REQUIRED` in the audit line.
  - `approveMcpCall({ pendingId })`, under its own policy, runs the stored call through `invoke` **as the original actor** (`withChildContext`, `action/src/invoke.ts:100`) with `idempotencyKey = pendingId`, so a double approve runs once. `approvedBy` is recorded in the audit sink.
  - Expired approvals: `X_MCP_CONFIRMATION_EXPIRED`.
  - DDL `SQL_MCP_PENDING_TABLE` is exported for slice 11 to add to `FRAMEWORK_SCHEMA` (`packages/cli/src/framework-schema.ts:34`).
- `packages/core/src/registrar.ts` — add the rows for `approveMcpCall`, `rejectMcpCall` and `pendingMcpCalls` to `PRIMITIVE_FACTORIES`, which `scripts/primitive-factories.test.ts` enforces.
- `packages/mcp/src/errors.ts` — `X_MCP_SURFACE_DUPLICATE` (two `AppMcp`s with one surface or path; thrown by slice 11, registered here), `X_MCP_CONFIRMATION_REQUIRED`, `X_MCP_CONFIRMATION_EXPIRED`, `X_MCP_CONFIRM_UNSAFE`.
- `packages/mcp/README.md`, `wiki/MCP-And-AI.md` (the gate-order table near `:120-126`) — gate order becomes: visibility → **surface** → scope → arguments → policy → **confirm**.

## Steps
1. Add `surfaces` to the action and query declarations, and the filter in `defineAppMcp`. `path` and `surface` go on `AppMcp`.
2. Add request facts to `resolveToken`, then `onAudit`.
3. `mcpConfirmations`: table DDL, the pending-call write, then approve and reject, then factory rows.

## Tests
- `bun test packages/mcp/src/app-tools.test.ts packages/mcp/src/transport-http.test.ts packages/mcp/src/audit.test.ts packages/mcp/src/confirm.test.ts`.
- Two `defineAppMcp` calls with surfaces `default` and `admin`. An action with `surfaces: ['admin']` is absent from `default`'s `tools/list` and present in `admin`'s.
- The resolver receives the `x-forwarded-for`-resolved peer.
- `onAudit` sees a scope denial. A throwing hook leaves the response byte-identical.
- A confirm tool: its call writes one pending row and runs no handler (spy). Approve runs it once, and a second approve is a replay. After expiry, approve is `X_MCP_CONFIRMATION_EXPIRED`. A caller whose policy denies gets `X_FORBIDDEN` and no row.

## Done when
- A confirm-required mutating tool has zero side effects until `approveMcpCall`.
- A staff-only action cannot appear on the default surface without naming it in `surfaces`.
