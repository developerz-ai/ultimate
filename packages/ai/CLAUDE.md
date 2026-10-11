# @ultimat3/ai — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http action
query jobs realtime`. **Never** `mcp manifest render pwa ui admin testing cli`.

Declared today: `action` (the primitive `llm()` returns), `cache` (semantic cache), `core`,
`db` (pgvector), `http` (`statusFor`, so a tool result redacts a 5xx cause as a problem document
does), `jobs` (`agentJob()`), `money`, `policy`, `schema`, `time`.

`jobs` is declared for `agentJob()`: the action→job bridge has to live at tier 4+.

`mcp` is the same tier, so the LLM-tool projection is restated structurally in `tools.ts`, never
imported: same contract, same *decision* (`isMcpExposed` from `@ultimat3/core`, never a local
`=== true`), same NAME (`action.name` verbatim, never derived) and the same TOOL —
`asProjectableAction` and mcp's `primitiveFromAction` are two copies the tier table forces, held
equal by `scripts/ai-mcp-tool-parity.test.ts` (name, description, exposure, the whole input schema
incl. `tool-idempotency.ts`'s reserved `idempotencyKey`, the policy verdict, the replay). A field
one adds, the other adds.

## Owns

| File | Job |
|---|---|
| `models.ts` | the model REGISTRY: `registerModel`, limits, prices, the reasoning controls each one accepts — and NO row of its own |
| `model-resolve.ts` | `resolveModel` / `modelForCall` — declaration → prompt → gateway `defaultModel`, none is `X_AI_MODEL_UNRESOLVED` naming all three; `describedModel` for a published fact |
| `model-fixture.ts` | the rows this package's own suites register (`useFixtureModels()`). Not shipped |
| `provider.ts` | `Provider` interface, the request half, `anthropicProvider()` |
| `echo-provider.ts` | `echoProvider()`, the deterministic double — split from `provider.ts` at its line ceiling |
| `content-blocks.ts` | the `image` / `document` block shapes, the screen every request runs them through, their token estimate |
| `content-errors.ts` | the `X_AI_CONTENT_UNSUPPORTED` class; its code and title belong in `errors.ts` |
| `wire.ts` | the response half: `usage` / `stop_reason` shapes, and the SSE `MessageStream` |
| `error-body.ts` | what a failure body SAYS (`detailOf`) and what must never survive into it (`withoutKey`) — one copy, both transports |
| `sse.ts` | Server-Sent Events framing — protocol only, knows nothing about Anthropic |
| `openai-provider.ts` | `openAiProvider()` — the socket, the credential and the errors for any endpoint speaking the OpenAI chat-completions FORMAT |
| `openai-messages.ts` | the format mapping's request half: `AiMessage` blocks → OpenAI messages, `LlmTool` → functions, `tool_choice` |
| `openai-body.ts` | one chat-completions body, and the per-model reasoning mapping |
| `openai-wire.ts` | its response half: one completion, and `ChatCompletionStream` (fragmented tool calls, trailing usage, `[DONE]`) |
| `gateway.ts` | routing, retries, cache, budget wiring |
| `budget.ts` | token ledgers per request/actor/org, ALS carrier |
| `prompt.ts` | `definePrompt`, `promptHash`, version registry |
| `prompt-fence.ts` | a template's data fences: which tag pairs enclose each slot (`promptFences`), and the closer-breaking `render` applies inside one |
| `embeddings.ts` | `Embedder`, `hashEmbedder()`, cosine helpers |
| `remote-embedder.ts` | `remoteEmbedder()` — the production `/v1/embeddings` client |
| `evals.ts` | `defineEval`, the run, the baseline gate, prompt coverage |
| `eval-baseline.ts` | the recorded scores: path, read/write, what counts as a regression |
| `scorers.ts` | what a `Scorer` is, the built-in ones, and `llmJudge` |
| `vector.ts` | `VectorStore`, in-memory cosine + BM25, RRF hybrid |
| `pg-vector.live.test.ts` | the same store against a real pgvector — DDL, fusion, scope, plan |
| `vector-scope.ts` | the tenant + policy envelope, and the tighten-only derive rule |
| `pg-vector-sql.ts` | every pgvector statement: DDL, upsert, cosine, FTS, RRF fusion |
| `pg-vector.ts` | `postgresVectorStore()` — the production store |
| `rag.ts` | chunker, retriever, reranker, budgeted context assembler |
| `tools.ts` | action → LLM tool definition; the `AgentTool` union and `asProjectableAction`; `runLlmToolCall` |
| `tool-idempotency.ts` | an idempotent action's reserved `idempotencyKey` tool argument — MCP's, restated (same tier), held equal by the parity test |
| `tool-arguments.ts` / `answer-errors.ts` | one argument-string reader for both wires and what an unreadable one means (`assertToolArguments`); `X_LLM_TRUNCATED` + `X_LLM_TOOL_ARGUMENTS_INVALID` |
| `billed.ts` / `run-meter.ts` | `meta.billed` + `billedOf`; the meter every `llm()`/`agent()` provider call goes through |
| `failure-disclosure.ts` | `discloseFailure` — the ONE rule for what of a throw a remote reader sees (tool result, hive member); the withheld half is logged, never its message or cause |
| `llm.ts` | `llm()` — the model call, declared as an `action`; and what a streamed answer must satisfy |
| `respond.ts` | the `respond` tool for one `output` (a non-object one wrapped in `{ value }`), its reader, and `parseJsonish` |
| `llm-stream.ts` | `.stream()`'s plumbing: the sink, the ambient mark, the one-turn drive |
| `agent.ts` | `agent()` — the tool loop, declared as an `action` |
| `agent-def.ts` / `agent-declared.ts` / `agent-system.ts` / `agent-usage.ts` | the declaration's types; its defaults, bound screen, limits and fact row; the system one run sends; its running usage |
| `llm-def.ts` / `cost.ts` | `llm()`'s declaration types and `LlmCall`; the money arithmetic (`costOf`, `exactCostOf`) |
| `agent-guards.ts` / `agent-errors.ts` | the repeated-turn detector and the run deadline; their two classes |
| `prompt-cache.ts` | PROVIDER prompt caching: `SystemParts`, `PromptCacheHint`, `PROMPT_CACHE_RULES` (sources in its header) |
| `prompt-cache-blocks.ts` | the Anthropic wire's marks (chat-completions': `openai-messages.ts`) |
| `agent-continue.ts` / `agent-turn.ts` | `.run()` / `.continue()`, the transcript handle and its screen; one turn's report and refusals |
| `agent-transcript.ts` | what one turn leaves in the transcript: the assistant replay, the tool results, the correction |
| `agent-facts.ts` | `describeAgents()` — the agent registry, and the row a manifest WOULD publish (its consumer has to be `cli`, tier 5) |
| `agent-job.ts` | `agentJob()` — an agent as a real `JobHandle`, composed from `job()` |
| `hive.ts` | `hive()` — one action fanned out over many inputs, declared as an `action` |
| `hive-result.ts` | `HiveMember` / `HiveResult`, and the SCHEMA built from the member's own `output` |
| `hive-errors.ts` | the `X_HIVE_*` class; its code and title stay in `errors.ts` |
| `redaction.ts` | the one gate between `vars()` and the provider: a `Secret` never reaches a prompt |
| `eval-errors.ts` | the five `X_EVAL_*` classes; their codes and titles stay in `errors.ts` |
| `llm-cache.ts` | the semantic cache half of `llm()`: what a declaration may partition on, and the store it reaches |
| `llm-fixture.ts` / `bounds-fixture.ts` | the `llm()` harness; the one `refusal`/`asyncRefusal` of every bound suite. Not shipped (`!src/**/*-fixture.ts`) |
| `runtime.ts` | the ambient gateway / embedder / semantic caches an `llm()` reaches |
| `fix-line*` | the package's dogfood eval — proof the baseline convention fails a build |

## Invariants — bounds and budget

Why each is shaped this way: [`docs/history/ai.md`](../../docs/history/ai.md#bounds-and-budget).

- **Every numeric option is screened; `??` is not the screen** (`finiteOption`/`finiteCount`;
  `bun run finite-bounds`). **`maxTokens` is the worst**: it IS the pre-flight estimate, and a `NaN`
  switches every ceiling off — screened by the gateway, `registerModel` and `llm()`/`agent()`.
- **A bound is screened under the key the DECLARATION uses** (`budget.tokensPerRun`, not `request`).
- A per-call budget `derive`s from the ambient ledger and only TIGHTENS; a derived ledger reports
  back up the chain; the STORE is written once, by the ledger the call was made on.
- **`reserve` debits, then checks — never a read-then-write across an `await`**:
  `BudgetStore.take(key, tokens, limit)` is REQUIRED and atomic; a later refusal gives back.
- **The store is touched only for a scope whose ceiling is DECLARED**; `memoryBudgetStore()` has no
  window and no eviction; a zero counter is deleted.
- **`llm()`, `agent()`, `hive()` root as `currentBudget() ?? gateway.callLedger(budgetKeysFor(ctx.actor))`**
  (`actor:<kind>:<id>` / `org:<orgId>`). `callLedger` is required on `Gateway`.
- **`BudgetStore` is where `actor` and `org` live; the default is per PROCESS**; `add` takes a
  negative `tokens` for a release — a store that clamps at zero leaks the ceiling.
- A budget throws `X_AI_BUDGET_EXCEEDED` **before** the provider call. Never truncate. List price
  over-reserves.
- **Cost is exact in bigint (`cost.ts`, `Money` at `costScale`), rounded UP once**: per call by
  `costOf`, per ledger at `report()`, per run from the summed usage — never a sum of round-ups. A
  price may state a `scale` (≤ `PRICE_SCALE_DIGITS` finer); it is always read through `minorAt`.
- **`Gateway.stream` routes BEFORE it reserves**; `settled = true` comes after `ledger.record`.

## Invariants — `llm()`

Why each is shaped this way: [`docs/history/ai.md`](../../docs/history/ai.md#llm-invariants).

- **`llm()` returns an `action`**, never a ninth primitive; it adds only the model half: render the
  prompt, project `output` into the one `respond` tool, reserve the budget, consult the cache.
- **A non-object `output` is wrapped in `{ value }` and unwrapped** (`respond.ts`), never refused;
  `parseJsonish` is two `indexOf` scans, never a backtracking pattern.
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim** (`index.test.ts`).
- One repair turn, then `X_LLM_OUTPUT_INVALID`. A refusal (a 200 with no answer) is `X_LLM_REFUSED`
  before the parse; a truncated turn is `X_LLM_TRUNCATED` before the schema AND before any tool
  runs (a cut `respond` reads `{}`). The gateway never caches a refusal.
- **Semantic scopes are separate cache INSTANCES** (key: prompt hash AND `ctx.locale`); **the
  default scope is the calling ACTOR**; widening is `scope: () => 'global'`; the map is bounded.
  `cache.invalidates` is not on `llm()`: version bump + `ttl` is the invalidation.
- The gateway is ambient (`configureAi`); absent at call time is `X_AI_GATEWAY_MISSING`.
- **`llm()` forwards `ctx.signal`** onto `GenerateRequest`; `.stream()` inherits it.
- **`.stream()` is the SAME action**, marked with an ambient sink: UNVALIDATED text, then one `done`
  with the validated value; no repair turn (`X_LLM_STREAM_INVALID`), no `respond` tool. LAZY.
- **`configureAi({ redact })` is the one seam between `vars()` and the provider**; a `Secret` in
  `vars()` is `X_AI_PROMPT_SECRET` regardless.
- **Fallback is across PROVIDERS serving one model, never across models**; `GenerateResult.provider`
  is stamped by the gateway. Server-side `fallbacks` (beta) are never sent.
- **A slot inside a tag pair is DATA** (`prompt-fence.ts`, #689): `render` breaks every fence closer
  a fenced value wrote, in the ASSEMBLED prompt — never deletes, never touches a template's own.
- `definePrompt` refuses a re-registered version whose hash moved; the hash is over core's
  `canonicalJson`; an absent schema hashes as `''`.

## Invariants — providers and the gateway

- **The response cache key is core's `fingerprint` over the request, each tool WHOLE** (every `llm()`
  tool is `respond`); a throwing `cache.set` is logged (`ai.cache.write_failed`), never a failure.
- **An unknown stop/finish reason FAILS CLOSED as `max_tokens` on both formats**, streamed or not.
- **One failure-body reader** (`error-body.ts`'s `detailOf`, bounded at `READ_LIMIT`) and one
  `withoutKey` scrub — the embedder included.
- **`attempt` collects TRANSPORT failures only**: an `UltimateError` other than
  `X_AI_PROVIDER_UNAVAILABLE` is rethrown on the spot (the same misconfiguration everywhere). Read
  with `stringField(error, 'code')`.
- **The gateway's reads of a provider's throw are total**: `isRetryable` fails closed; the line goes
  through `renderThrowable`.
- **`X_AI_PROVIDER_UNAVAILABLE` is the one code classified `retryable`** (`AI_ERROR_RETRY`);
  `AiProviderUnavailableError({ unserved: true })` carries a per-instance `terminal`. Every other
  code but the two agent stops stays UNREGISTERED on purpose.
- **The retry SCHEDULE is core's (`backoffDelay`, `isRetryableStatus`); the LOOP is this package's** —
  core's `retry()` retries unclassified throws, so it would retry a 400 (`gateway-backoff.test.ts`).
- Every non-2xx and every in-band `error` frame is `AiTransportError` with a real `status`.
- **Both wire formats answer the same question the same way** (`provider-parity.test.ts`): an in-band
  `error` in a 200 throws (`throwInBandError`); a `refusal` detail forces `stopReason: 'refusal'`; a
  tool call's `input` is parsed (`parseToolArguments`); the credential is scrubbed from `detail`.
- **Arguments that are not JSON are never thrown by a wire reader**: recorded as `malformed`, and
  the PROVIDER decides once usage is known — dropped on a truncated turn, else
  `X_LLM_TOOL_ARGUMENTS_INVALID` with `meta.billed`, which the gateway RECORDS (`settleFailure`).
- **Every throw of `llm()`/`agent()` after a provider call STARTED carries `meta.billed`**
  (`meter.fail`): answered calls summed, `unsettled` counted and never priced.
- A stream ending without `message_stop` throws. **`readSse` caps the unterminated buffer**
  (`MAX_FRAME_CHARS`); `provider` is required so a transport error names its endpoint.
- A tool call is emitted whole. Thinking chunks are never appended to `text`.
- Anthropic body: no `top_p`/`top_k`, no `budget_tokens`, `effort` inside `output_config`. Model
  IDs are exact aliases, never date-suffixed.
- **`temperature`/`seed` (`sampling.ts`) are sent ONLY to a row with `sampling: { … : true }`** —
  else left out (never refused; `llm.sampling.ignored`); no `seed` on the Anthropic wire; in
  `promptCacheKey` only when set.
- **Apps bring their own models and providers (M12, 25.0.0): no vendor choice, no vendor data.** The
  registry starts EMPTY; a model resolves declaration → prompt → `Gateway.defaultModel`
  (`resolveModel` / `modelForCall`), none is `X_AI_MODEL_UNRESOLVED` (no gateway at all:
  `X_AI_GATEWAY_MISSING`). `vendor-neutral.test.ts` proves it; no fix line names a vendor id.
- **`ModelId` is `string`; the catalogue is an open registry** — `modelSpec(id)` refuses an
  unregistered id (`X_AI_MODEL_UNKNOWN`) before a socket or a reservation. Re-registering REPLACES
  the spec and keeps its rung; registration order is the ladder within a `family`
  (`moreCapableThan`); `X_LLM_REFUSED`'s fix names a rung ABOVE or nothing.
- **Every provider serves the app's list** (`{ models }` required, non-empty); no provider has a
  model of its own.
- **The reasoning controls are PER MODEL (`models.ts`)**: an unasked control is omitted; an asked
  control the model lacks is `X_AI_REQUEST_INVALID`, never dropped. Adding a model is a row the app
  registers. `disableThinkingUpTo: 'never'` refuses `thinking: 'disabled'` at every effort;
  `disabledThinking: 'between_tools'` is the wire spelling of the same declaration
  (`model-rules.test.ts`, over the fixture rows).
- **Media blocks are screened once, by `assertMediaContent`, at the top of BOTH body builders** —
  malformed is `X_AI_REQUEST_INVALID`, untakeable (role, the row's `input`, the wire) is
  `X_AI_CONTENT_UNSUPPORTED`; never dropped, never approximated (`provider-parity-content.test.ts`).
- `generate()` above `STREAM_ONLY_MAX_TOKENS` runs the streaming transport.
- **Every provider and embedder is built by its factory** (`anthropicProvider()`, `echoProvider()`,
  `hashEmbedder()`, `remoteEmbedder()`); the classes are type exports only (`bun run factory-names`).
- **`openAiProvider()` is a FORMAT, not a vendor** — `baseUrl`, `auth`, `headers` are the
  differences; never a second class per vendor:
  - structured output is the `respond` tool, never `response_format`; `tool_choice` names the tool
    only when the request offers exactly one and the row is not `forcedToolChoice: false`;
  - `strict: true` only when `satisfiesStrictMode` says the schema qualifies;
  - `max_completion_tokens`; `role: 'system'`; `stream_options: { include_usage: true }` and an
    ESTIMATE when usage never arrives; subtract `cached_tokens` from `prompt_tokens`;
  - tool-call deltas merge by `tool_calls[].index`, a differing `id` starting a new call; calls are
    read at `end()` (`[DONE]` or socket close), never at the finish reason; `isComplete()` accepts
    `[DONE]` or a finish reason, except `[DONE]` with pending tool fragments, which is refused;
  - no code of its own (a media refusal is the shared `X_AI_CONTENT_UNSUPPORTED`);
    `AiTransportError` takes the provider's `envVar`; the key is revealed late,
    never stored, scrubbed from `detail`.
- **`embedBatched` enforces the `Embedder` arity per batch** (`X_AI_EMBEDDER_INVALID` with both
  counts). One `remoteEmbedder()` for every vendor; vectors L2-normalised; a wrong width is
  `X_VECTOR_DIM_MISMATCH`.
- **A caught value is read with `renderThrowable`** (`remote-embedder.ts`, `wire.ts`,
  `openai-wire.ts`) — `scripts/error-render.ts` cannot see `catch` bindings.
- **A caller's string is never an object KEY**: the wire tables are `Map`s; `prompt.render` and
  `echoProvider()`'s `replies` use `Object.hasOwn`.

## Invariants — `agent()`, `hive()`, `agentJob()`

- **`agent()` returns an action** (listed in `PRIMITIVE_FACTORIES`). `ctx.actor` is read once and is
  the only identity any tool runs as — never taken from the model's output. Bounded by `maxTurns`
  (`X_AGENT_MAX_TURNS`), `budget.tokensPerRun`, `maxToolResultChars`, `maxRepeatedToolCalls`
  (`X_AGENT_TOOL_LOOP`) and `deadlineMs` (`X_AGENT_DEADLINE`).
  - `tools` takes a real `action()` (`AgentTool = AnyAction | ProjectableAction`,
    `asProjectableAction`); projection happens on the FIRST RUN, memoised. An agent can be another
    agent's tool.
  - A tool is an exposed action or an `inProcessTool()` (`isOfferedTool`); anything else is
    `X_AGENT_TOOL_UNEXPOSED` at DECLARATION. An in-process tool is never an action, never projected
    to MCP, has no policy (the agent's decides) and parses its own input.
  - `ctx.signal` is read at the top of every turn, before every tool batch, and forwarded to
    `fetch`; `X_ABORTED` is core's.
  - One turn's tools run concurrently, results paired by index; no tool STARTS after an abort.
  - `onTurn` reports facts only (also an `agent.turn` span event); a throw from it fails the run.
    `.stream()` on `agent()` is deliberately not shipped. No semantic cache.
  - Every replayed `tool_use` is answered by a `tool_result` in the very next message
    (`agent-transcript.ts`); an unaccepted `respond` comes back as an `is_error` `tool_result`
    ("superseded").
  - A tool result is rendered totally (`'null'` for `undefined`; a non-JSON result reported as such,
    never as a failure); the throw is read with `stringField`.
  - **A 5xx code's cause reaches the model only when core's `hasPublicCause` allows it** (status from
    `@ultimat3/http`'s `statusFor`) — else `CODE: HIDDEN_TOOL_CAUSE`, plus a branded `callerFix`. The
    same verdict a problem document and `@ultimat3/mcp` give, from `failure-disclosure.ts` — the
    rule a hive member's `reason` follows too. Never a second copy. One widening, for an
    `inProcess` tool only (`discloseOwnFailure`): a branded error under a code with NO declared
    status is shown as `{ error: { code, cause, fix } }`; `discloseErrors: false` opts out.
- **`.run()`/`.continue()` are the SAME action**, marked by an ambient session (as `.stream()` is).
  The handle is screened before anything is loaded (`screenTranscript`); `maxTurns` and
  `tokensPerRun` are cumulative — the remainder is the ceiling, NEVER a ledger debit (it would
  charge actor/org twice); `vars()` is not re-run; the open `respond` call is answered first.
- **`hive()` is a fan-out action** (`PRIMITIVE_FACTORIES`): `HiveResult` is a SCHEMA from the
  member's `output`; three arms (`ok`/`failed`/`skipped`) and three counters; `members` in SPLIT
  order with `index`; the hive never names an actor; no hive budget code; a member's throw goes
  through `discloseFailure` (`HIDDEN_MEMBER_CAUSE`);
  `skipped` reasons `SKIPPED_ABORTED` / `SKIPPED_NO_INPUT`; `onMemberError` is required;
  `concurrency` 4, `minMembers` 2 (a below-floor split runs serially); an empty split is
  `X_HIVE_EMPTY`; an aborted `ctx` is `X_ABORTED`.
- **`describeAgents()` / `registeredModels()` are offered, not published** — their only legal consumer
  is `@ultimat3/cli`. The facts are a THUNK; an unnamed agent has no row.
- **`agentJob()` composes `job()`** (never an imitation). `name`, `tenant`, `retry` are
  REQUIRED; both reads of `target.job()` are LAZY. No result is kept: wrap an ACTION that runs the
  agent and writes, target bound from its input — never a model-aimed write tool; every write
  idempotent (unenforceable). **`actor`** re-resolves who it acts FOR each attempt (a served worker:
  ANONYMOUS) via `impersonate`; off-tenant is TERMINAL `X_JOB_TENANT_MISMATCH`.

## Invariants — provider prompt caching

- **`GenerateRequest.promptCache` is the one switch; what it sends is a ROW in `PROMPT_CACHE_RULES`**
  (wire, host, model prefix → marks, session carrier), never an `if`. An unnamed endpoint gets
  NOTHING. At most 3 `cache_control`, a caller's own counted first (cap 4), never on a blank text
  block; never a `provider` routing object.
- **`agent()` defaults `'auto'`, `llm()` `'off'`.** The stable system part (`prompt.system` +
  `system().stable`) is sent FIRST; the mark follows the tail. The hint is not in `promptCacheKey`.
- **Usage**: chat-completions `prompt_tokens` INCLUDES read and written tokens; both are subtracted,
  clamped. A budget debits all four counters; the estimate prices a WRITE only where a provider
  would mark (`marksPromptCache`), at the dearer rate.
- **`maxRepeatedToolCalls` compares calls AND results over cycles of 1–3 turns**; `deadlineMs` has no
  default and rides the request's AND each tool's signal; both stops are `terminal`
  (`errors-retry.ts`).

## Invariants — evals, retrieval, fix lines

Full text of each rule: [`docs/history/ai.md`](../../docs/history/ai.md#evals-retrieval-fix-lines).

- **No fix line may name `x ai`** (planned); an eval is selected with `x test eval --filter <name>`.
- Every eval result carries the prompt hash; an eval gates on the DROP from its recorded baseline,
  mean AND per case (`X_EVAL_BASELINE_MISSING` / `_INVALID`); every prompt is named by an eval
  (`X_EVAL_MISSING`); `ULTIMATE_EVAL_RECORD=1` records, and `x verify` with it is `X_EVAL_RECORDING`.
- Retrieval is hybrid by default, no vector-only path. `chunk()` hard-wraps (no chunk over `size`);
  `metadata.source` is written AFTER the caller's spread; `VectorStore.prune` is required.
- **An unbound store read inside a request whose actor has an `orgId` is `X_VECTOR_UNSCOPED`**
  (both stores, every read); `scope: UNSCOPED` is the named opt-in, an omitted scope is `UNBOUND`.
- `postgresVectorStore()` is the only production vector path; `pg-vector.live.test.ts` refuses to
  skip without the extension. Distance ordering is an ascending raw subquery (the shape hnsw
  answers), pinned by a plan assertion. Tenant and policy filters are in SQL on every statement and
  BOTH fusion halves; `(tenant, id)` is the key; `scoped()` only TIGHTENS (`X_VECTOR_SCOPE_WIDENED`).

## Commands

```
bun test packages/ai
bun run --filter @ultimat3/ai typecheck

# the live vector suite — needs the extension, not just a Postgres
docker run -d -e POSTGRES_PASSWORD=ultimate -p 5432:5432 pgvector/pgvector:pg17
TEST_DATABASE_URL=postgres://postgres:ultimate@localhost:5432/postgres \
  bun test packages/ai/src/pg-vector.live.test.ts
```

Why each rule above is shaped the way it is: [`docs/history/ai.md`](../../docs/history/ai.md).
