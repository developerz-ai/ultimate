# @ultimat3/ai — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http action
query jobs realtime`. **Never** `mcp manifest render pwa ui admin testing cli`.

Declared today: `action` (the primitive `llm()` returns), `cache` (semantic cache), `core`,
`db` (pgvector), `jobs` (`agentJob()`), `money`, `policy`, `schema`, `time`.

`jobs` is declared for `agentJob()`: the action→job bridge has to live at tier 4+.

`mcp` is the same tier, so the LLM-tool projection is restated structurally in `tools.ts`
rather than imported. Same contract, two wire formats — and the same *decision*: `toLlmTools` and
`runLlmToolCall` ask `isMcpExposed` from `@ultimat3/core` (tier 0, reachable by both), never a
local `=== true`. An in-app agent and an external one must be offered exactly the same tools.

**And the same NAME**: `toLlmTool` passes `action.name` through untouched (the export name
`@ultimat3/mcp` serves); `llm()` and `agent()` `.tool()` names are verbatim too. Never derive one.

## Owns

| File | Job |
|---|---|
| `models.ts` | the model REGISTRY: `registerModel`, limits, prices, the reasoning controls each one accepts |
| `provider.ts` | `Provider` interface, the request half, the money arithmetic, Anthropic + Echo |
| `wire.ts` | the response half: `usage` / `stop_reason` shapes, and the SSE `MessageStream` |
| `error-body.ts` | what a failure body SAYS (`detailOf`) and what must never survive into it (`withoutKey`) — one copy, both transports |
| `sse.ts` | Server-Sent Events framing — protocol only, knows nothing about Anthropic |
| `openai-provider.ts` | `openAiProvider()` — the socket, the credential and the errors for any endpoint speaking the OpenAI chat-completions FORMAT |
| `openai-messages.ts` | the format mapping's request half: `AiMessage` blocks → OpenAI messages, `LlmTool` → functions, `tool_choice` |
| `openai-body.ts` | one chat-completions body, and the per-model reasoning mapping |
| `openai-wire.ts` | its response half: one completion, and `ChatCompletionStream` (fragmented tool calls, trailing usage, `[DONE]`) |
| `openai-models.ts` | the OpenAI-format price rows, registered through the same `registerModel` |
| `gateway.ts` | routing, retries, cache, budget wiring |
| `budget.ts` | token ledgers per request/actor/org, ALS carrier |
| `prompt.ts` | `definePrompt`, content hashing, version registry |
| `embeddings.ts` | `Embedder`, `HashEmbedder`, cosine helpers |
| `remote-embedder.ts` | `RemoteEmbedder` — the production `/v1/embeddings` client |
| `evals.ts` | `defineEval`, the run, the baseline gate, prompt coverage |
| `eval-baseline.ts` | the recorded scores: path, read/write, what counts as a regression |
| `scorers.ts` | what a `Scorer` is, the built-in ones, and `llmJudge` |
| `vector.ts` | `VectorStore`, in-memory cosine + BM25, RRF hybrid |
| `pg-vector.live.test.ts` | the same store against a real pgvector — DDL, fusion, scope, plan |
| `vector-scope.ts` | the tenant + policy envelope, and the tighten-only derive rule |
| `pg-vector-sql.ts` | every pgvector statement: DDL, upsert, cosine, FTS, RRF fusion |
| `pg-vector.ts` | `PgVectorStore` — the production store |
| `rag.ts` | chunker, retriever, reranker, budgeted context assembler |
| `tools.ts` | action → LLM tool definition; the `AgentTool` union and `asProjectableAction`; `runLlmToolCall` |
| `llm.ts` | `llm()` — the model call, declared as an `action`; and what a streamed answer must satisfy |
| `llm-stream.ts` | `.stream()`'s plumbing: the sink, the ambient mark, the one-turn drive |
| `agent.ts` | `agent()` — the tool loop, declared as an `action` |
| `agent-transcript.ts` | what one turn leaves in the transcript: the assistant replay, the tool results, the correction |
| `agent-facts.ts` | `describeAgents()` — the agent registry, and the row a manifest WOULD publish: nothing reads it yet, because `manifest` is tier 4 like this package and the consumer has to be `cli` at tier 5 |
| `agent-job.ts` | `agentJob()` — an agent as a real `JobHandle`, composed from `job()` |
| `hive.ts` | `hive()` — one action fanned out over many inputs, declared as an `action` |
| `hive-result.ts` | `HiveMember` / `HiveResult`, and the SCHEMA built from the member's own `output` |
| `hive-errors.ts` | the `X_HIVE_*` class; its code and title stay in `errors.ts` |
| `redaction.ts` | the one gate between `vars()` and the provider: a `Secret` never reaches a prompt |
| `eval-errors.ts` | the five `X_EVAL_*` classes; their codes and titles stay in `errors.ts` |
| `llm-cache.ts` | the semantic cache half of `llm()`: what a declaration may partition on, and the store it reaches |
| `llm-fixture.ts` | the harness `llm.test.ts` and `llm-cache.test.ts` share. Not shipped (`!src/**/*-fixture.ts`) |
| `bounds-fixture.ts` | the one `refusal`/`asyncRefusal` every numeric-bound suite here asserts through. Not shipped, same rule |
| `agent-bounds.test.ts` | the agent loop's ceilings, split out because `agent.test.ts` is at the 500-line ceiling |
| `runtime.ts` | the ambient gateway / embedder / semantic caches an `llm()` reaches |
| `fix-line.ts` / `fix-line.evals.ts` / `fix-line.v1.baseline.json` / `fix-line.eval.test.ts` | the package's own dogfood eval — the first framework-level `*.eval.test.ts`, proving the `defineEval`/baseline convention actually fails a build |

## Invariants — bounds and budget

- **Every numeric option is screened; `??` is not the screen.** `finiteOption`/`finiteCount` from
  `@ultimat3/core` are the one form; `bun run finite-bounds` is the ratchet, and it cannot see a
  required option with no `??`, a default parameter or a cross-field product. **`maxTokens` is the
  worst**: it IS the budget's pre-flight estimate, and a `NaN` switches every actor and org ceiling
  off. `Gateway.generate`/`stream` screen it at the one seam, `registerModel` screens `maxOutput`, and
  `llm()`/`agent()` screen theirs at DECLARATION.
- **A bound is screened under the key the DECLARATION uses** (`budget.tokensPerRun` in `limitsOf`
  before the ledger's `request`; `retrieve()`'s own `k`; `RemoteEmbedder`'s `maxResponseBytes`).
- A per-call budget `derive`s from the ambient ledger and only TIGHTENS. **A derived ledger reports
  back up the chain** (every debit on every ancestor; `reserve` checks each `request` scope); the
  STORE is written once, by the ledger the call was made on; reservations queue on the ROOT's turnstile.
- **`BudgetStore` is where `actor` and `org` live; the default is per PROCESS**
  (`createGateway({ budgetStore })`). `add` takes a negative `tokens` for a release — a store that
  clamps at zero leaks the ceiling.
- Cost is `Money` (integer minor units), rounded **up**. A budget throws `X_AI_BUDGET_EXCEEDED`
  **before** the provider call. Never truncate. List price over-reserves (no introductory prices).
- **`Gateway.stream` routes BEFORE it reserves**, and `settled = true` comes after
  `await ledger.record(...)`.

## Invariants — `llm()`

- **`llm()` returns an `action`**, never a ninth primitive; it adds only the model half: render the
  prompt, project `output` into the one `respond` tool, reserve the budget, consult the semantic cache.
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim** (`index.test.ts`).
- One repair turn, then `X_LLM_OUTPUT_INVALID`. A refusal (a 200 with no answer) is `X_LLM_REFUSED`
  before the parse, carrying `stopDetails.category`; a truncated invalid answer is `X_LLM_TRUNCATED`.
  The gateway never caches a refusal.
- **Semantic scopes are separate cache INSTANCES**; the instance key carries the prompt hash AND
  `ctx.locale` (in the unconditional half). **The default scope is the calling ACTOR**
  (`JSON.stringify([actor.kind, actor.id, actor.orgId ?? null])`); `scope` receives
  `{ input, ctx }`; widening is `scope: () => 'global'`. The instance map is bounded
  (`MAX_SEMANTIC_CACHE_SCOPES`).
- `cache.invalidates` is not on `llm()`: a `SemanticCache` is not a `CacheTier`. Version bump + `ttl`
  is the invalidation.
- The gateway is ambient (`configureAi`); absent at call time is `X_AI_GATEWAY_MISSING`, never a
  default provider.
- **`llm()` forwards `ctx.signal`** onto `GenerateRequest`; `.stream()` inherits it.
- **`.stream()` is the SAME action**, marked with an ambient sink: it yields UNVALIDATED text and one
  final `done` with the value that satisfied `output`; no repair turn (`X_LLM_STREAM_INVALID`); the
  budget is reserved before the provider, debited on the first pull, reconciled at `done`; no
  `respond` tool; a cache hit yields `done` alone. LAZY. `named()` is re-narrowed so the twin still streams.
- **`configureAi({ redact })` is the one seam between `vars()` and the provider**; a `Secret` in
  `vars()` is `X_AI_PROMPT_SECRET` regardless. The `llm.redacted` span attribute records it.
- **Fallback is across PROVIDERS serving one model, never across models**; `GenerateResult.provider`
  is stamped by the gateway and put on the span as `llm.provider`.
- Server-side `fallbacks` (beta) are never sent — the stable `2023-06-01` surface only.
- `definePrompt` refuses a re-registered version whose hash moved; the hash is over core's
  `canonicalJson` (`prompt.test.ts` pins one hash literally); an absent schema hashes as `''`.

## Invariants — providers and the gateway

- **`attempt` collects TRANSPORT failures only**: an `UltimateError` other than
  `X_AI_PROVIDER_UNAVAILABLE` is rethrown on the spot (the same misconfiguration everywhere). Read
  with `stringField(error, 'code')`.
- **The gateway's reads of a provider's throw are total**: `isRetryable` fails closed; the line goes
  through `renderThrowable`.
- **`X_AI_PROVIDER_UNAVAILABLE` is the one code classified `retryable`** (`AI_ERROR_RETRY`);
  `AiProviderUnavailableError({ unserved: true })` carries a per-instance `terminal`. Every other code
  stays UNREGISTERED on purpose.
- **The retry SCHEDULE is core's (`backoffDelay`, `isRetryableStatus`); the LOOP is this package's** —
  core's `retry()` retries unclassified throws, and every value here is an app `Provider`'s plain
  object, so it would retry a 400. `gateway-backoff.test.ts`. `RetryPolicy`/`DEFAULT_RETRY` keep the
  field names an app writes.
- Every non-2xx and every in-band `error` frame is `AiTransportError` with a real `status`.
- **Both wire formats answer the same question the same way** (`provider-parity.test.ts`): an in-band
  `error` in a 200 body throws (`throwInBandError`, `wire.ts`); a `refusal` stop detail forces
  `stopReason: 'refusal'`; a tool call's `input` is parsed (`asToolInput`); the credential is scrubbed
  from `detail` (`error-body.ts`'s `withoutKey`/`detailOf`). The status tables and the OpenAI
  `estimatedUsage` fallback are asserted as differences.
- A stream ending without `message_stop` throws. **`readSse` caps the unterminated buffer**
  (`MAX_FRAME_CHARS`); `provider` is required so a transport error names its endpoint.
- A tool call is emitted whole. Thinking chunks are never appended to `text`.
- Anthropic body: no `temperature`/`top_p`/`top_k`, no `budget_tokens`, `effort` inside
  `output_config`. Model IDs are exact aliases, never date-suffixed.
- **`ModelId` is `string`; the catalogue is an open registry** — `modelSpec(id)` refuses an
  unregistered id (`X_AI_MODEL_UNKNOWN`). The built-ins register through the same `registerModel`.
  **Re-registering REPLACES the spec and keeps its rung** (negotiated rates). **Registration order is
  the ladder within a `family`**, read only by `moreCapableThan`; `X_LLM_REFUSED`'s fix names a rung
  ABOVE or nothing.
- `AnthropicProvider.models` is its own list; `EchoProvider.models` reads the registry.
- **The reasoning controls are PER MODEL (`models.ts`)**: an unasked control is omitted; an asked
  control the model lacks is `X_AI_REQUEST_INVALID`, never dropped. Adding a model is a row in `MODELS`.
- `generate()` above `STREAM_ONLY_MAX_TOKENS` runs the streaming transport.
- **`openAiProvider()` is a FORMAT, not a vendor** — `baseUrl`, `auth`, `headers` are the
  differences; never a second class per vendor:
  - structured output is the `respond` tool, never `response_format`; `tool_choice` names the tool
    only when the request offers exactly one;
  - `strict: true` only when `satisfiesStrictMode` says the schema qualifies;
  - `max_completion_tokens`; `role: 'system'`; `stream_options: { include_usage: true }` and an
    ESTIMATE when usage never arrives; subtract `cached_tokens` from `prompt_tokens`;
  - tool-call deltas merge by `tool_calls[].index`; `isComplete()` accepts `[DONE]` or a finish reason,
    except `[DONE]` with pending tool fragments, which is refused;
  - only `gpt-5.6-sol` / `-terra` / `-luna` are priced; `registerOpenAiModels()` re-registers after
    `resetModels()` (every `openai-*.test.ts` calls it in `beforeEach`);
  - no new `X_*` code; `AiTransportError` takes the provider's `envVar`; the key is revealed late,
    never stored, scrubbed from `detail`.
- **`embedBatched` enforces the `Embedder` arity per batch** (`X_AI_EMBEDDER_INVALID` with both
  counts). One `RemoteEmbedder` for every vendor; vectors L2-normalised; a wrong width is
  `X_VECTOR_DIM_MISMATCH`.
- **A caught value is read with `renderThrowable`** (`remote-embedder.ts`, `wire.ts`,
  `openai-wire.ts`) — `scripts/error-render.ts` cannot see `catch` bindings.
- **A caller's string is never an object KEY**: the wire tables are `Map`s; `prompt.render` and
  `EchoProvider`'s `replies` use `Object.hasOwn`.

## Invariants — `agent()`, `hive()`, `agentJob()`

- **`agent()` returns an action** (listed in `PRIMITIVE_FACTORIES`). `ctx.actor` is read once and is
  the only identity any tool runs as — never taken from the model's output. Bounded by `maxTurns`
  (`X_AGENT_MAX_TURNS`), `budget.tokensPerRun` and `maxToolResultChars`.
  - `tools` takes a real `action()` (`AgentTool = AnyAction | ProjectableAction`,
    `asProjectableAction`); projection happens on the FIRST RUN, memoised. An agent can be another
    agent's tool.
  - A tool not `mcp: { expose: true }` is `X_AGENT_TOOL_UNEXPOSED` at DECLARATION.
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
- **`hive()` is a fan-out action** (`PRIMITIVE_FACTORIES`): `HiveResult` is a SCHEMA from the
  member's `output`; three arms (`ok`/`failed`/`skipped`) and three counters; `members` in SPLIT
  order with `index`; the hive never names an actor; no hive budget code (the root turnstile holds
  it); a member's throw is recorded via `isThrownError`/`stringField`; `skipped` reasons
  `SKIPPED_ABORTED` / `SKIPPED_NO_INPUT`; `onMemberError` is required; `concurrency` 4, `minMembers`
  2 (a below-floor split still runs serially); an empty split is `X_HIVE_EMPTY`; an aborted `ctx`
  unwinds with `X_ABORTED`.
- **`describeAgents()` / `registeredModels()` are offered, not published** — their only legal consumer
  is `@ultimat3/cli`. The facts are a THUNK; an unnamed agent has no row.
- **`agentJob()` composes `job()`** (never an imitation handle). `name`, `tenant`, `retry` are
  REQUIRED; both reads of `target.job()` are LAZY. **Every tool an `agentJob()`'d agent may call must
  be idempotent** — stated in `AgentJobOptions.idempotencyKey`'s doc and the README, not enforceable.

## Invariants — evals, retrieval, fix lines

- **No fix line may name `x ai`** (planned). An eval is selected with `x test eval --filter <name>`;
  `eval-errors.test.ts` asserts every `x test <word>` is one of the six types.
- Every eval result carries the prompt hash. An eval gates on the DROP from its recorded baseline,
  mean AND per case. Never-recorded is `X_EVAL_BASELINE_MISSING`, corrupt is `X_EVAL_BASELINE_INVALID`.
  `baseline` is `import.meta.resolve('./…')`. Every prompt is named by an eval (`X_EVAL_MISSING`, by
  prompt ID). `ULTIMATE_EVAL_RECORD=1` records; a deliberately-worse test calls `run`, never
  `assert`; `x verify` with the flag is `X_EVAL_RECORDING` and runs no eval. The gate asks for a
  recorded baseline, not only a declaration.
- Retrieval is hybrid by default; no vector-only path. **`chunk()` hard-wraps**, and the overlap
  carry stops at `buffer.length - 1`.
- `PgVectorStore` is the only production vector path (pgvector + FTS in the app's Postgres);
  `MemoryVectorStore` enforces the same envelope. **`pg-vector.live.test.ts` refuses to skip** on a
  Postgres without the extension (CI uses `pgvector/pgvector:pg17`).
- The distance ordering lives in an ascending raw subquery (the only shape hnsw answers), pinned by a
  plan assertion. hnsw scopes after the scan — assert rows, never the node; `analyze` after a backfill.
- Tenant and policy filters are in SQL on every statement (`conditionsSql`), on BOTH fusion halves.
  `(tenant, id)` is the primary key. `scoped()` only TIGHTENS (`X_VECTOR_SCOPE_WIDENED`). Metadata is
  bound `::text::jsonb`.

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
