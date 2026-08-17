# @ultimat3/ai — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http action
query jobs realtime`. **Never** `mcp manifest render pwa ui admin testing cli`.

Declared today: `action` (the primitive `llm()` returns), `cache` (semantic cache), `core`,
`db` (pgvector), `money`, `policy`, `schema`, `time`.

`mcp` is the same tier, so the LLM-tool projection is restated structurally in `tools.ts`
rather than imported. Same contract, two wire formats — and the same *decision*: `toLlmTools` and
`runLlmToolCall` ask `isMcpExposed` from `@ultimat3/core` (tier 0, reachable by both), never a
local `=== true`. An in-app agent and an external one must be offered exactly the same tools.

**And the same NAME**: `toLlmTool` passes `action.name` through untouched, which is the export name
`@ultimat3/mcp` serves. Never derive one here. `llm()` and `agent()` return actions, so their
`.tool()` name is the verbatim export name too — it read `summarize_post` / `projecting_agent`
until 2026-08, naming a tool no catalog contained (`llm.test.ts`, `agent.test.ts`).

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
| `tools.ts` | action → LLM tool definition; `runLlmToolCall` |
| `llm.ts` | `llm()` — the model call, declared as an `action`; and what a streamed answer must satisfy |
| `llm-stream.ts` | `.stream()`'s plumbing: the sink, the ambient mark, the one-turn drive |
| `agent.ts` | `agent()` — the tool loop, declared as an `action` |
| `redaction.ts` | the one gate between `vars()` and the provider: a `Secret` never reaches a prompt |
| `eval-errors.ts` | the five `X_EVAL_*` classes; their codes and titles stay in `errors.ts` |
| `runtime.ts` | the ambient gateway / embedder / semantic caches an `llm()` reaches |
| `fix-line.ts` / `fix-line.evals.ts` / `fix-line.v1.baseline.json` / `fix-line.eval.test.ts` | the package's own dogfood eval — the first framework-level `*.eval.test.ts`, proving the `defineEval`/baseline convention actually fails a build |

## Invariants

- **`llm()` returns an `action`. It is not a ninth primitive** (root `CLAUDE.md`, 2026-08). It
  never re-implements parse, authz or invoke — `action()` owns those and `invoke` runs them.
- `src/index.ts` re-exports `t` from `@ultimat3/schema` **verbatim**, so an `llm` file imports one
  package. Never wrap, spread or re-declare it: `t` delegates to `schemaProvider()` on every
  access, and a copy would freeze the provider at import time. `index.test.ts` asserts identity.
- The model half is the only thing `llm.ts` adds: render the prompt, project `output` into the
  one tool the model may answer through, reserve the budget, consult the semantic cache.
- One repair turn, then `X_LLM_OUTPUT_INVALID`. Two schema failures is a prompt/schema
  disagreement; a third attempt only spends money.
- Semantic scopes are separate cache INSTANCES, never a filter over a shared one — cosine
  similarity has no notion of a tenant. The instance key carries the prompt hash too, which is
  what makes a version bump invalidate the cache.
- A per-call budget `derive`s from the ambient ledger, so it can only TIGHTEN the actor and org
  ceilings it runs inside. Widening them from a declaration would be a budget that is not one.
  **A derived ledger reports back up the chain**: every debit and every recorded cost lands on it
  AND on every ledger it was derived from, and `reserve` checks the `request` scope of each one.
  Without that link a child was a fresh counter with no parent — `llm()` derives one per call, so
  `gateway.spent()` answered zero after a hundred calls and a `request` ceiling of 5,000 was
  re-granted in full to each of them. The STORE is written once, by the ledger the call was made
  on: a child shares its parent's store and keys, so writing through both bills the actor twice.
  Reservations queue on the ROOT's turnstile for the same reason — a per-ledger queue serialises
  nothing once every call has its own ledger.
- `cache.invalidates` from `docs/idea/05-caching.md` is **not** on `llm()` yet: `invalidateTags`
  fans out to `CacheTier`s, and a `SemanticCache` is not one. Storing tags nothing visits would
  read as wired and silently not be. Version bump + `ttl` is the invalidation today.
- The gateway is ambient (`configureAi`) because a declaration is evaluated at module scope,
  long before a provider exists. Absent at call time is `X_AI_GATEWAY_MISSING`, never a default
  provider — a silent fallback would spend real money on a boot mistake.

- **`BudgetStore` is where `actor` and `org` actually live, and the default is per PROCESS.**
  `createGateway({ budgetStore })` is the one install point; omitted, it is `MemoryBudgetStore`,
  so an `org` ceiling is multiplied by the replica count exactly as `jobs`' `LimitConfig` is.
  `request` is unaffected — it is one call chain and never crosses a process. `add` takes a
  **negative** `tokens` (releasing an unspent reservation is a credit), so a store that clamps at
  zero leaks the ceiling upward on every release.
- Cost is `Money` (integer minor units), rounded **up**. Never a float, never a division
  that loses a fraction.
- Every non-2xx and every in-band `error` frame becomes `AiTransportError`, which carries a real
  `status` field — that field IS the gateway's retry rule. A body parsed as a message would read
  as an empty, successful answer, which is the one outcome nothing downstream can detect.
- **The two wire formats answer the same question the same way, and `provider-parity.test.ts` is
  what makes that a build error — added 2026-08.** Four rules were held by one format and not the
  other, all of them in the RESPONSE half, and each one is a failure that reads as a success:
  - an in-band `error` object in a **200 body** is `AiTransportError` on both. `parseMessage` read
    one as an empty `end_turn` answer while `MessageStream` — the *same provider's* streamed half —
    had always refused it. `throwInBandError` is `wire.ts`'s, exported, so one status table decides
    the gateway's retry on both transports.
  - a `stopDetails` of type `refusal` **forces** `stopReason: 'refusal'`, because `llm()` and
    `agent()` branch on the reason and nothing reads the detail. `parseStopReason` answers
    `end_turn` for a spelling this build has never seen, so a refusal in a new vocabulary arrived
    as a complete answer that happened to be empty. The OpenAI-format read always forced it.
  - a tool call's `input` is **parsed, never cast**: `asToolInput`, one copy. `(b['input'] ?? {}) as
    Record<string, unknown>` put a string under that type, and `runLlmToolCall` indexes it.
  - the **credential is scrubbed** out of `AiTransportError.detail` on both. `withoutKey` was the
    OpenAI provider's alone, so a proxy echoing `x-api-key` into its 400 body put an Anthropic key
    in an error — and an error reaches a log index, a span and a problem document. Both providers
    now call `error-body.ts`'s pair; `detailOf` moved there from `provider.ts` with it (internal,
    never in `src/index.ts`).
  What is NOT parity: the two status tables (529 vs 503 for "overloaded") and the OpenAI-format
  `estimatedUsage` fallback. Those are the formats differing, and the parity suite asserts them
  *as* differences rather than flattening them.
- A stream that ends without `message_stop` throws. A truncated answer that returns `end_turn`
  is a confidently wrong answer with no signal, which the budget rule already forbids.
- A tool call is emitted whole. `input_json_delta` fragments are not arguments until the block
  closes, so nothing partial reaches a caller.
- Thinking chunks are never appended to `text`. A consumer concatenating every chunk must not
  end up shipping the reasoning to the user.
- One `RemoteEmbedder` for every vendor: `baseUrl` selects the provider, the wire shape is the
  same. Vectors are L2-normalised on arrival so `cosine` stays a dot product, and a width other
  than the declared one is `X_VECTOR_DIM_MISMATCH` before anything reaches a store.
- A budget throws `X_AI_BUDGET_EXCEEDED` **before** the provider call. Never truncate.
- Anthropic body: no `temperature`/`top_p`/`top_k`, no `budget_tokens`, `effort` inside
  `output_config`. All 400s otherwise.
- **`ModelId` is `string`, and the catalogue is an open registry — decided 2026-08.** The routing
  seam (`Provider`, `createGateway`) was always open; the VOCABULARY was not, so a company's own
  gateway serving `llama-internal-70b` could not be typed and the only way past `tsc` was to claim
  a Claude id — after which `costOf` charged list price for a model nobody ran, `BudgetLedger`
  reserved against the wrong number and the manifest recorded a model the company does not use.
  What replaces the union as the guard is `modelSpec(id)`: an unregistered id is
  `X_AI_MODEL_UNKNOWN` at the first read, naming the registered set. **The three built-ins register
  through the same `registerModel` an app calls**, at the bottom of `models.ts`, so the default
  path is the app's path and there is one way to put a model in the catalogue.
- **Re-registering an id REPLACES its spec and keeps its rung.** That is the negotiated-rate
  mechanism, and the reason there is no `overrideModel`: an app whose contract prices
  `claude-opus-5` below list registers it again with its own prices, and every `costOf`, every
  reservation and every recorded cost is that number from then on. Boot runs after this module is
  imported, so the app always wins.
- **Registration order IS the ladder within a `family`, most capable first, and `moreCapableThan`
  is its only reader.** `ModelSpec.family` is what makes that true once more than one vendor's
  list is registered: the built-ins are `anthropic` then `openai`, so without it the rung above
  `gpt-5.6-sol` was `claude-haiku-4-5` — the cheapest model in the catalogue, from a vendor the
  app's gateway may not serve, offered as an UPGRADE in `X_LLM_REFUSED`'s fix line. Absent is its
  own family, so an app that registers its whole catalogue in one order still compares across all
  of it. A refusal is worth retrying upward and nowhere else: `MODEL_IDS.find((id) => id !==
  refused)` answered a refusal on the default model with the next entry DOWN, so `X_LLM_REFUSED`'s
  fix line told an operator to buy the same refusal from a weaker model. When there is no rung
  above — including for a model nobody registered — `alternative` is `undefined` and the fix line
  drops the suggestion rather than inventing a downgrade. A model appended after the built-ins is
  the least capable rung, because that is what appending to a most-capable-first list means; an app
  wanting its own ladder registers its whole catalogue in order.
- `AnthropicProvider.models` is `ANTHROPIC_MODEL_IDS`, its OWN list, never the registry's — an
  app's internal model must not be routed to Anthropic. `EchoProvider.models` is a getter over the
  registry, because a test double has to serve whatever the test registered.
- **The reasoning half of the body is PER MODEL, and `models.ts` owns which model takes what.**
  `output_config.effort` and adaptive thinking arrived with 4.6, so one body sent to the whole
  catalogue is a guaranteed 400 on the oldest entry — which is how `claude-haiku-4-5` shipped
  blessed and uncallable. A control the caller never asked for is omitted; a control they DID
  ask for is refused locally with `X_AI_REQUEST_INVALID`, never dropped, because a declaration
  reading `effort: 'max'` that quietly runs at the default is the failure nobody can see. Adding
  a model is a row in `MODELS`, never an `if` in the request builder. Omission is literal: an
  absent `thinking` sends no block at all, where `(thinking ?? 'adaptive')` sent an adaptive one
  for every adaptive-capable model — harmless on the wire, since adaptive is the server default,
  but it made a defaulted control indistinguishable from a declared one, which is the whole
  distinction this rule draws.
- **`openAiProvider()` is a FORMAT, not a vendor — decided 2026-08.** Azure OpenAI, vLLM, Ollama,
  LiteLLM, OpenRouter, Together and most company gateways speak the OpenAI chat-completions wire
  format, so one provider plus `baseUrl` is what makes "point Ultimate at our internal gateway"
  real. Never add a second class per vendor: `baseUrl`, `auth` and `headers` are the differences.
  - **Structured output is the `respond` tool, never `response_format`.** `llm()` already projects
    `output` into one tool and reads the answer out of `toolCalls`; `json_schema` + `strict` would
    be a SECOND structured-output path (axiom 1), would need the provider to synthesise a
    `respond` call out of a content string, and is the one feature most OpenAI-*compatible* servers
    do not implement. Forcing the function is what buys the reliability instead: `tool_choice`
    names the tool when the request offers **exactly one**, which is precisely `llm()`'s shape and
    never `agent()`'s — forcing a name inside a tool loop decides the model's next step for it.
  - **`strict: true` is derived from the schema, never forwarded.** `LlmTool.strict` is `true` on
    every projection; on this wire the server CHECKS it, and one optional field (a key in
    `properties` absent from `required`) is a 400. `satisfiesStrictMode` is the gate, recursive
    because the server's check is.
  - `max_completion_tokens`, never `max_tokens`: the old field is rejected outright by every
    current reasoning model. No `temperature`/`top_p`, same rule as the Anthropic body.
  - **`stream_options: { include_usage: true }` on every streamed request, and an ESTIMATE when
    usage never arrives.** Usage comes once, in a trailing chunk with an empty `choices` array, and
    only when that field was sent — a compatible server that ignores it would otherwise leave the
    budget reconciling a real call against zero, refunding the whole reservation. Zero is wrong by
    all of it; an estimate is wrong by a few percent in the safe direction.
  - `prompt_tokens` INCLUDES the cached prefix here, where Anthropic's `input_tokens` excludes it.
    Subtract `prompt_tokens_details.cached_tokens` out of the input count or the cached half is
    billed twice — once at the input rate, once at the cache rate.
  - Tool-call deltas are merged by `tool_calls[].index`. The id and the name arrive on the FIRST
    fragment and on no other, so merging by array position builds one call per chunk and keeps only
    the last slice of arguments. The call is emitted whole at the finish reason — there is no
    per-block stop event in this format.
  - `isComplete()` accepts `[DONE]` **or** a finish reason: plenty of servers in the family close
    the socket straight after the finish chunk, and a finish reason is the model saying why it
    stopped, which a cut connection cannot produce.
  - `role: 'system'`, not `developer` — the newer role is OpenAI's alone and every other server in
    the family knows only `system`.
  - **Only three models are priced** (`gpt-5.6-sol` / `-terra` / `-luna`, list price read
    2026-08-16). `gpt-4o` and the `o1` family cache at 0.5x input where `costOf` assumes 0.1x, and
    the `pro` tiers publish no cached rate — a wrong price is worse than a missing one, because
    `costOf` answers confidently either way and `X_AI_MODEL_UNKNOWN` at least says so.
  - The specs register at module scope, like the Anthropic three — so a suite that calls
    `resetModels()` drops them. `registerOpenAiModels()` is exported for exactly that, and every
    `openai-*.test.ts` calls it in `beforeEach`.
  - **No new `X_*` code.** A non-2xx and an in-band `error` object are `AiTransportError`, a missing
    key is `X_AI_KEY_MISSING`, a control the endpoint has not got is `X_AI_REQUEST_INVALID` — the
    failures are the same failures, and a second code per provider would be a vocabulary that grows
    with the driver list. What DID change: `AiTransportError` now takes the provider's `envVar`,
    because the 401 fix line was a hardcoded `ANTHROPIC_API_KEY` for every provider in the package.
  - The key is revealed as late as possible, never stored on the instance, and scrubbed out of the
    error `detail` — a proxy echoing request headers into its 4xx body is the one path by which a
    key reaches an error, and an error reaches a log index, a span and a problem document.
- Model IDs are exact aliases. Never append a date suffix.
- **No fix line may name `x ai`.** That command is PLANNED and throws (`packages/cli/src/cmd-planned.ts`),
  so a fix citing `x ai reindex` sends an operator to a wall — an axiom-4 violation. Two shipped;
  both now name the app-code fix instead.
- **An eval is selected with `x test eval --filter <name>`, never `x test <name>`.** `x test`'s
  positional is a `TestType` (`unit contract live job e2e eval`), so the eval's own name there is
  `X_CLI_BAD_FLAG`. `X_EVAL_THRESHOLD` shipped that fix line until 2026-08; `eval-errors.test.ts`
  now asserts every `x test <word>` these five classes emit is one of the six types. The
  `errors` step's `fix-command.ts` resolves the *command*, not its positional, so nothing else
  would have caught it.
- The introductory price on a model is deliberately not modelled. A price that lapses on a date
  makes a recorded cost depend on when it was read, and under-reporting spend after the lapse is
  a budget that is not one. List price over-reserves, which is the safe direction.
- `generate()` above `STREAM_ONLY_MAX_TOKENS` runs the STREAMING transport and assembles the
  result, rather than refusing. The ceiling is the transport's, not the model's.
- **`llm()` streams through `.stream()`, and it is the SAME action — decided 2026-08.** The
  invocation is an ordinary one, marked with an ambient sink; policy, input parse, budget scope,
  semantic cache, span, audit and `.tool()` all still apply, because there is no second execution
  path. Before it existed, the first feature needing tokens on a screen called `aiGateway()`
  directly and lost every one of them.
  - **Output schema:** a schema cannot be checked until the last token lands, so a stream yields
    UNVALIDATED text and one final `done` carrying the value that DID satisfy `output`. **No repair
    turn** — the consumer has already read the tokens, and a second answer over the top is two
    answers to one question. One attempt, then `X_LLM_STREAM_INVALID`, whose fix is the
    non-streaming call.
  - **Budget:** unchanged and still reserved before the provider is touched. `Gateway.stream`
    debits the worst-case estimate on the first pull and reconciles at `done`, releasing in a
    `finally`. The whole stream is driven inside the handler, so reservation and reconciliation sit
    on one async chain; abandoning the iterator stops delivery, never the accounting.
  - A streamed call offers **no `respond` tool**: a tool call is emitted whole, so forcing one
    leaves nothing to stream. The answer is prose, and its JSON parse is what a non-string `output`
    validates. A semantic-cache hit yields `done` alone, with no text increments.
  - `.stream()` is LAZY. Nothing is authorised, budgeted or sent until the first pull. `named()` is
    re-narrowed for the same reason `stream` is assigned in place: `action()`'s `named` builds a
    fresh twin that would silently not stream.
- **`agent()` is a job for the tool loop, and the third instance of the factory rule** (after
  `llm()` and `backfill()`) — it returns an `action`, never a ninth primitive. It exists because
  the alternative is a hand-rolled loop, and a hand-rolled loop is where the dangerous mistake
  lives: **taking the actor from the model's output.** `ctx.actor` is read once and is the only
  identity any tool runs as; nothing the model emits can reach it. Bounded by `maxTurns`
  (`X_AGENT_MAX_TURNS`, never a partial answer), by `budget.tokensPerRun` (the ledger's `request`
  scope, which accumulates across turns) and by `maxToolResultChars` — the transcript IS the
  request, so an untruncated tool result is re-billed once per remaining turn.
  - A tool listed in `agent({ tools })` that is not `mcp: { expose: true }` is
    `X_AGENT_TOOL_UNEXPOSED` **at declaration**, not filtered at the call: a silently dropped tool
    reads as offered and is not. `isMcpExposed` is the one predicate, so an in-app agent and an
    external MCP client see the same catalogue.
  - **No semantic cache on `agent()`.** Similar prompts do not have similar answers once the answer
    depends on what `lookupOrder` returned this second.
  - `AiMessage.content` widened to `string | readonly AiContentBlock[]` for this: a `tool_result`
    has to name the `tool_use` it answers and a string has nowhere to put the id. The block field
    names are the Messages API's, so `body()` passes them through untouched.
- **`configureAi({ redact })` is the one seam between `vars()` and the provider.** `vars()` is the
  one declared place a model call loads data, so it is the one place a redactor can see the row
  before it leaves the process; the redactor sees the whole RENDERED prompt and the system prompt,
  template as well as values. WHAT to remove is the app's (a PII classifier is a model choice —
  axiom 8). The framework ships the seam, the `llm.redacted` span attribute, and the one rule it
  can enforce structurally: **a `Secret` in `vars()` is `X_AI_PROMPT_SECRET`**, whether or not a
  redactor is installed. Not a leak — `Secret` renders `[redacted]` by value — but a prompt that
  reads fine, means something else, and costs full price.
- **Fallback is across PROVIDERS serving one model, never across models — decided 2026-08.** The
  wiki's LLM-gateway table claimed an ordered model list; there never was one, and building one was
  rejected: a silent model swap changes what answered, what it cost, and which eval baseline the
  answer belongs to, and `X_LLM_REFUSED` already names a more capable model for the DECLARATION to
  adopt. What was missing is the other half of the claim — "never silent" — so the gateway now
  stamps `GenerateResult.provider` with the provider that actually answered and `llm()` puts it on
  the span as `llm.provider`. Stamped by the gateway, not the provider: routing is a gateway
  concept, and an app's own `Provider` cannot report on a decision it did not make.
- A **refusal is a 200 with no answer in it**, so it becomes `X_LLM_REFUSED` at the `llm()` seam,
  before the output is parsed. Parsing it first reports a schema disagreement — wrong cause,
  inapplicable fix — and spends a repair turn buying the same refusal again. A truncated answer
  that also fails its schema is `X_LLM_TRUNCATED` for the same reason: the ceiling does not move
  between attempts. `stopDetails.category` is carried, not dropped: it is the only thing that
  says whether another model would answer.
- The gateway does not cache a refusal. Caching one keeps serving a classifier decision long
  after the prompt that provoked it was fixed.
- Server-side `fallbacks` (beta) are deliberately NOT sent. The provider speaks the stable
  `2023-06-01` surface, and a 1.0 package that promises semver cannot pin a beta wire contract;
  the typed refusal plus the gateway's own model routing is the framework's answer instead.
- `definePrompt` refuses a re-registered version whose hash moved.
- Every eval result carries the prompt hash. A score without one is not a measurement.
- An eval gates on the DROP from its recorded baseline, never on an absolute score. An absolute
  floor fails every eval at once the day a provider ships a slightly different model, which
  teaches everyone to lower thresholds until they measure nothing.
- The run mean AND every case are compared. A mean that holds while one case collapses is the
  regression an eval exists to catch.
- A baseline that has never been recorded is `X_EVAL_BASELINE_MISSING`, and a corrupt one is
  `X_EVAL_BASELINE_INVALID` — never "absent, so pass". A step that cannot fail is not running.
- `baseline` is `import.meta.resolve('./…')`. A cwd-relative path resolves to a different file
  depending on where the suite was started, which is how a gate silently stops gating.
- Every registered prompt must be named by an eval (`promptsWithoutEvals`, `X_EVAL_MISSING`).
  Coverage is by prompt ID, not ref: old versions are retained, and an eval on the current one
  evaluates that lineage.
- `ULTIMATE_EVAL_RECORD=1` writes baselines instead of gating on them. A test that deliberately
  scores a worse model calls `run`, never `assert` — `assert` would re-record during that pass.
- **Recording and the gate are mutually exclusive.** `x verify` with that variable set is
  `X_EVAL_RECORDING` and runs no eval suite at all. Recording passes by definition, so a gate run
  that inherited the flag is green over numbers it wrote itself — and rewrites every committed
  baseline on its way through, which is the half a red step would not undo. Hence refuse *before*
  the suite, never after it.
- The gate asks whether an eval has a baseline, not only whether one is declared. `defineEval`
  proves a prompt is named; it proves nothing measured it, and an eval whose numbers were never
  recorded — one no test asserts, one whose `baseline:` is a cwd-relative string — would otherwise
  satisfy `X_EVAL_MISSING` while gating on nothing.
- Retrieval is hybrid by default. Do not add a vector-only convenience path.
- `PgVectorStore` is the ONLY production vector path — pgvector and Postgres FTS in the app's own
  Postgres, never a second datastore. `MemoryVectorStore` is the dev twin and enforces the same
  envelope; a leak that only reproduces against real Postgres is a leak nobody finds.
- **It is proved against a real pgvector, not only against a recording client.**
  `pg-vector.live.test.ts` runs the whole chain — `ddl()` -> a live server -> `upsert` -> cosine,
  FTS and the RRF fusion -> decoded hit — and REFUSES to skip when `TEST_DATABASE_URL` names a
  Postgres without the extension, because a suite that stands down reports green for the one
  store that runs in front of real traffic. CI's service container is `pgvector/pgvector:pg17`
  for that reason. Asserting statement *text* cannot catch a statement Postgres rejects, nor a
  filter that compiles cleanly and excludes nothing: that is exactly how metadata shipped bound
  `::jsonb`. A new operator, read path or scope rule is not done until it round-trips there.
- The distance ordering lives in a subquery, ascending and raw, because that is the only shape
  hnsw answers — `order by 1 - (…) desc` is a sequential scan. Both halves are pinned by a plan
  assertion in the live suite, since only a planner can say which one shipped.
- hnsw applies the scope AFTER the index scan, so an approximate index can return fewer rows
  than asked for once a tenant filter is selective. The planner takes the exact path instead
  when it has stats — which is why a bulk backfill that skips `analyze` is how a search that
  used the index yesterday scans today. Assert the rows a scoped read returns, never the node.
- Tenant and policy filters go **in SQL**, on every statement, through `conditionsSql` — and on
  BOTH halves of the fusion. Filtering after the rows are loaded is not filtering.
- `(tenant, id)` is the primary key. A cross-tenant overwrite is impossible at the storage layer
  rather than conditional on every upsert remembering to check.
- `scoped()` only ever TIGHTENS: tenants are set once, allow-lists intersect. Widening is
  `X_VECTOR_SCOPE_WIDENED`. Same rule as `budget.derive`, for the same reason.
- Metadata is bound `::text::jsonb`. A bound string cast straight to `::jsonb` is JSON-encoded
  twice, reads back correctly, and makes every `metadata ->> key` filter match nothing.

## Commands

```
bun test packages/ai
bun run --filter @ultimat3/ai typecheck

# the live vector suite — needs the extension, not just a Postgres
docker run -d -e POSTGRES_PASSWORD=ultimate -p 5432:5432 pgvector/pgvector:pg17
TEST_DATABASE_URL=postgres://postgres:ultimate@localhost:5432/postgres \
  bun test packages/ai/src/pg-vector.live.test.ts
```
