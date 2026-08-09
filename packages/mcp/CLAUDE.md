# @ultimat3/mcp — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http action
query jobs realtime`. **Never** `render manifest ai pwa ui admin testing cli`.

Same-tier data (routes, manifest, policy catalog) arrives as an **injected thunk**, never an
import. The CLI wires it.

## Owns

| File | Job |
|---|---|
| `wire.ts` | JSON-RPC types, error codes, protocol version, `JsonSchema` subset |
| `registry.ts` | catalog + the first two security outcomes (visibility, scope) |
| `audit.ts` | one structured line per `tools/call`, outcome → level |
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

- Three outcomes, never blurred: role-hidden → `-32601` ToolNotFound with no `data`;
  scope → `-32600` `X_MCP_SCOPE_DENIED` naming the scope; policy → an `isError` result
  carrying `X_POLICY_DENIED`. Swapping any two is an enumeration oracle.
- `visibleTo` is **fail-closed** and may be a predicate over the caller — never over the
  arguments, so existence cannot be probed by varying input. `tools/list` is per caller.
- Resolve order is visibility → scope → args → policy. Validating first leaks a schema;
  running the policy first decides a refusal from attacker-supplied input.
- Every outcome is audited via `audit.ts`, hidden included, at `warn`. Never log arguments
  or row data — a denial reason naming a row is a leak wearing an audit line's clothes.
- `security.test.ts` is the executable contract for all of the above. Extend it, never
  weaken it.
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
