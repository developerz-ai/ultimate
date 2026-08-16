# 04 — The projection contract

> Part of [`overview.md`](overview.md). Depends on: none. Tiers: 0 → 4 (land the tier-0 schema half
> first; every other item reads it).

Axiom 2 is *define once, project everywhere*: one `action` yields HTTP + OpenAPI + typed client +
job handle + MCP tool + tests, all consistent. This slice is where that is broken **in code**.

`nullable` was found independently by the tier-0/1 sweep and this one — the strongest signal in the
audit, and the only finding already visible in committed bytes.

## Critical

- `packages/schema/src/json-schema.ts:102` — `convert()` never reads `node.nullable`, so every
  projection of a `t.nullable(...)` field contradicts the runtime validator. `SchemaNode.nullable` is
  declared (`packages/schema/src/node.ts:45`), set by `.nullable()` (`builder.ts:154`), and consumed
  by exactly one reader — `packages/action/src/sample-input.ts:65`. `annotate()` applies
  `description`, `default` and `x-ultimate-refinements` and nothing else; `requiredKeys()`
  (`node.ts:102`) filters on `optional`/`hasDefault` only. `null` therefore vanishes from **every**
  surface at once: OpenAPI bodies, MCP `inputSchema`, `respondToolFor` (`packages/ai/src/llm.ts:407`),
  and any generated client. Proven:

  ```
  runtime parse null OK: {"title":"a","coverUrl":null}
  json schema coverUrl:  {"type":"string","format":"uri"}
  json schema required:  ["title","coverUrl"]
  ```

  Already shipped contract, not a latent risk — it is live in both apps' **committed** specs:

  | Spec | Field | Declared |
  |---|---|---|
  | `examples/dummy/openapi.json:167` (required at `:218`) | `coverUrl` | `t.nullable(t.url)`, `examples/dummy/apps/web/app/posts/entity.ts:31` |
  | `examples/dummy/openapi.json:188` | `publishedAt` | `t.nullable(t.date)`, `entity.ts:35` |
  | `dummy/social-media-clone/openapi.json:318` (required at `:335`) | `respondedAt` | `t.nullable(t.date)`, `dummy/social-media-clone/apps/web/app/friends/actions.ts:20` |

  Consequence: an unpublished post returns `publishedAt: null`, which the action's own `output:`
  validator accepts and the published spec forbids — a generated client types it non-null and
  dereferences it, a spec-validating gateway rejects the server's own valid response, and an MCP
  agent can never send `null`. `contract-diff` cannot catch it: the emitter is what is wrong and the
  committed bytes agree with it. No test covers it — `nullable` appears in
  `packages/action/src/sample-input.test.ts:57` and in no `json-schema.test.ts`, `action/*.test.ts`
  or `mcp/*.test.ts`.

  Fix: in `annotate()`, when `node.nullable === true`, wrap as `{ anyOf: [<converted>, { type: 'null' }] }`
  (OpenAPI 3.1 / JSON Schema 2020-12; `packages/mcp/src/wire.ts` already lists `'null'` in its type
  union and `validate-args.ts:117` already handles `case 'null'`). Keep `requiredKeys` unchanged —
  nullable ≠ optional. Add a round-trip test pinning the IR field and its projection together, then
  regenerate both apps' `openapi.json`.

## High

- `packages/action/src/job-handle.ts:16` — the documented "action as durable work" projection is
  inert: nothing consumes `kind: 'action-job'`. `ActionJobHandle` exposes
  `{ kind, name, input, idempotencyKey(), invoke() }`; `@ultimat3/jobs` accepts only `JobHandle`
  (`packages/jobs/src/job.ts:93`), a disjoint shape requiring `queue`, `retry`, `concurrency`,
  `timeoutMs`, `parse()`, `run()`, `enqueue()`, `as()`, `describe()` — and `isJobHandle`
  (`job.ts:218`) additionally requires membership in a private `WeakMap` only `job()` writes, so no
  `ActionJobHandle` can ever pass. Repo-wide, `'action-job'` occurs in four places: its declaration,
  its construction (`:30`), and two assertions in its own tests. `packages/action/CLAUDE.md` calls
  `job-handle.ts` "the shape `@ultimat3/jobs` consumes" and `job-handle.ts:2` claims "enqueueing an
  existing action costs zero rewriting" — both false. It is the only one of axiom 2's six
  projections with no consumer. Fix: build a real `JobHandle` through `job()` — an `action → jobs`
  edge is not permitted (both tier 3), so the bridge belongs in `defineApi`'s registrar path, or
  `@ultimat3/jobs` grows a `fromActionHandle` adapter reached through core's registrar table.
  Otherwise delete `.job()` and the claim. Shipping a projection with no consumer is the
  built-but-never-called defect commit `156a847` closed elsewhere.

