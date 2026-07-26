# @ultimat3/mcp 🤖

The MCP surface. An agent that can reach this package needs no framework documentation — it
asks instead of guessing.

## The dev server: `x mcp serve`

| Tool | Scope | Answers |
|---|---|---|
| `routes.list` | `dev:read` | route table — url, render mode, offline strategy, hydrate, budget |
| `schema.describe` | `dev:read` | entities with columns, types, invariants |
| `policies.list` | `dev:read` | every policy: permission, subject, enforcement points |
| `actions.describe` | `dev:read` | actions + queries: input/output schema, policy, cache tags, MCP exposure |
| `jobs.inspect` | `dev:read` | job definitions, retry policy, steps (omit `name` for all) |
| `queue.depth` | `dev:read` | pending / running / failed per queue |
| `manifest.read` | `dev:read` | `x.manifest.json` verbatim |
| `errors.explain` | `dev:read` | stable `X_*` code → cause + exact fix command + docs |
| `db.query` | `db:read` | **read-only, enforced** — one statement, no writes, no locks, no data-modifying CTE |
| `db.migrate` | `db:migrate` | **branch DB only** — refuses production and any non-branch target |
| `tests.run` | `dev:test` | runs the suite (executes project code) |
| `verify.run` | `dev:test` | `x verify` — the shippable contract |
| `logs.tail` | `dev:logs` | last N lines, optionally per runtime role |

`db.query` and `db.migrate` are gated *and* say so in their own description, so a model that
reads only the catalog still knows what it is holding.

## One authz system, two surfaces

Every `action` with `mcp: { expose: true }` becomes a tool for free, and the tool's `handle`
calls the **same `action.run`** the HTTP route calls. Policy evaluation lives inside `run`.

```
HTTP  POST /api/publishPost  ─┐
                              ├─→ action.run({ input, actor }) ─→ policy ─→ handler
MCP   tools/call publishPost ─┘
```

A projected tool declares **no `scope`** — adding one would put a second gate in front of the
only gate that matters, and the two would eventually disagree. There is no MCP-specific
authorization code to review, because there is none.

## Security posture: hidden ≠ forbidden

Two orthogonal axes, both enforced in `registry.ts`:

| Axis | Declared by | Caller lacks it | Code |
|---|---|---|---|
| visibility (role) | `visibleTo` | omitted from `tools/list`, **ToolNotFound** on call | `-32601` |
| scope (capability) | `scope` | **Forbidden**, message names the missing scope | `-32600` |

Forbidden confirms a tool exists, which turns an authz boundary into a catalog an agent can
enumerate by probing. So a role-hidden tool is indistinguishable from an absent one — even
for a caller holding every scope in the system.

## Their apps are AI-first too

A generated app exposes its own MCP surface with one call, so the user's agents can drive the
user's app:

```ts
// apps/admin/src/mcp.ts
import { defineAppMcp } from '@ultimat3/mcp';

export const mcp = defineAppMcp({
  name: 'acme-admin',
  actions: [publishPost, suspendUser],   // only those with mcp.expose are projected
  queries: [liveFeed, orgUsage],
  resources: [orgExport],
  resolveToken: (token) => sessions.resolveAgentToken(token),
});

// app.config.ts
routes: [mcp.route]                      // POST /mcp, rate-limited per method class
```

## Transports

| Transport | Entry | Auth |
|---|---|---|
| HTTP | `mcpHttpRoute({ server, resolveToken })` → `POST /mcp` | `Authorization: Bearer <token>` → `Actor { kind: 'agent' }` |
| stdio | `serveStdio({ server, caller })` | none — the peer already owns the shell |

The HTTP transport exports a route *descriptor*, not a mounted handler: `@ultimat3/http`
owns the lifecycle, and the descriptor stays drivable from a bare `Request` in a test. It
carries `rateLimitClass(body)` because all MCP traffic is one URL — a per-route bucket would
charge `initialize` to the write bucket and throttle an agent on its handshake.

Reads: 120/min. Writes: 20/min. Unresolvable calls bill the write bucket (fail-closed).

## Resources

| URI | Contents |
|---|---|
| `ultimate://manifest` | `x.manifest.json` — the generated facts |
| `ultimate://openapi.json` | OpenAPI 3.1 projected from actions and queries |
| `ultimate://routes` | route table |
| `ultimate://schema` | entities, columns, invariants |

Providers are injected thunks: `@ultimat3/manifest` and `@ultimat3/render` sit in this same
tier, so the CLI wires them and this package owns only the shape and the URIs.

## Argument validation

`tools/list` hands the agent a JSON Schema, so that document is the thing enforced — there is
no second private validator a tool could be judged against instead. `validate-args.ts`
implements the emitted subset (objects, arrays, enums, `required`, `additionalProperties`,
bounds, `default`) and applies declared defaults. Actions still re-parse authoritatively
inside their own handler.

## Errors

| Code | Meaning |
|---|---|
| `X_MCP_TOOL_UNKNOWN` | no visible tool by that name |
| `X_MCP_SCOPE_MISSING` | visible, but the token lacks the scope |
| `X_MCP_ARGS_INVALID` | arguments failed the declared schema |
| `X_MCP_PROTOCOL` | malformed envelope, unknown method, bad auth header |
| `X_MCP_READONLY_VIOLATION` | `db.query` given a write, or `db.migrate` given a non-branch DB |
