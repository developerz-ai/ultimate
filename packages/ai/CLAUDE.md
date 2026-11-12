# @ultimat3/ai — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http action
query jobs realtime`. **Never** `mcp manifest render pwa ui admin testing cli`.

Shipped: `action` (`llm()`), `cache`, `core`, `db` (pgvector), `http` (`statusFor`),
`jobs` (`agentJob()`, a tier 4+ action→job bridge), `money`, `schema`, `time`.

Keep `policy` dev-only: tests and `*-fixture.ts` harnesses import `allow`. The
`!src/**/*-fixture.ts` exclusion keeps harnesses unpublished; their imports still need a declaration.

`mcp` is the same tier, so the LLM-tool projection is restated in `tools.ts`, never imported —
`asProjectableAction` and mcp's `primitiveFromAction` held equal by
`scripts/ai-mcp-tool-parity.test.ts`; a field one adds, the other adds. Full rule: `docs/history/ai.md`.

## Owns

| File | Job |
|---|---|
| `models.ts` | the model REGISTRY: `registerModel`, limits, prices, the reasoning controls each one accepts — and NO row of its own |
| `model-resolve.ts` | `resolveModel` / `modelForCall` — declaration → prompt → gateway `defaultModel`, none is `X_AI_MODEL_UNRESOLVED` naming all three; `describedModel` for a published fact |
| `model-fixture.ts` | the rows this package's own suites register (`useFixtureModels()`). Not shipped |
| `provider.ts` | `Provider` interface, the request half; re-exports the Anthropic names |
| `anthropic-provider.ts` | `anthropicProvider()`, its stream-only rule (`requiresStreaming`) and message parse |
| `echo-provider.ts` | `echoProvider()`, the deterministic double — split from `provider.ts` at its line ceiling. A fixture that needs a tool call uses `scriptedProvider`, never a hand-rolled `Provider` |
| `scripted-provider.ts` | `scriptedProvider()`, the scripted double that calls tools, and `X_AI_SCRIPT_EXHAUSTED`: one call past the script is refused, never answered with the last turn again |
| `content-blocks.ts` | the `image` / `document` block shapes, the screen every request runs them through, their token estimate |
| `content-errors.ts` | the `X_AI_CONTENT_UNSUPPORTED` class; its code and title belong in `error-codes.ts` |
| `wire.ts` | the response half: `usage` / `stop_reason` shapes, and the SSE `MessageStream` |
| `error-body.ts` | what a failure body SAYS (`detailOf`) and what must never survive into it (`withoutKey`) — one copy, both transports |
| `sse.ts` | Server-Sent Events framing — protocol only, knows nothing about Anthropic |
| `openai-provider.ts` | `openAiProvider()` — the socket, the credential and the errors for any endpoint speaking the OpenAI chat-completions FORMAT |
| `openai-messages.ts` | the format mapping's request half: `AiMessage` blocks → OpenAI messages, `LlmTool` → functions, `tool_choice` |
| `openai-body.ts` | one chat-completions body, and the per-model reasoning mapping |
| `openai-wire.ts` / `openai-wire-stream.ts` | its response half: one completion and the field readers; `ChatCompletionStream` (fragmented tool calls, trailing usage, `[DONE]`) |
| `gateway.ts` | routing, cache, budget wiring |
| `gateway-providers.ts` | the retry loop across providers, `backoffMs`, `isRetryable`, the breakers |
| `budget.ts` / `budget-store.ts` | token ledgers per request/actor/org, ALS carrier; the `BudgetStore` contract and `memoryBudgetStore()` |
| `prompt.ts` | `definePrompt`, `promptHash`, version registry |
| `prompt-fence.ts` | a template's data fences: which tag pairs enclose each slot (`promptFences`), and the closer-breaking `render` applies inside one |
| `embeddings.ts` | `Embedder`, `hashEmbedder()`, cosine helpers |
| `remote-embedder.ts` | `remoteEmbedder()` — the production `/v1/embeddings` client |
| `evals.ts` | `defineEval`, the run, the baseline gate, prompt coverage |
| `eval-agent.ts` | the agent arm of `defineEval`: one case is one `agent.run()` in the eval scope; `agentPrompt` reads the prompt off `agentFactsOf` |
| `eval-agent-fixture.ts` | the agent-arm suites' harness. Not shipped |
| `eval-baseline.ts` | the recorded scores: path, read/write, what counts as a regression |
| `scorers.ts` | what a `Scorer` is, the built-in ones, and `llmJudge` |
| `vector.ts` | `VectorStore`, in-memory cosine + BM25, RRF hybrid |
| `pg-vector.live.test.ts` | the same store against a real pgvector — DDL, fusion, scope, plan |
| `vector-scope.ts` | the tenant + policy envelope, and the tighten-only derive rule |
| `pg-vector-sql.ts` | every pgvector statement: DDL, upsert, cosine, FTS, RRF fusion |
| `pg-vector.ts` | `postgresVectorStore()` — the production store |
| `rag.ts` | chunker, retriever, reranker, budgeted context assembler |
| `tools.ts` | action → LLM tool definition; the `AgentTool` union and `asProjectableAction`; `runLlmToolCall` |
| `tools-gate.ts` | a tool's way to `run`: actor half, the name's gate, the tool |
| `tool-idempotency.ts` | an idempotent action's reserved `idempotencyKey` tool argument — MCP's, restated (same tier), held equal by the parity test |
| `tool-arguments.ts` / `answer-errors.ts` | one argument-string reader for both wires and what an unreadable one means (`assertToolArguments`); `X_LLM_TRUNCATED` + `X_LLM_TOOL_ARGUMENTS_INVALID` |
| `billed.ts` / `run-meter.ts` | `meta.billed` + `billedOf`; the meter every `llm()`/`agent()` provider call goes through, and `meteredRun`, its one public total (`RunMeter` stays internal) |
| `failure-disclosure.ts` | `discloseFailure` — the ONE rule for what of a throw a remote reader sees (tool result, hive member); the withheld half is logged, never its message or cause |
| `llm.ts` / `llm-answer.ts` | `llm()` — the model call, declared as an `action`; one answered turn's span, `onCall`, fit, and what a streamed answer must satisfy |
| `llm-instrument.ts` | what one `llm()` call reports when it settles: gen_ai usage on the span, `ai.llm` on the bus |
| `respond.ts` | the `respond` tool for one `output` (a non-object one wrapped in `{ value }`), its reader, and `parseJsonish` |
| `llm-stream.ts` | `.stream()`'s plumbing: the sink, the ambient mark, the one-turn drive |
| `agent.ts` / `agent-tools.ts` | `agent()` — the tool loop, declared as an `action`; one turn's bounded tool fan-out |
| `agent-def.ts` / `agent-declared.ts` / `agent-system.ts` / `agent-usage.ts` | the declaration's types; its defaults, bound screen, limits and fact row; the system one run sends; its running usage |
| `llm-def.ts` / `cost.ts` | `llm()`'s declaration types and `LlmCall`; the money arithmetic (`costOf`, `exactCostOf`) |
| `agent-guards.ts` / `agent-errors.ts` | the repeated-turn detector and the run deadline; their two classes |
| `prompt-cache.ts` / `-rows.ts` | PROVIDER prompt caching, `PROMPT_CACHE_RULES` (sources in its header); the provider-rows screen |
| `prompt-cache-blocks.ts` | the Anthropic wire's marks (chat-completions': `openai-messages.ts`) |
| `agent-per-run.ts` / `agent-run-limits.ts` | one run's `offerTools()`/`model()`/`limits()`, narrow only; `costPerRun` |
| `agent-compact{,-def,-measure,-request,-text}.ts` | trigger, cut; `compact`'s option and event; the token ratio; the summary request, as text when too long |
| `agent-send.ts` / `context-overflow.ts` / `agent-checkpoint.ts` | a turn sent, an overflow compacted once; `X_AI_CONTEXT_OVERFLOW`'s phrases; `onCheckpoint` |
| `agent-continue.ts` / `agent-session.ts` / `agent-turn.ts` | the transcript handle and its screen; `.run()` / `.continue()` and their session; one turn's report and refusals |
| `agent-transcript.ts` | what one turn leaves in the transcript: the assistant replay, the tool results, the correction |
| `agent-facts.ts` | `describeAgents()` — the agent registry, and the row a manifest WOULD publish (its consumer has to be `cli`, tier 5) |
| `agent-job.ts` | `agentJob()` — an agent as a real `JobHandle`, composed from `job()` |
| `hive.ts` | `hive()` — one action fanned out over many inputs, declared as an `action` |
| `hive-result.ts` | `HiveMember` / `HiveResult`, and the SCHEMA built from the member's own `output` |
| `hive-errors.ts` | the `X_HIVE_*` class; its code and title stay in `error-codes.ts` |
| `redaction.ts` | the one gate between `vars()` and the provider: a `Secret` never reaches a prompt |
| `eval-errors.ts` | the six `X_EVAL_*` classes; their codes and titles stay in `error-codes.ts` |
| `error-codes.ts` | the codes this package owns, their titles and the one `registerErrorCodes` call (`new-error-code --package ai` writes here); `errors.ts` holds the core classes |
| `llm-cache.ts` | the semantic cache half of `llm()`: what a declaration may partition on, and the store it reaches |
| `llm-fixture.ts` / `bounds-fixture.ts` | the `llm()` harness; the one `refusal`/`asyncRefusal` of every bound suite. Not shipped (`!src/**/*-fixture.ts`) |
| `runtime.ts` | the ambient gateway / embedder / semantic caches an `llm()` reaches, and the private agent-eval scope (`withEvalScope`): `aiGateway`/`installedGateway` read its gateway first; `runLlmToolCall` resolves its doubles |
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
- **`Gateway.stream` routes BEFORE it reserves**; the `done` record is attempted ONCE (a throw is
  never re-booked from the running bill). Unsettled: the wire's running bill (`stream-bill.ts`),
  else the prompt once sent (`trackSent`) — an aborted `generate` too; released only if never sent.

## Invariants — `llm()`

- **Telemetry is semconv's `gen_ai.*`, the rest `ultimate.llm.*`** — never a bare `llm.*` key.
  `llm-instrument.ts` wraps the run meter (every provider call passes it) and settles ONCE per
  `llm()` call — answered, cache hit or failed: the run's summed usage onto the `client` span and
  `ai.llm` onto core's bus (`llm-instrument.test.ts`). `agent()` emits one `ai.llm` per MODEL CALL —
  each turn and each compaction summary, through `reportedCall` — so the token metric counts agents.

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
- The gateway is the `aiGateway` port: one slot, `installAiGateway` on `./adapter` only (`adapter.test.ts`), never `configureAi` (v31); absent at call time is `X_AI_GATEWAY_MISSING`.
- **`llm()` forwards `ctx.signal`** onto `GenerateRequest`; `.stream()` inherits it.
- **`.stream()` is the SAME action**, marked with an ambient sink: UNVALIDATED text, then one `done`
  with the validated value; no repair turn (`X_LLM_STREAM_INVALID`), no `respond` tool. LAZY.
- **`llm()` streams over its own route** (`stream: LlmTextChunk`, exported): `text/event-stream`
  gets `{ type: 'text' }` frames, then `done`; `thinking` NEVER crosses the wire. Drained
  (`chunksRead()` false: JSON, MCP, `.job()`) it is the ordinary call, repair turn included.
- **`configureAi({ redact })` is the one seam between `vars()` and the provider**; a `Secret` in
  `vars()` is `X_AI_PROMPT_SECRET` regardless.
- **Fallback is across PROVIDERS serving one model, never across models**; `GenerateResult.provider`
  is stamped by the gateway. Server-side `fallbacks` (beta) are never sent. Media generation:
  absent, awaiting an owner decision (OD8).
- **A slot inside a tag pair is DATA** (`prompt-fence.ts`, #689): `render` breaks every fence closer
  a fenced value wrote, in the ASSEMBLED prompt — never deletes, never touches a template's own.
- `definePrompt` refuses a re-registered version whose hash moved; the hash is over core's
  `canonicalJson`; an absent schema hashes as `''`.

## Invariants — providers and the gateway

- **The response cache key is core's `fingerprint` over the request, each tool WHOLE** (every `llm()`
  tool is `respond`); a throwing `cache.set` is logged (`ai.cache.write_failed`), never a failure.
- **An unknown stop reason FAILS CLOSED as `max_tokens` on the Anthropic wire; on chat-completions
  it is UNKNOWN** (`readFinishReason`): a whole turn is a stop, else `X_AI_PROVIDER_UNEXPECTED`.
- **One failure-body reader** (`error-body.ts`'s `detailOf`, bounded at `READ_LIMIT`) and one
  `withoutKey` scrub — the embedder included.
- **`attempt` collects TRANSPORT failures only**: an `UltimateError` other than
  `X_AI_PROVIDER_UNAVAILABLE` is rethrown on the spot (the same misconfiguration everywhere). Read
  with `stringField(error, 'code')`.
- **The gateway's reads of a provider's throw are total**: `isRetryable` fails closed; the line goes
  through `renderThrowable`.
- **`X_AI_PROVIDER_UNAVAILABLE` is the one code classified `retryable`** (`AI_ERROR_RETRY`);
  `AiProviderUnavailableError({ unserved: true })` carries a per-instance `terminal`. Nine
  deterministic failures are `terminal` (`errors-retry.ts`); the rest stay UNREGISTERED on purpose.
- **One breaker per provider** (`gateway-providers.ts`, `DEFAULT_GATEWAY_BREAKER` `{ failures: 5,
  cooldownMs: 30_000 }`, `breaker: 'off'` declines). Every settle carries the `admit()`
  ticket. Full rule: `docs/history/ai.md`.
- **The retry SCHEDULE is core's (`backoffDelay`, `isRetryableStatus`); the LOOP is this package's** —
  core's `retry()` retries unclassified throws, so it would retry a 400 (`gateway-backoff.test.ts`).
- Every non-2xx and in-band `error` frame is `AiTransportError` with a real `status` — but a
  window overflow (`providerFailure`).
- **Both wire formats answer the same question the same way** (`provider-parity.test.ts`). Full rule: `docs/history/ai.md`.
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
- **`temperature`/`seed` (`sampling.ts`) are sent ONLY to a row with `sampling: { … : true }`**, else
  left out, never refused. Full rule: `docs/history/ai.md`.
- **Apps bring their own models and providers: no vendor choice, no vendor data.** The registry
  starts EMPTY (`vendor-neutral.test.ts`); resolution is `model-resolve.ts`'s. Full rule: `docs/history/ai.md`.
- **`ModelId` is `string`; the catalogue is an open registry** — `modelSpec(id)` refuses an
  unregistered id (`X_AI_MODEL_UNKNOWN`) before a socket or a reservation. Full rule: `docs/history/ai.md`.
- **Every provider serves the app's list** (`{ models }` required, non-empty); no provider has a
  model of its own.
- **The reasoning controls are PER MODEL (`models.ts`)**: an unasked control is omitted; an asked
  control the model lacks is `X_AI_REQUEST_INVALID`, never dropped. Full rule: `docs/history/ai.md`.
- **Media blocks are screened once, by `assertMediaContent`, at the top of BOTH body builders**;
  never dropped, never approximated. Full rule: `docs/history/ai.md`.
- `generate()` above `STREAM_ONLY_MAX_TOKENS` runs the streaming transport.
- **Every provider and embedder is built by its factory** (`anthropicProvider()`, `echoProvider()`,
  `hashEmbedder()`, `remoteEmbedder()`); the classes are type exports only (`bun run factory-names`).
- **`openAiProvider()` is a FORMAT, not a vendor** — `baseUrl`, `auth`, `headers` are the
  differences; never a second class per vendor. Wire rules: [history](../../docs/history/ai.md#openaiprovider-wire-rules).
- **`embedBatched` enforces the `Embedder` arity per batch** (`X_AI_EMBEDDER_INVALID` with both
  counts). Full rule: `docs/history/ai.md`.
- **A caught value is read with `renderThrowable`** (`remote-embedder.ts`, `wire.ts`,
  `openai-wire-stream.ts`) — `scripts/error-render.ts` cannot see `catch` bindings.
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
  - A tool is an action core's `isAgentOffered` admits (exposed, or `agents: true`) or an
    `inProcessTool()` (`isOfferedTool`); anything else is
    `X_AGENT_TOOL_UNEXPOSED` at DECLARATION. An in-process tool is never an action, never projected
    to MCP, has no policy (the agent's decides) and parses its own input.
  - `ctx.signal` is read at the top of every turn, before every tool batch, and forwarded to
    `fetch`; `X_ABORTED` is core's.
  - One turn's tools run concurrently, at most `maxToolConcurrency` (default 8, `agent-tools.ts`),
    results paired by index; no tool STARTS after an abort or the deadline.
  - **`mcpConfirmations({ tools })` holds a tool here**, one pass each however it arrives
    (`tools-gate.ts`). Proof: `scripts/ai-tool-confirmation.test.ts`.
  - `onTurn` reports facts only (also an `agent.turn` span event); a throw from it fails the run.
    Streams per turn on its route (`stream: AgentChunk`). No semantic cache.
  - Every replayed `tool_use` is answered by a `tool_result` in the very next message
    (`agent-transcript.ts`); an unaccepted `respond` comes back as an `is_error` `tool_result`
    ("superseded").
  - A tool result is rendered totally (`'null'` for `undefined`; a non-JSON result reported as such,
    never as a failure); the throw is read with `stringField`.
  - **A 5xx code's cause reaches the model only when core's `hasPublicCause` allows it**, else
    `CODE: HIDDEN_TOOL_CAUSE` plus a branded `callerFix` (`failure-disclosure.ts`, never a second
    copy). Full rule: `docs/history/ai.md`.
- **A run only NARROWS its declaration**: `offerTools()` ⊆ declared names (`X_AGENT_TOOL_UNDECLARED`),
  `model()` via `modelSpec`, `limits()` screened and ≤ declared (`X_AI_REQUEST_INVALID`); all
  before `vars()`. The handle binds the run's model and OFFERED subset; `costPerRun` is checked per turn.
- **`.run()`/`.continue()` are the SAME action**, marked by an ambient session only the declaring
  agent may claim, once (a nested agent starts fresh). The handle is SIGNED (`sealTranscript`)
  and bound to agent, model, tool names and `orgId`. Full rule: `docs/history/ai.md`.
- **`compact` (default `'auto'`) acts BEFORE a turn on the MEASURED estimate; an overflow gets one
  forced compaction and a re-send**;
  never truncated (`X_AGENT_CONTEXT_EXHAUSTED`). Full rule: `docs/history/ai.md`.
- **A summary request too long for its writer goes as TEXT** (`agent-compact-request.ts`,
  `agent-compact-text.ts`): oldest tool results clipped to `SUMMARY_CLIP_CHARS` (2,000, head +
  tail), then left out; a turn is never dropped. Reported on `AgentCompaction`: `summaryInput`
  (`'messages' | 'text'`), `clipped`, `omitted`.
- **`hive()` is a fan-out action** (`PRIMITIVE_FACTORIES`): `HiveResult` is a SCHEMA from the
  member's `output`; a member's throw goes through `discloseFailure`; the hive never names an actor.
  Full rule: `docs/history/ai.md`.
- **`describeAgents()` / `registeredModels()` are offered, not published** — their only legal consumer
  is `@ultimat3/cli`. The facts are a THUNK; an unnamed agent has no row.
- **`agentJob()` composes `job()`** (never an imitation). `name`, `tenant`, `retry` are
  REQUIRED; both reads of `target.job()` are LAZY. No result is kept; `actor` re-resolves
  each attempt via `impersonate` (off-tenant: `X_JOB_TENANT_MISMATCH`). Full rule: `docs/history/ai.md`.

## Invariants — provider prompt caching

One switch (`GenerateRequest.promptCache`), `promptCacheRule`: provider rows (`ProviderCacheRow`, screened by `prompt-cache-rows.ts`), then `PROMPT_CACHE_RULES`, then nothing; `agent()` `'auto'`, `llm()` `'off'`. In full: [`docs/history/ai.md`](../../docs/history/ai.md#moved-out-2026-11-03-plan-101-wave-3-the-claudemd-ceiling).

## Invariants — evals, retrieval, fix lines

In brief ([full text](../../docs/history/ai.md#evals-retrieval-fix-lines)): no fix line names
`x ai`; an eval gates on the DROP from its baseline, mean AND per case, and every prompt has one;
retrieval is hybrid only; an unbound store read under an org actor is `X_VECTOR_UNSCOPED`;
`postgresVectorStore()` filters tenant and policy in SQL on every statement (hnsw reads widen the
scan, `pg-vector-recall.ts`); `scoped()` TIGHTENS.

- **An eval never runs a real tool**: no double is `X_EVAL_TOOL_UNDOUBLED` (history, 2026-11-06).

## Commands

```
bun test ./packages/ai/
bun run --filter @ultimat3/ai typecheck

# the live vector suite — needs the extension, not just a Postgres
docker run -d -e POSTGRES_PASSWORD=ultimate -p 5432:5432 pgvector/pgvector:pg17
TEST_DATABASE_URL=postgres://postgres:ultimate@localhost:5432/postgres \
  bun test ./packages/ai/src/pg-vector.live.test.ts
```

Why each rule above is shaped the way it is: [`docs/history/ai.md`](../../docs/history/ai.md).
