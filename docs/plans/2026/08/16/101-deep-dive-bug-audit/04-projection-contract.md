# 04 — The projection contract

> Part of [`overview.md`](overview.md). Depends on: none. Tiers: 0 → 4 (land the tier-0 schema half
> first; every other item reads it).

Axiom 2 is *define once, project everywhere*: one `action` yields HTTP + OpenAPI + typed client +
job handle + MCP tool + tests, all consistent. This slice is where that is broken **in code**.

`nullable` was found independently by the tier-0/1 sweep and this one — the strongest signal in the
audit, and the only finding already visible in committed bytes.

## Status, re-derived against the code `As of 2026-08`

Three of the ten entries are live, one carries a named residue, and the enforcement-gaps table is
untouched. An entry left asserting a defect the code does not have sends the next reader to fix
something already correct, so a closed one says so and a void one is struck.

| Entry | State |
|---|---|
| Critical — `nullable` vanishes from every projection | **closed**, both specs regenerated |
| High — `.job()` has no consumer | **open**, unchanged |
| High — the query client encodes what `coerceQuery` cannot decode | **open**, reproduced verbatim |
| High — `useRequestContext()` throws a bare `TypeError` | **closed** — `X_NO_REQUEST` |
| Medium — two input schemas for one tool | **mostly closed**; the residue is named in the entry |
| Medium — `coerceNode` has no `literal` case | **closed** |
| Medium — `normalize()` swallows into a permissive node | **void** — it throws, and did before this slice's PR landed |
| Medium — `sampleString` ignores `pattern` | **closed** — the misattribution is gone |
| Low — `.default(x).optional()` publishes a default `parse` never returns | **closed** |
| Low — `coerceInput` is exported with no caller | **open**, unchanged |
| Enforcement gaps — five unenforced non-negotiables | **open**, all five |

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

  **CLOSED `As of 2026-08`**, exactly as specified: `annotate` emits
  `{ anyOf: [schema, { type: 'null' }], ...annotations }` (`packages/schema/src/json-schema.ts:125-128`),
  annotations stay outside the `anyOf`, and `requiredKeys` is untouched. Both specs are regenerated —
  `examples/dummy/openapi.json:167` now carries the `anyOf` for `coverUrl`, and `coverUrl` is still
  `required` at `:232`. `packages/schema/src/json-schema.test.ts` pins it.

## High

- **OPEN, re-verified `As of 2026-08`** — `packages/action/src/job-handle.ts:16` — the documented
  "action as durable work" projection is
  inert: nothing consumes `kind: 'action-job'`. `ActionJobHandle` exposes
  `{ kind, name, input, idempotencyKey(), invoke() }`; `@ultimat3/jobs` accepts only `JobHandle`
  (`packages/jobs/src/job.ts:110`), a disjoint shape requiring `queue`, `retry`, `concurrency`,
  `timeoutMs`, `parse()`, `idempotencyKeyFor()`, `tenantFor()`, `run()`, `enqueue()`, `as()`,
  `describe()` — and `isJobHandle` (`job.ts:256`) additionally requires `kind === 'job'` plus
  membership in a private `WeakMap` only `job()` writes, so no
  `ActionJobHandle` can ever pass. Repo-wide, `'action-job'` still occurs in four places: its
  declaration, its construction (`:30`), and two test assertions
  (`job-handle.test.ts:36`, `facade.test.ts:91`). `packages/action/CLAUDE.md:25` calls
  `job-handle.ts` "the shape `@ultimat3/jobs` consumes" and `job-handle.ts:2` claims "enqueueing an
  existing action costs zero rewriting" — both false. It is the only one of axiom 2's six
  projections with no consumer. Fix: build a real `JobHandle` through `job()` — an `action → jobs`
  edge is not permitted (both tier 3), so the bridge belongs in `defineApi`'s registrar path, or
  `@ultimat3/jobs` grows a `fromActionHandle` adapter reached through core's registrar table.
  Otherwise delete `.job()` and the claim. Shipping a projection with no consumer is the
  built-but-never-called defect commit `156a847` closed elsewhere.