- `packages/query/src/client.ts:151` — `searchOf()` cannot encode a nested object or a `null`, so the
  typed query client typechecks against inputs the server's own route rejects. `:156` skips `null`
  and `undefined`; `:158` encodes a non-array object member as `JSON.stringify(item)`. The server
  (`packages/query/src/http.ts:43` → `coerceQuery` → `coerceNode`,
  `packages/schema/src/coerce.ts:60`) has no inverse — `case 'object'` returns the raw value
  untouched and there is no `JSON.parse` on that path. Proven with
  `{ orgId: t.string, filter: t.object({...}), since: t.nullable(t.date) }`:

  ```
  server coerces to: {"filter":"{\"status\":\"live\",\"limit\":10}","orgId":"o1"}
  parse FAILED:      filter: expected an object, received a string of 28 characters
                     since:  expected an ISO-8601 date-time, received undefined
  ```

  `QueryClientMethod` types the argument as `InferInput<TInput>`, so both calls compile — the exact
  failure the file header claims to prevent ("a compile error in a Solid component rather than a 404
  at runtime"). Asymmetric: `@ultimat3/action`'s client sends a JSON body
  (`packages/action/src/client.ts:114`) and round-trips correctly. Fix, in one change touching both
  halves: either constrain `Query`'s `input:` to a flat schema at declaration time with a build error
  naming the offending key, or teach `coerceNode`'s `object`/`record` cases to `JSON.parse` a string
  when the node is structural, and encode `null` as a sentinel the coercer decodes.

- `packages/http/src/context.ts:205` — `useRequestContext()` is an exported public API whose
  unchecked cast (`useContext() as unknown as RequestContext`) hands back an object with `undefined`
  in non-optional fields, failing as a **bare `TypeError`**. Exported from
  `packages/http/src/index.ts:13`; `useContext()` returns core's `Ctx`, which a job, a task, a
  scheduler round or a CLI command all supply. The same file concedes the value can be wrong —
  `assertInRequest` (`:214`) tests `(ctx.requestHeaders as Headers | undefined) === undefined`, a
  cast that only makes sense because the declared type is a lie — and `:196-200` documents a cast in
  the opposite direction as a shipped bug ("Never reintroduce a cast — the type error IS the
  enforcement"). Proven inside an ordinary `createContext({})`:
  `TypeError - undefined is not an object (evaluating 'ctx.requestHeaders.get')`. Violates "never
  throw a bare `Error`" from a public API. Fix: drop the unguarded reader from `src/index.ts` and
  export `assertInRequest`'s behaviour under that name, or return `RequestContext | undefined` — the
  existing `noRequest(member)` error is already the right instruction.

## Medium

- `packages/mcp/src/input-schema.ts:21` — the MCP **server** publishes a different input schema than
  `action.tool()` does, and `from-action.ts` documents the wrong one as the source. Two projections
  of one input exist: `packages/action/src/mcp-tool.ts:43` uses `mcpSchemaOf` (full draft-07
  vocabulary); `packages/mcp/src/projectable.ts:47,60` — the path that actually serves `tools/list` —
  uses `toWireSchema`, whose `narrow()` allow-list omits `pattern`, `x-ultimate-refinements` and
  `discriminator`. Proven, same schema through both:

  ```
  action .tool():  "orderRef": { "type":"string","minLength":1,"maxLength":8,"pattern":"^ORD-\\d{4}$" }
  mcp server:      "orderRef": { "type":"string","minLength":1,"maxLength":8 }
  ```

  Meanwhile `packages/mcp/src/from-action.ts:12` says "`toMcpTool` in @ultimat3/action owns the
  schema half" and `:52` says the field is "as produced by `toMcpTool`" — neither true of the code
  beside them. An agent is given no way to know the format, calls the tool, and gets
  `X_INPUT_INVALID` from the action's own parse — while the OpenAPI spec for that same action *does*
  carry the `pattern`, so HTTP and MCP clients hold different contracts for one declaration. Fix:
  add `pattern` to `wire.ts`'s `JsonSchema`, to `narrow()`, and to `validate-args.ts`'s `string()`;
  then make `mcp-tool.ts` emit through `toWireSchema` too (or delete its schema half) so one function
  answers "what is this action's MCP tool schema". Correct both `from-action.ts` comments in the same
  change.

- `packages/schema/src/coerce.ts:29` — `coerceNode` has no `literal` case, so a numeric or boolean
  `t.literal` in a query input can never be satisfied over its own GET route: the switch covers
  `number`, `boolean`, `date`, `array`, `record`, `object`, `money`, `union`, and `literal` falls to
  `default: return raw`. `t.literal(2)` receives `"2"` and `literalSchema`
  (`packages/schema/src/validators.ts:210`) compares with `===`. Proven: `version: expected 2,
  received a string of 1 character`. The same declaration works over an action's JSON body and over
  MCP and is unreachable over the query's own HTTP projection — the endpoint 400s on every request.
  String literals happen to work, which makes it look arbitrary. Fix: add `case 'literal':`
  coercing toward `typeof node.literal`; this also closes `t.union(t.literal(1), t.literal(2))`.

- `packages/action/src/json-schema.ts:25` — `normalize()` swallows a conversion failure into a
  permissive node (`catch { }` → `{ type: 'object', additionalProperties: true }`), so a schema the
  runtime rejects everything from is published as "any object accepted". `toJsonSchema` throws
  `X_SCHEMA_UNSUPPORTED` (`packages/schema/src/provider.ts:55`) exactly when the spec must not claim
  anything; instead the OpenAPI component and the MCP `inputSchema` both widen while `validateInput`
  still rejects every payload. The stated reason ("a missing OpenAPI detail must not break a
  deploy") inverts axiom 3 — the deploy succeeds and every caller is lied to. `packages/ai/src/llm.ts:407`
  calls `toMcpInputSchema` directly and does *not* degrade, so one unsupported schema throws in one
  projection and silently widens in two others; the `llm.ts:402` comment claiming it "throws HERE, at
  declaration time" is true of that call site only. Fix: let the throw propagate at registration
  (`registerAction` already refuses a missing policy there), or emit `{ not: {} }` with an
  `X_SCHEMA_UNSUPPORTED` description — honest about being unenforceable.

- `packages/action/src/sample-input.ts:32` — `sampleString` ignores `node.pattern`, so `x g action`'s
  generated contract test reports `X_CONTRACT_DRIFT` against a **correct** action: any input using
  `t.string.pattern(...)` fails with drift naming `input:` as the fix, when `input:` is fine. The
  file is candid about this (`:100-104`) and `packages/schema/CLAUDE.md` defers it here — but a
  generated test failing on a supported construct is a false build error. Fix: return a sentinel
  `undefined` for "cannot construct" and have `contractTestsFor` require an explicit sample, or skip
  the policy assertion for that action with a distinct non-failing note.

## Low

- `packages/schema/src/builder.ts:158` — `.default(x).optional()` publishes `default: x` while
  `parse` returns `undefined`: `optional()` wraps the check so `undefined` short-circuits to
  `pass(undefined)` before the default is reached, but leaves `hasDefault`/`default` on the node. A
  client honouring the published default assumes `20`; the server produced absent. Fix: have
  `optional()` strip both fields, or refuse the composition — the two modifiers are mutually
  exclusive by meaning.

- `packages/schema/src/coerce.ts:130` — `coerceInput` is exported from `src/index.ts:19` with no
  caller anywhere in the framework (only `coerceQuery` is used, at `packages/query/src/http.ts:43`).
  Documented as the route-params/form-data path; nothing routes through it. Same built-but-never-called
  shape as the job handle, at much lower cost.

## Enforcement gaps

Five conventions the root `CLAUDE.md` lists as non-negotiable have **no check anywhere** — searched
`packages/cli/src/`, `scripts/`, `biome.json`, `framework.manifest.json`. By axiom 3 they do not exist.

| Convention | Current state |
|---|---|
| no blind `export *` | six package indexes assert it in comments; `X_EXPORT_STAR_FORBIDDEN` exists only in an untracked stale `packages/manifest/dist/` build, in no tracked source, no wiki row, no manifest entry |
| no raw colours (semantic tokens only) | no rule, no code, no step |
| no hardcoded user-facing strings outside `t()` | no rule, no code, no step |
| no date formatted without an explicit IANA `timeZone` | `@ultimat3/time` validates a zone when one is passed; nothing stops a call that passes none |
| no float money | `t.money`/`MoneyValue` prevent a float *shape* structurally; no check on arithmetic |

All five are decidable by a source scan. Fold them into `package-shape` (which already walks every
`src/index.ts`) or the `lint` walk via the existing `eachSourceFile`, each with its own code — or
strike them from the non-negotiables list. Enforced-and-verified for contrast: file size, package
shape + lockstep, `noExplicitAny`/`noNonNullAssertion`/`noDefaultExport`, `verbatimModuleSyntax`,
tier boundaries, route-file naming (`X_ROUTE_FILE_INVALID`, `packages/render/src/registry.ts:87`),
eight-primitive closure (`registrar.test.ts:64`), the full error-code contract
(`packages/cli/src/error-contract.ts`), manifest drift.

## Tests

- `packages/schema/src/json-schema.test.ts` — a `nullable` round-trip pinning the IR field to its
  emitted `anyOf`; a `nullable` field stays out of `required`.
- `packages/query/src/client.test.ts` — nested object and `null` inputs survive `searchOf` →
  `coerceQuery` → `parse`.
- `packages/schema/src/coerce.test.ts` — `t.literal(2)` and `t.literal(true)` coerce from a query
  string.
- `packages/action/src/json-schema.test.ts` — an unsupported schema does not publish
  `additionalProperties: true`.
- Cross-surface test: one action with a `pattern` + a `nullable` field, asserted identical across
  `.openapi()`, `.tool()` and the MCP server's `tools/list`. This is the test that would have caught
  every finding in this slice.

## Done when

- `nullable` survives to OpenAPI and MCP; both apps' `openapi.json` regenerated and `contract-diff`
  green on the new bytes.
- `.job()` either consumes into `@ultimat3/jobs` or is deleted along with its claim in
  `packages/action/CLAUDE.md`.
- The query client and `coerceQuery` agree on every `SchemaKind`, proven by one test over all kinds.
- The five unenforced conventions are each a build error or struck from `CLAUDE.md`.
- `bun run verify` green.
