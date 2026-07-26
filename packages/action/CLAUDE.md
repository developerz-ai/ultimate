# @ultimat3/action

Owns the `action` + `mutator` primitives and their six projections. Tier 3.

## Boundary

- May import: `core`, `schema` (t0), `cache`, `i18n`, `time` (t1), `entity`, `policy`, `http` (t2).
- Never import: `query`, `jobs`, `realtime` (sideways), or any tier 4-5 package.
- Never re-implement authz, validation or caching — call `policy`, `schema`, `cache`.

## Files

| File | Job |
|---|---|
| `action.ts` | the primitive + `runAction`, the one execution path |
| `mutator.ts` | action + optimistic local twin + conflict strategy |
| `registry.ts` | export-name registration, collisions, `describeActions()` |
| `http.ts` | route projection + OpenAPI operation |
| `openapi.ts` | deterministic OpenAPI 3.1 document |
| `client.ts` | typed RPC client (browser-safe: no server imports) |
| `mcp-tool.ts` | MCP descriptor, same `runAction` |
| `job-handle.ts` | shape `@ultimat3/jobs` consumes |
| `contract-test.ts` | assertions `x g action` emits |
| `idempotency.ts` | store interface + memory default |
| `policy-gate.ts` | **the only** file that touches `@ultimat3/policy` |
| `naming.ts`, `infer.ts`, `validate.ts`, `json-schema.ts`, `stable.ts`, `tags.ts` | pure helpers |

## Invariants

- Every surface goes through `runAction`. Adding a second execution path is the one
  unforgivable change in this package.
- No policy at registration → `X_ACTION_POLICY_MISSING`. No exceptions, no flag.
- `serializeOpenApi` output must be byte-stable: sorted keys, sorted registry, no clock.
- `client.ts` stays free of server imports — it is bundled into the browser.
- Authz goes through `enforce(surface, policy, { input, actor, ctx })` from
  `@ultimat3/policy`; a returned denial becomes `ActionDeniedError`, which keeps the
  policy's own code (`X_FORBIDDEN`, `X_UNAUTHENTICATED`) and carries the surface
  denial. `policy-gate.ts` is the only file that imports the policy package.

## Commands

```
bun test packages/action
bun run typecheck
```
