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
| `define-api.ts` | `defineApi({ actions, mutators, queries, llm, jobs, tasks })` — the app's one boot call |
| `http.ts` | route projection (`enforcedBy: 'handler'`) + OpenAPI operation |
| `openapi.ts` | deterministic OpenAPI 3.1 document |
| `client.ts` | typed RPC client (browser-safe: no server imports) |
| `mcp-tool.ts` | MCP descriptor, same `invoke` |
| `job-handle.ts` | shape `@ultimat3/jobs` consumes |
| `contract-test.ts` | assertions `x g action` emits |
| `idempotency.ts` | store interface + memory default |
| `policy-gate.ts` | **the only** file that touches `@ultimat3/policy` |
| `cache-gate.ts` | the post-commit bust — **the only** file that calls `invalidateTags` |
| `naming.ts`, `infer.ts`, `validate.ts`, `json-schema.ts`, `stable.ts`, `tags.ts` | pure helpers |

## Invariants

- Every surface goes through `invoke`: parse input, evaluate policy, handle, parse
  output. Adding a second execution path is the one unforgivable change here.
- The declaration never leaves `invoke.ts`. `defOf`/`stashDef` are internal and must
  never be re-exported from `src/index.ts` — that absence is the enforcement, and
  `index.test.ts` is what makes it one.
- **`toRoute` sets `enforcedBy: 'handler'`, so the HTTP pipeline's authz stage stands down.**
  `invoke` is the route's single evaluation and the only one holding the row `def.row` loaded;
  a stage deciding first would decide the same policy from `row: null`, deny the row's own
  author, and never reach the evaluation that had the row. `meta.policy` stays set — dropping
  it would read as "this action is unguarded" in `x routes` and the manifest. `http.test.ts`
  drives a row-level action over the real pipeline and counts the evaluations: exactly one.
- An action has no `.def`. Inside the package read it with `defOf(target)`; outside,
  read the lifted `.input`/`.output`/`.policy`/`.mcp` or `describe()`.
- **MCP exposure is read through `isMcpExposed` from `@ultimat3/core`, in all three places.**
  `toMcpTools` builds the tool, `describeAction` publishes the manifest fact and
  `toOpenApiOperation` publishes `x-ultimate.mcpTool` — the last two fail-opened (`?? true`,
  `!== false`) until 2026-08, so an action with no `mcp` block was advertised as a tool by both
  contract artifacts and refused by the only surface that could serve one. A contract that
  disagrees with the runtime is worse than no contract; never spell the check inline again.
- **The post-commit bust never fails the write it followed.** `cache.invalidates` fans out once the
  handler has committed, so `bustAfterCommit` — `cache-gate.ts`, the only caller of
  `invalidateTags` here — absorbs a fan-out that refuses and answers `undefined`: an undeclared tag
  (`X_CACHE_TAG_UNKNOWN`) must not turn a durable write into a failed action, and those entries
  expire by TTL. One dead tier is not that case; `invalidateTags` already reports it in
  `report.errors`. It logs through core's `logger`, never `ctx.logger` — an HTTP `Ctx` is a cast
  request context that carries none — and never renders the tags, because reading a malformed
  `invalidates` entry back is the second throw the guard exists to stop. **A replay skips the bust
  entirely:** no handler ran, the first call already busted these tags, and re-purging the CDN and
  re-queueing ISR per retry is work for a write nobody made.
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
- `defineApi` is the app's registration call; `registerActions` is what it composes. It reaches
  `@ultimat3/query`'s and `@ultimat3/jobs`' registries through core's registrar table
  (`primitiveRegistrar('query' | 'job' | 'task')`), never a sideways import — and throws
  `X_REGISTRAR_MISSING` rather than skipping a kind whose registrar is absent, because a silent
  skip drops every primitive of that kind.
- **`jobs` and `tasks` belong in the same call, for the same reason `queries` do.** The export
  name becomes the job's durable queue key; a job module nothing hands over keeps `job()`'s
  positional `anonymous-job-<n>`, on every queue row and in the manifest. A definition with its
  own `name:` keeps it — that rule lives in `@ultimat3/jobs`, not here. Jobs register before
  tasks: a task descriptor lists the jobs it enqueues by name.
- `defineApi`'s returned maps are built from the **registrar's own results**, never from the
  modules' exports. A feature module exports helpers next to its primitives; copying every export
  would seat one in `Api['actions']` as a client method nothing serves, and let two modules'
  same-named helpers overwrite each other with no `X_ACTION_DUPLICATE` to raise. The type does the
  same filter, so `rpc<Api['actions']>()` offers only what registered.
- `rpc` is the only name for the map-wide typed client. There is no `createClient` alias.
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
