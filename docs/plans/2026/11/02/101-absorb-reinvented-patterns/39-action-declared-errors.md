# 39 — `errors:` on an action and a query, closed by a red build

> Part of [`overview.md`](overview.md). Depends on: [`09-core-define-error.md`](09-core-define-error.md), [`39-testing-property.md`](39-testing-property.md) (reaches handlers through it; `query`'s `.contract()`). Tier: 0 (`core`), 3 (`action`, `query`), 4 (`mcp`, `ai`, `manifest`), 5 (`cli`).

## Why
A client cannot branch on a refusal the contract does not name. Probe: OpenAPI paths are byte-identical across thrown codes, keys `200, 400, 403, 422`; `http.ts:249-252` lists framework failures only. Every API with a typed client needs per-operation refusals.
Recorded objection: "declared means closed" could only be a log line (axiom 3). Answer: closure is judged at the one place a handler runs and it is red in every test through any surface, plus a static first hop in `contract`, so the failure is a build error in the suite that reaches the path.

## Decisions
| Question | Answer |
|---|---|
| What is judged | only a throw out of `def.handle` / `def.row` (`invoke.ts:277-286`). Policy, parse, rate limit and idempotency sit outside the wrap, so no ambient allow-list exists to go stale |
| Which throws | a coded error whose `statusFor` is 400-499. A 5xx or a statusless code is an outage, not a contract member. `X_ABORTED`, `X_DRAINING` are lifetime, exempt by code |
| Test and dev | raises `X_ERROR_UNDECLARED`, original as `sourceError`. A test expecting the old code goes red, naming the code to add |
| Production | answer unchanged; `logger.warn` and `undeclared_errors_total{primitive,name,code}`. A bookkeeping miss never turns a refusal into a 500 |
| Static half | `.contract()` scans `def.handle.toString()` and `def.row.toString()` for `X_…` literals and `new <Class>(` of a `defineError` class. Probe under `bun test`: source kept `new Late("X_REFUND_TOO_LATE")` and inlined a local const to `"X_OTHER"`. First hop only |
| Reached behind a helper | the dynamic half, driven by any test and by 39-testing-property's generated runs. A path nothing reaches stays unjudged: stated in `wiki/Actions.md`, not hidden |
| Absent `errors` | today's open contract, bytes unchanged. `x g action`, `x g mutator`, `x g query` emit `errors: []` |
| Spelling | code strings: framework codes have no `defineError` class, and one list has one form |
| Shared check | `query` cannot import `action`, so `core/src/declared-errors.ts`. Status is passed in: `http` is above `core`, and both callers already import it |

## Files to change
- `packages/core/src/declared-errors.ts` (new) — `judgeThrown(declared, code, status)`, `scanHandlerSource(source, classCodes)`, the error class.
- `packages/core/src/define-error.ts` (from 09) — class name → code map, read by the scan.
- `packages/action/src/action.ts`, `invoke.ts:286` — the option, the wrap, seating validation.
- `packages/action/src/http.ts:232-253` — `responses` gains a status per declared code; `contract-test.ts` — the assertion.
- `packages/query/src/facade.ts`, `http.ts:66`, `openapi.ts:102,149,193` — same option and responses; `contract-test.ts` (from 39-testing-property), one assertion.
- `packages/manifest/src/schema.ts`, `diff-*.ts` — `ActionFact.errors`, `QueryFact.errors`; a removed declared code is `breaking`, an added one `additive`. `packages/mcp/src/projectable.ts`, `packages/ai/src/tools.ts` — the tool description names the codes; parity test `scripts/ai-mcp-tool-parity.test.ts` covers it.
- `packages/cli/src/templates/action.ts`, query template — emit `errors: []`.
- `examples/dummy/apps/web/app/posts/actions/*.ts` — declare; `wiki/Actions.md`, `wiki/Queries-And-Live-Queries.md`, `wiki/MCP-And-AI.md`, `wiki/Error-Codes.md`, `packages/{action,query}/{README,CLAUDE}.md`.

## Steps
1. `bun run new-error-code` for both codes.
2. `action({ errors: ['X_POST_NOT_FOUND'], … })`, `query({ errors, … })`. At registration each must match `FRAMEWORK_CODE`, have `declaredStatusFor` in 400-499, and not repeat, else `X_ACTION_ERRORS_INVALID`.
3. In `invoke`, around the handler only: on a coded throw, `judgeThrown`. Environment read through `core/src/environment.ts`; an unnamed environment takes the production branch.
4. OpenAPI: per declared code, `responses[status]` carries `Problem` narrowed by `type: { enum: ['urn:ultimate:error:<CODE>'] }` (`problemTypeFor`), merged per status and sorted, so `serializeOpenApi` stays byte-stable. Undeclared actions keep today's bytes.
5. `.contract()` gains one assertion only when `errors` is present. It rejects a literal or class in the first hop outside the list.
6. MCP and in-app tool descriptions end with the list, on both copies, so an agent can plan around a refusal before calling.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_ERROR_UNDECLARED` (status 500: `x dev` raises it inside a request) | test or dev run threw a 4xx code outside `errors`, or the contract scan found one | add `'<CODE>'` to `errors:` in `<name>`, or stop throwing it there. `bun run new-error-code X_ERROR_UNDECLARED --package core --title '…' --cause '…' --fix '…' --off-socket` |
| `X_ACTION_ERRORS_INVALID` (off-socket) | a listed code is malformed, unregistered, not a 4xx, or repeated | `defineError({ code, status })` first, then list it; `x errors explain <CODE> --json` |

## Tests
- `packages/core/src/declared-errors.test.ts` (unit): the status table; scan over a literal, a class, a code in a comment-free helper not seen.
- `packages/action/src/declared-errors.test.ts`, `packages/query/src/declared-errors.test.ts` (unit, same fixture): undeclared raises in test env; production env passes the original and counts; a policy denial and `X_INPUT_INVALID` are never judged. Declared passes.
- `packages/action/src/openapi-errors.test.ts`: undeclared document byte-equal to today's snapshot; declared adds the enum.
- `packages/action/src/contract-test.contract.test.ts`: a handler with a stray `X_` literal fails `.contract()`.
- `packages/manifest/src/diff-registries.test.ts`: removal is breaking. `bun test packages/core/src/declared-errors.test.ts`

## Semver
Minor. Optional field; absent keeps bytes and behaviour. A scaffolded `errors: []` closes new actions from day one.

## Done when
- In `examples/dummy`, removing one code from a declared list fails `x verify --only contract` with the code named.
- The OpenAPI operation for a declared action names its refusals, and `contract-diff` reports removing one.
- `bun run verify`, `bun run scripts/reference-app-gate.ts`, `scaffold-smoke` green.

## Risks
- `toString()` needs unminified server source: true for tests, the only place it runs. A class reached under an alias is missed; the dynamic half still has it.
- Nested `invoke`: an inner action's declared refusal is the outer's to declare too. Correct, since the outer's caller receives it.
