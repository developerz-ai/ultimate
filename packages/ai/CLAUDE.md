# @ultimat3/ai — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http action
query jobs realtime`. **Never** `mcp manifest render pwa ui admin testing cli`.

Declared today: `action` (the primitive `llm()` returns), `cache` (semantic cache), `core`,
`db` (pgvector), `money`, `policy`, `schema`, `time`.

`mcp` is the same tier, so the LLM-tool projection is restated structurally in `tools.ts`
rather than imported. Same contract, two wire formats.

## Owns

| File | Job |
|---|---|
| `provider.ts` | `Provider` interface, model catalogue + prices, the request half, Anthropic + Echo |
| `wire.ts` | the response half: `usage` / `stop_reason` shapes, and the SSE `MessageStream` |
| `sse.ts` | Server-Sent Events framing — protocol only, knows nothing about Anthropic |
| `gateway.ts` | routing, retries, cache, budget wiring |
| `budget.ts` | token ledgers per request/actor/org, ALS carrier |
| `prompt.ts` | `definePrompt`, content hashing, version registry |
| `embeddings.ts` | `Embedder`, `HashEmbedder`, cosine helpers |
| `remote-embedder.ts` | `RemoteEmbedder` — the production `/v1/embeddings` client |
| `evals.ts` | `defineEval`, built-in scorers, threshold assertion |
| `vector.ts` | `VectorStore`, in-memory cosine + BM25, RRF hybrid |
| `vector-scope.ts` | the tenant + policy envelope, and the tighten-only derive rule |
| `pg-vector-sql.ts` | every pgvector statement: DDL, upsert, cosine, FTS, RRF fusion |
| `pg-vector.ts` | `PgVectorStore` — the production store |
| `rag.ts` | chunker, retriever, reranker, budgeted context assembler |
| `tools.ts` | action → LLM tool definition; `runLlmToolCall` |
| `llm.ts` | `llm()` — the model call, declared as an `action` |
| `runtime.ts` | the ambient gateway / embedder / semantic caches an `llm()` reaches |

## Invariants

- **`llm()` returns an `action`. It is not a ninth primitive** (root `CLAUDE.md`, 2026-08). It
  never re-implements parse, authz or invoke — `action()` owns those and `invoke` runs them.
- The model half is the only thing `llm.ts` adds: render the prompt, project `output` into the
  one tool the model may answer through, reserve the budget, consult the semantic cache.
- One repair turn, then `X_LLM_OUTPUT_INVALID`. Two schema failures is a prompt/schema
  disagreement; a third attempt only spends money.
- Semantic scopes are separate cache INSTANCES, never a filter over a shared one — cosine
  similarity has no notion of a tenant. The instance key carries the prompt hash too, which is
  what makes a version bump invalidate the cache.
- A per-call budget `derive`s from the ambient ledger, so it can only TIGHTEN the actor and org
  ceilings it runs inside. Widening them from a declaration would be a budget that is not one.
- `cache.invalidates` from `docs/idea/05-caching.md` is **not** on `llm()` yet: `invalidateTags`
  fans out to `CacheTier`s, and a `SemanticCache` is not one. Storing tags nothing visits would
  read as wired and silently not be. Version bump + `ttl` is the invalidation today.
- The gateway is ambient (`configureAi`) because a declaration is evaluated at module scope,
  long before a provider exists. Absent at call time is `X_AI_GATEWAY_MISSING`, never a default
  provider — a silent fallback would spend real money on a boot mistake.

- Cost is `Money` (integer minor units), rounded **up**. Never a float, never a division
  that loses a fraction.
- Every non-2xx and every in-band `error` frame becomes `AiTransportError`, which carries a real
  `status` field — that field IS the gateway's retry rule. A body parsed as a message would read
  as an empty, successful answer, which is the one outcome nothing downstream can detect.
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
  `output_config`, `thinking: 'disabled'` only at effort ≤ `high`. All 400s otherwise.
- Model IDs are exact aliases. Never append a date suffix.
- `definePrompt` refuses a re-registered version whose hash moved.
- Every eval result carries the prompt hash. A score without one is not a measurement.
- Retrieval is hybrid by default. Do not add a vector-only convenience path.
- `PgVectorStore` is the ONLY production vector path — pgvector and Postgres FTS in the app's own
  Postgres, never a second datastore. `MemoryVectorStore` is the dev twin and enforces the same
  envelope; a leak that only reproduces against real Postgres is a leak nobody finds.
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
```
