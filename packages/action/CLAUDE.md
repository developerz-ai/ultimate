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
| `sample-input.ts` | a value `input:` accepts, from its own IR — what makes the policy assertion reach a policy |
| `idempotency.ts` | store interface + memory default |
| `policy-gate.ts` | **the only** file that touches `@ultimat3/policy` |
| `cache-gate.ts` | the post-commit bust — **the only** file that calls `invalidateTags` |
| `audit.ts` | the audit seam: `AuditRecord`, `AuditSink`, the memory sink, the installed-sink store |
| `audit-gate.ts` | **the only** file that calls a sink, and where the two failure policies live |
| `type-pins.ts` | compile-time assertions `tsc` checks — what the erased view projects, and why `client()` is not part of it |
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
- **`AnyAction` projects every surface, `client()` excepted.** The registry answers in the erased
  view — `listActions()`, `getAction(name)` — so a member missing from it is a projection the
  registry cannot reach: `.job()` was absent until 2026-08 and `getAction('publishPost')?.job()`
  was a type error against an object that has had the method since `facadeFor` bound it. `job()`
  erases because `ActionJobHandle`'s members are method-syntax (bivariant parameters) and its
  output erases to `unknown`; `ClientMethod` is a **function type**, so its input is
  contravariant and `(input: unknown) => …` is a supertype of no concrete action's method. Both
  halves are build errors in `type-pins.ts`, never a comment — and type claims go there, never in
  a `.test.ts`, because `tsconfig.json` excludes tests and `tsc` never reads one.
- **The client keeps the server's error code and marks it remote.** A `problem+json` failure
  becomes `RemoteActionError` (`errors.ts`), which re-uses the code off the wire the way
  `ActionDeniedError` re-uses the policy decision's — and then says so, because the browser
  bundle never registered it: `name` marks it in a stack, `meta.origin: 'remote'` marks it in
  `--json`, the overlay and the error reporter. **It never synthesizes a docs URL.**
  `https://ultimate.dev/errors/X_SIGNUP_CLOSED` for an app-declared code is a 404 dressed as
  documentation; the link is the server's own `docs`/`type` when it sent an `http(s)` one, this
  build's registered link when `hasErrorCode` knows the code, otherwise `ERROR_DOCS_BASE`. The
  code must be `X_SCREAMING_SNAKE` to be taken at all — `typeof code === 'string'` accepted `""`
  from a gateway — and anything else is `RpcFailedError`, which is what that code means.
  `docs` and `type` travel to `remoteDocs` as an ordered pair, not `docs ?? type`: preference is
  not selection, and picking the preferred slot on presence alone let one `javascript:` string
  bury a perfectly good `type` the same response had already offered.
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
- **The policy contract test asserts `ActionDeniedError`, and it sends valid input to get there.**
  It sent `{}` and accepted any `UltimateError` until 2026-08, so every action with a required
  field failed `input:` before `guard()` ran and the assertion passed on `X_INPUT_INVALID` —
  including one whose policy was `allow()`. `sampleInput` builds the payload from `input:`'s own
  IR (required keys only) so the invocation reaches the policy; the class, not `X_FORBIDDEN`, is
  the assertion, because `ActionDeniedError` re-uses the policy decision's code and `can()`
  answers a null actor with `X_UNAUTHENTICATED`. **Only `X_INPUT_INVALID` becomes
  `X_CONTRACT_DRIFT`** — it is the one code `invoke` raises before `guard()` is reached, and
  `input:` is the one knob that answers it. Everything else keeps its own code and its own fix:
  saying `X_OUTPUT_INVALID … before its policy decided` named a stage nothing had checked and
  offered a fix that changes nothing, and it hid the `allow()` whose handler threw — the authz
  escape this assertion exists to catch. A non-`UltimateError` (a `row:` loader's own
  `TypeError`) is rethrown untouched too: its stack is the thing worth reading.
  `contract-test.contract.test.ts` drives all three assertions against actions built to fail them.
  **`X_AUDIT_SINK_MISSING` is the one code assertion 1 passes through as well**, for the same
  reason: `auditSinkFor` runs *before* `validateInput`, so "the schema accepted garbage" is a
  false statement about it and `tighten input:` is a fix that changes nothing. It is the only
  refusal that precedes the parse — a second one is a design mistake, not a second entry here.
