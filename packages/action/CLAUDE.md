# @ultimat3/action

Owns the `action` + `mutator` primitives and their six projections. Tier 3.

## Boundary

- May import: `core`, `schema` (t0), `cache`, `i18n`, `time` (t1), `entity`, `policy`, `http` (t2).
- Never import: `query`, `jobs`, `realtime` (sideways), or any tier 4-5 package.
- Never re-implement authz, validation or caching — call `policy`, `schema`, `cache`.

## Files

| File | Job |
|---|---|
| `action.ts` | the primitive: `action()`, `describeAction`, the registry-facing name stamp |
| `invoke.ts` | **the one execution path** + the private declaration store `handle` lives in |
| `facade.ts` | the fluent surface — binds each projection to the action, re-implements none |
| `mutator.ts` | action + optimistic `.local` twin + authoritative `.server` + `.conflict` |
| `registry.ts` | export-name registration, collisions, `describeActions()` |
| `http.ts` | route projection + OpenAPI operation |
| `openapi.ts` | deterministic OpenAPI 3.1 document |
| `client.ts` | typed RPC client (browser-safe: no server imports) |
| `mcp-tool.ts` | MCP descriptor, same `invoke` |
| `job-handle.ts` | shape `@ultimat3/jobs` consumes |
| `contract-test.ts` | assertions `x g action` emits |
| `idempotency.ts` | store interface + memory default |
| `policy-gate.ts` | **the only** file that touches `@ultimat3/policy` |
| `naming.ts`, `infer.ts`, `validate.ts`, `json-schema.ts`, `stable.ts`, `tags.ts` | pure helpers |

## Invariants

- Every surface goes through `invoke`: parse input, evaluate policy, handle, parse
  output. Adding a second execution path is the one unforgivable change here.
- The declaration never leaves `invoke.ts`. `defOf`/`stashDef` are internal and must
  never be re-exported from `src/index.ts` — that export is the enforcement.
- An action has no `.def`. Inside the package read it with `defOf(target)`; outside,
  read the lifted `.input`/`.output`/`.policy`/`.mcp` or `describe()`.
- App code reaches a projection through the action (`publishPost.tool()`), never through
  `.def` and never by importing the projection function. `facade.ts` is where a new method
  is bound; the projection itself keeps living in its own file.
- A mutator projects the three names it was authored with — `.local`, `.server`, `.conflict` —
  plus every action façade member, through `named()` and registration alike. No aliases: the
  old `.applyLocal` is gone, not deprecated.
- `mutator.server()` calls the action's own callable, so it lands in `invoke` like every other
  surface. Reaching the declared `server` from there is the second execution path this package
  exists to prevent. `.local()` is the one member that skips the core — it never leaves the
  client, so there is nothing to authorize.
- Registration names the action the app exported, in place — `import { publishPost }` is
  projectable after boot. Naming an already-named action is the only case that twins.
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim**, so an action file imports
  one package. Never wrap, spread or re-declare it: `t` delegates to `schemaProvider()` on every
  access, and a copy would freeze the provider at import time. `index.test.ts` asserts identity.
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