- **OPEN, reproduced verbatim `As of 2026-08`** — `packages/query/src/client.ts:151` — `searchOf()`
  cannot encode a nested object or a `null`, so the
  typed query client typechecks against inputs the server's own route rejects. `:156` skips `null`
  and `undefined`; `:158` encodes a non-array object member as `JSON.stringify(item)`. The server
  (`packages/query/src/http.ts:43` → `coerceQuery` → `coerceNode`,
  `packages/schema/src/coerce.ts:79`) has no inverse — `case 'object'` returns the raw value
  untouched when it is a string and there is no `JSON.parse` on that path. Proven with
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

  The test this entry asks for does not exist: `packages/query/src/client.test.ts` contains no
  `searchOf`, `coerceQuery` or nested-object case, so nothing would fail if the asymmetry widened.

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

  **CLOSED `As of 2026-08`**, by the first option. `useRequestContext`
  (`packages/http/src/context.ts:235-236`) is now `assertInRequest(member, ambientContext())`, and
  `assertInRequest` (`:223-224`) throws `noRequest(member)`. Re-run inside a plain
  `createContext({})`: `X_NO_REQUEST — the request context was read outside an HTTP request`, with a
  runnable `fix:` (`packages/http/src/errors.ts:244-249`). No bare `TypeError`, and the export at
  `src/index.ts:13` is now safe to keep.

## Medium

