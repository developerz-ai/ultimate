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
| `from-action.ts` | action/query → tool; the "one authz system" projection; `toolsFrom` (sweep, skips) vs `toolsListed` (written out, refuses) |
| `resources.ts` | resources + prompts, stable `ultimate://` URIs |
| `dev-server.ts` | the 13 dev tools; depends only on an injected `DevHost` |
| `dev-host.ts` | wires `describe*` from entity/action/query/jobs into a `DevHost` |
| `transport-http.ts` | `POST /mcp` route descriptor, bearer → agent actor |
| `transport-stdio.ts` | NDJSON on stdin/stdout for `x mcp serve` |
| `app-tools.ts` | `defineAppMcp` — a generated app's own MCP surface, one call |
| `app-tool.ts` | the authored `tools: { name: {...} }` record → `ProjectablePrimitive` |
| `exposed.ts` | `include: 'exposed'` — the action/query registries → primitives |
| `input-schema.ts` | Standard Schema → the `JsonSchema` subset `validate-args.ts` enforces |
| `readonly-sql.ts` | layer 3 of `db.query` — the single-read parse — and `db.migrate`'s branch check |
| `query-limits.ts` | layer 4 of `db.query` — the row, byte and timeout ceilings, and what truncation reports |

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
- Exposure is declared at the primitive, never in `defineAppMcp`. A primitive NAMED in
  `actions:`/`queries:` without `mcp: { expose: true }` is `X_MCP_TOOL_UNDECLARED` at boot —
  a written-out list is a request, so filtering it would ship a catalog missing a tool its
  author believes is there. `include: 'exposed'` sweeps the registries and therefore skips,
  because that list is every primitive the app registered, not one anyone wrote out.
- Every boot-time refusal in `defineAppMcp` is an `UltimateError` with a code, never a bare
  throw: `X_MCP_TOOL_UNDECLARED`, `X_MCP_TOOL_UNSAFE`, `X_MCP_TOOL_DUPLICATE`. The caller
  reading them is usually an agent that needs `{ code, cause, fix }`.
- A projected action tool has **no `scope`**. The action's policy is the only gate. A
  hand-written app tool is the same: its `policy` reaches `guard()` from `@ultimat3/action`,
  which is the one authz path — never a second check written for MCP.
- `db.query` / `db.migrate` refuse structurally, in `readonly-sql.ts`, before the host runs
  (`X_MCP_QUERY_REJECTED` / `X_MCP_NOT_BRANCH_DB` — one code each, because they want different
  next commands).
- `db.query` is defended four ways: a SELECT-only role and `BEGIN READ ONLY` in `@ultimat3/db`
  (the CLI wires them — this package must never import `db`), the parse here, and the caps here.
  `limit` is a request, never a permission: `resolveQueryLimits` clamps it into a hard 1000.
- The caps run in the **tool**, not the host. A host that forgets them answers a million rows
  into a model's context. `guards` names the layers that engaged; a layer that could not engage
  is absent from the list, never assumed present.
- `transport-stdio.ts` never writes stdout except the wire. Diagnostics → stderr.
- New mutating tool ⇒ set `destructive: true`, or it is metered as cheap read chatter.

## Commands

```
bun test packages/mcp
bun run --filter @ultimat3/mcp typecheck
```