- **The audit seam ships the mechanism and none of the row.** `audit: true` on a declaration
  wraps `execute` — it never forks it — so a **denied** attempt is recorded, which is the whole
  reason this lives in the framework: `guard` throws before `handle`, so nothing an app writes
  around its own handler could ever see one. What reaches the sink is what `invoke` already holds
  (`at` from `ctx.now()`, the name, the mutator brand, the surface, the whole `ctx`, the parsed
  input, the namespaced idempotency key, `replayed`, the outcome, the failure code). What does
  **not** ship, ever: an audit entity, a schema, a retention policy, a storage backend, a hash
  chain, a subject index, or an opinion on what "who" means under impersonation — four apps model
  those four ways, so by axiom 8's own test they are business convention and shipping one makes
  three of them wrong. `result` is absent for the same reason and one more: a handler's return is
  reachable from the handler itself, so shipping it would be this package deciding a row carries
  an after-image, which is `@ultimat3/admin`'s `diff` convention arriving one tier down.
- **The audit vocabulary is `@ultimat3/admin`'s, shared by name and not by import.** `AuditOutcome`
  is the same three words (`allowed | denied | failed`) and `AuditSink` the same noun; `admin` is
  tier 5 and this is tier 3, so there is no edge to share them over. **Known duplicate**: admin's
  `AuditSink` writes a fixed `AuditEntry` requiring an `AdminActor` and a `permission`, and it is
  called only from `admin/crud.ts`, so an action outside `/admin` still produces nothing there.
  Unifying them means lifting the vocabulary into `@ultimat3/core` — the only tier both reach —
  and rebuilding `admin/audit.ts` on this seam. Not done here: `admin` is a shipped public API
  and its `AuditEntry` is a different shape.
- **A sink may not silently swallow, and the two failure policies are deliberate opposites.**
  `X_AUDIT_SINK_MISSING` is raised *before* the input parse, so an audited action nothing can
  record refuses with no committed write behind it — there is deliberately no logger-backed
  default sink, because a line nobody stores satisfies the declaration while recording nothing.
  A sink that refuses an **allowed** record fails the invocation (`X_AUDIT_SINK_FAILED`), which
  is the inverse of `cache-gate.ts`'s absorb-and-log: a dropped cache entry expires by TTL and
  the stack heals itself, while nothing ever re-derives an audit row that was never written. It
  is post-commit all the same, so the cause says the handler already committed rather than
  implying a rollback. **Its `fix:` branches on `record.idempotencyKey !== null` — the
  INVOCATION's fact, never the declaration's `idempotent`.** A retry replays instead of re-running
  only when this call reserved a record, and `invoke` reads
  `def.idempotent === true ? (options.idempotencyKey ?? null) : null`, so a non-idempotent action
  and an idempotent one whose caller sent no header collapse to the same `null`. The unqualified
  "retry with the same Idempotency-Key" told a caller to apply a committed write twice — an
  axiom-4 violation dressed as a fix line. Requiring `idempotent: true` at declaration was the
  other candidate and was rejected: it would not have made the message true (the header is still
  the caller's), and it would force the idempotency store on every app that wants only an audit
  trail — "which writes must be retry-safe" is the app's call, not this package's.
  `meta.replayable` carries the same fact to `--json`, and `audit.test.ts` pins both branches so
  the text cannot drift back. A sink that refuses a **denied or failed** record is logged as
  `audit.sink.failed` and the original error still reaches the caller — `X_AUDIT_SINK_FAILED`
  there would hide the `X_FORBIDDEN` and would answer a probing client differently depending on
  whether the audit backend was up, which is an oracle.
- **`auditSettled` sits outside the `catch`, not inside it.** Inside, its own
  `X_AUDIT_SINK_FAILED` fell into the failure branch and wrote a *second* record saying the
  action `failed` — for a handler that had committed. An audit trail lying about a write is
  worse than no audit trail; `audit.test.ts` counts the records a refusing sink was offered.
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
- **`registerAction` guards the derived PATH as well as the name.** `X_ACTION_DUPLICATE` only ever
  asked about the name, so `archiveOrder` and `archiveOrders` — one route, by `pluralize`'s
  deliberate "a trailing `s` is already plural" rule — both registered and both projected: the
  router table seated whichever came last and the other was unreachable over HTTP while its
  OpenAPI operation and MCP tool still advertised it. `paths` is a second index, cleared by
  `resetRegistry` with the first, and the refusal is `X_ACTION_PATH_DUPLICATE`.
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