- `packages/mcp/src/input-schema.ts:21` — **mostly closed in PR #106; what remains is narrower than
  this entry, and this entry missed the larger half of the same split.** As written: the MCP
  **server** publishes a different input schema than `action.tool()` does, and `from-action.ts`
  documents the wrong one as the source. Two projections of one input exist —
  `packages/action/src/mcp-tool.ts` uses `mcpSchemaOf` (full draft-07 vocabulary);
  `packages/mcp/src/projectable.ts` — the path that actually serves `tools/list` — uses
  `toWireSchema`, whose `narrow()` allow-list omitted `pattern`, `x-ultimate-refinements` and
  `discriminator`. Proven at the time, same schema through both:

  ```
  action .tool():  "orderRef": { "type":"string","minLength":1,"maxLength":8,"pattern":"^ORD-\\d{4}$" }
  mcp server:      "orderRef": { "type":"string","minLength":1,"maxLength":8 }
  ```

  **Closed `As of 2026-08`**: `pattern` is in `wire.ts:91`, in `narrow()` (`input-schema.ts:37`) and
  enforced at `validate-args.ts:125` — with a pattern the server cannot compile *refused* rather
  than skipped, because `tools/list` published it. Both `from-action.ts` comments are corrected; its
  header now names `toWireSchema` as the owner of the schema half and says why the two are not
  interchangeable. The cross-surface test this slice asked for exists:
  `packages/mcp/src/cross-surface.test.ts`.

  **Still open, and smaller**: two functions still answer "what is this action's MCP tool schema".
  `narrow()` now drops exactly `discriminator` and `x-ultimate-refinements`, and flattens an
  `additionalProperties` *schema* to `true` — deliberately, per `input-schema.ts:1-7`: the subset is
  what `validate-args.ts` can enforce, and a keyword the server ignores is worse than an absent one.
  The residual exposure is app code feeding `.tool().inputSchema` to its own MCP host, which
  publishes keywords this server neither publishes nor checks; nothing inside the framework consumes
  `.tool()` (`toMcpTools`/`toQueryTools` have no caller outside their own tests), so no shipped wire
  depends on the difference. Closing it is one of: emit `mcp-tool.ts`'s schema through the same
  narrowing, delete `.tool()`'s schema half, or lift the subset into `@ultimat3/schema` — `action` is
  tier 3 and `mcp` is tier 4, so they cannot share a function anywhere else.

  **The larger half of this split was the tool NAME, and this entry never named it.** The same two
  files also disagreed about what the tool is *called*: `toToolName` published `publish_post` from
  `mcp-tool.ts`, from `http.ts`'s `x-ultimate.mcpTool` and from `action.ts`'s `describeAction`
  (`@ultimat3/query`'s `toQueryTool` had the same bug), while `from-action.ts:82` served
  `publishPost` — the only name `tools/call` accepts. Both tracked apps' committed `openapi.json`
  carried the unserveable names: 15 of the 17 published, every multi-word one. Filed as **#120**
  and fixed on branch `fix/mcp-tool-name-unify`: `toToolName` is deleted from both tier-3 packages, and
  `cross-surface.test.ts` drives a `tools/call` with the name OpenAPI published, so a publisher that
  re-derives is a failing test.

- `packages/schema/src/coerce.ts:29` — `coerceNode` has no `literal` case, so a numeric or boolean
  `t.literal` in a query input can never be satisfied over its own GET route: the switch covers
  `number`, `boolean`, `date`, `array`, `record`, `object`, `money`, `union`, and `literal` falls to
  `default: return raw`. `t.literal(2)` receives `"2"` and `literalSchema`
  (`packages/schema/src/validators.ts:210`) compares with `===`. Proven: `version: expected 2,
  received a string of 1 character`. The same declaration works over an action's JSON body and over
  MCP and is unreachable over the query's own HTTP projection — the endpoint 400s on every request.
  String literals happen to work, which makes it look arbitrary. Fix: add `case 'literal':`
  coercing toward `typeof node.literal`; this also closes `t.union(t.literal(1), t.literal(2))`.

  **CLOSED `As of 2026-08`**: `case 'literal':` is at `packages/schema/src/coerce.ts:44-54`, coercing
  toward `typeof node.literal` — `numeric` for a number, `booleanish` for a boolean, untouched for a
  string. `packages/schema/src/coerce.test.ts` pins it.

- ~~`packages/action/src/json-schema.ts:25` — `normalize()` swallows a conversion failure into a
  permissive node.~~ **VOID `As of 2026-08`: the code does the opposite.** `normalize()` has no
  `catch` and builds no permissive node — it throws `SchemaUnsupportedError`
  (`packages/action/src/json-schema.ts:31-40`), and the fix this entry asked for is the one that
  shipped: `registerAction` calls `assertProjectable` at boot (`packages/action/src/registry.ts:48`,
  `:68-84`), which runs both `jsonSchemaOf` and `mcpSchemaOf` over `input:` and `output:` and
  re-raises `X_SCHEMA_UNSUPPORTED` naming the action and the field, so a registered action can never
  reach a projection that throws. The file header (`:12-21`) and the registry comment (`:60-67`)
  both record the old behaviour as fixed. The entry's last clause is void with it: `llm.ts:397-402`'s
  claim that an inexpressible schema "throws HERE, at declaration time" is now true of every
  projection, not only that call site. **Nothing to do.**

- `packages/action/src/sample-input.ts:32` — `sampleString` ignores `node.pattern`, so `x g action`'s
  generated contract test reports `X_CONTRACT_DRIFT` against a **correct** action: any input using
  `t.string.pattern(...)` fails with drift naming `input:` as the fix, when `input:` is fine. The
  file is candid about this (`:100-104`) and `packages/schema/CLAUDE.md` defers it here — but a
  generated test failing on a supported construct is a false build error. Fix: return a sentinel
  `undefined` for "cannot construct" and have `contractTestsFor` require an explicit sample, or skip
  the policy assertion for that action with a distinct non-failing note.

  **CLOSED `As of 2026-08`**, by the first option, and the misattribution is what was actually
  wrong. `sampleString` still cannot invert a regex — nothing can — but `satisfiesPattern`
  (`packages/action/src/sample-input.ts:58-61`) reads `node.pattern` off the IR and `sampleGaps`
  (`:145`) reports every field whose synthesized value misses it. `assertSampleable`
  (`packages/action/src/contract-test.ts:94-102`) refuses *before* invoking, and its `fix:` is the
  call to paste — `contractTestsFor(<name>, { input: { … } })` — instead of blaming an `input:`
  that is correct. It is still `X_CONTRACT_DRIFT` and the author still supplies the sample; that is
  the design, not the defect.

## Low

- `packages/schema/src/builder.ts:158` — `.default(x).optional()` publishes `default: x` while
  `parse` returns `undefined`: `optional()` wraps the check so `undefined` short-circuits to
  `pass(undefined)` before the default is reached, but leaves `hasDefault`/`default` on the node. A
  client honouring the published default assumes `20`; the server produced absent. Fix: have
  `optional()` strip both fields, or refuse the composition — the two modifiers are mutually
  exclusive by meaning.

  **CLOSED `As of 2026-08`**, by the first option: `optional()` builds from
  `withoutDefault({ ...node, optional: true })` (`packages/schema/src/builder.ts:184-192`), so
  `hasDefault` and `default` are gone from the node and nothing publishes a default `parse` will not
  return. `default()` (`:198-206`) is unchanged and still keeps the declaration.

- **OPEN, re-verified `As of 2026-08`** — `packages/schema/src/coerce.ts:149` — `coerceInput` is
  exported from `src/index.ts:19` with no
  caller anywhere in the framework or either tracked app (only `coerceQuery` is used, at
  `packages/query/src/http.ts:43`).
  Documented as the route-params/form-data path; nothing routes through it. Same built-but-never-called
  shape as the job handle, at much lower cost.

## Enforcement gaps

Five conventions the root `CLAUDE.md` lists as non-negotiable have **no check anywhere** — searched
`packages/cli/src/`, `scripts/`, `biome.json`, `framework.manifest.json`. By axiom 3 they do not exist.

| Convention | Current state |
|---|---|
| no blind `export *` | six package indexes assert it in comments; `X_EXPORT_STAR_FORBIDDEN` now exists **nowhere at all** — the stale `packages/manifest/dist/` copy this entry cited is gone, and there is still no tracked source, no wiki row and no manifest entry |
| no raw colours (semantic tokens only) | no rule, no code, no step |
| no hardcoded user-facing strings outside `t()` | no rule, no code, no step |
| no date formatted without an explicit IANA `timeZone` | `@ultimat3/time` validates a zone when one is passed; nothing stops a call that passes none |
| no float money | `t.money`/`MoneyValue` prevent a float *shape* structurally; no check on arithmetic |

All five are **still open `As of 2026-08`** — re-checked against `scripts/`, `packages/cli/src/` and
`biome.json`, none of which carries a rule for any of them. What did change is the framing: six such
conventions are now *labelled* as unenforced in prose rather than asserted as rules (PR #119), which
is honesty, not enforcement.

All five are decidable by a source scan. Fold them into `package-shape` (which already walks every
`src/index.ts`) or the `lint` walk via the existing `eachSourceFile`, each with its own code — or
strike them from the non-negotiables list. Enforced-and-verified for contrast: file size, package
shape + lockstep, `noExplicitAny`/`noNonNullAssertion`/`noDefaultExport`, `verbatimModuleSyntax`,
tier boundaries, route-file naming (`X_ROUTE_FILE_INVALID`, `packages/render/src/registry.ts:87`),
eight-primitive closure (`registrar.test.ts:64`), the full error-code contract
(`packages/cli/src/error-contract.ts`), manifest drift.

## Tests

Four of the five exist `As of 2026-08`; the one that does not is the one whose defect is still open.

| Test | State |
|---|---|
| `packages/schema/src/json-schema.test.ts` — a `nullable` round-trip pinning the IR field to its emitted `anyOf`; a `nullable` field stays out of `required` | written |
| `packages/query/src/client.test.ts` — nested object and `null` inputs survive `searchOf` → `coerceQuery` → `parse` | **missing** — the file names none of `searchOf`, `coerceQuery` or a nested object |
| `packages/schema/src/coerce.test.ts` — `t.literal(2)` and `t.literal(true)` coerce from a query string | written |
| `packages/action/src/json-schema.test.ts` — an unsupported schema does not publish `additionalProperties: true` | written |
| Cross-surface: one action asserted identical across `.openapi()`, `.tool()` and the MCP server's `tools/list` — the test that would have caught every finding in this slice | written, `packages/mcp/src/cross-surface.test.ts`, and it caught the tool-name split |

## Done when

| Condition | State `As of 2026-08` |
|---|---|
| `nullable` survives to OpenAPI and MCP; both apps' `openapi.json` regenerated and `contract-diff` green on the new bytes | **done** |
| `.job()` either consumes into `@ultimat3/jobs` or is deleted along with its claim in `packages/action/CLAUDE.md:25` | open — no consumer, and the claim still stands |
| The query client and `coerceQuery` agree on every `SchemaKind`, proven by one test over all kinds | open — `object` and `null` still disagree, and no test exists |
| The five unenforced conventions are each a build error or struck from `CLAUDE.md` | open — all five |
| `bun run verify` green | the gate's own business, not this slice's |
