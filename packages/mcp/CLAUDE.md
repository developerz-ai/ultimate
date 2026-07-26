# @ultimat3/mcp — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http action
query jobs realtime`. **Never** `render manifest ai pwa ui admin testing cli`.

Same-tier data (routes, manifest, policy catalog) arrives as an **injected thunk**, never an
import. The CLI wires it.

## Owns

| File | Job |
|---|---|
| `wire.ts` | JSON-RPC types, error codes, protocol version, `JsonSchema` subset |
| `registry.ts` | catalog + the two security axes (visibility, scope) |
| `validate-args.ts` | JSON-Schema-subset arg validation, applies defaults |
| `server.ts` | JSON-RPC dispatch, `classify` for rate-limit buckets |
| `from-action.ts` | action/query → tool; the "one authz system" projection |
| `resources.ts` | resources + prompts, stable `ultimate://` URIs |
| `dev-server.ts` | the 13 dev tools; depends only on an injected `DevHost` |
| `dev-host.ts` | wires `describe*` from entity/action/query/jobs into a `DevHost` |
| `transport-http.ts` | `POST /mcp` route descriptor, bearer → agent actor |
| `transport-stdio.ts` | NDJSON on stdin/stdout for `x mcp serve` |
| `app-tools.ts` | `defineAppMcp` — a generated app's own MCP surface, one call |
| `app-tool.ts` | the authored `tools: { name: {...} }` record → `ProjectablePrimitive` |
| `exposed.ts` | `include: 'exposed'` — the action/query registries → primitives |
| `input-schema.ts` | Standard Schema → the `JsonSchema` subset `validate-args.ts` enforces |

## Invariants

- Role-hidden → `-32601` ToolNotFound. Scope-missing → `-32600`. Never swap them.
- Resolve order is visibility → scope → args. Validating first leaks a schema.
- A projected action tool has **no `scope`**. The action's policy is the only gate. A
  hand-written app tool is the same: its `policy` reaches `guard()` from `@ultimat3/action`,
  which is the one authz path — never a second check written for MCP.
- `db.query` / `db.migrate` refuse structurally, in `readonly-sql.ts`, before the host runs.
- `transport-stdio.ts` never writes stdout except the wire. Diagnostics → stderr.
- New mutating tool ⇒ set `destructive: true`, or it is metered as cheap read chatter.

## Commands

```
bun test packages/mcp
bun run --filter @ultimat3/mcp typecheck
```
