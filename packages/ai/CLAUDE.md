# @ultimat3/ai — boundary

Tier 4. May import tier 0–3: `core schema i18n money time cache seo entity policy http action
query jobs realtime`. **Never** `mcp manifest render pwa ui admin testing cli`.

`mcp` is the same tier, so the LLM-tool projection is restated structurally in `tools.ts`
rather than imported. Same contract, two wire formats.

## Owns

| File | Job |
|---|---|
| `provider.ts` | `Provider` interface, model catalogue + prices, Anthropic + Echo |
| `gateway.ts` | routing, retries, cache, budget wiring |
| `budget.ts` | token ledgers per request/actor/org, ALS carrier |
| `prompt.ts` | `definePrompt`, content hashing, version registry |
| `evals.ts` | `defineEval`, built-in scorers, threshold assertion |
| `embeddings.ts` | `Embedder`, `HashEmbedder`, cosine helpers |
| `vector.ts` | `VectorStore`, in-memory cosine + BM25, RRF hybrid, pgvector DDL |
| `rag.ts` | chunker, retriever, reranker, budgeted context assembler |
| `tools.ts` | action → LLM tool definition; `runLlmToolCall` |

## Invariants

- Cost is `Money` (integer minor units), rounded **up**. Never a float, never a division
  that loses a fraction.
- A budget throws `X_AI_BUDGET_EXCEEDED` **before** the provider call. Never truncate.
- Anthropic body: no `temperature`/`top_p`/`top_k`, no `budget_tokens`, `effort` inside
  `output_config`, `thinking: 'disabled'` only at effort ≤ `high`. All 400s otherwise.
- Model IDs are exact aliases. Never append a date suffix.
- `definePrompt` refuses a re-registered version whose hash moved.
- Every eval result carries the prompt hash. A score without one is not a measurement.
- Retrieval is hybrid by default. Do not add a vector-only convenience path.

## Commands

```
bun test packages/ai
bun run --filter @ultimat3/ai typecheck
```
